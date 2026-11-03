import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFleet } from './helpers/fakeFleet.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import * as changes from '../services/workbenches/changes.js';
import * as emit from '../services/workbenches/emit.js';
import * as prLink from '../services/workbenches/prLink.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import * as sandboxSize from '../services/workbenches/sandboxSize.js';
import * as sandboxRun from '../services/selfHosted/sandboxRun.js';
import { FleetCapacityError, FleetHttpError, HIBERNATION_FETCH_FAILED } from '../services/selfHosted/client.js';
import { beginWorkbenchDrain, resetWorkbenchDrainForTests } from '../services/workbenches/ownership.js';
import {
  capacityWaitDelayMs,
  NO_FREE_SANDBOX_MESSAGE,
  PROVISION_CAPACITY_WAIT,
  provisionClaimName,
  provisionWorkbench,
  WAITING_FOR_SANDBOX_MESSAGE,
} from '../services/workbenches/lifecycle.js';
import { getChat, getWorkbench, insertChat, insertWorkbench, listEvents, updateWorkbench } from '../services/workbenches/store.js';

const WB = 'wb-wait';
const CLAIM = provisionClaimName(WB);
const BOX = runtime.sandboxIdFor(WB);
const DEFAULT_WAIT = { ...PROVISION_CAPACITY_WAIT };

const busy = (reason: 'no_capacity' | 'unreachable' = 'no_capacity') =>
  new FleetCapacityError('host full at http://10.0.0.1', undefined, reason);

describe('a provision waits for a free sandbox', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  /** Status messages the provision emitted, in order. */
  let messages: Array<string | null>;

  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
  });

  afterAll(async () => { await testDb.cleanup(); });

  beforeEach(async () => {
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 2_000, firstDelayMs: 5, maxDelayMs: 20, checkMs: 5 });
    await testDb.db.delete(workbenches);
    await testDb.db.execute(sql`DELETE FROM workbench_maintenance_claims`);
    await insertWorkbench({
      id: WB, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', name: WB, branch: 'feat', baseBranch: 'main',
      runtime: 'sandbox', agent: 'claude', status: 'provisioning', statusMessage: 'Creating the sandbox',
      sandboxState: 'creating', sandboxId: BOX,
    });
    await insertChat({ id: 'chat', workbenchId: WB, workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    await testDb.db.update(workbenchChats).set({ queuedMessages: [{ id: 'm1', text: 'first prompt' }] as never });
    fleet = new FakeFleet();
    messages = [];
    vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'test' }, githubToken: 'test' });
    vi.spyOn(sandboxRun, 'resolveRepository').mockResolvedValue({ slug: 'o/r', defaultBranch: 'main' });
    vi.spyOn(sandboxRun, 'buildSandboxCreateBody').mockImplementation(async (input) => ({ ok: true, body: { id: input.id, workspaceId: input.workspaceId } }));
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client: fleet.asClient() });
    vi.spyOn(runtime, 'loadWorkbenchConfig').mockResolvedValue(null as never);
    vi.spyOn(sandboxSize, 'sizeForSession').mockResolvedValue('standard');
    vi.spyOn(prLink, 'linkPullRequest').mockImplementation(async (row) => row);
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (row) => row);
    vi.spyOn(runtime, 'runCapture').mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', stdoutBytes: Buffer.from('') } as never);
    const emitUpdated = emit.emitWorkbenchUpdated;
    vi.spyOn(emit, 'emitWorkbenchUpdated').mockImplementation(async (wb) => {
      messages.push(wb.statusMessage ?? null);
      return emitUpdated(wb);
    });
  });

  afterEach(() => {
    Object.assign(PROVISION_CAPACITY_WAIT, DEFAULT_WAIT);
    resetWorkbenchDrainForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The fleet answers each create from `script` in turn, then creates the box. */
  const fleetAnswers = (...script: Array<Error | ((attempt: number) => Promise<void> | void)>) => {
    const create = fleet.createSandbox.bind(fleet);
    let attempt = 0;
    return vi.spyOn(fleet, 'createSandbox').mockImplementation(async (input) => {
      const step = script[attempt++];
      if (step instanceof Error) throw step;
      if (step) await step(attempt);
      return create(input);
    });
  };
  /** A fleet that is always full, after running `during` on the given try. */
  const alwaysFull = (during?: { onAttempt: number; run: () => Promise<void> | void }) => {
    let attempt = 0;
    return vi.spyOn(fleet, 'createSandbox').mockImplementation(async () => {
      attempt++;
      if (during && attempt === during.onAttempt) await during.run();
      throw busy();
    });
  };
  const failureEvents = async () => (await listEvents('chat', 0, 50)).events
    .filter((e) => (e.event as { subtype?: string }).subtype === 'workbench_failed');
  const claims = async () =>
    (await testDb.db.execute(sql`SELECT name, token FROM workbench_maintenance_claims`)).rows as Array<{ name: string; token: string }>;

  it.each(['no_capacity', 'unreachable'] as const)('waits through a full fleet (%s) and ends ready', async (reason) => {
    const create = fleetAnswers(busy(reason), busy(reason));
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls.map(([input]) => input.id)).toEqual([BOX, BOX, BOX]);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', sandboxState: 'running', sandboxId: BOX, statusMessage: null });
    expect(messages).toContain(WAITING_FOR_SANDBOX_MESSAGE);
    expect(messages.filter((m) => m === WAITING_FOR_SANDBOX_MESSAGE)).toHaveLength(1);
    expect(await failureEvents()).toEqual([]);
    expect(await claims()).toEqual([]);
  });

  it('shows the waiting message on the row while it waits', async () => {
    let seen: string | null | undefined;
    fleetAnswers(busy(), async () => { seen = (await getWorkbench(WB))?.statusMessage; });
    await provisionWorkbench(WB);
    expect(seen).toBe(WAITING_FOR_SANDBOX_MESSAGE);
    expect((await getWorkbench(WB))?.status).toBe('ready');
  });

  it('fails with a clear message after the bound', async () => {
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 60 });
    const create = alwaysFull();
    await provisionWorkbench(WB);
    expect(create.mock.calls.length).toBeGreaterThan(1);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'error', sandboxState: 'error', statusMessage: NO_FREE_SANDBOX_MESSAGE });
    expect((await getChat('chat'))?.status).toBe('error');
    expect(await claims()).toEqual([]);
  });

  it('stops without a failure write when the backend drains during the wait', async () => {
    const create = alwaysFull({ onAttempt: 2, run: () => beginWorkbenchDrain() });
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(2);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning', statusMessage: WAITING_FOR_SANDBOX_MESSAGE });
    expect((await getChat('chat'))?.status).not.toBe('error');
    expect(await failureEvents()).toEqual([]);
    // The claim goes, so the next instance's sweep can resume the wait at once.
    expect(await claims()).toEqual([]);
  });

  it('stops without a failure write when the claim is lost during the wait', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    alwaysFull({
      onAttempt: 2,
      run: async () => {
        await testDb.db.execute(sql`UPDATE workbench_maintenance_claims SET token = 'other-instance' WHERE name = ${CLAIM}`);
        vi.advanceTimersByTime(20_000);
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    });
    await provisionWorkbench(WB);
    expect(await getWorkbench(WB)).toMatchObject({ status: 'provisioning' });
    expect((await getChat('chat'))?.status).not.toBe('error');
    expect(await failureEvents()).toEqual([]);
    expect(await claims()).toEqual([{ name: CLAIM, token: 'other-instance' }]);
  });

  it.each([
    ['archived', { status: 'archived', archivedAt: new Date() }],
    ['given a new sandbox id', { sandboxId: runtime.sandboxIdFor(WB, 1) }],
    ['failed', { status: 'error', statusMessage: 'boom' }],
  ] as const)('stops when the row is %s during the wait', async (_name, patch) => {
    const create = alwaysFull({ onAttempt: 1, run: async () => { await updateWorkbench(WB, patch); } });
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await getWorkbench(WB)).toMatchObject(patch);
    expect(await failureEvents()).toEqual([]);
  });

  it('stops when the row is archived between two tries', async () => {
    const create = alwaysFull({ onAttempt: 2, run: async () => { await updateWorkbench(WB, { status: 'archived', archivedAt: new Date() }); } });
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(2);
    expect((await getWorkbench(WB))?.status).toBe('archived');
    expect(await failureEvents()).toEqual([]);
  });

  it.each([
    ['a fleet refusal', new FleetHttpError('bad request', 400)],
    ['a plain fault', new Error('boom')],
    ['a hibernation fetch failure', new FleetCapacityError('fetch failed', undefined, 'no_capacity', HIBERNATION_FETCH_FAILED)],
  ])('fails at once on %s', async (_name, err) => {
    const create = fleetAnswers(err);
    await provisionWorkbench(WB);
    expect(create).toHaveBeenCalledTimes(1);
    const row = await getWorkbench(WB);
    expect(row?.status).toBe('error');
    expect(row?.statusMessage).not.toBe(WAITING_FOR_SANDBOX_MESSAGE);
    expect(messages).not.toContain(WAITING_FOR_SANDBOX_MESSAGE);
  });

  describe('capacityWaitDelayMs', () => {
    beforeEach(() => { Object.assign(PROVISION_CAPACITY_WAIT, DEFAULT_WAIT); });

    it.each([
      [0, undefined, 10_000],
      [1, undefined, 20_000],
      [2, undefined, 40_000],
      [3, undefined, 60_000],
      [10, undefined, 60_000],
      [100, undefined, 60_000],
      [0, 30_000, 30_000],
      [0, 5_000, 10_000],
      [0, 600_000, 60_000],
    ])('attempt %i with Retry-After %s waits about %i ms', (attempt, retryAfter, expected) => {
      expect(capacityWaitDelayMs(attempt, retryAfter, () => 0.5)).toBe(expected);
    });

    it.each([[0, 0.8], [0.999999, 1.2]])('jitter at random %f stays within 20 percent', (random, factor) => {
      expect(capacityWaitDelayMs(0, undefined, () => random)).toBeCloseTo(10_000 * factor, -1);
    });
  });
});
