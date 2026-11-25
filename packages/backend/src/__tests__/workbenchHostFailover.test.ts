import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn } from './helpers/fakeFleet.js';
import { repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import {
  FleetCapacityError,
  FleetDispatchUncertainError,
  FleetHttpError,
  HOST_SILENT,
  HOST_UNRESPONSIVE,
} from '../services/selfHosted/client.js';

vi.mock('../services/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/github.js')>();
  return { ...actual, githubService: { ...actual.githubService, getVerifiedAccessToken: vi.fn(async () => 'gh-token') } };
});
vi.mock('../services/mcpServers/dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpServers/dispatch.js')>()),
  mcpIntegrationSecrets: vi.fn(async () => ({})),
}));
// Recovery starts the new box's provision. The tests end the provision themselves.
vi.mock('../services/workbenches/lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/lifecycle.js')>()),
  scheduleProvision: vi.fn(),
}));

const { addFleetAccount, setFleetAccountUsage } = await import('../services/selfHosted/accounts.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const store = await import('../services/workbenches/store.js');
const { resetWorkbenchDrainForTests } = await import('../services/workbenches/ownership.js');
const { settleAgentBackupsForTests } = await import('../services/workbenches/agentBackups.js');
const { PROVISION_CAPACITY_WAIT, scheduleProvision, settleArchivesForTests } = await import('../services/workbenches/lifecycle.js');
const { NO_FREE_SANDBOX_TURN_MESSAGE, isWaitingForSandbox, sendMessage, setTurnRetryDelaysForTests, startQueuedIfIdle } =
  await import('../services/workbenches/turns.js');
const { HOST_FAILOVER, hostFailoverNote } = await import('../services/workbenches/hostFailover.js');
const { SANDBOX_HOST_FAILOVER_MESSAGE, resetLostRecoveryForTests } = await import('../services/workbenches/recovery.js');

const DEFAULT_WAIT = { ...PROVISION_CAPACITY_WAIT };
const DEFAULT_FAILOVER = { ...HOST_FAILOVER };
const OLD_BOX = 'talyn-wb-test';

type Refusal = () => Error;
const timeout: Refusal = () =>
  new FleetCapacityError('Fleet unreachable at https://fleet: The operation was aborted due to timeout', undefined, 'unreachable', undefined, true);
/** Answers that say the box's host does not answer. A timeout counts while the fleet API answers. */
const SILENT_HOST: Array<[string, Refusal]> = [
  ['a 503 host_unresponsive', () => new FleetCapacityError('host coder-1 does not answer', 5_000, 'no_capacity', HOST_UNRESPONSIVE)],
  ['a 504 host_silent', () => new FleetDispatchUncertainError('the host never answered', HOST_SILENT)],
  ['a host_silent HTTP error', () => new FleetHttpError('the host never answered', 504, HOST_SILENT)],
  ['a client timeout while the fleet API answers', timeout],
];
/** Refusals that never fail over: the host answers, or nothing says which part is silent. */
const ANSWERING: Array<[string, Refusal]> = [
  ['a 503 with no room on the host', () => new FleetCapacityError('host out of memory', undefined, 'no_capacity')],
  ['a dial error', () => new FleetCapacityError('fleet unreachable', undefined, 'unreachable', 'host_unreachable')],
];

describe('a turn fails over from a box whose host does not answer', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  let agentRuns: number;
  /** While set, the exec that wakes the box (the turn-start checkpoint) is refused with it. */
  let refusal: Refusal | null;
  let wakeTries: number;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    resetWorkbenchDrainForTests();
    resetLostRecoveryForTests();
    setTurnRetryDelaysForTests([0]);
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 60_000, firstDelayMs: 30, maxDelayMs: 30 });
    Object.assign(HOST_FAILOVER, { silentForMs: 150 });
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
      sandboxId: OLD_BOX, sandboxState: 'running', status: 'ready', settings: { autoCreatePr: false },
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
      if (script.includes('git commit-tree') || script.includes('df -B1')) {
        wakeTries++;
        if (refusal) throw refusal();
        return { stdout: `${'c'.repeat(40)}\n` };
      }
      return { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    vi.mocked(scheduleProvision).mockClear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    refusal = null;
    await vi.waitFor(async () => expect((await chat()).status).not.toBe('running'), { timeout: 5000 });
    await testDb.db.update(workbenchChats).set({ queuedMessages: [], drainPending: false });
    await settleAgentBackupsForTests();
    await settleArchivesForTests();
    setWorkbenchFleetClientForTests(null);
    setTurnRetryDelaysForTests(null);
    Object.assign(PROVISION_CAPACITY_WAIT, DEFAULT_WAIT);
    Object.assign(HOST_FAILOVER, DEFAULT_FAILOVER);
    resetWorkbenchDrainForTests();
    resetLostRecoveryForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  const chat = async () => (await store.getChat('chat'))!;
  const workbench = async () => (await store.getWorkbench('wb'))!;
  const events = async () => (await store.listEvents('chat', 0, 200)).events;
  const userMessages = async () => (await events()).filter((e) => (e.event.talyn as { kind?: string } | undefined)?.kind === 'user_message');
  const results = async () => (await events()).filter((e) => e.event.type === 'result');
  const failoverNotes = async () => (await events()).filter((e) => e.event.subtype === 'sandbox_host_failover');

  /** The turn waits for its box, after at least `tries` refusals. */
  async function waiting(tries = 1) {
    await vi.waitFor(async () => {
      expect(wakeTries).toBeGreaterThanOrEqual(tries);
      const row = await chat();
      expect(isWaitingForSandbox(row)).toBe(true);
      expect(row.queuedMessages[0].capacityWait?.attempts).toBeGreaterThanOrEqual(tries);
    }, { timeout: 5000 });
  }

  /** Recovery claimed the box, and the message waits for the new box. */
  async function failedOver() {
    await vi.waitFor(async () => {
      expect((await workbench()).status).toBe('provisioning');
      const row = await chat();
      expect(row.status).toBe('idle');
      expect(row.queuedMessages).toHaveLength(1);
      expect(row.queuedMessages[0].capacityWait).toBeUndefined();
    }, { timeout: 5000 });
  }

  /** What the provision does when the new box is up: the session is ready, and the queue drains. */
  async function provisionEnds() {
    await testDb.db.update(workbenches).set({ status: 'ready', sandboxState: 'running', statusMessage: null }).where(eq(workbenches.id, 'wb'));
    return startQueuedIfIdle('chat');
  }

  it.each(SILENT_HOST)('replaces the box after the bound on %s, and runs the message once on the new box', async (_name, make) => {
    refusal = make;
    await sendMessage('chat', { text: 'fix the build' });
    await failedOver();

    const wb = await workbench();
    expect(wb).toMatchObject({ sandboxState: 'lost', statusMessage: SANDBOX_HOST_FAILOVER_MESSAGE });
    expect(wb.sandboxId).not.toBe(OLD_BOX);
    // The old box stays for an operator.
    expect(wb.settings?.keptSandboxIds).toEqual([OLD_BOX]);
    expect(fleet.deleted).toEqual([]);
    expect(scheduleProvision).toHaveBeenCalledTimes(1);
    // At least two silent answers: the first starts the bound, a later one ends it.
    expect(wakeTries).toBeGreaterThanOrEqual(2);

    const row = await chat();
    expect(row.turnCount).toBe(0);
    expect(row.statusMessage).toBeNull();
    expect(row.queuedMessages[0]).toMatchObject({ text: 'fix the build' });
    expect((await failoverNotes()).map((e) => [e.turn, e.event.text])).toEqual([[1, hostFailoverNote(null)]]);
    expect(await results()).toEqual([]);
    expect(agentRuns).toBe(0);
    // The new box is still provisioning: nothing starts yet.
    expect(await startQueuedIfIdle('chat')).toBe(false);

    refusal = null;
    expect(await provisionEnds()).toBe(true);
    await vi.waitFor(async () => {
      const after = await chat();
      expect(after.status).toBe('idle');
      expect(after.queuedMessages).toEqual([]);
    }, { timeout: 5000 });
    expect(agentRuns).toBe(1);
    expect((await chat()).turnCount).toBe(1);
    expect((await userMessages()).map((e) => e.turn)).toEqual([1]);
    expect((await results()).map((e) => [e.turn, e.event.is_error])).toEqual([[1, false]]);
    expect(await failoverNotes()).toHaveLength(1);
  });

  it('names the last checkpoint in the note', async () => {
    const at = new Date('2026-11-25T14:05:30Z');
    await testDb.db.update(workbenches).set({ workCheckpointAt: at, workCheckpointSha: 'a'.repeat(40) }).where(eq(workbenches.id, 'wb'));
    refusal = SILENT_HOST[0][1];
    await sendMessage('chat', { text: 'go' });
    await failedOver();
    const [note] = await failoverNotes();
    expect(note.event.text).toBe(hostFailoverNote(at));
    expect(note.event.text).toContain('from the checkpoint of 2026-11-25 14:05 UTC');
    expect(note.event.text).toContain('Changes made after that checkpoint stay on the old sandbox.');
  });

  it.each([
    [null, 'from the branch on GitHub'],
    [new Date('2026-11-25T09:00:00Z'), 'from the checkpoint of 2026-11-25 09:00 UTC'],
  ] as const)('writes a plain note for checkpoint %s', (at, expected) => {
    const text = hostFailoverNote(at);
    expect(text).toMatch(/^The sandbox's host is not answering\. Talyn started a new sandbox on another host /);
    expect(text).toContain(expected);
    expect(text).toContain('stay on the old sandbox');
  });

  it('does not fail over before the bound', async () => {
    Object.assign(HOST_FAILOVER, { silentForMs: 60_000 });
    refusal = SILENT_HOST[0][1];
    await sendMessage('chat', { text: 'go' });
    await waiting(3);
    const row = await chat();
    const since = row.queuedMessages[0].capacityWait?.hostSilentSince;
    expect(since).toEqual(expect.any(String));
    // The bound counts from the first silent answer, not from each one.
    await waiting(4);
    expect((await chat()).queuedMessages[0].capacityWait?.hostSilentSince).toBe(since);
    expect(await workbench()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });
    expect(scheduleProvision).not.toHaveBeenCalled();
    expect(await failoverNotes()).toEqual([]);
  });

  it('does not fail over while the whole fleet API is unreachable', async () => {
    Object.assign(HOST_FAILOVER, { silentForMs: 0 });
    fleet.pingError = timeout();
    refusal = timeout;
    await sendMessage('chat', { text: 'go' });
    await waiting(4);
    expect(fleet.pings).toBeGreaterThanOrEqual(4);
    expect((await chat()).queuedMessages[0].capacityWait?.hostSilentSince).toBeUndefined();
    expect(await workbench()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });
    expect(scheduleProvision).not.toHaveBeenCalled();
  });

  it('restarts the bound when the host answers again in the wait', async () => {
    Object.assign(HOST_FAILOVER, { silentForMs: 60_000 });
    let silent = true;
    refusal = () => (silent ? SILENT_HOST[0][1]() : ANSWERING[0][1]());
    await sendMessage('chat', { text: 'go' });
    await waiting(2);
    expect((await chat()).queuedMessages[0].capacityWait?.hostSilentSince).toEqual(expect.any(String));
    silent = false;
    const tries = wakeTries;
    await waiting(tries + 1);
    await vi.waitFor(async () => expect((await chat()).queuedMessages[0].capacityWait?.hostSilentSince).toBeUndefined(), { timeout: 5000 });
  });

  it.each(ANSWERING)('never fails over on %s', async (_name, make) => {
    Object.assign(HOST_FAILOVER, { silentForMs: 0 });
    refusal = make;
    await sendMessage('chat', { text: 'go' });
    await waiting(3);
    expect((await chat()).queuedMessages[0].capacityWait?.hostSilentSince).toBeUndefined();
    expect(await workbench()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });
    expect(scheduleProvision).not.toHaveBeenCalled();
  });

  it('fails over once per turn, and the wait keeps the bound of its first refusal', async () => {
    refusal = SILENT_HOST[0][1];
    await sendMessage('chat', { text: 'go' });
    await failedOver();
    const replacement = (await workbench()).sandboxId;
    const mark = (await chat()).queuedMessages[0].hostFailover;
    expect(mark).toMatchObject({ turn: 1, at: expect.any(String), waitStartedAt: expect.any(String) });
    // The 10-minute window of recovery is over: only the mark on the message stops a second failover.
    resetLostRecoveryForTests();
    // The bound counts from the first refusal on the old box, so it ends soon after the failover.
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: Date.now() - Date.parse(mark!.waitStartedAt) + 500 });

    // The new box lands on the same host: it does not answer either.
    expect(await provisionEnds()).toBe(true);
    await vi.waitFor(async () => expect((await chat()).status).toBe('error'), { timeout: 5000 });
    expect((await chat()).statusMessage).toBe(NO_FREE_SANDBOX_TURN_MESSAGE);
    expect(await workbench()).toMatchObject({ status: 'ready', sandboxId: replacement });
    expect((await workbench()).settings?.keptSandboxIds).toEqual([OLD_BOX]);
    expect(scheduleProvision).toHaveBeenCalledTimes(1);
    expect(await failoverNotes()).toHaveLength(1);
    expect(agentRuns).toBe(0);
  });

  it('a later turn can fail over again', async () => {
    refusal = SILENT_HOST[0][1];
    await sendMessage('chat', { text: 'first' });
    await failedOver();
    resetLostRecoveryForTests();
    refusal = null;
    expect(await provisionEnds()).toBe(true);
    await vi.waitFor(async () => expect(agentRuns).toBe(1), { timeout: 5000 });
    await vi.waitFor(async () => expect((await chat()).status).toBe('idle'), { timeout: 5000 });

    refusal = SILENT_HOST[0][1];
    await sendMessage('chat', { text: 'second' });
    await failedOver();
    expect(scheduleProvision).toHaveBeenCalledTimes(2);
    expect((await failoverNotes()).map((e) => e.turn)).toEqual([1, 2]);
  });

  it('does not replace the box while another chat of the session runs a turn', async () => {
    await testDb.db.insert(workbenchChats).values({
      id: 'chat-b', workbenchId: 'wb', workspaceId: 'ws', title: 'Other', agent: 'claude', turnCount: 1, status: 'running',
    });
    refusal = SILENT_HOST[0][1];
    await sendMessage('chat', { text: 'go' });
    await waiting(4);
    expect(await workbench()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });
    expect(scheduleProvision).not.toHaveBeenCalled();
    expect(await failoverNotes()).toEqual([]);

    // The other turn ends: the next silent answer fails over.
    await testDb.db.update(workbenchChats).set({ status: 'idle' }).where(eq(workbenchChats.id, 'chat-b'));
    await failedOver();
    expect(scheduleProvision).toHaveBeenCalledTimes(1);
  });

  it('does not fail over a turn whose agent already started', async () => {
    Object.assign(HOST_FAILOVER, { silentForMs: 0 });
    // The box wakes, then the host stops answering the agent's launch: the agent may run.
    const exec = fleet.exec.bind(fleet);
    fleet.exec = async (id, req) => {
      if (req.env?.TALYN_DURABLE_SCRIPT) {
        fleet.launches.push('launch');
        throw SILENT_HOST[0][1]();
      }
      return exec(id, req);
    };
    await sendMessage('chat', { text: 'go' });
    await vi.waitFor(async () => {
      expect(fleet.launches.length).toBeGreaterThanOrEqual(1);
      expect((await chat()).status).not.toBe('running');
    }, { timeout: 5000 });
    expect(await workbench()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });
    expect(scheduleProvision).not.toHaveBeenCalled();
    expect(await failoverNotes()).toEqual([]);
    expect(isWaitingForSandbox(await chat())).toBe(false);
    // The turn ends with its error, on the old box.
    expect((await chat()).status).toBe('error');
    expect((await results()).map((e) => [e.turn, e.event.is_error])).toEqual([[1, true]]);
  });

  it('waits on a 504 host_silent instead of failing the turn', async () => {
    Object.assign(HOST_FAILOVER, { silentForMs: 60_000 });
    refusal = SILENT_HOST[1][1];
    await sendMessage('chat', { text: 'go' });
    await waiting(3);
    expect((await chat()).queuedMessages[0].capacityWait).toMatchObject({ reason: 'capacity', hostSilentSince: expect.any(String) });
    expect(await results()).toEqual([]);
    expect(agentRuns).toBe(0);
    expect(await workbench()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });

    // The host answers again: the turn runs on the old box.
    refusal = null;
    await vi.waitFor(async () => expect(agentRuns).toBe(1), { timeout: 5000 });
    expect(scheduleProvision).not.toHaveBeenCalled();
  });
});
