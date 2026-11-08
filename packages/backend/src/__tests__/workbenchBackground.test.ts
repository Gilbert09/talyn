import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageTrigger, messageTriggerText, type Features, type WorkbenchMessageTrigger } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { invokeRoute } from './helpers/invokeRoute.js';
import { workbenchBackgroundJobs, workbenchChats, workbenches, workbenchWakeups, workspaces } from '../db/schema.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import {
  JOB_PROBE,
  cancelWakeup,
  fireWakeup,
  jobExitPrompt,
  scheduleWakeup,
  startBackgroundJob,
  stopBackgroundJob,
} from '../services/workbenches/background.js';
import {
  dueWakeupsQuery,
  recentJobsQuery,
  recentWakeupsQuery,
  runningJobsQuery,
  scheduledWakeupsQuery,
  getJob,
  getWakeup,
} from '../services/workbenches/backgroundStore.js';
import { checkJob, markJobsLostAfterMove, sweepBackground } from '../services/workbenches/backgroundSweep.js';
import { getWorkbench } from '../services/workbenches/store.js';
import { WorkbenchError } from '../services/workbenches/errors.js';
import { sendMessage } from '../services/workbenches/turns.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import * as durable from '../services/workbenches/durableExec.js';
import { chooseReadSource } from '../services/workbenches/sandboxReadSource.js';
import { existingBoxRefusal } from '../services/workbenches/boxGate.js';
import { workbenchBackgroundRoutes } from '../routes/workbenchBackground.js';
import { listToolsFor } from '../mcp/server.js';
import { BACKGROUND } from '../mcp/tools/background.js';

vi.mock('../services/workbenches/turns.js', () => ({
  sendMessage: vi.fn(async () => ({ queued: false })),
}));
vi.mock('../services/workbenches/sandboxReadSource.js', () => ({
  chooseReadSource: vi.fn(async () => ({ live: true })),
}));
vi.mock('../services/workbenches/boxGate.js', () => ({ existingBoxRefusal: vi.fn(async () => null) }));
vi.mock('../services/workbenches/emit.js', () => ({
  emitWorkbenchBackground: vi.fn(),
  emitWorkbenchChat: vi.fn(),
  emitWorkbenchEvents: vi.fn(),
  emitWorkbenchUpdated: vi.fn(async () => undefined),
}));

let testDb: Awaited<ReturnType<typeof createTestDb>>;
// Spies, not module mocks: these modules import each other, and a partial
// module mock of one returns the real other.
let runCapture: ReturnType<typeof vi.spyOn<typeof runtime, 'runCapture'>>;
let killMarker: ReturnType<typeof vi.spyOn<typeof runtime, 'killMarker'>>;
let wakeWithCredentials: ReturnType<typeof vi.spyOn<typeof runtime, 'wakeWithCredentials'>>;
let startDurableExec: ReturnType<typeof vi.spyOn<typeof durable, 'startDurableExec'>>;
const HOUR = 60 * 60_000;

function probeAnswer(state: string, code: number | null = null, lines: string[] = []) {
  const stdout = JSON.stringify({ state, code, lines });
  return { exitCode: 0, stdout, stderr: '', stdoutBytes: Buffer.from(stdout) };
}

async function insertJob(values: Partial<typeof workbenchBackgroundJobs.$inferInsert> = {}) {
  await testDb.db.insert(workbenchBackgroundJobs).values({
    id: 'job', workbenchId: 'wb', chatId: 'chat', workspaceId: 'ws', sandboxId: 'box', name: 'tests',
    command: 'npm test', cwd: '/work/repo', durableKey: 'bg-job', marker: 'talyn-bg-job',
    keepAwakeUntil: new Date(Date.now() + HOUR), startedAt: new Date(Date.now() - 90_000), ...values,
  });
  return (await getJob(values.id ?? 'job'))!;
}

async function insertWakeup(values: Partial<typeof workbenchWakeups.$inferInsert> = {}) {
  await testDb.db.insert(workbenchWakeups).values({
    id: 'wake', workbenchId: 'wb', chatId: 'chat', workspaceId: 'ws', wakeAt: new Date(Date.now() - 1000),
    reason: 'Check the deploy', ...values,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  runCapture = vi.spyOn(runtime, 'runCapture');
  killMarker = vi.spyOn(runtime, 'killMarker').mockResolvedValue(undefined);
  wakeWithCredentials = vi.spyOn(runtime, 'wakeWithCredentials').mockResolvedValue(undefined);
  startDurableExec = vi.spyOn(durable, 'startDurableExec').mockResolvedValue(undefined);
  vi.mocked(chooseReadSource).mockResolvedValue({ live: true });
  vi.mocked(existingBoxRefusal).mockResolvedValue(null);
  vi.stubEnv('SESSION_BACKGROUND_ENABLED', 'true');
  vi.stubEnv('WORKBENCHES_ENABLED', 'true');
  resetFeatureFlagsForTests();
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: 'owner' });
  await seedUser(testDb.db, { id: 'mate' });
  await testDb.db.insert(workspaces).values({ id: 'ws', name: 'Workspace', ownerId: 'owner' });
  await testDb.db.insert(workbenches).values({
    id: 'wb', workspaceId: 'ws', repoFullName: 'acme/web', branch: 'b', baseBranch: 'main', name: 'Session',
    runtime: 'sandbox', agent: 'claude', status: 'ready', sandboxId: 'box', sandboxState: 'running',
  });
  await testDb.db.insert(workbenchChats).values({
    id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude', status: 'idle',
  });
});

afterEach(async () => {
  for (const spy of [runCapture, killMarker, wakeWithCredentials, startDurableExec]) spy.mockRestore();
  vi.unstubAllEnvs();
  resetFeatureFlagsForTests();
  await testDb.cleanup();
});

describe('wake-ups', () => {
  it('sends one turn when two sweeps run together', async () => {
    await insertWakeup();
    await Promise.all([sweepBackground(), sweepBackground(), fireWakeup('wake')]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, input, opts] = vi.mocked(sendMessage).mock.calls[0];
    expect(chatId).toBe('chat');
    expect(input.text).toContain('Wake-up you scheduled at');
    expect(input.text).toContain('Check the deploy');
    expect(opts).toMatchObject({ origin: 'talyn', trigger: { kind: 'wakeup', wakeupId: 'wake', reason: 'Check the deploy', createdBy: 'agent' } });
    expect(opts).not.toHaveProperty('payer');
    expect(await getWakeup('wake')).toMatchObject({ status: 'fired' });
  });

  it('leaves a wake-up that is not due', async () => {
    await insertWakeup({ wakeAt: new Date(Date.now() + HOUR) });
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await getWakeup('wake')).toMatchObject({ status: 'scheduled' });
  });

  it.each([
    ['a delay of 0', { delaySeconds: 0 }],
    ['a negative delay', { delaySeconds: -30 }],
    ['a time in the past', { at: new Date(Date.now() - 60_000).toISOString() }],
    ['the current instant', { at: 'NOW' }],
  ])('refuses %s', async (_label, timing) => {
    const now = new Date();
    const input = { reason: 'later', ...timing, ...(timing.at === 'NOW' ? { at: now.toISOString() } : {}) };
    const err = await scheduleWakeup((await getWorkbench('wb'))!, input, 'agent', now).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkbenchError);
    expect((err as WorkbenchError).code).toBe('wakeup_in_past');
  });

  it.each([
    ['no reason', { delaySeconds: 60, reason: ' ' }],
    ['both times', { delaySeconds: 60, at: new Date(Date.now() + HOUR).toISOString(), reason: 'x' }],
    ['no time', { reason: 'x' }],
    ['a bad time', { at: 'tomorrow', reason: 'x' }],
    ['a fractional delay', { delaySeconds: 1.5, reason: 'x' }],
    ['a long reason', { delaySeconds: 60, reason: 'x'.repeat(1001) }],
  ])('refuses %s', async (_label, input) => {
    await expect(scheduleWakeup((await getWorkbench('wb'))!, input, 'user')).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    ['a delay', { delaySeconds: 600 }, 600_000],
    ['a time a year away', { at: 'YEAR' }, 365 * 24 * HOUR],
  ])('schedules %s with no upper bound', async (_label, timing, offset) => {
    const now = new Date();
    const input = { reason: 'later', ...timing, ...('at' in timing ? { at: new Date(now.getTime() + offset).toISOString() } : {}) };
    const wakeup = await scheduleWakeup((await getWorkbench('wb'))!, input, 'user', now);
    expect(Math.abs(Date.parse(wakeup.wakeAt) - (now.getTime() + offset))).toBeLessThan(1000);
    expect(wakeup).toMatchObject({ status: 'scheduled', createdBy: 'user', chatId: 'chat' });
  });

  it('cancels a scheduled wake-up, and the sweep then sends nothing', async () => {
    await insertWakeup();
    const cancelled = await cancelWakeup((await getWorkbench('wb'))!, 'wake');
    expect(cancelled).toMatchObject({ status: 'cancelled', failureDetail: 'Cancelled.' });
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([true, false])('cancels the wake-ups of an archived session (due: %s)', async (due) => {
    await insertWakeup({ wakeAt: new Date(Date.now() + (due ? -1000 : HOUR)) });
    await testDb.db.update(workbenches).set({ archivedAt: new Date(), status: 'archived' }).where(eq(workbenches.id, 'wb'));
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await getWakeup('wake')).toMatchObject({ status: 'cancelled', failureDetail: 'The session is archived.' });
  });

  it('cancels a wake-up whose chat closed', async () => {
    await insertWakeup();
    await testDb.db.update(workbenchChats).set({ closedAt: new Date() }).where(eq(workbenchChats.id, 'chat'));
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await getWakeup('wake')).toMatchObject({ status: 'cancelled', failureDetail: 'The chat is closed.' });
  });

  it('marks a wake-up failed on a box-gate refusal, and sends nothing', async () => {
    await insertWakeup();
    vi.mocked(existingBoxRefusal).mockResolvedValue({ message: 'Your box-hours ran out.' } as never);
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(vi.mocked(existingBoxRefusal).mock.calls[0][1]).toBe(true);
    expect(await getWakeup('wake')).toMatchObject({ status: 'failed', failureDetail: 'Your box-hours ran out.' });
  });

  it('marks a wake-up failed when the send fails', async () => {
    await insertWakeup();
    vi.mocked(sendMessage).mockRejectedValueOnce(new WorkbenchError('This session failed to start; retry it.', 409, 'not_ready'));
    await sweepBackground();
    expect(await getWakeup('wake')).toMatchObject({ status: 'failed', failureDetail: 'This session failed to start; retry it.' });
  });

  it('sends the turn with the stored payer', async () => {
    await testDb.db.insert(workspaces).values({ id: 'ws-mate', name: 'Mate', ownerId: 'mate' });
    await insertWakeup({ payerUserId: 'mate', payerWorkspaceId: 'ws-mate' });
    await sweepBackground();
    expect(vi.mocked(sendMessage).mock.calls[0][2]).toMatchObject({ payer: { userId: 'mate', workspaceId: 'ws-mate' } });
    expect(vi.mocked(existingBoxRefusal).mock.calls[0][2]).toEqual({ userId: 'mate', workspaceId: 'ws-mate' });
  });

  it.each([
    ['agent', 'running', 'mate'],
    ['agent', 'idle', null],
    ['user', 'running', null],
  ] as const)('a %s wake-up while the chat is %s is paid by %s', async (createdBy, status, payer) => {
    await testDb.db.update(workbenchChats).set({ status, payerUserId: 'mate', payerWorkspaceId: 'ws-mate' })
      .where(eq(workbenchChats.id, 'chat'));
    const wakeup = await scheduleWakeup((await getWorkbench('wb'))!, { reason: 'later', delaySeconds: 60 }, createdBy);
    const stored = await getWakeup(wakeup.id);
    expect(stored?.payerUserId ?? null).toBe(payer);
  });

  it('does nothing while the flag is off for the owner', async () => {
    vi.stubEnv('SESSION_BACKGROUND_ENABLED', 'false');
    resetFeatureFlagsForTests();
    await insertWakeup();
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await getWakeup('wake')).toMatchObject({ status: 'scheduled' });
  });
});

describe('background jobs', () => {
  it('starts a job under the supervisor in the current box', async () => {
    const job = await startBackgroundJob((await getWorkbench('wb'))!, { command: 'npm test -- --all', cwd: 'packages/api' });
    expect(job).toMatchObject({ status: 'running', name: 'npm test -- --all', notifyOnExit: true, chatId: 'chat' });
    expect(Date.parse(job.keepAwakeUntil!) - Date.now()).toBeGreaterThan(HOUR - 5000);
    const [, key, marker, script, env, segmented] = startDurableExec.mock.calls[0];
    expect(key).toBe(`bg-${job.id}`);
    expect(marker).toBe(`talyn-bg-${job.id}`);
    expect(script).toBe('cd /work/web/packages/api || exit 1\nnpm test -- --all');
    expect(env).toMatchObject({ TALYN_BACKGROUND_JOB_ID: job.id, TALYN_SESSION_ID: 'wb' });
    expect(segmented).toBe(true);
    expect((await getJob(job.id))?.sandboxId).toBe('box');
  });

  it.each([
    ['an empty command', { command: '  ' }],
    ['a command over the env limit', { command: 'x'.repeat(100_001) }],
    ['keep-awake over a day', { command: 'x', keepAwakeSeconds: 24 * 3600 + 1 }],
    ['a negative keep-awake', { command: 'x', keepAwakeSeconds: -1 }],
    ['a chat of another session', { command: 'x', chatId: 'nope' }],
  ])('refuses %s', async (_label, input) => {
    await expect(startBackgroundJob((await getWorkbench('wb'))!, input)).rejects.toBeInstanceOf(WorkbenchError);
    expect(startDurableExec).not.toHaveBeenCalled();
  });

  it('records a job that did not start as lost', async () => {
    startDurableExec.mockRejectedValueOnce(new Error('launcher exited 1'));
    runCapture.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', stdoutBytes: Buffer.alloc(0) });
    await expect(startBackgroundJob((await getWorkbench('wb'))!, { command: 'x' })).rejects.toThrow('launcher exited 1');
    const [row] = await testDb.db.select().from(workbenchBackgroundJobs);
    expect(row).toMatchObject({ status: 'lost' });
  });

  it('turns an exit into a wake-up with the log tail', async () => {
    await insertJob();
    const lines = Array.from({ length: 45 }, (_, i) => `line ${i}`);
    runCapture.mockResolvedValue(probeAnswer('exited', 3, lines.slice(-40)));
    await sweepBackground();
    expect(await getJob('job')).toMatchObject({ status: 'exited', exitCode: 3 });
    const [wakeup] = await testDb.db.select().from(workbenchWakeups);
    expect(wakeup).toMatchObject({ sourceJobId: 'job', status: 'fired', reason: 'Background job tests exited with code 3' });
    expect(wakeup.prompt).toContain('line 44');
    expect(wakeup.prompt).not.toContain('line 4\n');
    const [, input, opts] = vi.mocked(sendMessage).mock.calls[0];
    expect(input.text).toContain('exited with code 3 after');
    expect(input.text).toContain('line 5\nline 6');
    const trigger = (opts as { trigger: WorkbenchMessageTrigger }).trigger;
    expect(trigger).toEqual({ kind: 'job_exit', wakeupId: wakeup.id, reason: wakeup.reason, jobId: 'job', jobName: 'tests', exitCode: 3 });
    expect(messageTriggerText(trigger)).toBe('Background job tests exited with code 3');
    // A second pass finds nothing running and sends nothing more.
    await sweepBackground();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('records an exit without a wake-up when the agent did not ask', async () => {
    await insertJob({ notifyOnExit: false });
    runCapture.mockResolvedValue(probeAnswer('exited', 0));
    await sweepBackground();
    expect(await getJob('job')).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(await testDb.db.select().from(workbenchWakeups)).toHaveLength(0);
    expect(runCapture.mock.calls[0][2]?.env?.TALYN_TAIL_LINES).toBe('0');
  });

  it.each(['gone', 'missing'])('marks a job lost when the box says %s', async (state) => {
    await insertJob();
    runCapture.mockResolvedValue(probeAnswer(state));
    await sweepBackground();
    expect(await getJob('job')).toMatchObject({ status: 'lost', exitCode: null });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    // keep-awake, chat running, box state -> probes, wakes
    ['keep-awake on, idle chat, awake box', HOUR, 'idle', 'awake', 1, 0, 'running'],
    ['keep-awake ended, idle chat, awake box', -HOUR, 'idle', 'awake', 0, 0, 'idle'],
    ['no keep-awake, idle chat, awake box', null, 'idle', 'awake', 0, 0, 'idle'],
    ['keep-awake ended, a turn running', -HOUR, 'running', 'awake', 1, 0, 'running'],
    ['keep-awake on, asleep box', HOUR, 'idle', 'asleep', 1, 1, 'running'],
    ['keep-awake ended, asleep box, a turn running', -HOUR, 'running', 'asleep', 0, 0, 'skipped'],
  ] as const)('%s', async (_label, keep, chatStatus, box, probes, wakes, outcome) => {
    const job = await insertJob({ keepAwakeUntil: keep === null ? null : new Date(Date.now() + keep) });
    await testDb.db.update(workbenchChats).set({ status: chatStatus }).where(eq(workbenchChats.id, 'chat'));
    vi.mocked(chooseReadSource).mockResolvedValue(box === 'awake' ? { live: true } : { live: false, reason: 'asleep' });
    runCapture.mockResolvedValue(probeAnswer('running'));
    expect(await checkJob(job, new Map())).toBe(outcome);
    expect(runCapture).toHaveBeenCalledTimes(probes);
    expect(wakeWithCredentials).toHaveBeenCalledTimes(wakes);
    if (probes) expect((await getJob('job'))?.lastCheckedAt).not.toBeNull();
  });

  it('stops keeping a sleeping box awake when the box gate refuses', async () => {
    const job = await insertJob();
    vi.mocked(chooseReadSource).mockResolvedValue({ live: false, reason: 'asleep' });
    vi.mocked(existingBoxRefusal).mockResolvedValue({ message: 'Your box-hours ran out.' } as never);
    expect(await checkJob(job, new Map())).toBe('refused');
    expect(wakeWithCredentials).not.toHaveBeenCalled();
    expect(runCapture).not.toHaveBeenCalled();
    expect(await getJob('job')).toMatchObject({ status: 'running', keepAwakeUntil: null });
    expect((await getJob('job'))?.detail).toContain('Your box-hours ran out.');
  });

  it.each([
    ['a move', async () => markJobsLostAfterMove('wb', 'ws', 'box-2'), true],
    ['a new box found by the sweep', async () => {
      await testDb.db.update(workbenches).set({ sandboxId: 'box-2' }).where(eq(workbenches.id, 'wb'));
      await sweepBackground();
    }, false],
    ['a lost box', async () => {
      await testDb.db.update(workbenches).set({ sandboxState: 'lost' }).where(eq(workbenches.id, 'wb'));
      await sweepBackground();
    }, false],
    ['an archive', async () => {
      await testDb.db.update(workbenches).set({ archivedAt: new Date(), status: 'archived' }).where(eq(workbenches.id, 'wb'));
      await sweepBackground();
    }, false],
  ])('marks running jobs lost after %s', async (_label, act, moved) => {
    await insertJob();
    await insertJob({ id: 'new-box-job', sandboxId: 'box-2', durableKey: 'bg-2', marker: 'm-2' });
    runCapture.mockResolvedValue(probeAnswer('running'));
    await act();
    expect(await getJob('job')).toMatchObject({ status: 'lost' });
    if (moved) expect(await getJob('new-box-job')).toMatchObject({ status: 'running' });
  });

  it('stops a job by its process group', async () => {
    await insertJob();
    const job = await stopBackgroundJob((await getWorkbench('wb'))!, 'job');
    expect(killMarker).toHaveBeenCalledWith(expect.objectContaining({ id: 'wb' }), 'talyn-bg-job');
    expect(job).toMatchObject({ status: 'stopped' });
  });

  it('writes the exit prompt with a fence longer than any in the output', () => {
    const job = { id: 'j', name: 'build', command: 'make', startedAt: new Date(0) };
    const text = jobExitPrompt(job, 2, ['ok', '````', 'done'], new Date(65_000));
    expect(text).toContain('exited with code 2 after');
    expect(text).toContain('`````\nok\n````\ndone\n`````');
  });
});

describe('the probe script in a real process', () => {
  it.each([
    ['exits', 'printf "a\\nb\\n"; exit 4', { state: 'exited', code: 4, lines: ['a', 'b'] }],
    ['prints to stderr', 'echo out; echo err >&2', { state: 'exited', code: 0, lines: ['out', 'err'] }],
  ])('reads a job that %s', (_label, script, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'talyn-bg-'));
    const paths = { log: join(dir, 'job.log'), exit: join(dir, 'job.exit'), started: join(dir, 'job.started'), launchError: join(dir, 'err') };
    const env = { ...process.env, TALYN_LOG_PATHS: JSON.stringify(paths), TALYN_PID_FILE: join(dir, 'job.pid') };
    try {
      const run = spawnSync(process.execPath, ['-e', durable.DURABLE_SUPERVISOR], {
        env: { ...env, TALYN_DURABLE_SCRIPT: script, TALYN_SEGMENT_BYTES: String(8 * 1024 * 1024) }, encoding: 'utf8',
      });
      expect(run.status, run.stderr).toBe(0);
      const probe = spawnSync(process.execPath, ['-e', JOB_PROBE], {
        env: { ...env, TALYN_TAIL_LINES: '10', TALYN_TAIL_BYTES: '65536' }, encoding: 'utf8',
      });
      expect(probe.status, probe.stderr).toBe(0);
      const answer = JSON.parse(probe.stdout);
      expect(answer.state).toBe(expected.state);
      expect(answer.code).toBe(expected.code);
      expect([...answer.lines].sort()).toEqual([...expected.lines].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['no start marker', false, 'missing'],
    ['a start marker and a dead supervisor', true, 'gone'],
  ])('answers %s', (_label, started, state) => {
    const dir = mkdtempSync(join(tmpdir(), 'talyn-bg-'));
    const paths = { log: join(dir, 'job.log'), exit: join(dir, 'job.exit'), started: join(dir, 'job.started') };
    try {
      if (started) spawnSync('sh', ['-c', `printf 1 > ${paths.started}; printf 999999 > ${join(dir, 'job.pid')}`]);
      const probe = spawnSync(process.execPath, ['-e', JOB_PROBE], {
        env: { ...process.env, TALYN_LOG_PATHS: JSON.stringify(paths), TALYN_PID_FILE: join(dir, 'job.pid'), TALYN_TAIL_LINES: '5' },
        encoding: 'utf8',
      });
      expect(probe.status, probe.stderr).toBe(0);
      expect(JSON.parse(probe.stdout)).toEqual({ state, code: null, lines: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the flag and the projections', () => {
  const names = BACKGROUND.map((t) => t.name);
  const base = { workflows: true } as unknown as Features;

  it.each([
    [false, 0],
    [true, names.length],
  ])('lists the MCP tools only when the flag is %s', (on, count) => {
    const listed = listToolsFor({ ...base, sessionBackground: on }, { session: { tokenId: 't', workbenchId: 'wb', depth: 0 } });
    expect(listed.filter((t) => names.includes(t.name))).toHaveLength(count);
  });

  it.each([
    ['GET', '/:id/background', {}],
    ['POST', '/:id/background/jobs', { command: 'x' }],
    ['GET', '/:id/background/jobs/:jobId/logs', {}],
    ['POST', '/:id/background/jobs/:jobId/stop', {}],
    ['POST', '/:id/background/jobs/:jobId/keep-awake', { seconds: 60 }],
    ['POST', '/:id/wakeups', { delaySeconds: 60, reason: 'x' }],
    ['DELETE', '/:id/wakeups/:wakeupId', {}],
  ])('answers 404 for %s %s while the flag is off', async (method, path, body) => {
    vi.stubEnv('SESSION_BACKGROUND_ENABLED', 'false');
    resetFeatureFlagsForTests();
    const req = { params: { id: 'wb', jobId: 'job', wakeupId: 'wake' }, query: {}, body, user: { id: 'owner' } } as unknown as Request;
    const { status } = await invokeRoute(workbenchBackgroundRoutes(), method, path, req);
    expect(status).toBe(404);
  });

  it.each([
    ['owner', 200],
    ['mate', 404],
  ])('answers the background state to %s with %i', async (user, expected) => {
    await insertWakeup({ wakeAt: new Date(Date.now() + HOUR) });
    const req = { params: { id: 'wb' }, query: {}, user: { id: user } } as unknown as Request;
    const { status, body } = await invokeRoute<{ data?: { wakeups: unknown[] } }>(workbenchBackgroundRoutes(), 'GET', '/:id/background', req);
    expect(status).toBe(expected);
    if (expected === 200) expect(body.data?.wakeups).toHaveLength(1);
  });

  it.each([
    ['running jobs', () => runningJobsQuery('wb')],
    ['recent jobs', () => recentJobsQuery('wb')],
    ['scheduled wake-ups', () => scheduledWakeupsQuery('wb')],
    ['recent wake-ups', () => recentWakeupsQuery('wb')],
    ['due wake-ups', () => dueWakeupsQuery(new Date(), 10)],
  ])('the %s list selects no large or private column', (_label, query) => {
    const sql = query().toSQL().sql;
    expect(sql).not.toContain('"prompt"');
    expect(sql).not.toContain('"payer_user_id"');
    expect(sql).not.toContain('"durable_key"');
    if (sql.includes('"command"')) {
      expect(sql).toContain('left("command", 2000)');
      expect(sql).not.toMatch(/(^|[^(])"command"/);
    }
  });

  it('reads a trigger off a stored user-message event', () => {
    const trigger = { kind: 'wakeup', wakeupId: 'w', reason: 'Check CI', createdBy: 'agent' };
    expect(messageTrigger({ origin: 'talyn', trigger })).toEqual(trigger);
    expect(messageTrigger({ origin: 'talyn' })).toBeNull();
    expect(messageTrigger({ trigger: { kind: 'other' } })).toBeNull();
    expect(messageTriggerText(trigger as WorkbenchMessageTrigger)).toBe('Woke up: Check CI');
  });
});

describe('the system origin of a wake turn', () => {
  const trigger: WorkbenchMessageTrigger = { kind: 'wakeup', wakeupId: 'w', reason: 'Check CI', createdBy: 'agent' };

  it.each([
    ['a Talyn message', 'talyn', true],
    ['a person message', undefined, false],
  ] as const)('the transcript event of %s carries the trigger: %s', async (_label, origin, carries) => {
    const turns = await vi.importActual<typeof import('../services/workbenches/turns.js')>('../services/workbenches/turns.js');
    const event = turns.userMessageEvent({ id: 'm', text: 'Wake', queuedAt: new Date().toISOString(), trigger, ...(origin ? { origin } : {}) });
    expect(messageTrigger(event.talyn)).toEqual(carries ? trigger : null);
  });

  it('never takes a trigger from a request body', async () => {
    const turns = await vi.importActual<typeof import('../services/workbenches/turns.js')>('../services/workbenches/turns.js');
    const message = turns.normaliseMessage({ text: 'hi', trigger, origin: 'talyn' } as never);
    expect(message).not.toHaveProperty('trigger');
    expect(message).not.toHaveProperty('origin');
  });
});
