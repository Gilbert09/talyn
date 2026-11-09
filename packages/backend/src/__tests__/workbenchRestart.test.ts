import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_SIZES } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, type ExecReply } from './helpers/fakeFleet.js';
import { repositories, workspaces } from '../db/schema.js';
import type { FleetExecFrame, FleetExecRequest, FleetSandbox } from '../services/selfHosted/client.js';

/**
 * Restarting a session: the request waits for the running turn, a move to a
 * fresh box of the same size applies it, and the new box gets the MCP servers
 * the workspace has now. Any move after the request answers it.
 */

/** The workspace's MCP servers as the store gives them to a box create. A test adds one. */
const servers: Array<Record<string, unknown>> = [];

vi.mock('../services/mcpServersAccess.js', () => ({ workspaceMayUseMcpServers: async () => true }));
vi.mock('../services/mcpServers/store.js', async (original) => ({
  ...(await original<typeof import('../services/mcpServers/store.js')>()),
  mcpServersForDispatch: async () => servers,
}));

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
const restart = await import('../services/workbenches/restart.js');
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

describe('restarting a session', () => {
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
    servers.length = 0;
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

  const POLAR = {
    id: 'm-polar', name: 'polar', url: 'https://mcp.polar.sh/mcp', description: null,
    authKind: 'bearer', inject: null, tools: null, secret: 'polar-key',
  };
  const createdServers = (i: number) =>
    ((fleet.created[i] as { mcpServers?: Array<{ name: string }> }).mcpServers ?? []).map((s) => s.name);

  describe('the request', () => {
    it('waits while a turn runs, and records the time and the reason', async () => {
      await store.updateChat('chat-a', { status: 'running' });
      const result = await restart.requestSessionRestart(await row(), { reason: '  load   the Polar server. ' });
      expect(result).toEqual({ outcome: 'after_turn' });
      const after = await settings();
      expect(typeof after.restartRequestedAt).toBe('string');
      expect(after.restartReason).toBe('load the Polar server.');
      expect(fleet.creates()).toEqual([]);
    });

    it('restarts at once when no turn runs, on a box of the same size with the current MCP servers', async () => {
      servers.push(POLAR);
      const result = await restart.requestSessionRestart(await row(), { reason: 'load the Polar server.' });
      expect(result.outcome).toBe('restarting');
      await moved();
      expect(fleet.creates()).toEqual([SANDBOX_SIZES.standard.memMib]);
      expect(createdServers(0)).toContain('polar');
      const after = await settings();
      expect(after.restartRequestedAt).toBeUndefined();
      expect(after.restartReason).toBeUndefined();
      expect(await notes('sandbox_moved')).toEqual([
        "Talyn restarted this session on a fresh sandbox: load the Polar server. It has the workspace's current MCP servers.",
      ]);
      expect(fleet.deleted).toContain(OLD_BOX);
    });

    it('a later request replaces the reason', async () => {
      await store.updateChat('chat-a', { status: 'running' });
      await restart.requestSessionRestart(await row(), { reason: 'first' });
      await restart.requestSessionRestart(await row(), {});
      const after = await settings();
      expect(typeof after.restartRequestedAt).toBe('string');
      expect(after.restartReason).toBeUndefined();
    });

    it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
      ['a reason that is not text', {}, { reason: 7 }, 'bad_reason'],
      ['a reason over the limit', {}, { reason: 'x'.repeat(restart.RESTART_REASON_MAX_CHARS + 1) }, 'bad_reason'],
      ['a thread', { kind: 'thread' }, {}, 'thread_restart'],
      ['a local session', { runtime: 'local' }, {}, 'local_runtime'],
      ['an archived session', { archivedAt: new Date() }, {}, 'archived'],
      ['a session that is still starting', { status: 'provisioning' }, {}, 'not_ready'],
      ['a session with no box', { sandboxId: null }, {}, 'not_ready'],
    ])('refuses %s', async (_name, patch, input, code) => {
      await store.updateWorkbench(WB, patch);
      const err = await restart.requestSessionRestart(await row(), input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorkbenchError);
      expect((err as InstanceType<typeof WorkbenchError>).code).toBe(code);
      expect((await settings()).restartRequestedAt).toBeUndefined();
    });
  });

  describe('applying it', () => {
    it('restarts at the next turn start, before the agent runs', async () => {
      await store.setPendingRestart(WB, new Date().toISOString(), null);
      servers.push(POLAR);
      await turns.sendMessage('chat-a', { text: 'go on' });
      await vi.waitFor(() => expect(fleet.first('agent')).toBeGreaterThanOrEqual(0), { timeout: 5000 });
      expect(fleet.first('agent', OLD_BOX)).toBe(-1);
      expect(fleet.first('create')).toBeLessThan(fleet.first('agent', NEW_BOX));
      expect(createdServers(0)).toContain('polar');
      expect(await notes('sandbox_moved')).toEqual([
        "Talyn restarted this session on a fresh sandbox. It has the workspace's current MCP servers.",
      ]);
      expect((await settings()).restartRequestedAt).toBeUndefined();
    });

    it('restarts after the running turn ends, and never during it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      replies.agent = async () => { await gate; return { stdout: claudeTurnLines(SESSION, 'done') }; };
      await turns.sendMessage('chat-a', { text: 'run the tests' });
      await vi.waitFor(() => expect(fleet.first('agent', OLD_BOX)).toBeGreaterThanOrEqual(0), { timeout: 5000 });
      expect((await restart.requestSessionRestart(await row(), {})).outcome).toBe('after_turn');
      await new Promise((r) => setTimeout(r, 50));
      expect(fleet.creates()).toEqual([]);
      release();
      await moved();
      expect(fleet.first('create')).toBeGreaterThan(fleet.first('agent', OLD_BOX));
      expect((await settings()).restartRequestedAt).toBeUndefined();
    });

    it('keeps the request while another chat runs, for the next turn start', async () => {
      await store.insertChat({ id: 'chat-b', workbenchId: WB, workspaceId: 'ws-a', title: 'B', agent: 'claude', status: 'running' });
      const at = new Date().toISOString();
      await store.setPendingRestart(WB, at, null);
      const after = await restart.applyPendingRestart(await row());
      expect(after.sandboxId).toBe(OLD_BOX);
      expect((await settings()).restartRequestedAt).toBe(at);
      expect(fleet.creates()).toEqual([]);
      await store.updateChat('chat-b', { status: 'idle' });
    });

    it('does nothing with no request', async () => {
      const before = await row();
      expect(await restart.applyPendingRestart(before)).toBe(before);
      expect(fleet.log).toEqual([]);
    });

    it('a resize answers a restart asked for before it, so the session moves once', async () => {
      await store.setPendingRestart(WB, new Date().toISOString(), 'load Polar');
      await store.setPendingResize(WB, 'large', null);
      await turns.sendMessage('chat-a', { text: 'go on' });
      await vi.waitFor(() => expect(fleet.first('agent')).toBeGreaterThanOrEqual(0), { timeout: 5000 });
      expect(fleet.creates()).toEqual([SANDBOX_SIZES.large.memMib]);
      const after = await settings();
      expect(after.restartRequestedAt).toBeUndefined();
      expect(after.resizeTo).toBeUndefined();
    });

    it('a failed restart keeps the old box, clears the request and says why', async () => {
      fleet.limitMib = 0;
      await store.setPendingRestart(WB, new Date().toISOString(), null);
      const after = await restart.applyPendingRestart(await row());
      expect(after.sandboxId).toBe(OLD_BOX);
      expect((await settings()).restartRequestedAt).toBeUndefined();
      expect((await settings()).moveFailures).toBeUndefined();
      const [text] = await notes('sandbox_restart_failed');
      expect(text).toMatch(/^Talyn did not restart this session on a fresh sandbox: .+\. It stays on its current sandbox\.$/);
      expect(fleet.deleted).not.toContain(OLD_BOX);
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
      await new Promise<void>((r) => server.listen(0, r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });

    const post = async (body: unknown, user = 'owner-a') => {
      const resp = await fetch(`${base}/workbenches/${WB}/restart`, {
        method: 'POST',
        headers: { 'x-user': user, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: resp.status, body: (await resp.json()) as any };
    };

    it('queues continueWith as a Talyn message while the turn runs', async () => {
      await store.updateChat('chat-a', { status: 'running' });
      const res = await post({ reason: 'load Polar', continueWith: 'Go on with the Polar work.' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ outcome: 'after_turn', continued: true });
      expect((await settings()).restartReason).toBe('load Polar');
      const queued = (await store.getChat('chat-a'))!.queuedMessages;
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ text: 'Go on with the Polar work.', origin: 'talyn' });
      expect(fleet.creates()).toEqual([]);
    });

    it('starts the continueWith turn at once on an idle session, and the restart comes first', async () => {
      servers.push(POLAR);
      const res = await post({ continueWith: 'Use Polar now.' });
      expect(res.body.data.continued).toBe(true);
      await vi.waitFor(() => expect(fleet.first('agent')).toBeGreaterThanOrEqual(0), { timeout: 5000 });
      expect(fleet.first('agent', OLD_BOX)).toBe(-1);
      expect(createdServers(0)).toContain('polar');
    });

    it.each([
      [{ reason: 4 }, 400],
      [{ continueWith: 5 }, 400],
    ])('refuses %j with %i', async (body, status) => {
      expect((await post(body)).status).toBe(status);
      expect((await settings()).restartRequestedAt).toBeUndefined();
    });

    it("refuses another owner's session", async () => {
      await seedUser(testDb.db, { id: 'owner-b' });
      expect((await post({}, 'owner-b')).status).toBeGreaterThanOrEqual(403);
      expect((await settings()).restartRequestedAt).toBeUndefined();
    });
  });
});
