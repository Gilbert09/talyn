import { eq } from 'drizzle-orm';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_SIZES, type SandboxSize } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, type ExecReply } from './helpers/fakeFleet.js';
import { repositories, workspaces } from '../db/schema.js';
import type { FleetExecFrame, FleetExecRequest, FleetSandbox } from '../services/selfHosted/client.js';

/**
 * Resizing a session: the request waits for the running turn, a move to a box
 * of the new size applies it, a refusal keeps the old box and says why, and
 * the repository can keep the size for new sessions.
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

vi.mock('../services/cloudProviders/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/cloudProviders/registry.js')>()),
  getCloudProvider: () => ({ type: 'selfhosted' }),
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
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { FleetThrottleError } = await import('../services/selfHosted/client.js');
const { WorkbenchError } = await import('../services/workbenches/errors.js');
const store = await import('../services/workbenches/store.js');
const move = await import('../services/workbenches/move.js');
const turns = await import('../services/workbenches/turns.js');
const resize = await import('../services/workbenches/resize.js');
const { sizeFallbackNote, sizeForSession } = await import('../services/workbenches/sandboxSize.js');
const { settleArchivesForTests } = await import('../services/workbenches/lifecycle.js');
const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

const WB = '11111111-2222-4333-8444-555555555555';
const OLD_BOX = 'talyn-wb-111111112222433384445555';
const NEW_BOX = `${OLD_BOX}-r1`;
const SESSION = '4f1c2b9e-1111-4222-8333-944455556666';
const HEAD = 'a'.repeat(40);
const GIB = 1024 * 1024 * 1024;
const b64 = (s: string) => Buffer.from(s).toString('base64');
const BODIES: Record<string, string> = { 'repo.bundle': 'bundle', 'staged.patch.gz': 'staged', 'unstaged.patch.gz': 'unstaged' };

function manifest(): string[] {
  return [
    `HEAD ${HEAD}`,
    `BRANCH ${b64('paris')}`,
    `UPSTREAM ${b64('origin/paris')}`,
    `REF ${HEAD} refs/heads/paris origin/paris`,
    ...Object.keys(BODIES).map((name, i) => `FILE ${name} ${Buffer.byteLength(BODIES[name])} ${String(i + 1).repeat(64)}`),
    'SKIPPED_COUNT 0',
    'END',
  ];
}

type Kind = 'stop' | 'export' | 'chunk' | 'clone' | 'checkpoint' | 'probe' | 'agent' | 'other';

function kindOf(script: string): Kind {
  if (script.includes('TALYN_PREFIX')) return 'stop';
  if (script.includes('git bundle create -')) return 'export';
  if (script.startsWith('dd if=')) return 'chunk';
  if (script.includes('git clone --filter=blob:none')) return 'clone';
  if (script.includes('git commit-tree')) return 'checkpoint';
  if (script.includes('TALYN_DISK') && script.includes('df -B1')) return 'probe';
  if (isAgentTurn(script)) return 'agent';
  return 'other';
}

/** The fake fleet, with every call logged by the box it went to, and a size limit. */
class ResizeFleet extends FakeFleet {
  log: Array<{ kind: Kind | 'create'; box: string; memMib?: number }> = [];
  memMib = SANDBOX_SIZES.standard.memMib;
  /** The tenant's limit: a create asking for more is refused, as YAS refuses it. */
  limitMib = Infinity;

  override async exec(id: string, req: FleetExecRequest): Promise<FleetExecFrame> {
    this.log.push({ kind: kindOf(req.env?.TALYN_DURABLE_SCRIPT ?? req.env?.TALYN_SCRIPT ?? ''), box: id });
    return super.exec(id, req);
  }

  override async *execFollow(id: string, req: FleetExecRequest, signal: AbortSignal): AsyncGenerator<FleetExecFrame> {
    this.log.push({ kind: kindOf(req.env?.TALYN_DURABLE_SCRIPT ?? req.env?.TALYN_SCRIPT ?? ''), box: id });
    yield* super.execFollow(id, req, signal);
  }

  override async createSandbox(input: Parameters<FakeFleet['createSandbox']>[0]) {
    this.log.push({ kind: 'create', box: input.id, memMib: input.memMib });
    if ((input.memMib ?? 0) > this.limitMib) {
      throw new FleetThrottleError(`tenant_memory: 4096 MiB held + ${input.memMib} MiB requested exceeds the ${this.limitMib} MiB permitted`);
    }
    return super.createSandbox(input);
  }

  override async getSandbox(id: string) {
    if (id !== OLD_BOX && !this.created.some((c) => c.id === id)) throw new Error('no such sandbox');
    return { sandbox: { id, status: 'idle', memMib: this.memMib } as FleetSandbox, terminal: false };
  }

  first(kind: string, box?: string): number {
    return this.log.findIndex((e) => e.kind === kind && (!box || e.box === box));
  }

  creates(): Array<number | undefined> {
    return this.log.filter((e) => e.kind === 'create').map((e) => e.memMib);
  }
}

describe('resizing a session', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: ResizeFleet;
  let replies: Partial<Record<Kind, ExecReply | (() => ExecReply | Promise<ExecReply>)>>;

  beforeEach(async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
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
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
    // No detection from GitHub: the repository's size is standard unless a test sets it.
    vi.spyOn(githubService, 'getRefSha').mockRejectedValue(new Error('offline'));
    replies = {};
    fleet = new ResizeFleet();
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
    // A real turn may still be finishing. A test that only marked the chat running has no turn to wait for.
    if (fleet.first('agent') >= 0) {
      await vi.waitFor(async () => expect((await store.getChat('chat-a'))?.status).not.toBe('running'), { timeout: 5000 });
    }
    await move.settleMovesForTests();
    await settleArchivesForTests();
    setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
    await testDb.cleanup();
  });

  const row = async () => (await store.getWorkbench(WB))!;
  const settings = async () => ((await row()).settings ?? {}) as Record<string, unknown>;
  const notes = async (subtype: string) =>
    (await store.listEvents('chat-a', 0, 500)).events
      .map((e) => e.event as { type?: string; subtype?: string; text?: string })
      .filter((e) => e.subtype === subtype)
      .map((e) => e.text);
  const moved = () => vi.waitFor(async () => expect((await row()).sandboxId).toBe(NEW_BOX), { timeout: 5000 });

  describe('the request', () => {
    it('waits while a turn runs, and records the size and the reason', async () => {
      await store.updateChat('chat-a', { status: 'running' });
      const result = await resize.requestSessionResize(await row(), { size: 'large', reason: '  pytest was   killed for memory. ' });
      expect(result).toEqual({ outcome: 'after_turn', size: 'large', rememberedForRepository: false });
      expect(await settings()).toMatchObject({ resizeTo: 'large', resizeReason: 'pytest was killed for memory.' });
      expect(fleet.creates()).toEqual([]);
    });

    it('moves at once when no turn runs, and tells the person why', async () => {
      const result = await resize.requestSessionResize(await row(), { size: 'large', reason: 'pytest was killed for memory.' });
      expect(result.outcome).toBe('moving');
      await moved();
      expect(fleet.creates()).toEqual([SANDBOX_SIZES.large.memMib]);
      expect(fleet.created[0]).toMatchObject({ milliVcpu: SANDBOX_SIZES.large.milliVcpu });
      const after = await settings();
      expect(after).toMatchObject({ sandboxSize: 'large' });
      expect(after.resizeTo).toBeUndefined();
      expect(after.resizeReason).toBeUndefined();
      expect(await notes('sandbox_moved')).toEqual(['Talyn moved this session to a Large · 12 GB sandbox: pytest was killed for memory.']);
      expect(fleet.deleted).toContain(OLD_BOX);
    });

    it('does nothing when the box already has the size, and drops a resize that waited', async () => {
      fleet.memMib = SANDBOX_SIZES.large.memMib;
      await store.setPendingResize(WB, 'xlarge', null);
      const result = await resize.requestSessionResize(await row(), { size: 'large' });
      expect(result.outcome).toBe('unchanged');
      expect((await settings()).resizeTo).toBeUndefined();
      expect(fleet.creates()).toEqual([]);
    });

    it('asks again when the fleet cannot say the size of the box', async () => {
      fleet.memMib = 0;
      await store.updateChat('chat-a', { status: 'running' });
      expect((await resize.requestSessionResize(await row(), { size: 'standard' })).outcome).toBe('after_turn');
    });

    it('a later request replaces the size and the reason', async () => {
      await store.updateChat('chat-a', { status: 'running' });
      await resize.requestSessionResize(await row(), { size: 'large', reason: 'first' });
      await resize.requestSessionResize(await row(), { size: 'medium' });
      const after = await settings();
      expect(after.resizeTo).toBe('medium');
      expect(after.resizeReason).toBeUndefined();
    });

    it('keeps the size as the repository default only when asked', async () => {
      await store.updateChat('chat-a', { status: 'running' });
      const result = await resize.requestSessionResize(await row(), { size: 'large', rememberForRepository: true });
      expect(result.rememberedForRepository).toBe(true);
      const [repo] = await testDb.db.select({ settings: repositories.settings }).from(repositories).where(eq(repositories.id, 'repo-a'));
      expect(repo.settings?.sandboxSize).toBe('large');
      expect(await sizeForSession({ repositoryId: 'repo-a', workspaceId: 'ws-a' })).toBe('large');
    });

    it('leaves the repository alone by default', async () => {
      await store.updateChat('chat-a', { status: 'running' });
      await resize.requestSessionResize(await row(), { size: 'large' });
      const [repo] = await testDb.db.select({ settings: repositories.settings }).from(repositories).where(eq(repositories.id, 'repo-a'));
      expect(repo.settings?.sandboxSize).toBeUndefined();
    });

    it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
      ['an unknown size', {}, { size: 'huge' }, 'bad_size'],
      ['no size', {}, {}, 'bad_size'],
      ['auto', {}, { size: 'auto' }, 'bad_size'],
      ['a reason that is not text', {}, { size: 'large', reason: 7 }, 'bad_reason'],
      ['a reason over the limit', {}, { size: 'large', reason: 'x'.repeat(resize.RESIZE_REASON_MAX_CHARS + 1) }, 'bad_reason'],
      ['a remember flag that is not a boolean', {}, { size: 'large', rememberForRepository: 'yes' }, 'bad_remember'],
      ['a thread', { kind: 'thread' }, { size: 'large' }, 'thread_resize'],
      ['a local session', { runtime: 'local' }, { size: 'large' }, 'local_runtime'],
      ['an archived session', { archivedAt: new Date() }, { size: 'large' }, 'archived'],
    ])('refuses %s', async (_name, patch, input, code) => {
      await store.updateWorkbench(WB, patch);
      const err = await resize.requestSessionResize(await row(), input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkbenchError);
      expect((err as InstanceType<typeof WorkbenchError>).code).toBe(code);
      expect((await settings()).resizeTo).toBeUndefined();
    });
  });

  describe('applying it', () => {
    it('moves at the next turn start, before the agent runs', async () => {
      await store.setPendingResize(WB, 'medium', null);
      await turns.sendMessage('chat-a', { text: 'go on' });
      await vi.waitFor(() => expect(fleet.first('agent')).toBeGreaterThanOrEqual(0), { timeout: 5000 });
      expect(fleet.first('agent', OLD_BOX)).toBe(-1);
      expect(fleet.first('create')).toBeLessThan(fleet.first('agent', NEW_BOX));
      expect(fleet.creates()).toEqual([SANDBOX_SIZES.medium.memMib]);
      expect(await notes('sandbox_moved')).toEqual(['Talyn moved this session to a Medium · 8 GB sandbox.']);
    });

    it('moves after the running turn ends, and never during it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      replies.agent = async () => { await gate; return { stdout: claudeTurnLines(SESSION, 'done') }; };
      await turns.sendMessage('chat-a', { text: 'run the tests' });
      await vi.waitFor(() => expect(fleet.first('agent', OLD_BOX)).toBeGreaterThanOrEqual(0), { timeout: 5000 });
      expect((await resize.requestSessionResize(await row(), { size: 'large' })).outcome).toBe('after_turn');
      await new Promise((r) => setTimeout(r, 50));
      expect(fleet.creates()).toEqual([]);
      expect((await row()).status).toBe('ready');
      release();
      await moved();
      expect(fleet.first('create')).toBeGreaterThan(fleet.first('agent', OLD_BOX));
      expect(fleet.creates()).toEqual([SANDBOX_SIZES.large.memMib]);
    });

    it('keeps the request while another chat runs, for the next turn start', async () => {
      await store.insertChat({ id: 'chat-b', workbenchId: WB, workspaceId: 'ws-a', title: 'B', agent: 'claude', status: 'running' });
      await store.setPendingResize(WB, 'large', null);
      const after = await resize.applyPendingResize(await row());
      expect(after.sandboxId).toBe(OLD_BOX);
      expect((await settings()).resizeTo).toBe('large');
      expect(fleet.creates()).toEqual([]);
      await store.updateChat('chat-b', { status: 'idle' });
    });

    it('does nothing with no request', async () => {
      const before = await row();
      expect(await resize.applyPendingResize(before)).toBe(before);
      expect(fleet.log).toEqual([]);
    });

    it('keeps the size on later boxes of the session', async () => {
      await store.setPendingResize(WB, 'large', null);
      await resize.applyPendingResize(await row());
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(fleet.creates()).toEqual([SANDBOX_SIZES.large.memMib, SANDBOX_SIZES.large.memMib]);
    });

    it('a move for another reason applies a waiting resize too', async () => {
      await store.setPendingResize(WB, 'medium', 'builds are slow');
      await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(fleet.creates()).toEqual([SANDBOX_SIZES.medium.memMib]);
      expect(await settings()).toMatchObject({ sandboxSize: 'medium' });
      expect((await settings()).resizeTo).toBeUndefined();
      expect(await notes('sandbox_moved')).toEqual(['Talyn moved this session to a Medium · 8 GB sandbox: builds are slow.']);
    });

    it('keeps a resize asked for during a move that made another size', async () => {
      await store.claimMove(WB, OLD_BOX, NEW_BOX, 'x');
      await store.setPendingResize(WB, 'xlarge', null);
      await store.commitMove(WB, OLD_BOX, { sandboxId: NEW_BOX, fleetHost: null, fleetSandboxId: null, statusMessage: null, size: 'standard' });
      expect((await settings()).resizeTo).toBe('xlarge');
    });
  });

  describe('a refusal', () => {
    it.each<[SandboxSize, number]>([
      ['xlarge', 12288],
      ['large', 8192],
    ])('keeps the old box for %s over a %i MiB limit, says why, and does not back off', async (size, limit) => {
      fleet.limitMib = limit;
      await store.setPendingResize(WB, size, 'tests need it');
      const after = await resize.applyPendingResize(await row());
      expect(after.sandboxId).toBe(OLD_BOX);
      expect(after.status).toBe('ready');
      // Asked exactly once: a resize never falls back to a standard box.
      expect(fleet.creates()).toEqual([SANDBOX_SIZES[size].memMib]);
      const s = await settings();
      expect(s.resizeTo).toBeUndefined();
      expect(s.sandboxSize).toBeUndefined();
      expect(s.moveFailures).toBeUndefined();
      expect(move.backingOff(after)).toBe(false);
      expect(await notes('sandbox_resize_failed')).toEqual([
        `Talyn did not move this session to a ${SANDBOX_SIZES[size].label} sandbox: the fleet allows at most ${limit} MiB. It stays on its current sandbox.`,
      ]);
      expect(fleet.deleted).not.toContain(OLD_BOX);
    });

    it('a failed move for another cause clears the request and says so', async () => {
      replies.clone = { exitCode: 128, stderr: 'fatal: could not read from remote' };
      await store.setPendingResize(WB, 'large', null);
      const after = await resize.applyPendingResize(await row());
      expect(after.sandboxId).toBe(OLD_BOX);
      expect((await settings()).resizeTo).toBeUndefined();
      const [text] = await notes('sandbox_resize_failed');
      expect(text).toMatch(/^Talyn did not move this session to a Large · 12 GB sandbox: the clone failed: .*fatal: could not read from remote\. It stays on its current sandbox\.$/);
      expect(fleet.deleted).toEqual([NEW_BOX]);
    });

    it('a non-resize move still falls back to standard, and names the session as the asker', async () => {
      await store.updateWorkbench(WB, { settings: { sandboxSize: 'xlarge' } });
      fleet.limitMib = 8192;
      const result = await move.moveWorkbenchToFreshSandbox(await row(), 'stale_golden');
      expect(result.moved).toBe(true);
      expect(fleet.creates()).toEqual([SANDBOX_SIZES.xlarge.memMib, SANDBOX_SIZES.standard.memMib]);
      expect(await notes('sandbox_size_fallback')).toEqual([
        'This session asks for X-Large · 16 GB, but the fleet allows at most 8192 MiB; using 4 GB.',
      ]);
    });

    it.each<[string, 'repository' | 'session' | undefined, string]>([
      ['the repository by default', undefined, 'This repository asks'],
      ['the repository', 'repository', 'This repository asks'],
      ['the session', 'session', 'This session asks'],
    ])('the fallback note names %s', (_name, asker, start) => {
      expect(sizeFallbackNote(new Error('nope'), 'large', asker)).toBe(`${start} for Large · 12 GB, but the fleet refused that size; using 4 GB.`);
    });
  });

  describe('the notes', () => {
    it.each<[string, Parameters<typeof move.movedNote>[0], string | null]>([
      ['a clean move', { reason: 'stale_golden', conversation: 'carried', stopped: false, manifest: { skipped: [], skippedCount: 0, skippedDirs: [] } }, null],
      ['a resize with a reason', {
        reason: 'resize', conversation: 'carried', stopped: false, manifest: { skipped: [], skippedCount: 0, skippedDirs: [] },
        resized: { size: 'xlarge', why: 'Kafka needs memory.' },
      }, 'Talyn moved this session to a X-Large · 16 GB sandbox: Kafka needs memory.'],
      ['a resize with no reason', {
        reason: 'resize', conversation: 'carried', stopped: false, manifest: { skipped: [], skippedCount: 0, skippedDirs: [] },
        resized: { size: 'small', why: null },
      }, 'Talyn moved this session to a Small · 2 GB sandbox.'],
      ['a resize that stopped processes', {
        reason: 'resize', conversation: 'carried', stopped: true, manifest: { skipped: [], skippedCount: 0, skippedDirs: [] },
        resized: { size: 'large' },
      }, 'Talyn moved this session to a Large · 12 GB sandbox. Running scripts and terminals were stopped; start them again.'],
    ])('%s', (_name, input, expected) => {
      expect(move.movedNote(input)).toBe(expected);
    });

    it.each([
      ['the fleet allows at most 8192 MiB', 'the fleet allows at most 8192 MiB'],
      ['ends with a period.', 'ends with a period'],
      [undefined, 'the move failed'],
    ])('the failure note reads %s', (why, shown) => {
      expect(resize.resizeFailedNote('large', why)).toBe(`Talyn did not move this session to a Large · 12 GB sandbox: ${shown}. It stays on its current sandbox.`);
    });
  });

  describe('the route', () => {
    let server: Server;
    let base: string;

    beforeEach(async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const id = req.headers['x-user'] as string;
        req.user = { id, email: `${id}@example.test`, isAdmin: false };
        next();
      });
      app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
      app.use(apiErrorHandler);
      server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    const put = async (body: unknown, user = 'owner-a') => {
      const resp = await fetch(`${base}/workbenches/${WB}/sandbox-size`, {
        method: 'PUT',
        headers: { 'x-user': user, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: resp.status, body: (await resp.json()) as any };
    };

    it('queues continueWith as a Talyn message while the turn runs, and moves before that turn', async () => {
      await store.updateChat('chat-a', { status: 'running' });
      const res = await put({ size: 'large', continueWith: 'Run the tests again.' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ outcome: 'after_turn', size: 'large', rememberedForRepository: false, continued: true });
      const queued = (await store.getChat('chat-a'))!.queuedMessages;
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ text: 'Run the tests again.', origin: 'talyn' });
      expect(fleet.creates()).toEqual([]);
    });

    it('starts the continueWith turn at once on an idle session, and the move comes first', async () => {
      const res = await put({ size: 'large', continueWith: 'Run the tests again.' });
      expect(res.body.data.continued).toBe(true);
      await vi.waitFor(() => expect(fleet.first('agent')).toBeGreaterThanOrEqual(0), { timeout: 5000 });
      expect(fleet.first('agent', OLD_BOX)).toBe(-1);
      expect(fleet.creates()).toEqual([SANDBOX_SIZES.large.memMib]);
    });

    it('sends no message when nothing moves', async () => {
      fleet.memMib = SANDBOX_SIZES.large.memMib;
      const res = await put({ size: 'large', continueWith: 'Run the tests again.' });
      expect(res.body.data).toMatchObject({ outcome: 'unchanged', continued: false });
      expect((await store.getChat('chat-a'))!.queuedMessages).toEqual([]);
    });

    it.each([
      [{ size: 'huge' }, 400],
      [{ size: 'large', continueWith: 5 }, 400],
    ])('refuses %j with %i', async (body, status) => {
      expect((await put(body)).status).toBe(status);
    });

    it("refuses another owner's session", async () => {
      await seedUser(testDb.db, { id: 'owner-b' });
      expect((await put({ size: 'large' }, 'owner-b')).status).toBeGreaterThanOrEqual(403);
      expect((await settings()).resizeTo).toBeUndefined();
    });
  });
});
