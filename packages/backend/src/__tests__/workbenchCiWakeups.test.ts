import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ciWakeupOutcomeLabel, messageTriggerText, type CiWakeupOutcome } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  prCheckStates,
  pullRequests,
  repositories,
  workbenchChats,
  workbenches,
  workbenchWakeups,
  workspaces,
} from '../db/schema.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { scheduleWakeup } from '../services/workbenches/background.js';
import { getWakeup, scheduledCiWakeups } from '../services/workbenches/backgroundStore.js';
import { onPrChecksForWakeups, sweepBackground } from '../services/workbenches/backgroundSweep.js';
import { ciWakeupPrompt, decideCiWakeup, type CiWakeupFacts } from '../services/workbenches/ciWakeups.js';
import { getWorkbench } from '../services/workbenches/store.js';
import { WorkbenchError } from '../services/workbenches/errors.js';
import { sendMessage } from '../services/workbenches/turns.js';

vi.mock('../services/workbenches/turns.js', () => ({
  sendMessage: vi.fn(async () => ({ queued: false })),
}));
vi.mock('../services/workbenches/boxGate.js', () => ({ existingBoxRefusal: vi.fn(async () => null) }));
vi.mock('../services/workbenches/emit.js', () => ({
  emitWorkbenchBackground: vi.fn(),
  emitWorkbenchChat: vi.fn(),
  emitWorkbenchEvents: vi.fn(),
  emitWorkbenchUpdated: vi.fn(async () => undefined),
}));

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const HOUR = 60 * 60_000;

let testDb: Awaited<ReturnType<typeof createTestDb>>;

async function setPr(values: Partial<typeof pullRequests.$inferInsert>) {
  await testDb.db.update(pullRequests).set(values).where(eq(pullRequests.id, 'pr'));
}

async function setHead(headSha: string | null) {
  await setPr({ lastSummary: headSha ? { headSha } : {} } as Partial<typeof pullRequests.$inferInsert>);
}

async function ledger(headSha: string, checks: Array<[string, string, boolean?]>) {
  await testDb.db.delete(prCheckStates).where(eq(prCheckStates.headSha, headSha));
  if (checks.length === 0) return;
  await testDb.db.insert(prCheckStates).values(checks.map(([name, state, required]) => ({
    id: `${headSha.slice(0, 4)}-${name}`, repoFullName: 'acme/web', headSha, name, source: 'check_run', state,
    required: required ?? null,
  })));
}

async function scheduleCi(extra: Record<string, unknown> = {}) {
  const row = (await getWorkbench('wb'))!;
  return scheduleWakeup(row, { reason: 'Read CI', untilCi: true, headSha: SHA_A, ...extra }, 'agent');
}

async function insertCiWakeup(values: Partial<typeof workbenchWakeups.$inferInsert> = {}) {
  await testDb.db.insert(workbenchWakeups).values({
    id: 'ci-wake', workbenchId: 'wb', chatId: 'chat', workspaceId: 'ws', wakeAt: new Date(Date.now() + HOUR),
    reason: 'Read CI', ciPullRequestId: 'pr', ciHeadSha: SHA_A, ciPrHeadAtSchedule: SHA_A, ...values,
  });
}

function sentTurn() {
  expect(sendMessage).toHaveBeenCalledTimes(1);
  const [chatId, input, opts] = vi.mocked(sendMessage).mock.calls[0];
  return { chatId, text: input.text, opts };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('WORKBENCHES_ENABLED', 'true');
  vi.stubEnv('SESSION_CI_WAIT_ENABLED', 'true');
  resetFeatureFlagsForTests();
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: 'owner' });
  await testDb.db.insert(workspaces).values({ id: 'ws', name: 'Workspace', ownerId: 'owner' });
  await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'acme/web', url: 'https://github.com/acme/web', defaultBranch: 'main' });
  await testDb.db.insert(pullRequests).values({
    id: 'pr', workspaceId: 'ws', repositoryId: 'repo', owner: 'acme', repo: 'web', number: 42, state: 'open',
    lastSummary: { headSha: SHA_A } as never,
  });
  await testDb.db.insert(workbenches).values({
    id: 'wb', workspaceId: 'ws', repoFullName: 'acme/web', branch: 'b', baseBranch: 'main', name: 'Session',
    runtime: 'sandbox', agent: 'claude', status: 'ready', sandboxId: 'box', sandboxState: 'running', pullRequestId: 'pr',
  });
  await testDb.db.insert(workbenchChats).values({
    id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude', status: 'idle',
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetFeatureFlagsForTests();
  await testDb.cleanup();
});

describe('decideCiWakeup', () => {
  const base: CiWakeupFacts = {
    ciHeadSha: SHA_A, ciPrHeadAtSchedule: SHA_C, prState: 'open', prHeadSha: SHA_A, owner: 'acme', repo: 'web',
  };
  it.each<[string, Partial<CiWakeupFacts>, ReturnType<typeof decideCiWakeup>]>([
    ['reads CI on the head it waits for', {}, { kind: 'check_ci', repoFullName: 'acme/web', headSha: SHA_A }],
    ['fires on a merge', { prState: 'merged' }, { kind: 'fire', outcome: { kind: 'merged' } }],
    ['fires on a close', { prState: 'closed' }, { kind: 'fire', outcome: { kind: 'closed' } }],
    ['waits when the pull request is gone', { prState: null }, { kind: 'wait' }],
    ['fires when somebody pushed', { prHeadSha: SHA_B }, { kind: 'fire', outcome: { kind: 'head_moved', headSha: SHA_B } }],
    ['reads CI while the row still has the head from before the push', { prHeadSha: SHA_C }, { kind: 'check_ci', repoFullName: 'acme/web', headSha: SHA_A }],
    ['reads CI when the row has no head', { prHeadSha: null }, { kind: 'check_ci', repoFullName: 'acme/web', headSha: SHA_A }],
    ['matches a head in another case', { prHeadSha: SHA_A.toUpperCase() }, { kind: 'check_ci', repoFullName: 'acme/web', headSha: SHA_A }],
    ['waits with no repository to read', { owner: null }, { kind: 'wait' }],
  ])('%s', (_name, patch, expected) => {
    expect(decideCiWakeup({ ...base, ...patch })).toEqual(expected);
  });
});

describe('ciWakeupPrompt', () => {
  it.each<[CiWakeupOutcome, string[]]>([
    [{ kind: 'passing' }, ['CI finished on aaaaaaaaaaaa of acme/web#42, and no required check failed.']],
    [{ kind: 'failing', checks: ['lint', 'test'] }, ['These required checks failed: `lint`, `test`.']],
    [{ kind: 'failing', checks: [] }, ['some checks failed']],
    [{ kind: 'head_moved', headSha: SHA_B }, ['moved from aaaaaaaaaaaa to bbbbbbbbbbbb', 'schedule a new CI wake-up']],
    [{ kind: 'timed_out' }, ['did not finish before the wake-up\'s time']],
    [{ kind: 'merged' }, ['acme/web#42 merged while you waited for CI.']],
    [{ kind: 'closed' }, ['acme/web#42 closed while you waited for CI.']],
  ])('%j', (outcome, parts) => {
    const text = ciWakeupPrompt({
      reason: 'Read CI', createdBy: 'agent', createdAt: new Date('2026-11-11T10:00:00Z'), ref: 'acme/web#42', headSha: SHA_A, outcome,
    });
    expect(text.split('\n')[0]).toBe('[Talyn] CI wake-up you scheduled at 2026-11-11T10:00:00.000Z: Read CI');
    for (const part of parts) expect(text).toContain(part);
  });

  it('names the person for their own wake-up', () => {
    const text = ciWakeupPrompt({
      reason: 'r', createdBy: 'user', createdAt: new Date(0), ref: 'the pull request', headSha: SHA_A, outcome: { kind: 'passing' },
    });
    expect(text).toContain('CI wake-up the person scheduled');
  });
});

describe('the trigger line', () => {
  it.each<[CiWakeupOutcome['kind'] | undefined, string]>([
    [undefined, 'Woke up: Read CI'],
    ['passing', 'CI passed: Read CI'],
    ['failing', 'CI failed: Read CI'],
    ['head_moved', 'The PR head moved: Read CI'],
    ['timed_out', 'CI did not finish in time: Read CI'],
    ['merged', 'The PR merged: Read CI'],
    ['closed', 'The PR closed: Read CI'],
  ])('%s', (ci, expected) => {
    expect(messageTriggerText({ kind: 'wakeup', wakeupId: 'w', reason: 'Read CI', createdBy: 'agent', ...(ci ? { ci } : {}) })).toBe(expected);
    if (ci) expect(ciWakeupOutcomeLabel(ci)).toBe(expected.replace(': Read CI', ''));
  });
});

describe('scheduling a CI wake-up', () => {
  it('waits on the commit given, three hours at the latest', async () => {
    const before = Date.now();
    const wakeup = await scheduleCi();
    expect(wakeup.ci).toEqual({ pullRequestId: 'pr', headSha: SHA_A });
    const wakeAt = Date.parse(wakeup.wakeAt);
    expect(wakeAt).toBeGreaterThanOrEqual(before + 3 * HOUR - 1000);
    expect(wakeAt).toBeLessThanOrEqual(Date.now() + 3 * HOUR + 1000);
    expect(await getWakeup(wakeup.id)).toMatchObject({ ciPrHeadAtSchedule: SHA_A });
  });

  it('defaults to the head Talyn knows, and keeps a time it is given', async () => {
    await setHead(SHA_B);
    const before = Date.now();
    const wakeup = await scheduleCi({ headSha: undefined, delaySeconds: 600 });
    expect(wakeup.ci?.headSha).toBe(SHA_B);
    expect(Date.parse(wakeup.wakeAt) - before).toBeLessThan(601_000);
  });

  it('stores a full sha in lower case', async () => {
    const wakeup = await scheduleCi({ headSha: SHA_A.toUpperCase() });
    expect(wakeup.ci?.headSha).toBe(SHA_A);
  });

  it('replaces an earlier CI wake-up in the chat, and leaves a timed one', async () => {
    const row = (await getWorkbench('wb'))!;
    const timed = await scheduleWakeup(row, { reason: 'Deploy', delaySeconds: 60 }, 'agent');
    const first = await scheduleCi();
    const second = await scheduleCi({ headSha: SHA_B });
    expect(await getWakeup(first.id)).toMatchObject({ status: 'cancelled', failureDetail: 'Replaced by a newer CI wake-up.' });
    expect(await getWakeup(second.id)).toMatchObject({ status: 'scheduled' });
    expect(await getWakeup(timed.id)).toMatchObject({ status: 'scheduled' });
  });

  it.each<[string, () => Promise<void>, Record<string, unknown>, number, string]>([
    ['the flag is off', async () => { vi.stubEnv('SESSION_CI_WAIT_ENABLED', 'false'); resetFeatureFlagsForTests(); }, {}, 403, 'ci_wait_unavailable'],
    ['the session has no pull request', async () => { await testDb.db.update(workbenches).set({ pullRequestId: null }).where(eq(workbenches.id, 'wb')); }, {}, 409, 'no_pull_request'],
    ['the pull request merged', async () => { await setPr({ state: 'merged' }); }, {}, 409, 'pull_request_not_open'],
    ['the pull request closed', async () => { await setPr({ state: 'closed' }); }, {}, 409, 'pull_request_not_open'],
    ['no head is known', async () => { await setHead(null); }, { headSha: undefined }, 409, 'no_head_sha'],
    ['the sha is short', async () => {}, { headSha: 'abc1234' }, 400, 'bad_request'],
    ['the sha is not hex', async () => {}, { headSha: 'z'.repeat(40) }, 400, 'bad_request'],
    ['the sha is not a string', async () => {}, { headSha: 42 }, 400, 'bad_request'],
    ['both times are given', async () => {}, { delaySeconds: 60, at: new Date(Date.now() + HOUR).toISOString() }, 400, 'bad_request'],
    ['the time is in the past', async () => {}, { delaySeconds: 0 }, 400, 'wakeup_in_past'],
    ['untilCi is not a boolean', async () => {}, { untilCi: 'yes', delaySeconds: 60 }, 400, 'bad_request'],
    ['headSha comes without untilCi', async () => {}, { untilCi: false, delaySeconds: 60 }, 400, 'bad_request'],
  ])('refuses when %s', async (_name, arrange, extra, status, code) => {
    await arrange();
    const err = await scheduleCi(extra).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkbenchError);
    expect(err).toMatchObject({ status, code });
    expect(await scheduledCiWakeups({ limit: 10 })).toEqual([]);
  });
});

describe('firing a CI wake-up', () => {
  it('waits while checks run', async () => {
    await insertCiWakeup();
    await ledger(SHA_A, [['lint', 'success'], ['test', 'in_progress']]);
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await getWakeup('ci-wake')).toMatchObject({ status: 'scheduled' });
  });

  it('waits while no check has reported', async () => {
    await insertCiWakeup();
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends the turn when every check passed', async () => {
    await insertCiWakeup();
    await ledger(SHA_A, [['lint', 'success'], ['test', 'success'], ['docs', 'skipped']]);
    await sweepBackground();
    const { chatId, text, opts } = sentTurn();
    expect(chatId).toBe('chat');
    expect(text).toContain('CI finished on aaaaaaaaaaaa of acme/web#42, and no required check failed.');
    expect(opts).toMatchObject({ origin: 'talyn', trigger: { kind: 'wakeup', wakeupId: 'ci-wake', ci: 'passing' } });
    expect(await getWakeup('ci-wake')).toMatchObject({ status: 'fired' });
  });

  it('names the required checks that failed', async () => {
    await insertCiWakeup();
    await ledger(SHA_A, [['lint', 'failure', true], ['flaky', 'failure', false], ['test', 'success']]);
    await sweepBackground();
    const { text, opts } = sentTurn();
    expect(text).toContain('These required checks failed: `lint`.');
    expect(opts).toMatchObject({ trigger: { ci: 'failing' } });
  });

  it('does not fire while the chat runs a turn', async () => {
    await insertCiWakeup();
    await ledger(SHA_A, [['test', 'success']]);
    await testDb.db.update(workbenchChats).set({ status: 'running' }).where(eq(workbenchChats.id, 'chat'));
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
    await testDb.db.update(workbenchChats).set({ status: 'idle' }).where(eq(workbenchChats.id, 'chat'));
    await sweepBackground();
    expect(sentTurn().opts).toMatchObject({ trigger: { ci: 'passing' } });
  });

  it('fires when somebody pushed', async () => {
    await insertCiWakeup();
    await setHead(SHA_B);
    await sweepBackground();
    const { text, opts } = sentTurn();
    expect(text).toContain('moved from aaaaaaaaaaaa to bbbbbbbbbbbb');
    expect(opts).toMatchObject({ trigger: { ci: 'head_moved' } });
  });

  it('keeps waiting while the row has the head from before the push', async () => {
    await insertCiWakeup({ ciPrHeadAtSchedule: SHA_C });
    await setHead(SHA_C);
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
    await ledger(SHA_A, [['test', 'success']]);
    await sweepBackground();
    expect(sentTurn().opts).toMatchObject({ trigger: { ci: 'passing' } });
  });

  it.each([['merged'], ['closed']] as const)('fires when the pull request %s', async (state) => {
    await insertCiWakeup();
    await setPr({ state });
    await sweepBackground();
    const { text, opts } = sentTurn();
    expect(text).toContain(`acme/web#42 ${state} while you waited for CI.`);
    expect(opts).toMatchObject({ trigger: { ci: state } });
  });

  it('reports a timeout when its time comes first', async () => {
    await insertCiWakeup({ wakeAt: new Date(Date.now() - 1000) });
    await ledger(SHA_A, [['test', 'pending']]);
    await sweepBackground();
    const { text, opts } = sentTurn();
    expect(text).toContain('did not finish before the wake-up\'s time');
    expect(opts).toMatchObject({ trigger: { ci: 'timed_out' } });
  });

  it('reports a settled result when its time comes, even while the chat runs', async () => {
    await insertCiWakeup({ wakeAt: new Date(Date.now() - 1000) });
    await ledger(SHA_A, [['test', 'failure', true]]);
    await testDb.db.update(workbenchChats).set({ status: 'running' }).where(eq(workbenchChats.id, 'chat'));
    await sweepBackground();
    expect(sentTurn().opts).toMatchObject({ trigger: { ci: 'failing' } });
  });

  it('sends one turn when the listener and the sweep race', async () => {
    await insertCiWakeup();
    await ledger(SHA_A, [['test', 'success']]);
    const evt = { prs: [{ prId: 'pr', workspaceId: 'ws', repositoryId: 'repo', number: 42 }], repoFullName: 'acme/web', headSha: SHA_A, checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 } } as never;
    await Promise.all([onPrChecksForWakeups(evt), onPrChecksForWakeups(evt), sweepBackground()]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('the listener only reads the pull requests a flush touched', async () => {
    await insertCiWakeup();
    await ledger(SHA_A, [['test', 'success']]);
    const other = { prs: [{ prId: 'other', workspaceId: 'ws', repositoryId: 'repo', number: 7 }], repoFullName: 'acme/web', headSha: SHA_A, checks: {} } as never;
    expect(await onPrChecksForWakeups(other)).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
    const ours = { prs: [{ prId: 'pr', workspaceId: 'ws', repositoryId: 'repo', number: 42 }], repoFullName: 'acme/web', headSha: SHA_A, checks: {} } as never;
    expect(await onPrChecksForWakeups(ours)).toBe(1);
  });

  it('a timed wake-up is not touched by the CI paths', async () => {
    await testDb.db.insert(workbenchWakeups).values({
      id: 'timed', workbenchId: 'wb', chatId: 'chat', workspaceId: 'ws', wakeAt: new Date(Date.now() + HOUR), reason: 'Deploy',
    });
    await ledger(SHA_A, [['test', 'success']]);
    await sweepBackground();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(await scheduledCiWakeups({ limit: 10 })).toEqual([]);
  });
});
