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

const runtime = await import('../services/workbenches/sandboxRuntime.js');
const instructions = await import('../services/workbenches/instructions.js');
const skills = await import('../services/workbenches/skillPack.js');
const sandboxFiles = await import('../services/workbenches/sandboxFiles.js');
const { FleetRunNotFoundError } = await import('../services/selfHosted/client.js');
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

  it('parks a turn when Claude returns the reported 429', async () => {
    const reason = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
    const normal = fleet.handler;
    fleet.handler = (script) => {
      if (isAgentTurn(script)) return { stdout: [JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: reason })], exitCode: 1 };
      return normal!(script);
    };
    await sendMessage('chat', { text: 'Continue the work' });
    await vi.waitFor(async () => expect((await store.getChat('chat'))?.resumeAt).toBeInstanceOf(Date), { timeout: 5000 });
    expect(await store.getChat('chat')).toMatchObject({ status: 'error', resumeReason: reason, limitCount: 1 });
  });

  it('wakes first, then starts all independent steps before any finishes', async () => {
    fleet.hibernated = true;
    let wake!: () => void;
    fleet.resumeGate = new Promise((resolve) => { wake = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    vi.spyOn(runtime, 'refreshSandboxCredentials').mockImplementation(async () => {
      calls.push('credentials'); await gate; return { accountId: null, note: null };
    });
    vi.spyOn(instructions, 'syncInstructionFiles').mockImplementation(async () => { calls.push('instructions'); await gate; });
    vi.spyOn(skills, 'syncSkillPack').mockImplementation(async () => { calls.push('skills'); await gate; return false; });
    vi.spyOn(sandboxFiles, 'writeSandboxFiles').mockImplementation(async () => { calls.push('attachments'); await gate; });
    await sendMessage('chat', { text: 'go', attachments: [{ name: 'a.txt', mimeType: 'text/plain', dataBase64: 'YQ==' }] });
    await vi.waitFor(() => expect(fleet.resumes).toBe(1));
    expect(calls).toEqual([]);
    wake();
    try {
      await vi.waitFor(() => expect(calls.sort()).toEqual(['attachments', 'credentials', 'instructions', 'skills']));
      expect(agentRuns).toBe(0);
    } finally { release(); }
    await settled('idle');
    expect(agentRuns).toBe(1);
    expect((await events()).filter((event) => event.subtype === 'boot_metric').map((event) => event.metric))
      .toEqual(['wake_start', 'wake_end']);
  });

  it('stores the route receipt time with the user message', async () => {
    const sentAt = '2026-11-04T09:00:00.000Z';
    await sendMessage('chat', { text: 'go' }, { sentAt });
    await settled('idle');
    const user = (await events()).find((event) => (event.talyn as { kind?: string } | undefined)?.kind === 'user_message');
    expect(user?.talyn).toMatchObject({ sentAt });
  });

  it('persists an inline image before it publishes the preview path', async () => {
    const write = vi.spyOn(sandboxFiles, 'writeSandboxFiles');
    await sendMessage('chat', {
      text: 'Review this image',
      attachments: [{ name: 'shot.jpeg', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }],
    });
    await settled('idle');

    const path = '.context/attachments/chat-1-0-shot.png';
    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      [{ path: `/work/app/${path}`, base64: 'aGVsbG8=' }],
      { before: expect.stringContaining('.context/'), timeoutMs: 120_000 },
    );
    // The writer runs from /, so the exclude step must enter the checkout before it calls git.
    const before = write.mock.calls[0][2]?.before ?? '';
    expect(before.split('\n')[0]).toMatch(/^cd '?\/work\/app'?$/);
    expect(before.indexOf('cd ')).toBeLessThan(before.indexOf('git rev-parse'));
    const user = (await events()).find((event) => (event.talyn as { kind?: string } | undefined)?.kind === 'user_message');
    expect(user?.talyn).toMatchObject({
      attachments: [{ name: 'shot.jpeg', mimeType: 'image/png', path }],
    });
    expect(JSON.stringify(user)).not.toContain('aGVsbG8=');
    expect(fleet.scripts.find((script) => isAgentTurn(script))).toContain(`/work/app/${path} (image/png)`);
  });

  it.each(['credentials', 'attachments', 'instructions', 'skills'] as const)('propagates a fatal %s failure after other steps finish', async (step) => {
    const failure = new FleetRunNotFoundError('missing sandbox');
    vi.spyOn(runtime, 'refreshSandboxCredentials').mockImplementation(async () => {
      if (step === 'credentials') throw failure;
      return { accountId: null, note: null };
    });
    vi.spyOn(instructions, 'syncInstructionFiles').mockImplementation(async () => { if (step === 'instructions') throw failure; });
    vi.spyOn(skills, 'syncSkillPack').mockImplementation(async () => { if (step === 'skills') throw failure; return false; });
    vi.spyOn(sandboxFiles, 'writeSandboxFiles').mockImplementation(async () => { if (step === 'attachments') throw failure; });
    await sendMessage('chat', { text: 'go', attachments: [{ name: 'a.txt', mimeType: 'text/plain', dataBase64: 'YQ==' }] });
    await settled('error');
    expect(agentRuns).toBe(0);
    expect(instructions.syncInstructionFiles).toHaveBeenCalled();
    expect(skills.syncSkillPack).toHaveBeenCalled();
    expect(sandboxFiles.writeSandboxFiles).toHaveBeenCalled();
  });

  it.each(['instructions', 'skills'] as const)('keeps a %s sync error as a warning', async (step) => {
    if (step === 'instructions') vi.spyOn(instructions, 'syncInstructionFiles').mockRejectedValue(new Error('sync failed'));
    else vi.spyOn(skills, 'syncSkillPack').mockRejectedValue(new Error('sync failed'));
    await sendMessage('chat', { text: 'go' });
    await settled('idle');
    expect(agentRuns).toBe(1);
  });

  it.each([
    [0, null, false],
    [0, new Date(), true],
    [1, null, true],
  ])('checks disk and takes a checkpoint only when needed: prior turns %i, saved %s', async (priorTurns, checkpointAt, expected) => {
    await testDb.db.update(workbenchChats).set({ turnCount: priorTurns }).where(eq(workbenchChats.id, 'chat'));
    await testDb.db.update(workbenches).set({ workCheckpointAt: checkpointAt }).where(eq(workbenches.id, 'wb'));
    await sendMessage('chat', { text: 'go' });
    await settled('idle');
    const first = fleet.scripts[0];
    expect(first).toContain('TALYN_FILE_HASH');
    expect(first.includes('git commit-tree')).toBe(expected);
    expect(first).toContain('df ');
    expect(Boolean(await store.getCheckpoint('chat', priorTurns + 1))).toBe(expected);
  });

  it('does not treat a new chat in a used session as a fresh box', async () => {
    await testDb.db.insert(workbenchChats).values({
      id: 'older-chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Older', agent: 'claude', turnCount: 2,
    });
    await sendMessage('chat', { text: 'go' });
    await settled('idle');
    expect(fleet.scripts[0]).toContain('git commit-tree');
  });

  it('takes a checkpoint when the terminal was used before the first turn', async () => {
    await testDb.db.update(workbenches).set({ lastActivityAt: new Date() }).where(eq(workbenches.id, 'wb'));
    await sendMessage('chat', { text: 'go' });
    await settled('idle');
    expect(fleet.scripts[0]).toContain('git commit-tree');
  });

  it('waits for pending writes before it settles a failed turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const failed = vi.spyOn(runtime, 'refreshSandboxCredentials').mockRejectedValue(new Error('credentials failed'));
    vi.spyOn(instructions, 'syncInstructionFiles').mockImplementation(() => gate);
    await sendMessage('chat', { text: 'go' });
    try {
      await vi.waitFor(() => expect(failed).toHaveBeenCalled());
      expect((await store.getChat('chat'))?.status).toBe('running');
      expect(agentRuns).toBe(0);
    } finally { release(); }
    await settled('error');
  });

  it.each(['claude', 'codex'] as const)('stores guest startup timing on the %s init event', async (agent) => {
    const durable = await import('../services/workbenches/durableExec.js');
    const follow = durable.followDurableBatches;
    vi.spyOn(durable, 'followDurableBatches').mockImplementation((wb, key, marker, offset, onBatch, opts) =>
      follow(wb, key, marker, offset, (records) => onBatch(records.map((r) => ({
        ...r, record: { ...r.record, timing: { queuedAt: 1000, spawnedAt: 2200, at: 2700 } },
      }))), opts));
    if (agent === 'codex') {
      await addFleetAccount('ws', {
        kind: 'openai_key', label: 'Codex', credential: { keyEnc: encryptString('codex-token') },
      });
      await testDb.db.update(workbenches).set({
        settings: { autoCreatePr: false, sandboxAgents: { 'talyn-wb-test': ['claude', 'codex'] } },
      }).where(eq(workbenches.id, 'wb'));
      await testDb.db.update(workbenchChats).set({ agent }).where(eq(workbenchChats.id, 'chat'));
      fleet.handler = (script) => isAgentTurn(script, 'codex')
        ? { stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'sess' }),
          JSON.stringify({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'done' } }),
          JSON.stringify({ type: 'turn.completed', usage: {} }),
        ], exitCode: 0 }
        : { stdout: '', exitCode: 0 };
    }
    await sendMessage('chat', { text: 'go' });
    await settled('idle');
    const script = fleet.execs.find((entry) => isAgentTurn(entry.script, agent))?.script;
    expect(script).toBeDefined();
    if (agent === 'codex') {
      expect(script).toContain('export OPENAI_API_KEY=not-a-key-the-fleet-proxy-injects-host-side');
      expect(script).toContain('\ncodex exec ');
    } else {
      expect(script?.startsWith('claude ')).toBe(true);
    }
    expect(await events()).toContainEqual(expect.objectContaining({
      type: 'system', subtype: 'init', talyn: { kind: 'turn_start_timing', startMs: 1200, initMs: 500 },
    }));
  });

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
