import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, type ExecReply } from './helpers/fakeFleet.js';
import { repositories, workspaces } from '../db/schema.js';
import type { FleetExecFrame, FleetExecRequest, FleetSandbox } from '../services/selfHosted/client.js';

/**
 * Moving a session to a fresh sandbox: the claim and its lease, the order of a
 * move, every failure keeping the old box, the commit that nothing after it
 * may undo, and the three triggers.
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
const turns = await import('../services/workbenches/turns.js');
const { SESSION_SANDBOX_MEM_MIB } = await import('../services/workbenches/lifecycle.js');
const { LOW_DISK_BYTES } = await import('../services/workbenches/execFailures.js');

const WB = '11111111-2222-4333-8444-555555555555';
const OLD_BOX = 'talyn-wb-111111112222433384445555';
const NEW_BOX = `${OLD_BOX}-r1`;
const SESSION = '4f1c2b9e-1111-4222-8333-944455556666';
const HEAD = 'a'.repeat(40);
const GIB = 1024 * 1024 * 1024;
const b64 = (s: string) => Buffer.from(s).toString('base64');

type Kind =
  | 'stop'
  | 'export'
  | 'chunk'
  | 'clone'
  | 'write'
  | 'import'
  | 'config'
  | 'drop'
  | 'checkpoint'
  | 'probe'
  | 'agent'
  | 'other';

function kindOf(script: string): Kind {
  if (script.includes('TALYN_PREFIX')) return 'stop';
  if (script.includes('git bundle create -')) return 'export';
  if (script.startsWith('dd if=')) return 'chunk';
  if (script.includes('git clone --filter=blob:none')) return 'clone';
  if (script.includes('base64 -d')) return 'write';
  if (script.includes('sha256sum -c')) return 'import';
  if (script.includes('cat .talyn/settings.toml')) return 'config';
  if (script.startsWith('rm -rf -- /dev/shm/talyn-move-')) return 'drop';
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
  failDelete = new Set<string>();

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
    if (this.failDelete.has(id)) throw new Error('fleet is down');
    return super.deleteSandbox(id);
  }

  async getSandbox(id: string) {
    this.getSandboxCalls++;
    if (id !== OLD_BOX && id !== NEW_BOX) throw new Error('no such sandbox');
    if (id === NEW_BOX && !this.created.some((c) => c.id === NEW_BOX)) throw new Error('no such sandbox');
    return { sandbox: { id, ...this.sandbox } as FleetSandbox, terminal: false };
  }

  async growSandboxDisk(id: string) {
    this.log.push({ kind: 'grow', box: id });
    return this.grow;
  }

  first(kind: string, box?: string): number {
    return this.log.findIndex((e) => e.kind === kind && (!box || e.box === box));
  }

  has(kind: string, box?: string): boolean {
    return this.first(kind, box) >= 0;
  }
}

const BODIES: Record<string, string> = {
  'repo.bundle': 'bundle-bytes',
  'staged.patch.gz': 'staged-bytes',
  'unstaged.patch.gz': 'unstaged',
  'agent.tgz': 'agent-archive',
};

function manifest(opts: { files?: string[]; extra?: string[]; end?: boolean } = {}): string[] {
  const files = opts.files ?? ['repo.bundle', 'staged.patch.gz', 'unstaged.patch.gz', 'agent.tgz'];
  return [
    `HEAD ${HEAD}`,
    `BRANCH ${b64('paris')}`,
    `UPSTREAM ${b64('origin/paris')}`,
    `REF ${HEAD} refs/heads/paris origin/paris`,
    `REF ${'b'.repeat(40)} refs/stash`,
    `REF ${'c'.repeat(40)} refs/talyn/checkpoints/chat-a/1`,
    ...files.map((name, i) => `FILE ${name} ${Buffer.byteLength(BODIES[name] ?? 'x')} ${String(i + 1).repeat(64)}`),
    `SKIPDIR ${b64('node_modules')} 120`,
    ...(opts.extra ?? []),
    'SKIPPED_COUNT 1',
    `SKIPPED ${b64('data/big.bin')}`,
    ...(opts.end === false ? [] : ['END']),
  ];
}

describe('moving a session to a fresh sandbox', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: MoveFleet;
  let replies: Partial<Record<Kind, ExecReply | (() => ExecReply | Promise<ExecReply>)>>;

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
    fleet.handler = async (script) => {
      const kind = kindOf(script);
      const reply = replies[kind];
      if (reply) return typeof reply === 'function' ? reply() : reply;
      if (kind === 'export') return { stdout: manifest() };
      if (kind === 'chunk') {
        const name = Object.keys(BODIES).find((n) => script.includes(`/${n} `));
        return { stdout: name ? BODIES[name] : '' };
      }
      if (kind === 'checkpoint') return { stdout: `${'c'.repeat(40)}\n`, stderr: `TALYN_DISK ${10 * GIB} ${16 * GIB}` };
      if (kind === 'probe') return { stderr: `TALYN_DISK ${10 * GIB} ${16 * GIB}` };
      if (kind === 'agent') return { stdout: claudeTurnLines(SESSION, 'done') };
      if (kind === 'stop') return { stdout: '0' };
      return { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
  });

  afterEach(async () => {
    await move.settleMovesForTests();
    setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  const row = async () => (await store.getWorkbench(WB))!;
  const events = async (chatId = 'chat-a') =>
    (await store.listEvents(chatId, 0, 200)).events.map((e) => e.event as { type?: string; subtype?: string; text?: string });
  const settings = async () => ((await row()).settings ?? {}) as Record<string, unknown>;
  const ageLease = (iso: string) =>
    testDb.db.execute(sql`UPDATE workbenches SET settings = settings || jsonb_build_object('moveHeartbeatAt', ${iso}::text)`);

  describe('the claim and its lease', () => {
    it('lets one of two concurrent moves win', async () => {
      const [a, b] = await Promise.all([
        store.claimMove(WB, OLD_BOX, NEW_BOX, 'x'),
        store.claimMove(WB, OLD_BOX, NEW_BOX, 'x'),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await settings()).toMatchObject({ moveSandboxId: NEW_BOX, moveHeartbeatAt: expect.any(String) });
    });

    it.each([
      ['error', OLD_BOX],
      ['provisioning', OLD_BOX],
      ['ready', 'some-other-box'],
    ])('refuses a workbench in %s on %s', async (status, sandboxId) => {
      await store.updateWorkbench(WB, { status });
      expect(await store.claimMove(WB, sandboxId, NEW_BOX, 'x')).toBeNull();
    });

    it('commits and releases only the move the row is in', async () => {
      await store.claimMove(WB, OLD_BOX, NEW_BOX, 'x');
      const other = `${OLD_BOX}-r7`;
      expect(await store.commitMove(WB, OLD_BOX, { sandboxId: other, fleetHost: null, fleetSandboxId: null, statusMessage: null })).toBeNull();
      expect(await store.releaseMove(WB, OLD_BOX, other, null)).toBeNull();
      expect(await store.heartbeatMove(WB, OLD_BOX, other)).toBe(false);
      expect(await row()).toMatchObject({ status: 'moving', sandboxId: OLD_BOX });
      expect(await store.releaseMove(WB, OLD_BOX, NEW_BOX, null)).not.toBeNull();
    });

    it('does not start a turn while the workbench is moving, and keeps the message queued', async () => {
      await store.claimMove(WB, OLD_BOX, NEW_BOX, 'x');
      const claim = await store.claimOrEnqueue('chat-a', { id: 'm1', text: 'hi', queuedAt: new Date().toISOString() }, true);
      expect(claim?.started).toBeNull();
      expect(claim?.chat.queuedMessages).toHaveLength(1);
    });

    it('queues a turn again when a move claimed the workbench after the turn did', async () => {
      const claim = await store.claimOrEnqueue('chat-a', { id: 'm1', text: 'hi', queuedAt: new Date().toISOString() }, true);
      expect(claim?.started).not.toBeNull();
      await store.claimMove(WB, OLD_BOX, NEW_BOX, 'x');
      turns.launchTurnLoopForTests('chat-a', claim!.started!);
      await vi.waitFor(async () => expect(await store.getChat('chat-a')).toMatchObject({ status: 'idle', turnCount: 0 }));
      expect((await store.getChat('chat-a'))?.queuedMessages.map((m) => m.id)).toEqual(['m1']);
      expect((await events()).some((e) => e.type === 'result')).toBe(false);
    });

    it('backs off when another chat is running, and starts what queued meanwhile', async () => {
      await store.insertChat({ id: 'chat-b', workbenchId: WB, workspaceId: 'ws-a', title: 'B', agent: 'claude', status: 'running' });
      await store.updateChat('chat-a', { queuedMessages: [{ id: 'q1', text: 'go', queuedAt: new Date().toISOString() }] });
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result).toEqual({ moved: false, reason: 'busy' });
      expect(await row()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });
      expect(fleet.has('export')).toBe(false);
      await vi.waitFor(() => expect(fleet.has('agent', OLD_BOX)).toBe(true));
    });

    it('does not count the chat whose turn asked for the move', async () => {
      await store.updateChat('chat-a', { status: 'running' });
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'low_disk', { ownerChatId: 'chat-a' });
      expect(result.moved).toBe(true);
    });

    it('the sweep leaves a move with a fresh lease alone', async () => {
      await store.claimMove(WB, OLD_BOX, NEW_BOX, 'x');
      expect(await move.sweepAbandonedMoves()).toBe(0);
      expect(await row()).toMatchObject({ status: 'moving' });
      expect(fleet.deleted).toEqual([]);
    });

    it('the sweep undoes a move whose lease lapsed, and deletes its half-made box', async () => {
      await store.claimMove(WB, OLD_BOX, NEW_BOX, 'x');
      await ageLease(new Date(Date.now() - (move.LEASE_STALE_SECONDS + 5) * 1000).toISOString());
      expect(await move.sweepAbandonedMoves()).toBe(1);
      expect(await row()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });
      expect(await settings()).not.toHaveProperty('moveHeartbeatAt');
      expect(fleet.deleted).toEqual([NEW_BOX]);
      expect(fleet.has('drop', OLD_BOX)).toBe(true);
    });
  });

  describe('a move that works', () => {
    it('stops the old box, exports, creates, imports, then deletes the old box, in that order', async () => {
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result.moved).toBe(true);
      const at = (kind: string, box?: string) => fleet.first(kind, box);
      expect(at('stop', OLD_BOX)).toBeGreaterThanOrEqual(0);
      expect(at('stop', OLD_BOX)).toBeLessThan(at('export', OLD_BOX));
      expect(at('export', OLD_BOX)).toBeLessThan(at('create', NEW_BOX));
      expect(at('create', NEW_BOX)).toBeLessThan(at('clone', NEW_BOX));
      expect(at('clone', NEW_BOX)).toBeLessThan(at('chunk', OLD_BOX));
      expect(at('chunk', OLD_BOX)).toBeLessThan(at('write', NEW_BOX));
      expect(at('write', NEW_BOX)).toBeLessThan(at('import', NEW_BOX));
      expect(at('import', NEW_BOX)).toBeLessThan(at('delete', OLD_BOX));
      expect(fleet.has('delete', NEW_BOX)).toBe(false);
    });

    it('asks for the session memory ceiling on the new box', async () => {
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(fleet.created[0]).toMatchObject({ id: NEW_BOX, memMib: SESSION_SANDBOX_MEM_MIB });
      expect(SESSION_SANDBOX_MEM_MIB).toBe(4096);
    });

    it('leaves the row on the new box with the lease and backoff cleared', async () => {
      await store.recordMoveFailure(WB);
      await move.moveWorkbenchToFreshSandbox(await row(), 'disk_full');
      expect(await row()).toMatchObject({ status: 'ready', sandboxId: NEW_BOX, sandboxState: 'running', fleetHost: 'host-1' });
      const s = await settings();
      expect(s).toMatchObject({ moveSandboxId: NEW_BOX, movedForDiskTo: NEW_BOX });
      for (const key of ['moveHeartbeatAt', 'moveTargetHost', 'moveFailedAt', 'moveFailures']) expect(s).not.toHaveProperty(key);
    });

    it('sends each staged file as its own bytes, and runs the old box execs with /dev/shm', async () => {
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      const exportExec = fleet.execs.find((e) => kindOf(e.script) === 'export')!;
      expect(exportExec.req.env).toMatchObject({
        TMPDIR: '/dev/shm', GIT_INDEX_FILE: `/dev/shm/talyn-move-${WB}.index`, GIT_OPTIONAL_LOCKS: '0',
      });
      const written = fleet.execs
        .filter((e) => kindOf(e.script) === 'write')
        .flatMap((e) => Object.entries(e.req.env ?? {}).filter(([k]) => k.startsWith('TALYN_F')).map(([, v]) => v));
      expect(written.map((v) => Buffer.from(v, 'base64').toString())).toEqual(Object.values(BODIES));
      const imported = fleet.execs.find((e) => kindOf(e.script) === 'import')!.script;
      expect(imported).toContain("git fetch --quiet --no-tags \"$d/repo.bundle\" '+refs/*:refs/talyn-import/*'");
      expect(imported).toContain(`git stash store -q -m 'Moved from the old sandbox' ${'b'.repeat(40)}`);
      expect(imported).toContain(`git update-ref refs/talyn/checkpoints/chat-a/1 ${'c'.repeat(40)}`);
    });

    it('writes a note that is true of each chat', async () => {
      await store.insertChat({ id: 'chat-new', workbenchId: WB, workspaceId: 'ws-a', title: 'New', agent: 'claude' });
      await move.moveWorkbenchToFreshSandbox(await row(), 'disk_full');
      const withSession = (await events('chat-a')).find((e) => e.subtype === 'sandbox_moved')!.text!;
      expect(withSession).toContain('Moved to a fresh sandbox (the disk was full).');
      expect(withSession).toContain('This conversation came along');
      expect(withSession).toContain('node_modules (1 folder, 120 files)');
      expect(withSession).toContain('data/big.bin');
      const without = (await events('chat-new')).find((e) => e.subtype === 'sandbox_moved')!.text!;
      expect(without).not.toContain('conversation');
      expect(await store.getChat('chat-a')).toMatchObject({ agentSessionId: SESSION });
    });

    it('says the conversation did not come along when its file was missing, and forgets it', async () => {
      replies.export = { stdout: manifest({ extra: [`MISSING_SESSION ${SESSION}`] }) };
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      const text = (await events()).find((e) => e.subtype === 'sandbox_moved')!.text!;
      expect(text).toContain('could not be found, so the agent starts fresh');
      expect(text).not.toContain('This conversation came along');
      expect(await store.getChat('chat-a')).toMatchObject({ agentSessionId: null });
    });

    it('says when it stopped scripts and terminals first', async () => {
      replies.stop = { stdout: '2' };
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect((await events()).find((e) => e.subtype === 'sandbox_moved')!.text).toContain(
        'Talyn stopped the running scripts and terminals first',
      );
    });

    it('keeps the new box when a step after the commit throws', async () => {
      fleet.failDelete.add(OLD_BOX);
      replies.other = () => {
        throw new Error('diff exploded');
      };
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result.moved).toBe(true);
      expect(await row()).toMatchObject({ status: 'ready', sandboxId: NEW_BOX });
      expect(fleet.has('delete', NEW_BOX)).toBe(false);
      expect((await events()).some((e) => e.subtype === 'sandbox_move_failed')).toBe(false);
    });

    it('treats a commit whose answer was lost as committed', async () => {
      replies.import = async () => {
        // The commit lands, and then the step fails as if its answer never came.
        await store.updateWorkbench(WB, { status: 'ready', sandboxId: NEW_BOX });
        return { exitCode: 1, stderr: 'connection reset' };
      };
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result.moved).toBe(true);
      expect(fleet.has('delete', NEW_BOX)).toBe(false);
      expect(fleet.has('delete', OLD_BOX)).toBe(true);
      expect(await row()).toMatchObject({ sandboxId: NEW_BOX });
    });
  });

  describe('a move that fails keeps the old box', () => {
    it.each<[string, () => void, boolean]>([
      ['the export', () => { replies.export = { exitCode: 36, stderr: 'bundle failed' }; }, false],
      ['a manifest with no END', () => { replies.export = { stdout: manifest({ end: false }) }; }, false],
      ['a manifest with a stray line', () => { replies.export = { stdout: ['oops', ...manifest()] }; }, false],
      ['a manifest missing the unstaged patch', () => {
        replies.export = { stdout: manifest({ files: ['staged.patch.gz'] }) };
      }, false],
      ['a transfer too large', () => {
        replies.export = { stdout: manifest().map((l) => l.replace(/^FILE agent.tgz \d+/, `FILE agent.tgz ${move.MOVE_TRANSFER_MAX_BYTES + 1}`)) };
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
      expect((await events()).some((e) => e.subtype === 'sandbox_move_failed')).toBe(true);
      expect(await store.getChat('chat-a')).toMatchObject({ agentSessionId: SESSION });
      expect(await settings()).toMatchObject({ moveFailures: 1, moveFailedAt: expect.any(String) });
    });

    it.each([
      [41, 'a rebase, merge, cherry-pick or bisect is in progress'],
      [42, 'there are commits with Git LFS files that are not pushed'],
    ])('does not move, and says why, when the export exits %d', async (exitCode, why) => {
      replies.export = { exitCode, stderr: 'IN_PROGRESS rebase-merge' };
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result).toMatchObject({ moved: false, reason: 'blocked' });
      expect(fleet.has('create')).toBe(false);
      const blocked = (await events()).find((e) => e.subtype === 'sandbox_move_blocked');
      expect(blocked?.text).toContain(why);
      expect(await row()).toMatchObject({ status: 'ready', sandboxId: OLD_BOX });
    });

    it('when the session is deleted during the move, deletes the new box and not the old one', async () => {
      replies.import = async () => {
        await testDb.db.execute(sql`DELETE FROM workbenches`);
        return { exitCode: 0 };
      };
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result.moved).toBe(false);
      expect(fleet.deleted).toEqual([NEW_BOX]);
    });

    it('takes the next generation after a failed move', async () => {
      replies.clone = { exitCode: 1 };
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      delete replies.clone;
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect((await row()).sandboxId).toBe(`${OLD_BOX}-r2`);
    });
  });

  describe('the failure backoff', () => {
    it.each<[number, number, boolean]>([
      [1, 29, true],
      [1, 31, false],
      [3, 119, true],
      [3, 121, false],
      [20, 23 * 60, true],
      [20, 25 * 60, false],
    ])('after %d failure(s), %d minutes later, waits: %s', (failures, minutes, waits) => {
      const now = Date.parse('2026-10-27T12:00:00Z');
      const failedAt = new Date(now - minutes * 60_000).toISOString();
      expect(move.backingOff({ settings: { moveFailures: failures, moveFailedAt: failedAt } as never }, now)).toBe(waits);
    });

    it('is read from the row, so it outlives the process', async () => {
      replies.clone = { exitCode: 1 };
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      move.resetMovesForTests();
      fleet.sandbox = { status: 'suspended', goldenStale: true };
      fleet.getSandboxCalls = 0;
      expect(await move.needsFreshGolden(await row())).toBe(false);
      expect(fleet.getSandboxCalls).toBe(0);
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
      await turns.sendMessage('chat-a', { text: 'go' });
      await vi.waitFor(() => expect(fleet.has('agent')).toBe(true), { timeout: 5000 });
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
      await turns.sendMessage('chat-a', { text: 'go' });
      await vi.waitFor(() => expect(fleet.has('agent')).toBe(true), { timeout: 5000 });
      expect(fleet.has('export')).toBe(moves);
      expect(fleet.log.find((e) => e.kind === 'agent')?.box).toBe(moves ? NEW_BOX : OLD_BOX);
    });

    it('grows the disk instead when the fleet can, and does not move', async () => {
      replies.checkpoint = lowCheckpoint(GIB);
      fleet.grow = 'grown';
      fleet.sandbox = { status: 'idle', diskMib: 16384 };
      await turns.sendMessage('chat-a', { text: 'go' });
      await vi.waitFor(() => expect(fleet.has('agent')).toBe(true), { timeout: 5000 });
      expect(fleet.has('grow')).toBe(true);
      expect(fleet.has('export')).toBe(false);
    });

    it('does not move a box a disk move made and that is on the newest golden; says so once', async () => {
      await store.mergeWorkbenchSettings(WB, { movedForDiskTo: OLD_BOX });
      replies.checkpoint = lowCheckpoint(GIB);
      fleet.sandbox = { status: 'idle', goldenStale: false };
      for (const text of ['one', 'two']) {
        await vi.waitFor(async () => expect((await store.getChat('chat-a'))?.status).not.toBe('running'));
        await turns.sendMessage('chat-a', { text });
        await vi.waitFor(async () => expect((await store.getChat('chat-a'))?.status).toBe('idle'), { timeout: 5000 });
      }
      expect(fleet.has('export')).toBe(false);
      expect((await events()).filter((e) => e.subtype === 'sandbox_low_disk')).toHaveLength(1);
    });
  });

  describe('T3: a full disk', () => {
    const enospc = (calls: { n: number }, failFirstOnly: boolean) => {
      const base = fleet.handler;
      fleet.handler = (script, req) => {
        if (script === 'echo hi') {
          calls.n++;
          return failFirstOnly && calls.n > 1 ? { stdout: 'hi' } : { exitCode: 1, stderr: 'mktemp: No space left on device' };
        }
        return base(script, req);
      };
    };

    it('does nothing for an exec that did not opt in', async () => {
      const calls = { n: 0 };
      enospc(calls, true);
      const result = await runCapture(await row(), 'echo hi', { quiet: true });
      expect(result.exitCode).toBe(1);
      expect(calls.n).toBe(1);
      expect(fleet.has('probe') || fleet.has('export')).toBe(false);
    });

    it('runs an opted-in exec once more on the same box after a grow', async () => {
      const calls = { n: 0 };
      enospc(calls, true);
      fleet.grow = 'grown';
      let probes = 0;
      replies.probe = () => ({ stderr: `TALYN_DISK ${++probes === 1 ? GIB / 2 : 10 * GIB} ${16 * GIB}` });
      const result = await runCapture(await row(), 'echo hi', { quiet: true, diskRecovery: true });
      expect(result).toMatchObject({ exitCode: 0, stdout: 'hi' });
      expect(calls.n).toBe(2);
      expect(fleet.log.filter((e) => e.kind === 'other').every((e) => e.box === OLD_BOX)).toBe(true);
    });

    it('never runs it again on a different box: without a grow it moves in the background and returns the failure', async () => {
      const calls = { n: 0 };
      enospc(calls, false);
      replies.probe = { stderr: `TALYN_DISK ${GIB / 2} ${16 * GIB}` };
      const result = await runCapture(await row(), 'echo hi', { quiet: true, diskRecovery: true });
      expect(result.exitCode).toBe(1);
      expect(calls.n).toBe(1);
      await vi.waitFor(async () => expect((await row()).sandboxId).toBe(NEW_BOX));
      expect(calls.n).toBe(1);
    });

    it('does not run a failed turn again; moves and asks the user to send it again', async () => {
      replies.agent = () => {
        throw new Error('Talyn Fleet refused the request: harness_error: ENOSPC: no space left on device');
      };
      await turns.sendMessage('chat-a', { text: 'go' });
      await vi.waitFor(async () => expect((await row()).sandboxId).toBe(NEW_BOX), { timeout: 5000 });
      await vi.waitFor(async () => expect((await store.getChat('chat-a'))?.status).toBe('error'));
      expect(fleet.log.filter((e) => e.kind === 'agent')).toHaveLength(1);
      expect((await events()).some((e) => e.text === turns.DISK_FULL_MOVED_NOTE)).toBe(true);
    });

    it('ignores the words in the agent’s own output', async () => {
      replies.agent = { exitCode: 1, stdout: claudeTurnLines(SESSION, 'I saw "No space left on device" in the logs'), stderr: 'ENOSPC' };
      await turns.sendMessage('chat-a', { text: 'go' });
      await vi.waitFor(async () => expect((await store.getChat('chat-a'))?.status).not.toBe('running'), { timeout: 5000 });
      expect(fleet.has('export')).toBe(false);
      expect(fleet.has('grow')).toBe(false);
      expect((await row()).sandboxId).toBe(OLD_BOX);
    });
  });
});
