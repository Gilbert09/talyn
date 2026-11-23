import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn } from './helpers/fakeFleet.js';
import { repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { FleetCapacityError } from '../services/selfHosted/client.js';

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
const { resetWorkbenchDrainForTests } = await import('../services/workbenches/ownership.js');
const { settleAgentBackupsForTests } = await import('../services/workbenches/agentBackups.js');
const { PROVISION_CAPACITY_WAIT, settleArchivesForTests } = await import('../services/workbenches/lifecycle.js');
const { cancelTurn, isWaitingForSandbox, sendMessage, setStopRetryDelaysForTests, setTurnRetryDelaysForTests } =
  await import('../services/workbenches/turns.js');

const DEFAULT_WAIT = { ...PROVISION_CAPACITY_WAIT };

/** A person stops a turn while messages wait behind it. */
describe('a stop with queued messages', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  /** The text of each agent turn the box ran, in order. */
  let prompts: string[];
  /** While true, an agent turn runs until a kill script stops it. */
  let holdTurns: boolean;
  let releaseTurn: (() => void) | null;
  let refuseWake: boolean;
  /** While true, every kill script fails as a box with no free runner does. */
  let refuseKill: boolean;
  let kills: number;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    resetWorkbenchDrainForTests();
    setTurnRetryDelaysForTests([0]);
    // A long backoff, so a wait for a free sandbox never retries by itself.
    Object.assign(PROVISION_CAPACITY_WAIT, { maxMs: 600_000, firstDelayMs: 60_000, maxDelayMs: 60_000 });
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
    prompts = [];
    holdTurns = true;
    releaseTurn = null;
    refuseWake = false;
    refuseKill = false;
    kills = 0;
    fleet.handler = (script) => {
      if (isAgentTurn(script)) {
        prompts.push(script);
        if (!holdTurns) return { stdout: claudeTurnLines('sess', 'done'), exitCode: 0 };
        const hold = new Promise<void>((resolve) => { releaseTurn = resolve; });
        return { stdout: claudeTurnLines('sess', 'working').slice(0, 1), exitCode: 0, hold };
      }
      if (script.includes('pkill')) {
        if (refuseKill) throw new FleetCapacityError('host out of memory', undefined, 'no_capacity');
        kills++;
        releaseTurn?.();
        releaseTurn = null;
        return { exitCode: 0, stdout: '' };
      }
      if (script.includes('git commit-tree') || script.includes('df -B1')) {
        if (refuseWake) throw new FleetCapacityError('host out of memory', undefined, 'no_capacity');
        return { stdout: `${'c'.repeat(40)}\n` };
      }
      return { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    holdTurns = false;
    refuseWake = false;
    refuseKill = false;
    releaseTurn?.();
    await vi.waitFor(async () => expect((await chat()).status).not.toBe('running'), { timeout: 5000 });
    await testDb.db.update(workbenchChats).set({ queuedMessages: [], drainPending: false });
    await settleAgentBackupsForTests();
    await settleArchivesForTests();
    setWorkbenchFleetClientForTests(null);
    setTurnRetryDelaysForTests(null);
    setStopRetryDelaysForTests(null);
    Object.assign(PROVISION_CAPACITY_WAIT, DEFAULT_WAIT);
    resetWorkbenchDrainForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  const chat = async () => (await store.getChat('chat'))!;
  const userTurns = async () => (await store.listEvents('chat', 0, 200)).events
    .filter((e) => (e.event.talyn as { kind?: string } | undefined)?.kind === 'user_message')
    .map((e) => e.turn);
  const ran = (text: string) => prompts.filter((script) => script.includes(text)).length;

  /** The first turn runs in the box, and `next` waits behind it. */
  async function runningWithQueue() {
    await sendMessage('chat', { text: 'first task' });
    await vi.waitFor(() => expect(releaseTurn).not.toBeNull(), { timeout: 5000 });
    expect(await sendMessage('chat', { text: 'next task' })).toEqual({ queued: true });
    expect((await chat()).queuedMessages.map((m) => m.text)).toEqual(['next task']);
  }

  it('starts the queued message after the stopped turn', async () => {
    await runningWithQueue();
    holdTurns = false;
    await cancelTurn('chat', { startQueue: true });
    await vi.waitFor(async () => {
      const row = await chat();
      expect(row.status).toBe('idle');
      expect(row.turnCount).toBe(2);
      expect(row.queuedMessages).toEqual([]);
    }, { timeout: 5000 });
    expect(ran('next task')).toBe(1);
    expect(await userTurns()).toEqual([1, 2]);
  });

  it('keeps the queue when Talyn stops the turn for itself', async () => {
    await runningWithQueue();
    await cancelTurn('chat');
    await vi.waitFor(async () => expect((await chat()).status).toBe('idle'), { timeout: 5000 });
    const row = await chat();
    expect(row.turnCount).toBe(1);
    expect(row.queuedMessages.map((m) => m.text)).toEqual(['next task']);
    expect(ran('next task')).toBe(0);
  });

  it('starts the queue when no follower runs here', async () => {
    // Another instance follows turn 1: this process has no live turn for the chat.
    await store.updateChat('chat', {
      status: 'running', turnCount: 1,
      queuedMessages: [{ id: 'next', text: 'next task', queuedAt: new Date().toISOString() }],
    });
    holdTurns = false;
    await cancelTurn('chat', { startQueue: true });
    await vi.waitFor(async () => {
      const row = await chat();
      expect(row.status).toBe('idle');
      expect(row.turnCount).toBe(2);
      expect(row.queuedMessages).toEqual([]);
    }, { timeout: 5000 });
    expect(ran('next task')).toBe(1);
  });

  it('starts the message behind a stopped wait for a free sandbox', async () => {
    refuseWake = true;
    holdTurns = false;
    await sendMessage('chat', { text: 'first task' });
    await vi.waitFor(async () => expect(isWaitingForSandbox(await chat())).toBe(true), { timeout: 5000 });
    await sendMessage('chat', { text: 'next task' });
    expect((await chat()).queuedMessages.map((m) => m.text)).toEqual(['first task', 'next task']);
    refuseWake = false;
    await cancelTurn('chat', { startQueue: true });
    await vi.waitFor(async () => {
      const row = await chat();
      expect(row.status).toBe('idle');
      expect(row.turnCount).toBe(2);
      expect(row.queuedMessages).toEqual([]);
    }, { timeout: 5000 });
    expect(ran('first task')).toBe(0);
    expect(ran('next task')).toBe(1);
  });

  describe('when the box cannot be reached', () => {
    it('stops the turn this instance follows', async () => {
      setStopRetryDelaysForTests([]);
      await runningWithQueue();
      refuseKill = true;
      await expect(cancelTurn('chat')).resolves.toBeUndefined();
      await vi.waitFor(async () => {
        const row = await chat();
        expect(row.status).toBe('idle');
        expect(row.statusMessage).toBe('Cancelled');
      }, { timeout: 5000 });
      expect((await chat()).queuedMessages.map((m) => m.text)).toEqual(['next task']);
    });

    it('stops a turn another instance follows', async () => {
      setStopRetryDelaysForTests([]);
      await store.updateChat('chat', { status: 'running', turnCount: 1 });
      refuseKill = true;
      await expect(cancelTurn('chat', { startQueue: true })).resolves.toBeUndefined();
      expect((await chat()).status).toBe('idle');
    });

    it('kills the agent once the box answers', async () => {
      setStopRetryDelaysForTests([20, 20, 20]);
      await runningWithQueue();
      refuseKill = true;
      await cancelTurn('chat');
      await vi.waitFor(async () => expect((await chat()).status).toBe('idle'), { timeout: 5000 });
      expect(kills).toBe(0);
      refuseKill = false;
      await vi.waitFor(() => expect(kills).toBeGreaterThan(0), { timeout: 5000 });
    });
  });
});
