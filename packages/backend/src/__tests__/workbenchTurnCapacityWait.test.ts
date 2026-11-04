import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn } from './helpers/fakeFleet.js';
import { repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import {
  FleetCapacityError,
  FleetHttpError,
  FleetThrottleError,
  HIBERNATION_FETCH_FAILED,
} from '../services/selfHosted/client.js';

vi.mock('../services/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/github.js')>();
  return { ...actual, githubService: { ...actual.githubService, getVerifiedAccessToken: vi.fn(async () => 'gh-token') } };
});
vi.mock('../services/mcpServers/dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpServers/dispatch.js')>()),
  mcpIntegrationSecrets: vi.fn(async () => ({})),
}));

const { addFleetAccount, setFleetAccountUsage } = await import('../services/selfHosted/accounts.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const store = await import('../services/workbenches/store.js');
const { beginWorkbenchDrain, resetWorkbenchDrainForTests } = await import('../services/workbenches/ownership.js');
const { settleAgentBackupsForTests } = await import('../services/workbenches/agentBackups.js');
const { dropQueuedMessage, clearQueuedMessages } = await import('../services/workbenches/sessionOps.js');
const { PROVISION_CAPACITY_WAIT, WAITING_FOR_SANDBOX_MESSAGE, archiveWorkbench, settleArchivesForTests } =
  await import('../services/workbenches/lifecycle.js');
const {
  NO_FREE_SANDBOX_TURN_MESSAGE, SANDBOX_DID_NOT_WAKE_TURN_MESSAGE, WAKING_SANDBOX_MESSAGE, cancelTurn, isWaitingForSandbox, sendMessage, setTurnRetryDelaysForTests,
  startQueuedIfIdle, sweepOrphanedTurns,
} = await import('../services/workbenches/turns.js');

const DEFAULT_WAIT = { ...PROVISION_CAPACITY_WAIT };

type Refusal = () => Error;
const REFUSALS: Array<[string, Refusal]> = [
  ['a 503 with no room on the host', () => new FleetCapacityError('host out of memory', undefined, 'no_capacity')],
  ['an unreachable host', () => new FleetCapacityError('fleet unreachable', undefined, 'unreachable')],
  ['a 429 throttle', () => new FleetThrottleError('queue_depth: too many queued boxes')],
];
/** The fleet could not fetch the hibernated copy yet: the copy is intact, so the turn waits for the box to wake. */
const HIBERNATION_FETCH: Array<[string, Refusal]> = [
  ['a hibernation fetch 503', () => new FleetCapacityError('fetch failed', 30_000, 'no_capacity', HIBERNATION_FETCH_FAILED)],
  ['a hibernation fetch HTTP error', () => new FleetHttpError('fetch failed', 503, HIBERNATION_FETCH_FAILED)],
];

describe('a turn waits for a free sandbox', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  let agentRuns: number;
  /** While set, the exec that wakes the box (the turn-start checkpoint) is refused with it. */
  let refusal: Refusal | null;
  let wakeTries: number;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    resetWorkbenchDrainForTests();
    setTurnRetryDelaysForTests([0]);
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 60_000, firstDelayMs: 30, maxDelayMs: 30 });
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner' });
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Workspace' });
    await testDb.db.insert(repositories).values({
      id: 'repo', workspaceId: 'ws', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
    });
    const account = await addFleetAccount('ws', {
      kind: 'anthropic_key', label: 'First', credential: { keyEnc: encryptString('token-first') },
    });
    await setFleetAccountUsage(account.id, {
      fetchedAt: new Date().toISOString(),
      windows: [{ key: 'session', label: '5-hour', usedPercent: 1, resetsAt: null }],
    });
    await testDb.db.insert(workbenches).values({
      id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'acme/app', name: 'wb',
      branch: 'tom/test', baseBranch: 'main', runtime: 'sandbox', agent: 'claude',
      sandboxId: 'talyn-wb-test', sandboxState: 'running', status: 'ready', settings: { autoCreatePr: false },
    });
    await testDb.db.insert(workbenchChats).values({
      id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Test', agent: 'claude', turnCount: 0,
    });
    fleet = new FakeFleet();
    agentRuns = 0;
    wakeTries = 0;
    refusal = null;
    fleet.handler = (script) => {
      if (isAgentTurn(script)) {
        agentRuns++;
        return { stdout: claudeTurnLines('sess', 'done'), exitCode: 0 };
      }
      // The turn-start exec wakes the box: the checkpoint script, or just the disk probe on a fresh session.
      if (script.includes('git commit-tree') || script.includes('df -B1')) {
        wakeTries++;
        if (refusal) throw refusal();
        return { stdout: `${'c'.repeat(40)}\n` };
      }
      return { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    // Stop the turns and the retry timers from reaching a closed database.
    refusal = null;
    await vi.waitFor(async () => expect((await chat()).status).not.toBe('running'), { timeout: 5000 });
    await testDb.db.update(workbenchChats).set({ queuedMessages: [], drainPending: false });
    await settleAgentBackupsForTests();
    await settleArchivesForTests();
    setWorkbenchFleetClientForTests(null);
    setTurnRetryDelaysForTests(null);
    Object.assign(PROVISION_CAPACITY_WAIT, DEFAULT_WAIT);
    resetWorkbenchDrainForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  const chat = async () => (await store.getChat('chat'))!;
  const drainPending = async () =>
    (await testDb.db.select({ drainPending: workbenchChats.drainPending }).from(workbenchChats).where(eq(workbenchChats.id, 'chat')))[0].drainPending;
  const events = async () => (await store.listEvents('chat', 0, 200)).events;
  const userMessages = async () => (await events()).filter((e) => (e.event.talyn as { kind?: string } | undefined)?.kind === 'user_message');
  const results = async () => (await events()).filter((e) => e.event.type === 'result');
  const notes = async () => (await events()).filter((e) => e.event.subtype === 'sandbox_capacity_wait');

  /** The turn hit the refusal and its message waits at the head of the queue. */
  async function waiting(tries = 1) {
    await vi.waitFor(async () => {
      expect(wakeTries).toBeGreaterThanOrEqual(tries);
      const row = await chat();
      expect(isWaitingForSandbox(row)).toBe(true);
      expect(row.queuedMessages[0].capacityWait?.attempts).toBeGreaterThanOrEqual(tries);
    }, { timeout: 5000 });
  }

  async function settled(status: string) {
    await vi.waitFor(async () => {
      const row = await chat();
      expect(row.status).toBe(status);
      expect(row.queuedMessages).toEqual([]);
    }, { timeout: 5000 });
  }

  const pastRetry = async () => {
    await testDb.db.update(workbenchChats).set({
      queuedMessages: (await chat()).queuedMessages.map((m, i) =>
        i === 0 && m.capacityWait ? { ...m, capacityWait: { ...m.capacityWait, retryAt: new Date(0).toISOString() } } : m),
    }).where(eq(workbenchChats.id, 'chat'));
  };

  it.each([
    ...REFUSALS.map(([name, make]) => [name, make, 'idle', 'capacity', WAITING_FOR_SANDBOX_MESSAGE] as const),
    ...HIBERNATION_FETCH.map(([name, make]) => [name, make, 'suspended', 'waking', WAKING_SANDBOX_MESSAGE] as const),
    ['a 503 while the fleet restores the box', REFUSALS[0][1], 'starting', 'waking', WAKING_SANDBOX_MESSAGE] as const,
  ])('keeps the message queued on %s, then runs the turn when the box wakes', async (_name, make, boxStatus, reason, note) => {
    refusal = make;
    fleet.sandboxStatus = boxStatus;
    expect(await sendMessage('chat', { text: 'fix the build' })).toEqual({ queued: false });
    await waiting();

    const row = await chat();
    expect(row.status).toBe('idle');
    expect(row.turnCount).toBe(0);
    expect(await drainPending()).toBe(true);
    expect(row.queuedMessages).toEqual([
      expect.objectContaining({
        text: 'fix the build',
        capacityWait: expect.objectContaining({ turn: 1, attempts: expect.any(Number), reason }),
      }),
    ]);
    // The wait shows as one note in the transcript, never as a failed turn.
    expect((await notes()).map((e) => e.event.text)).toEqual([note]);
    expect(await results()).toEqual([]);
    expect(fleet.launches).toEqual([]);

    refusal = null;
    fleet.sandboxStatus = 'idle';
    await settled('idle');
    expect(agentRuns).toBe(1);
    expect((await chat()).turnCount).toBe(1);
    const users = await userMessages();
    expect(users).toHaveLength(1);
    expect(users[0].turn).toBe(1);
    expect((await notes())).toHaveLength(1);
    expect((await results()).map((e) => [e.turn, e.event.is_error])).toEqual([[1, false]]);
  });

  it('honours the fleet Retry-After over the backoff', async () => {
    refusal = () => new FleetCapacityError('host out of memory', 60_000, 'no_capacity');
    Object.assign(PROVISION_CAPACITY_WAIT, { maxDelayMs: 120_000 });
    await sendMessage('chat', { text: 'go' });
    await waiting();
    const retryAt = Date.parse((await chat()).queuedMessages[0].capacityWait!.retryAt);
    expect(retryAt - Date.now()).toBeGreaterThan(40_000);
    // Not due: neither the sweep nor a direct start runs it.
    expect(await sweepOrphanedTurns()).toBe(0);
    expect(await startQueuedIfIdle('chat')).toBe(false);
    expect(wakeTries).toBe(1);
  });

  it('writes a second note when the reason of the wait changes', async () => {
    refusal = REFUSALS[0][1];
    await sendMessage('chat', { text: 'go' });
    await waiting();
    fleet.sandboxStatus = 'starting';
    await waiting(3);
    expect((await chat()).queuedMessages[0].capacityWait?.reason).toBe('waking');
    fleet.sandboxStatus = 'idle';
    refusal = null;
    await settled('idle');
    expect((await notes()).map((e) => e.event.text)).toEqual([WAITING_FOR_SANDBOX_MESSAGE, WAKING_SANDBOX_MESSAGE]);
  });

  it.each([
    ['a size refusal', () => new FleetThrottleError('tenant_memory: 8192 MiB is over the limit')],
    ['another fleet error', () => new FleetHttpError('bad request', 400)],
  ] as Array<[string, Refusal]>)('does not wait on %s', async (_name, make) => {
    refusal = make;
    await sendMessage('chat', { text: 'go' });
    await vi.waitFor(async () => expect((await chat()).status).not.toBe('running'), { timeout: 5000 });
    expect(isWaitingForSandbox(await chat())).toBe(false);
    expect(await notes()).toEqual([]);
  });

  it.each([
    ['no room', REFUSALS[0][1], 'idle', NO_FREE_SANDBOX_TURN_MESSAGE],
    ['a box that does not wake', HIBERNATION_FETCH[0][1], 'suspended', SANDBOX_DID_NOT_WAKE_TURN_MESSAGE],
  ] as const)('fails the turn after the bound on %s', async (_name, make, boxStatus, wording) => {
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 150 });
    refusal = make;
    fleet.sandboxStatus = boxStatus;
    await sendMessage('chat', { text: 'go' });
    await vi.waitFor(async () => expect((await chat()).status).toBe('error'), { timeout: 5000 });
    const row = await chat();
    expect(row.statusMessage).toBe(wording);
    expect(row.queuedMessages).toEqual([]);
    expect(row.turnCount).toBe(1);
    expect(wakeTries).toBeGreaterThan(1);
    expect((await results()).map((e) => [e.turn, e.event.result])).toEqual([
      [1, `Talyn could not run this turn: ${wording}`],
    ]);
    expect(await userMessages()).toHaveLength(1);
    expect(agentRuns).toBe(0);
  });

  it('runs a message sent during the wait after the waiting one, in order', async () => {
    Object.assign(PROVISION_CAPACITY_WAIT, { firstDelayMs: 60_000, maxDelayMs: 60_000 });
    refusal = REFUSALS[0][1];
    await sendMessage('chat', { text: 'first' });
    await waiting();
    // A send does not cut the wait short: it queues behind the waiting message.
    expect(await sendMessage('chat', { text: 'second' })).toEqual({ queued: true });
    expect((await chat()).queuedMessages.map((m) => m.text)).toEqual(['first', 'second']);
    expect(wakeTries).toBe(1);
    refusal = null;
    await pastRetry();
    expect(await sweepOrphanedTurns()).toBe(0);
    await settled('idle');
    expect(agentRuns).toBe(2);
    expect((await userMessages()).map((e) => [e.turn, (e.event.message as { content: Array<{ text: string }> }).content[0].text]))
      .toEqual([[1, 'first'], [2, 'second']]);
  });

  describe('stopping the wait', () => {
    beforeEach(() => {
      // A long backoff, so nothing retries by itself during the test.
      Object.assign(PROVISION_CAPACITY_WAIT, { firstDelayMs: 60_000, maxDelayMs: 60_000 });
      refusal = REFUSALS[0][1];
    });

    async function expectStopped() {
      const row = await chat();
      expect(row.status).toBe('idle');
      expect(row.queuedMessages).toEqual([]);
      expect(await drainPending()).toBe(false);
      // The turn keeps its number, and ends as stopped: the next message takes a new turn.
      expect(row.turnCount).toBe(1);
      expect((await results()).map((e) => [e.turn, e.event.subtype])).toEqual([[1, 'cancelled']]);
      refusal = null;
      expect(await sweepOrphanedTurns()).toBe(0);
      expect(await startQueuedIfIdle('chat')).toBe(false);
      expect(agentRuns).toBe(0);
    }

    it('stops on a cancel', async () => {
      await sendMessage('chat', { text: 'go' });
      await waiting();
      await cancelTurn('chat');
      await expectStopped();
    });

    it('stops when the person removes the waiting message, and the next message takes its own turn', async () => {
      await sendMessage('chat', { text: 'go' });
      await waiting();
      const id = (await chat()).queuedMessages[0].id;
      await dropQueuedMessage('chat', id);
      await expectStopped();
      await sendMessage('chat', { text: 'again' });
      await settled('idle');
      expect((await userMessages()).map((e) => e.turn)).toEqual([1, 2]);
      expect(agentRuns).toBe(1);
    });

    it('stops when the queue is cleared', async () => {
      await sendMessage('chat', { text: 'go' });
      await waiting();
      await clearQueuedMessages(await chat());
      await expectStopped();
    });

    it('stops when the session is archived', async () => {
      await sendMessage('chat', { text: 'go' });
      await waiting();
      await archiveWorkbench('wb');
      await settleArchivesForTests();
      await vi.waitFor(async () => expect((await chat()).queuedMessages).toEqual([]), { timeout: 5000 });
      await expectStopped();
    });
  });

  it('leaves the message queued through a drain, and the next instance picks it up', async () => {
    refusal = REFUSALS[0][1];
    await sendMessage('chat', { text: 'go' });
    await waiting();
    beginWorkbenchDrain();
    refusal = null;
    await pastRetry();
    // This instance drains: its timer and its sweep start nothing.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await sweepOrphanedTurns()).toBe(0);
    expect(await startQueuedIfIdle('chat')).toBe(false);
    expect(isWaitingForSandbox(await chat())).toBe(true);
    expect(agentRuns).toBe(0);

    // The next instance: its sweep finds the queued chat.
    resetWorkbenchDrainForTests();
    await sweepOrphanedTurns();
    await settled('idle');
    expect(agentRuns).toBe(1);
    expect(await userMessages()).toHaveLength(1);
  });

  it('starts one try when the timer, the sweep and a start race for the same chat', async () => {
    Object.assign(PROVISION_CAPACITY_WAIT, { firstDelayMs: 60_000, maxDelayMs: 60_000 });
    refusal = REFUSALS[0][1];
    await sendMessage('chat', { text: 'go' });
    await waiting();
    refusal = null;
    await pastRetry();
    const started = await Promise.all([startQueuedIfIdle('chat'), startQueuedIfIdle('chat'), sweepOrphanedTurns()]);
    expect(started.filter((s) => s === true)).toHaveLength(1);
    await settled('idle');
    expect(agentRuns).toBe(1);
    expect(fleet.launches).toHaveLength(1);
  });

  it('runs a person\'s Retry message like any other message, also after a failed turn', async () => {
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 150 });
    refusal = REFUSALS[0][1];
    await sendMessage('chat', { text: 'go' });
    await vi.waitFor(async () => expect((await chat()).status).toBe('error'), { timeout: 5000 });
    refusal = null;
    const retry = `Continue from where you stopped. The last turn ended with an error: Talyn could not run this turn: ${NO_FREE_SANDBOX_TURN_MESSAGE}.`;
    expect(await sendMessage('chat', { text: retry })).toEqual({ queued: false });
    await settled('idle');
    expect(agentRuns).toBe(1);
    expect((await userMessages()).map((e) => e.turn)).toEqual([1, 2]);
  });

  it('never ends a turn with an error while it waits, so nothing offers or sends a retry', async () => {
    refusal = REFUSALS[2][1];
    await sendMessage('chat', { text: 'go' });
    await waiting(3);
    expect(await results()).toEqual([]);
    expect(await userMessages()).toHaveLength(1);
    expect((await chat()).turnCount).toBe(0);
  });

  it('does not chain turns after the bound: one error, and nothing starts after it', async () => {
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 150 });
    refusal = REFUSALS[0][1];
    await sendMessage('chat', { text: 'go' });
    await vi.waitFor(async () => expect((await chat()).status).toBe('error'), { timeout: 5000 });
    const tries = wakeTries;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await sweepOrphanedTurns()).toBe(0);
    expect(wakeTries).toBe(tries);
    expect(await userMessages()).toHaveLength(1);
    expect(await results()).toHaveLength(1);
  });
});
