import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, type ExecReply } from './helpers/fakeFleet.js';
import { repositories, workspaces } from '../db/schema.js';
import type { FleetExecFrame, FleetExecRequest, FleetSandbox } from '../services/selfHosted/client.js';

/**
 * Moving a session to a fresh sandbox: the export and import scripts, the
 * claim, the order of a move, every failure keeping the old box, and the
 * three triggers.
 */

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
}));

vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  getSelfHostedCredentials: async () => ({ claudeToken: 'sk-ant-oat-claude', openaiKey: 'oa-codex' }),
  fleetAgentStatus: async () => ({ connectedAgents: ['claude', 'codex'], reauthAgents: [] }),
}));

vi.mock('../services/mcpServers/dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpServers/dispatch.js')>()),
  mcpIntegrationSecrets: async () => ({}),
}));

vi.mock('../services/repoDefaultBranch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/repoDefaultBranch.js')>()),
  reconcileDefaultBranch: async (input: { stored: string }) => input.stored || 'main',
}));

const { githubService } = await import('../services/github.js');
const { setWorkbenchFleetClientForTests, runCapture } = await import('../services/workbenches/sandboxRuntime.js');
const store = await import('../services/workbenches/store.js');
const move = await import('../services/workbenches/move.js');
const { sendMessage } = await import('../services/workbenches/turns.js');
const { LOW_DISK_BYTES } = await import('../services/workbenches/execFailures.js');

const WB = '11111111-2222-4333-8444-555555555555';
const OLD_BOX = 'talyn-wb-111111112222433384445555';
const NEW_BOX = `${OLD_BOX}-r1`;
const SESSION = '4f1c2b9e-1111-4222-8333-944455556666';
const SHA = (c: string) => c.repeat(64);
const GIB = 1024 * 1024 * 1024;

type Kind =
  | 'export'
  | 'chunk'
  | 'clone'
  | 'write'
  | 'import'
  | 'config'
  | 'ref_delete'
  | 'cleanup'
  | 'checkpoint'
  | 'probe'
  | 'agent'
  | 'other';

function kindOf(script: string): Kind {
  if (script.includes('git push --no-verify --force --quiet origin "$head"')) return 'export';
  if (script.startsWith('dd if=')) return 'chunk';
  if (script.includes('git clone --filter=blob:none')) return 'clone';
  if (script.includes('base64 -d')) return 'write';
  if (script.includes('sha256sum -c') || script.includes("git fetch --no-tags --quiet origin 'refs/talyn/move/")) return 'import';
  if (script.includes('cat .talyn/settings.toml')) return 'config';
  if (script.startsWith('rm -rf -- ') && script.includes(':refs/talyn/move/')) return 'cleanup';
  if (script.includes(':refs/talyn/move/')) return 'ref_delete';
  if (script.includes('git commit-tree')) return 'checkpoint';
  if (script.includes('TALYN_DISK') && script.includes('df -B1')) return 'probe';
  if (isAgentTurn(script)) return 'agent';
  return 'other';
}

/** The fake fleet, but every call names the box it went to, in one log. */
class MoveFleet extends FakeFleet {
  log: Array<{ kind: Kind | 'create' | 'delete' | 'grow'; box: string }> = [];
  sandbox: Partial<FleetSandbox> = { status: 'idle' };
  grow: 'grown' | 'unsupported' = 'unsupported';
  getSandboxCalls = 0;

  override async exec(id: string, req: FleetExecRequest): Promise<FleetExecFrame> {
    this.log.push({ kind: kindOf(req.env?.TALYN_SCRIPT ?? ''), box: id });
    return super.exec(id, req);
  }

  override async *execFollow(id: string, req: FleetExecRequest, signal: AbortSignal): AsyncGenerator<FleetExecFrame> {
    this.log.push({ kind: kindOf(req.env?.TALYN_SCRIPT ?? ''), box: id });
    yield* super.execFollow(id, req, signal);
  }

  override async createSandbox(input: Parameters<FakeFleet['createSandbox']>[0]) {
    this.log.push({ kind: 'create', box: input.id });
    return super.createSandbox(input);
  }

  override async deleteSandbox(id: string) {
    this.log.push({ kind: 'delete', box: id });
    return super.deleteSandbox(id);
  }

  async getSandbox(id: string) {
    this.getSandboxCalls++;
    if (id !== OLD_BOX) throw new Error('no such sandbox');
    return { sandbox: { id, ...this.sandbox } as FleetSandbox, terminal: false };
  }

  async growSandboxDisk(id: string) {
    this.log.push({ kind: 'grow', box: id });
    return this.grow;
  }

  first(kind: string, box?: string): number {
    return this.log.findIndex((e) => e.kind === kind && (!box || e.box === box));
  }
}

const STAGED = 'staged-bytes';
const AGENT = 'agent-archive';

function manifest(files: Array<[string, string]> = [['staged.patch.gz', STAGED], ['agent.tgz', AGENT]]): string[] {
  return [
    `HEAD ${'a'.repeat(40)}`,
    `BRANCH ${Buffer.from('paris').toString('base64')}`,
    `UPSTREAM ${Buffer.from('origin/paris').toString('base64')}`,
    ...files.map(([name, body], i) => `FILE ${name} ${Buffer.byteLength(body)} ${SHA(String(i + 1))}`),
    'SKIPPED_COUNT 1',
    `SKIPPED ${Buffer.from('data/big.bin').toString('base64')}`,
  ];
}

describe('moving a session to a fresh sandbox', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: MoveFleet;
  let replies: Partial<Record<Kind, ExecReply>>;

  beforeEach(async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    move.resetMovesForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({
      id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
    });
    await store.insertWorkbench({
      id: WB, workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: 'paris',
      branch: 'paris', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      sandboxState: 'running', sandboxId: OLD_BOX, fleetHost: 'host-0',
    });
    await store.insertChat({
      id: 'chat-a', workbenchId: WB, workspaceId: 'ws-a', title: 'Chat', agent: 'claude', agentSessionId: SESSION,
    });
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    replies = {};
    fleet = new MoveFleet();
    fleet.noise = [];
    fleet.handler = (script) => {
      const kind = kindOf(script);
      if (replies[kind]) return replies[kind]!;
      if (kind === 'export') return { stdout: manifest() };
      if (kind === 'chunk') return { stdout: script.includes('staged.patch.gz') ? STAGED : AGENT };
      if (kind === 'checkpoint') return { stdout: `${'c'.repeat(40)}\n`, stderr: `TALYN_DISK ${10 * GIB} ${16 * GIB}` };
      if (kind === 'probe') return { stderr: `TALYN_DISK ${10 * GIB} ${16 * GIB}` };
      if (kind === 'agent') return { stdout: claudeTurnLines(SESSION, 'done') };
      return { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
  });

  afterEach(async () => {
    setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  const row = async () => (await store.getWorkbench(WB))!;
  const notes = async () =>
    (await store.listEvents('chat-a', 0, 100)).events.map((e) => e.event as { subtype?: string; text?: string });

  describe('the claim', () => {
    it('lets one of two concurrent moves win', async () => {
      const [a, b] = await Promise.all([
        store.claimMove(WB, OLD_BOX, NEW_BOX, 'x'),
        store.claimMove(WB, OLD_BOX, NEW_BOX, 'x'),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await row()).toMatchObject({ status: 'moving', settings: expect.objectContaining({ moveSandboxId: NEW_BOX }) });
    });

    it.each([
      ['error', OLD_BOX],
      ['provisioning', OLD_BOX],
      ['ready', 'some-other-box'],
    ])('refuses a workbench in %s on %s', async (status, sandboxId) => {
      await store.updateWorkbench(WB, { status });
      expect(await store.claimMove(WB, sandboxId, NEW_BOX, 'x')).toBeNull();
    });

    it('does not start a turn while the workbench is moving, and keeps the message queued', async () => {
      await store.claimMove(WB, OLD_BOX, NEW_BOX, 'x');
      const claim = await store.claimOrEnqueue('chat-a', { id: 'm1', text: 'hi', queuedAt: new Date().toISOString() }, true);
      expect(claim?.started).toBeNull();
      expect(claim?.chat.queuedMessages).toHaveLength(1);
    });

    it('backs off when another chat is running', async () => {
      await store.insertChat({ id: 'chat-b', workbenchId: WB, workspaceId: 'ws-a', title: 'B', agent: 'claude', status: 'running' });
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result).toEqual({ moved: false, reason: 'busy' });
      expect(await row()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });
      expect(fleet.log.filter((e) => e.kind === 'export')).toHaveLength(0);
    });

    it('does not count the chat whose turn asked for the move', async () => {
      await store.updateChat('chat-a', { status: 'running' });
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'low_disk', { ownerChatId: 'chat-a' });
      expect(result.moved).toBe(true);
    });
  });

  describe('a move that works', () => {
    it('exports, creates, imports, then deletes the old box, in that order', async () => {
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result.moved).toBe(true);
      const at = (kind: string, box?: string) => fleet.first(kind, box);
      expect(at('export', OLD_BOX)).toBeGreaterThanOrEqual(0);
      expect(at('export', OLD_BOX)).toBeLessThan(at('create', NEW_BOX));
      expect(at('create', NEW_BOX)).toBeLessThan(at('clone', NEW_BOX));
      expect(at('clone', NEW_BOX)).toBeLessThan(at('chunk', OLD_BOX));
      expect(at('chunk', OLD_BOX)).toBeLessThan(at('write', NEW_BOX));
      expect(at('write', NEW_BOX)).toBeLessThan(at('import', NEW_BOX));
      expect(at('import', NEW_BOX)).toBeLessThan(at('delete', OLD_BOX));
      expect(at('delete', OLD_BOX)).toBeLessThan(at('ref_delete', NEW_BOX));
      expect(fleet.log.some((e) => e.kind === 'delete' && e.box === NEW_BOX)).toBe(false);
    });

    it('leaves the row on the new box, ready, with every chat still resuming its conversation', async () => {
      await move.moveWorkbenchToFreshSandbox(await row(), 'disk_full');
      expect(await row()).toMatchObject({ status: 'ready', sandboxId: NEW_BOX, sandboxState: 'running', fleetHost: 'host-1' });
      expect(await store.getChat('chat-a')).toMatchObject({ agentSessionId: SESSION });
      const note = (await notes()).find((e) => e.subtype === 'sandbox_moved');
      expect(note?.text).toContain('Moved to a fresh sandbox (the disk was full).');
      expect(note?.text).toContain('restart any dev servers');
      expect(note?.text).toContain('data/big.bin');
    });

    it('sends each staged file in its own bytes and runs no export exec outside /dev/shm', async () => {
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      const exportExec = fleet.execs.find((e) => kindOf(e.script) === 'export')!;
      expect(exportExec.req.env).toMatchObject({
        TMPDIR: '/dev/shm', GIT_INDEX_FILE: `/dev/shm/talyn-move-${WB}.index`, GIT_OPTIONAL_LOCKS: '0',
      });
      const chunks = fleet.execs.filter((e) => kindOf(e.script) === 'chunk');
      expect(chunks.map((c) => c.req.env?.TMPDIR)).toEqual(['/dev/shm', '/dev/shm']);
      const written = fleet.execs
        .filter((e) => kindOf(e.script) === 'write')
        .flatMap((e) => Object.entries(e.req.env ?? {}).filter(([k]) => k.startsWith('TALYN_F')).map(([, v]) => v));
      expect(written.map((b) => Buffer.from(b, 'base64').toString())).toEqual([STAGED, AGENT]);
    });

    it('clears the conversation of a chat whose file was not on the old box', async () => {
      replies.export = { stdout: [...manifest(), `MISSING_SESSION ${SESSION}`] };
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(await store.getChat('chat-a')).toMatchObject({ agentSessionId: null });
    });

    it('starts a message that queued during the move', async () => {
      const claimed = move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden', {
        onClaim: () => void sendMessage('chat-a', { text: 'while moving' }),
      });
      await claimed;
      await vi.waitFor(() => expect(fleet.log.some((e) => e.kind === 'agent' && e.box === NEW_BOX)).toBe(true));
    });
  });

  describe('a move that fails keeps the old box', () => {
    it.each<[string, () => void, boolean]>([
      ['the export', () => { replies.export = { exitCode: 32, stderr: 'rejected' }; }, false],
      ['the manifest', () => { replies.export = { stdout: 'nothing useful' }; }, false],
      ['a transfer too large', () => {
        replies.export = { stdout: manifest([['agent.tgz', 'x']]).map((l) => l.replace(/^FILE agent.tgz 1/, `FILE agent.tgz ${move.MOVE_TRANSFER_MAX_BYTES + 1}`)) };
      }, false],
      ['the create', () => {
        fleet.createSandbox = async () => { throw new Error('no capacity'); };
      }, false],
      ['the clone', () => { replies.clone = { exitCode: 128, stderr: 'fatal: clone' }; }, true],
      ['a short chunk', () => { replies.chunk = { stdout: 'abc' }; }, true],
      ['a write', () => { replies.write = { exitCode: 1, stderr: 'disk' }; }, true],
      ['the import', () => { replies.import = { exitCode: 23, stderr: 'patch does not apply' }; }, true],
    ])('when %s fails', async (_step, arrange, createdNew) => {
      arrange();
      await store.updateWorkbench(WB, { statusMessage: 'before' });
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result).toMatchObject({ moved: false, reason: 'failed' });
      expect(await row()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX, statusMessage: 'before' });
      expect(fleet.deleted).not.toContain(OLD_BOX);
      expect(fleet.deleted.includes(NEW_BOX)).toBe(createdNew);
      expect((await notes()).some((e) => e.subtype === 'sandbox_move_failed')).toBe(true);
      expect(await store.getChat('chat-a')).toMatchObject({ agentSessionId: SESSION });
    });

    it('when the session is deleted during the move, deletes the new box and not the old one', async () => {
      replies.import = { exitCode: 0 };
      const origImport = fleet.handler;
      fleet.handler = async (script, req) => {
        if (kindOf(script) === 'import') await testDb.db.delete((await import('../db/schema.js')).workbenches);
        return origImport(script, req);
      };
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result.moved).toBe(false);
      expect(fleet.deleted).toEqual([NEW_BOX]);
    });

    it('takes the next generation after a failed move', async () => {
      replies.clone = { exitCode: 1 };
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      delete replies.clone;
      move.resetMovesForTests();
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect((await row()).sandboxId).toBe(`${OLD_BOX}-r2`);
    });

    it('undoes a move a dead process left, on the boot sweep', async () => {
      await store.claimMove(WB, OLD_BOX, NEW_BOX, 'x');
      expect(await move.sweepAbandonedMoves()).toBe(1);
      expect(await row()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });
      expect(fleet.deleted).toEqual([NEW_BOX]);
    });
  });

  describe('T1: a stale golden', () => {
    it.each<[Partial<FleetSandbox>, boolean]>([
      [{ status: 'suspended', goldenStale: true }, true],
      [{ status: 'suspended', goldenStale: false }, false],
      [{ status: 'suspended' }, false],
      [{ status: 'idle', goldenStale: true }, false],
      [{ status: 'busy', goldenStale: true }, false],
      [{ status: 'stopped', goldenStale: true }, false],
    ])('moves %o: %s', (sandbox, expected) => {
      expect(move.shouldMoveForStaleGolden(sandbox as FleetSandbox)).toBe(expected);
    });

    it('asks the fleet at most once per interval', async () => {
      fleet.sandbox = { status: 'idle', goldenStale: true };
      expect(await move.needsFreshGolden(await row())).toBe(false);
      expect(await move.needsFreshGolden(await row())).toBe(false);
      expect(fleet.getSandboxCalls).toBe(1);
    });

    it('moves before the turn wakes the box, and runs the turn on the new one', async () => {
      fleet.sandbox = { status: 'suspended', goldenStale: true };
      await sendMessage('chat-a', { text: 'go' });
      await vi.waitFor(() => expect(fleet.log.some((e) => e.kind === 'agent')).toBe(true), { timeout: 5000 });
      expect(fleet.first('export', OLD_BOX)).toBeLessThan(fleet.first('checkpoint'));
      expect(fleet.log.filter((e) => e.kind === 'checkpoint').every((e) => e.box === NEW_BOX)).toBe(true);
      expect(fleet.log.find((e) => e.kind === 'agent')?.box).toBe(NEW_BOX);
    });

    it('starts the move from a read and answers that the session is moving', async () => {
      fleet.sandbox = { status: 'suspended', goldenStale: true };
      expect(await move.startStaleGoldenMove(await row())).toBe(true);
      await vi.waitFor(async () => expect((await row()).sandboxId).toBe(NEW_BOX));
    });
  });

  describe('T2: low disk before a turn', () => {
    const lowCheckpoint = (avail: number): ExecReply => ({
      stdout: `${'c'.repeat(40)}\n`,
      stderr: `TALYN_DISK ${avail} ${16 * GIB}`,
    });

    it.each<[number, boolean]>([
      [LOW_DISK_BYTES - 1, true],
      [LOW_DISK_BYTES, false],
      [8 * GIB, false],
    ])('with %d bytes free, moves: %s', async (avail, moves) => {
      replies.checkpoint = lowCheckpoint(avail);
      await sendMessage('chat-a', { text: 'go' });
      await vi.waitFor(() => expect(fleet.log.some((e) => e.kind === 'agent')).toBe(true), { timeout: 5000 });
      expect(fleet.log.some((e) => e.kind === 'export')).toBe(moves);
      expect(fleet.log.find((e) => e.kind === 'agent')?.box).toBe(moves ? NEW_BOX : OLD_BOX);
    });

    it('grows the disk instead when the fleet can, and does not move', async () => {
      replies.checkpoint = lowCheckpoint(GIB);
      fleet.grow = 'grown';
      fleet.sandbox = { status: 'idle', diskMib: 16384 };
      await sendMessage('chat-a', { text: 'go' });
      await vi.waitFor(() => expect(fleet.log.some((e) => e.kind === 'agent')).toBe(true), { timeout: 5000 });
      expect(fleet.log.some((e) => e.kind === 'grow')).toBe(true);
      expect(fleet.log.some((e) => e.kind === 'export')).toBe(false);
    });
  });

  describe('T3: a full disk', () => {
    it('retries the failed exec once on the new box', async () => {
      let calls = 0;
      const base = fleet.handler;
      fleet.handler = (script, req) => {
        if (script === 'echo hi') {
          calls++;
          return calls === 1 ? { exitCode: 1, stderr: 'mktemp: No space left on device' } : { stdout: 'hi' };
        }
        return base(script, req);
      };
      const result = await runCapture(await row(), 'echo hi', { quiet: true });
      expect(result).toMatchObject({ exitCode: 0, stdout: 'hi' });
      expect(calls).toBe(2);
      expect(fleet.log.filter((e) => e.kind === 'other').at(-1)?.box).toBe(NEW_BOX);
    });

    it('retries only once', async () => {
      let calls = 0;
      const base = fleet.handler;
      fleet.handler = (script, req) => {
        if (script === 'echo hi') {
          calls++;
          return { exitCode: 1, stderr: 'write error: No space left on device' };
        }
        return base(script, req);
      };
      const result = await runCapture(await row(), 'echo hi', { quiet: true });
      expect(result.exitCode).toBe(1);
      expect(calls).toBe(2);
    });

    it('does nothing for an ordinary failure', async () => {
      const base = fleet.handler;
      fleet.handler = (script, req) => (script === 'false' ? { exitCode: 1, stderr: 'nope' } : base(script, req));
      await runCapture(await row(), 'false', { quiet: true });
      expect(fleet.log.some((e) => e.kind === 'export' || e.kind === 'probe')).toBe(false);
    });

    it('re-runs a turn that failed on a full disk once, on the new box', async () => {
      let turns = 0;
      const base = fleet.handler;
      fleet.handler = (script, req) => {
        if (kindOf(script) === 'agent') {
          turns++;
          if (turns === 1) return { exitCode: 1, stderr: 'Error: ENOSPC: no space left on device, write' };
        }
        return base(script, req);
      };
      await sendMessage('chat-a', { text: 'go' });
      await vi.waitFor(async () => expect((await store.getChat('chat-a'))?.status).toBe('idle'), { timeout: 5000 });
      expect(turns).toBe(2);
      expect(fleet.log.filter((e) => e.kind === 'agent').map((e) => e.box)).toEqual([OLD_BOX, NEW_BOX]);
      const userMessages = (await notes()).filter((e) => (e as { type?: string }).type === 'user');
      expect(userMessages).toHaveLength(1);
    });
  });
});
