import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workbench, WorkbenchStartProgress } from '@talyn/shared';
import { FakeFleet } from './helpers/fakeFleet.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workbenches, workspaces } from '../db/schema.js';
import { FleetCapacityError } from '../services/selfHosted/client.js';
import * as changes from '../services/workbenches/changes.js';
import * as emit from '../services/workbenches/emit.js';
import * as prLink from '../services/workbenches/prLink.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import * as sandboxSize from '../services/workbenches/sandboxSize.js';
import * as scripts from '../services/workbenches/scripts.js';
import * as warmPool from '../services/workbenches/warmPool.js';
import * as sandboxRun from '../services/selfHosted/sandboxRun.js';
import * as accountSelection from '../services/selfHosted/accountSelection.js';
import {
  PROVISION_CAPACITY_WAIT,
  PROVISION_PROGRESS,
  provisionWorkbench,
  WAITING_FOR_SANDBOX_MESSAGE,
} from '../services/workbenches/lifecycle.js';
import { getWorkbench, insertWorkbench } from '../services/workbenches/store.js';

const WB = 'wb-progress';
const BOX = runtime.sandboxIdFor(WB);
const DEFAULT_WAIT = { ...PROVISION_CAPACITY_WAIT };
const DEFAULT_PROGRESS = { ...PROVISION_PROGRESS };

const history = (layer: string) => [10_000, 20_000, 30_000].map((ready, i) => ({
  measuredAt: `2099-01-01T0${i}:00:00.000Z`, boxReadyMs: ready, checkoutMs: 1_000 * (i + 1), totalMs: 60_000 * (i + 1), layer,
}));

type CloneReply = { exitCode: number; stdout?: string; stderr?: string };

describe('a provision reports its start progress', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  let emitted: Workbench[];
  /** Runs inside the clone, with the line handler the provision passed. */
  let onClone: (onStderrLine: ((line: string) => void) | undefined) => Promise<CloneReply>;

  const progressOf = () => emitted.map((wb) => wb.startProgress ?? null);
  /** The steps in the order they were sent, from the first one, each change once. */
  const steps = () => {
    const all = progressOf().map((p) => (p ? `${p.step}:${p.stepIndex}/${p.stepCount}` : null));
    return all.slice(Math.max(0, all.findIndex((step) => step !== null)))
      .filter((step, i, list) => i === 0 || step !== list[i - 1]);
  };

  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
  });

  afterAll(async () => { await testDb.cleanup(); });

  beforeEach(async () => {
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 2_000, firstDelayMs: 5, maxDelayMs: 20, checkMs: 5, queuePollMs: 5 });
    Object.assign(PROVISION_PROGRESS, { emitMs: 40 });
    await testDb.db.delete(workbenches);
    await testDb.db.execute(sql`DELETE FROM workbench_maintenance_claims`);
    await testDb.db.update(repositories).set({ settings: {} as never });
    fleet = new FakeFleet();
    emitted = [];
    onClone = async () => ({ exitCode: 0, stdout: 'a'.repeat(40) });
    vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'test' }, githubToken: 'test' });
    vi.spyOn(accountSelection, 'resolveRunCredential')
      .mockImplementation(async (_workspaceId, agent) => agent === 'claude' ? { token: 'test' } : null);
    vi.spyOn(sandboxRun, 'resolveRepository').mockResolvedValue({ slug: 'o/r', defaultBranch: 'main' });
    vi.spyOn(sandboxRun, 'buildSandboxCreateBody').mockImplementation(async (input) => ({ ok: true, body: { id: input.id, workspaceId: input.workspaceId } }));
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client: fleet.asClient() });
    vi.spyOn(runtime, 'loadWorkbenchConfig').mockResolvedValue(null as never);
    vi.spyOn(sandboxSize, 'sizeForSession').mockResolvedValue('standard');
    vi.spyOn(prLink, 'linkPullRequest').mockImplementation(async (row) => row);
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (row) => row);
    vi.spyOn(warmPool, 'claimWarmBox').mockResolvedValue(null);
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (_row, script, opts) => {
      const reply = script.includes('git clone --filter=blob:none') ? await onClone(opts?.onStderrLine) : { exitCode: 0 };
      return { stdout: '', stderr: '', stdoutBytes: Buffer.from(''), ...reply } as never;
    });
    const emitUpdated = emit.emitWorkbenchUpdated;
    vi.spyOn(emit, 'emitWorkbenchUpdated').mockImplementation(async (wb) => {
      emitted.push(wb);
      return emitUpdated(wb);
    });
  });

  afterEach(() => {
    Object.assign(PROVISION_CAPACITY_WAIT, DEFAULT_WAIT);
    Object.assign(PROVISION_PROGRESS, DEFAULT_PROGRESS);
    vi.restoreAllMocks();
  });

  const insert = (over: Record<string, unknown> = {}) => insertWorkbench({
    id: WB, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', name: WB, branch: 'feat', baseBranch: 'main',
    runtime: 'sandbox', agent: 'claude', status: 'provisioning', statusMessage: 'Creating the sandbox',
    sandboxState: 'creating', sandboxId: BOX, ...over,
  } as never);

  it('goes through the box and the code, then clears the progress when ready', async () => {
    await insert();
    await provisionWorkbench(WB);
    expect(steps()).toEqual(['sandbox:0/3', 'code:1/3', null]);
    const sandbox = progressOf().find((p) => p?.step === 'sandbox')!;
    expect(sandbox).toMatchObject({ expectedMs: null, percent: null, detail: null });
    expect(Date.parse(sandbox.stepStartedAt)).not.toBeNaN();
    const row = await getWorkbench(WB);
    expect(row).toMatchObject({ status: 'ready', startProgress: null });
    expect(emitted.at(-1)!.startProgress).toBeNull();
  });

  it.each([
    ['a clone on the base image', 'base', { sandbox: 20_000, code: 2_000 }],
    ['history with no layer', null, { sandbox: 20_000, code: null }],
  ])('estimates each step from the repository history: %s', async (_name, layer, expected) => {
    await testDb.db.update(repositories).set({ settings: { setupTimingHistory: history(layer as string) } as never });
    await insert();
    await provisionWorkbench(WB);
    expect(progressOf().find((p) => p?.step === 'sandbox')?.expectedMs).toBe(expected.sandbox);
    expect(progressOf().find((p) => p?.step === 'code')?.expectedMs).toBe(expected.code);
  });

  it('runs the setup step with its own estimate', async () => {
    await testDb.db.update(repositories).set({ settings: { setupTimingHistory: history('base') } as never });
    vi.spyOn(runtime, 'loadWorkbenchConfig').mockResolvedValue({ setup: 'make' } as never);
    vi.spyOn(scripts, 'startScript').mockResolvedValue({ done: Promise.resolve(0) });
    await insert();
    await provisionWorkbench(WB);
    expect(steps()).toEqual(['sandbox:0/3', 'code:1/3', 'setup:2/3', null]);
    expect(progressOf().find((p) => p?.step === 'setup')).toMatchObject({ expectedMs: 120_000, percent: null });
    expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', startProgress: null });
  });

  it('sends git progress at most once per interval, never stores it, and drops it after the clone', async () => {
    const stored: unknown[] = [];
    onClone = async (onStderrLine) => {
      for (const line of ['Cloning into \'/work/r\'...', 'Receiving objects:  10% (1/10)', 'Receiving objects:  20% (2/10)', 'Receiving objects:  30% (3/10)']) {
        onStderrLine?.(line);
      }
      stored.push((await getWorkbench(WB))!.startProgress);
      await new Promise((resolve) => setTimeout(resolve, 100));
      onStderrLine?.('Receiving objects: 100% (10/10), done.');
      onStderrLine?.('Resolving deltas: 100% (5/5), done.');
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { exitCode: 0, stdout: 'b'.repeat(40) };
    };
    await insert();
    await provisionWorkbench(WB);
    const percents = progressOf().filter((p): p is WorkbenchStartProgress => p?.step === 'code' && p.percent !== null);
    // Four whole-percent changes, sent in two bursts: the first of each burst at once, the last after the interval.
    expect(percents.length).toBeGreaterThanOrEqual(2);
    expect(percents.length).toBeLessThanOrEqual(4);
    const values = percents.map((p) => p.percent!);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(values.every((v) => [17, 24, 31, 80, 95].includes(v))).toBe(true);
    expect(percents.at(-1)).toMatchObject({ percent: 95, detail: 'Resolving deltas' });
    expect(stored[0]).not.toHaveProperty('percent');
    expect(stored[0]).toMatchObject({ step: 'code', stepIndex: 1, stepCount: 3 });
    expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', startProgress: null });
  });

  it('fails with the git error and no progress lines, and clears the progress', async () => {
    onClone = async (onStderrLine) => {
      const stderr = [
        'Cloning into \'/work/r\'...',
        'Receiving objects:  40% (4/10)',
        'error: RPC failed; curl 92',
        'fatal: early EOF',
        'Receiving objects:  41% (4/10)',
      ];
      for (const line of stderr) onStderrLine?.(line);
      return { exitCode: 128, stderr: stderr.join('\n') };
    };
    await insert();
    await provisionWorkbench(WB);
    const row = await getWorkbench(WB);
    expect(row).toMatchObject({ status: 'error', startProgress: null });
    expect(row!.statusMessage).toBe(
      "Could not clone o/r and check out feat: Cloning into '/work/r'... error: RPC failed; curl 92 fatal: early EOF",
    );
    expect(emitted.at(-1)!.startProgress).toBeNull();
  });

  it('shows the wait for a free sandbox with no estimate', async () => {
    await testDb.db.update(repositories).set({ settings: { setupTimingHistory: history('repo') } as never });
    const create = fleet.createSandbox.bind(fleet);
    let attempt = 0;
    vi.spyOn(fleet, 'createSandbox').mockImplementation(async (input) => {
      if (attempt++ === 0) throw new FleetCapacityError('host full', undefined, 'no_capacity');
      return create(input);
    });
    await insert();
    await provisionWorkbench(WB);
    const waiting = emitted.find((wb) => wb.statusMessage === WAITING_FOR_SANDBOX_MESSAGE);
    expect(waiting?.startProgress).toMatchObject({ step: 'sandbox', stepIndex: 0, expectedMs: null });
    expect(progressOf().find((p) => p?.step === 'sandbox')?.expectedMs).toBe(20_000);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', startProgress: null });
  });

  it('skips the box step for a box from the warm pool', async () => {
    await insert();
    vi.spyOn(warmPool, 'claimWarmBox').mockResolvedValue({
      created: {
        ok: true, sandboxId: BOX, fleetHost: 'host-1', fleetSandboxId: null, size: 'standard',
        record: { status: 'idle' }, legacyUserStepIds: [], client: fleet.asClient(),
      },
      box: {} as never,
      fillMs: null,
    });
    vi.spyOn(warmPool, 'noteWarmStartReady').mockResolvedValue();
    await provisionWorkbench(WB);
    expect(steps()).toEqual(['code:1/3', null]);
  });

  it('gives a thread one step, the box', async () => {
    await insert({ kind: 'thread', repositoryId: null, repoFullName: '' });
    await provisionWorkbench(WB);
    expect(steps()).toEqual(['sandbox:0/1', null]);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', startProgress: null });
  });
});
