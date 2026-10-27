import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn } from './helpers/fakeFleet.js';
import { repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';

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
const emit = await import('../services/workbenches/emit.js');
const { durablePaths } = await import('../services/workbenches/durableExec.js');
const { TURN_OWNER, resetWorkbenchDrainForTests } = await import('../services/workbenches/ownership.js');
const { settleAgentBackupsForTests } = await import('../services/workbenches/agentBackups.js');
const {
  LAUNCH_FAILED_MESSAGE, MAX_TURN_ATTEMPTS, ORPHAN_MESSAGE, launchTurnLoopForTests, sendMessage,
  setTurnRetryDelaysForTests, sweepOrphanedTurns, turnLogKey,
} = await import('../services/workbenches/turns.js');

const logOf = (turn: number, attempt: number) => durablePaths(turnLogKey('chat', turn, attempt)).log;

describe('workbench turn launch', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  let chatEmits: ReturnType<typeof vi.spyOn>;
  let agentRuns: number;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    resetWorkbenchDrainForTests();
    setTurnRetryDelaysForTests([0]);
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
    fleet.handler = (script) => {
      if (isAgentTurn(script)) {
        agentRuns++;
        return { stdout: claudeTurnLines('sess', 'done'), exitCode: 0 };
      }
      return script.includes('git commit-tree') ? { stdout: `${'c'.repeat(40)}\n` } : { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    chatEmits = vi.spyOn(emit, 'emitWorkbenchChat');
  });

  afterEach(async () => {
    await settleAgentBackupsForTests();
    setWorkbenchFleetClientForTests(null);
    setTurnRetryDelaysForTests(null);
    resetWorkbenchDrainForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  /** Every status clients were sent, in order. */
  const statuses = () => chatEmits.mock.calls.map((call) => (call[1] as { status: string }).status);

  /** Only the last emit may say the turn stopped: anything earlier is a false "agent finished". */
  function expectNoTransientStop(final: string) {
    const seen = statuses();
    expect(seen.at(-1)).toBe(final);
    expect(seen.slice(0, -1).every((status) => status === 'running')).toBe(true);
  }

  async function events() {
    return (await store.listEvents('chat', 0, 200)).events.map((e) => e.event);
  }

  async function settled(status: string) {
    await vi.waitFor(async () => expect((await store.getChat('chat'))?.status).toBe(status), { timeout: 5000 });
  }

  async function staleHeartbeat(at = new Date(Date.now() - 91_000)) {
    await testDb.db.update(workbenchChats).set({ turnHeartbeatAt: at }).where(eq(workbenchChats.id, 'chat'));
  }

  it.each([
    ['the supervisor started late', true, 0],
    ['the supervisor never started', false, 1],
  ] as const)('runs a turn once when the box resumes slowly during the launch: %s', async (_name, lateStart, attempt) => {
    fleet.hibernated = true;
    let resumed!: () => void;
    fleet.resumeGate = new Promise((resolve) => { resumed = resolve; });
    let first = true;
    fleet.launchHandler = () => {
      if (!first) return undefined;
      first = false;
      return { exitCode: 1, stderr: 'node did not start in time', lateStart };
    };

    await sendMessage('chat', { text: 'go' });
    await vi.waitFor(() => expect(fleet.resumes).toBe(1));
    // Two minutes of resume: the heartbeat may look stale, and the sweep must leave the live turn alone.
    await staleHeartbeat();
    expect(await sweepOrphanedTurns()).toBe(0);
    expect((await store.getTurnLease('chat'))?.owner).toBe(TURN_OWNER);
    expect(fleet.launches).toEqual([]);
    resumed();

    await settled('idle');
    expect(agentRuns).toBe(1);
    expect(fleet.launches).toEqual(lateStart ? [logOf(1, 0)] : [logOf(1, 0), logOf(1, 1)]);
    expect((await store.getTurnLease('chat'))?.attempt).toBe(attempt);
    const stored = await events();
    expect(stored.filter((e) => (e.talyn as { kind?: string } | undefined)?.kind === 'user_message')).toHaveLength(1);
    expect(stored.filter((e) => e.type === 'result')).toHaveLength(1);
    expectNoTransientStop('idle');
    expect(await sweepOrphanedTurns()).toBe(0);
  });

  it('settles with a clear error once every attempt failed to launch', async () => {
    const launchErrors: string[] = [];
    fleet.launchHandler = (log) => {
      launchErrors.push(log);
      return { exitCode: 1, stderr: "mkdir: cannot create directory '/root/.talyn': Permission denied" };
    };
    await sendMessage('chat', { text: 'go' });
    await settled('error');
    const chat = await store.getChat('chat');
    expect(chat?.statusMessage).toContain(LAUNCH_FAILED_MESSAGE);
    expect(chat?.statusMessage).toContain('Permission denied');
    expect(fleet.launches).toEqual(Array.from({ length: MAX_TURN_ATTEMPTS }, (_, i) => logOf(1, i)));
    expect(new Set(launchErrors).size).toBe(MAX_TURN_ATTEMPTS);
    expect(agentRuns).toBe(0);
    expect((await events()).filter((e) => e.type === 'result')).toEqual([
      expect.objectContaining({ is_error: true, result: expect.stringContaining(LAUNCH_FAILED_MESSAGE) }),
    ]);
    expectNoTransientStop('error');
    // Settled for good: nothing to adopt, nothing launched again.
    expect(await sweepOrphanedTurns()).toBe(0);
    expect(fleet.launches).toHaveLength(MAX_TURN_ATTEMPTS);
  });

  it('settles after the bound when the start-marker directory is not writable', async () => {
    fleet.fenceExitCode = 4;
    fleet.launchHandler = () => ({ exitCode: 1, stderr: 'EACCES' });
    await sendMessage('chat', { text: 'go' });
    await settled('error');
    expect(fleet.launches).toHaveLength(MAX_TURN_ATTEMPTS);
    expectNoTransientStop('error');
  });

  it('hands off a launch it cannot decide, then the adopter relaunches it once', async () => {
    let first = true;
    fleet.launchHandler = () => {
      if (!first) return undefined;
      first = false;
      fleet.fenceExitCode = -1;
      return { exitCode: 1 };
    };
    await sendMessage('chat', { text: 'go' });
    await vi.waitFor(async () => expect((await store.getTurnLease('chat'))?.heartbeat).toEqual(new Date(0)));
    expect((await store.getChat('chat'))?.status).toBe('running');
    fleet.fenceExitCode = undefined;
    await vi.waitFor(async () => expect(await sweepOrphanedTurns()).toBe(1));
    await settled('idle');
    expect(fleet.launches).toEqual([logOf(1, 0), logOf(1, 1)]);
    expect(agentRuns).toBe(1);
    expectNoTransientStop('idle');
  });

  it.each([
    ['present', true],
    ['absent', false],
  ] as const)('adopts a turn whose start marker is missing, turn_message %s', async (_name, withMessage) => {
    await store.claimOrEnqueue('chat', { id: 'msg', text: 'work', queuedAt: new Date().toISOString() }, true);
    await testDb.db.update(workbenchChats).set({
      turnOwner: 'instance-a', turnHeartbeatAt: new Date(0), ...(withMessage ? {} : { turnMessage: null }),
    }).where(eq(workbenchChats.id, 'chat'));
    expect(await sweepOrphanedTurns()).toBe(1);
    if (withMessage) {
      await settled('idle');
      expect(fleet.fenced.has(logOf(1, 0))).toBe(true);
      expect(fleet.launches).toEqual([logOf(1, 1)]);
      expect(agentRuns).toBe(1);
      expect((await store.getChat('chat'))?.queuedMessages).toEqual([]);
      expectNoTransientStop('idle');
    } else {
      await settled('error');
      expect((await store.getChat('chat'))?.statusMessage).toBe(ORPHAN_MESSAGE);
      expect(fleet.launches).toEqual([]);
      expectNoTransientStop('error');
    }
  });

  it('does not relaunch an adopted turn past the attempt bound', async () => {
    await store.claimOrEnqueue('chat', { id: 'msg', text: 'work', queuedAt: new Date().toISOString() }, true);
    await testDb.db.update(workbenchChats).set({
      turnOwner: 'instance-a', turnHeartbeatAt: new Date(0), turnAttempt: MAX_TURN_ATTEMPTS - 1,
    }).where(eq(workbenchChats.id, 'chat'));
    expect(await sweepOrphanedTurns()).toBe(1);
    await settled('error');
    expect((await store.getChat('chat'))?.statusMessage).toBe(LAUNCH_FAILED_MESSAGE);
    expect(fleet.launches).toEqual([]);
    expect(await sweepOrphanedTurns()).toBe(0);
  });

  it('never adopts a lease while its own turn loop is alive', async () => {
    const claim = await store.claimOrEnqueue('chat', { id: 'msg', text: 'work', queuedAt: new Date().toISOString() }, true);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const original = store.getChat;
    let held = false;
    const getChat = vi.spyOn(store, 'getChat').mockImplementation(async (id) => {
      if (!held) { held = true; await gate; }
      return original(id);
    });
    launchTurnLoopForTests('chat', claim!.started!);
    await vi.waitFor(() => expect(getChat).toHaveBeenCalled());
    // The loop is alive but has not reached its follower yet.
    for (const at of [new Date(0), new Date(Date.now() - 91_000)]) {
      await staleHeartbeat(at);
      expect(await sweepOrphanedTurns()).toBe(0);
    }
    open();
    await settled('idle');
    expect(fleet.launches).toEqual([logOf(1, 0)]);
    expect(agentRuns).toBe(1);
  });

  it('logs every release and adoption with its reason', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await store.claimOrEnqueue('chat', { id: 'msg', text: 'work', queuedAt: new Date().toISOString() }, true);
    await testDb.db.update(workbenchChats).set({ turnOwner: 'instance-a', turnHeartbeatAt: new Date(0) })
      .where(eq(workbenchChats.id, 'chat'));
    await sweepOrphanedTurns();
    await settled('idle');
    const lines = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0]));
    expect(lines.some((l) => /lease adopted: instance instance released it/.test(l))).toBe(true);
    expect(lines.some((l) => /turn relaunch: attempt 0 never started \(fenced\); launching attempt 1/.test(l))).toBe(true);
  });
});
