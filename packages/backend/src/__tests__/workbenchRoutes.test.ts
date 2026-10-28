import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { eq } from 'drizzle-orm';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, isTitleScript, type ExecReply } from './helpers/fakeFleet.js';
import { pullRequests, repositories, workspaces } from '../db/schema.js';
import { resolveWorkbenchConfig } from '@talyn/shared';

/**
 * The workbench routes, end to end against a fake fleet: the gate, tenancy,
 * provisioning, the turn queue, the transcript, cancel, archive and the
 * local-runtime split.
 */

const emitted: Array<{ workspaceId: string; type: string; payload: unknown }> = [];

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: (workspaceId: string, event: { type: string; payload: unknown }) => {
    emitted.push({ workspaceId, type: event.type, payload: event.payload });
  },
}));

let creds: { claudeToken?: string; openaiKey?: string } | null = { claudeToken: 'sk-ant-oat-claude', openaiKey: 'oa-codex' };
let reauth: string[] = [];
let fleetRegistered = true;

vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  getSelfHostedCredentials: async () => creds,
  fleetAgentStatus: async () => ({
    connectedAgents: [...(creds?.claudeToken ? ['claude'] : []), ...(creds?.openaiKey ? ['codex'] : [])],
    reauthAgents: reauth,
  }),
}));

vi.mock('../services/cloudProviders/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/cloudProviders/registry.js')>()),
  getCloudProvider: () => (fleetRegistered ? { type: 'selfhosted' } : null),
}));

vi.mock('../services/repoDefaultBranch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/repoDefaultBranch.js')>()),
  reconcileDefaultBranch: async (input: { stored: string }) => input.stored || 'main',
}));

const { settleArchivesForTests } = await import('../services/workbenches/lifecycle.js');
const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { githubService } = await import('../services/github.js');
const { refreshDiffStat } = await import('../services/workbenches/changes.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { sandboxIdFor, setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { getChat, getWorkbench, listChats, updateChat, updateWorkbench, rowToWorkbench } = await import('../services/workbenches/store.js');
const { ORPHAN_MESSAGE, sweepOrphanedTurns, turnMarker } = await import('../services/workbenches/turns.js');
const { resolveRunCredentials } = await import('../services/selfHosted/runCredentials.js');
const { FleetNotDeployedError } = await import('../services/selfHosted/credentials.js');
const { FleetCapacityError, FleetHttpError } = await import('../services/selfHosted/client.js');
const { buildSandboxCreateBody } = await import('../services/selfHosted/sandboxRun.js');

/** A response body read loosely: these tests assert on shapes the routes define, field by field. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

interface Json {
  status: number;
  body: { success: boolean; data?: Loose; error?: string; code?: string };
}

describe('workbench routes', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let fleet: FakeFleet;

  async function call(method: string, path: string, body?: unknown, user = 'owner-a'): Promise<Json> {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: (await resp.json()) as Json['body'] };
  }

  /** A fleet whose box has a repository with no config and an agent that answers `text`. */
  function scriptedFleet(turn: (script: string) => ExecReply | Promise<ExecReply> | null = () => null): void {
    fleet.handler = async (script) => {
      const custom = await turn(script);
      if (custom) return custom;
      if (isAgentTurn(script) || isAgentTurn(script, 'codex')) {
        return { stdout: claudeTurnLines('sess-1', 'done') };
      }
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
  }

  async function createSandboxWorkbench(extra: Record<string, unknown> = {}): Promise<Loose> {
    const res = await call('POST', '/workbenches', {
      workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude', ...extra,
    });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect((await getWorkbench(res.body.data.id))?.status).toBe('ready'), { timeout: 5000 });
    return res.body.data;
  }

  async function createLocalWorkbench(): Promise<Loose> {
    const res = await call('POST', '/workbenches', {
      workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'local', agent: 'claude', deviceId: 'dev-1', localPath: '/tmp/wt',
    });
    expect(res.status).toBe(200);
    return res.body.data;
  }

  const chatIdOf = async (workbenchId: string) => (await listChats(workbenchId))[0].id;
  const idle = (chatId: string) =>
    vi.waitFor(async () => expect((await getChat(chatId))?.status).not.toBe('running'), { timeout: 5000 });

  beforeEach(async () => {
    emitted.length = 0;
    creds = { claudeToken: 'sk-ant-oat-claude', openaiKey: 'oa-codex' };
    reauth = [];
    fleetRegistered = true;
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    // A deployed fleet, by the registry path. Readiness reads only these.
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main' },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'other/app', url: 'https://github.com/other/app', defaultBranch: 'main' },
    ]);
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    fleet = new FakeFleet();
    scriptedFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());

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
    await settleArchivesForTests();
    setWorkbenchFleetClientForTests(null);
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  describe('the gate', () => {
    it.each([
      ['GET', '/workbenches?workspaceId=ws-a'],
      ['POST', '/workbenches'],
    ])('refuses %s %s with 403 when the flag is off', async (method, path) => {
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await call(method, path, method === 'POST' ? { workspaceId: 'ws-a' } : undefined);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('workbenches_unavailable');
    });

    it('refuses every route on an existing workbench when the flag is turned off afterwards', async () => {
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      for (const [method, path] of [
        ['GET', `/workbenches/${wb.id}`],
        ['GET', `/workbenches/${wb.id}/changes`],
        ['POST', `/workbenches/chats/${chatId}/messages`],
        ['GET', `/workbenches/chats/${chatId}/events`],
        ['POST', `/workbenches/${wb.id}/archive`],
        ['DELETE', `/workbenches/${wb.id}`],
      ]) {
        expect((await call(method, path, method === 'POST' ? { text: 'x' } : undefined)).status, `${method} ${path}`).toBe(403);
      }
    });

    it('requires a workspaceId to list', async () => {
      expect((await call('GET', '/workbenches')).status).toBe(400);
    });
  });

  describe('tenancy', () => {
    it("answers 404 for another owner's workspace, workbench and chat", async () => {
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      const asB = (method: string, path: string, body?: unknown) => call(method, path, body, 'owner-b');
      for (const [method, path, body] of [
        ['GET', '/workbenches?workspaceId=ws-a', undefined],
        ['GET', `/workbenches/${wb.id}`, undefined],
        ['PATCH', `/workbenches/${wb.id}`, { name: 'mine-now' }],
        ['DELETE', `/workbenches/${wb.id}`, undefined],
        ['POST', `/workbenches/${wb.id}/archive`, undefined],
        ['POST', `/workbenches/${wb.id}/chats`, {}],
        ['GET', `/workbenches/${wb.id}/file?path=a`, undefined],
        ['POST', `/workbenches/${wb.id}/scripts/run`, undefined],
        ['POST', `/workbenches/${wb.id}/actions/fix_checks`, undefined],
        ['POST', `/workbenches/${wb.id}/pull-request`, { title: 't', base: 'main' }],
        ['GET', `/workbenches/${wb.id}/ports/3000/x`, undefined],
        ['POST', `/workbenches/chats/${chatId}/messages`, { text: 'hi' }],
        ['POST', `/workbenches/chats/${chatId}/cancel`, undefined],
        ['GET', `/workbenches/chats/${chatId}/events`, undefined],
        ['GET', `/workbenches/chats/${chatId}/checkpoints`, undefined],
        ['DELETE', `/workbenches/chats/${chatId}`, undefined],
        ['POST', `/workbenches/chats/${chatId}/local-events`, { events: [] }],
        ['PATCH', `/workbenches/chats/${chatId}/local`, { status: 'idle' }],
      ] as const) {
        expect((await asB(method, path, body)).status, `${method} ${path}`).toBe(404);
      }
      expect(await getWorkbench(wb.id)).not.toBeNull();
    });

    it("refuses a repository or a pull request from another workspace", async () => {
      const repo = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-b', runtime: 'sandbox', agent: 'claude',
      });
      expect(repo.status).toBe(400);
      await testDb.db.insert(pullRequests).values({
        id: 'pr-b', workspaceId: 'ws-b', repositoryId: 'repo-b', owner: 'other', repo: 'app', number: 1, state: 'open',
        lastSummary: { headBranch: 'feature' },
      });
      const pr = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude', fromPullRequestId: 'pr-b',
      });
      expect(pr.status).toBe(400);
      expect(fleet.created).toEqual([]);
    });
  });

  describe('creating', () => {
    it('records the fleet sandbox id and keeps other settings', async () => {
      const createSandbox = fleet.createSandbox.bind(fleet);
      fleet.createSandbox = async (input) => {
        const created = await createSandbox(input);
        return { ...created, sandbox: { ...created.sandbox, id: `${input.id}--3542ee` } };
      };
      const wb = await createSandboxWorkbench({ internetAccess: false });
      expect((await getWorkbench(wb.id))?.settings).toEqual({
        internetAccess: false,
        fleetSandboxId: `${sandboxIdFor(wb.id)}--3542ee`,
      });
    });

    it('answers at once as provisioning, then clones and becomes ready', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      scriptedFleet(async (script) => {
        if (script.includes('git clone')) await held;
        return null;
      });
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude',
      });
      expect(res.body.data).toMatchObject({
        status: 'provisioning', sandboxState: 'creating', runtime: 'sandbox', repoFullName: 'acme/app',
        baseBranch: 'main', sandboxId: `${sandboxIdFor(res.body.data.id)}`, error: null,
      });
      expect(res.body.data.branch).toBe(res.body.data.name);
      expect(res.body.data.chats).toHaveLength(1);
      release();
      await vi.waitFor(async () => expect((await getWorkbench(res.body.data.id))?.status).toBe('ready'));
      const row = await getWorkbench(res.body.data.id);
      expect(row).toMatchObject({ sandboxState: 'running', fleetHost: 'host-1', statusMessage: null });
      const clone = fleet.scripts.find((s) => s.includes('git clone'))!;
      expect(clone).toContain('https://github.com/acme/app.git /work/app');
      const statuses = emitted.filter((e) => e.type === 'workbench:updated').map((e) => (e.payload as Loose).workbench.status);
      expect(statuses[0]).toBe('provisioning');
      expect(statuses[statuses.length - 1]).toBe('ready');
    });

    it.each([
      ['claude', 'anthropic', { anthropicKey: 'sk-ant-oat-claude' }, 'openaiKey', { openai: 'none' }],
      ['codex', 'openai', { openaiKey: 'oa-codex' }, 'anthropicKey', { anthropic: 'none' }],
    ] as const)(
      'creates a bare %s box with its own key and the other vendor suppressed',
      async (agent, provider, key, otherKey, suppressed) => {
        const wb = await createSandboxWorkbench({ agent });
        const body = fleet.created[0];
        expect(body).toMatchObject({ id: `${sandboxIdFor(wb.id)}`, workspaceId: 'ws-a', provider, githubToken: 'gh-token', ...key });
        expect(body).not.toHaveProperty(otherKey);
        expect(body.policy).toEqual({ credentials: suppressed, egress: { mode: 'open' } });
        // Bare and long-lived: no task, and no `ephemeral` to stop it after one.
        expect(body).not.toHaveProperty('task');
        expect(body).not.toHaveProperty('ephemeral');
        // With no task to carry task.repo, the box names its repository at the
        // top level. Without it the fleet proxy refuses the commit, checks and
        // review-thread endpoints that Create PR and Fix checks need.
        expect(body.repo).toBe('acme/app');
      },
    );

    it("names the repository's DEFAULT branch for the golden, never the session's base", async () => {
      await testDb.db.update(repositories).set({ defaultBranch: 'trunk' }).where(eq(repositories.id, 'repo-a'));
      const wb = await createSandboxWorkbench({ baseBranch: 'release/2' });
      expect((await getWorkbench(wb.id))?.baseBranch).toBe('release/2');
      const body = fleet.created[0];
      expect(body.repo).toBe('acme/app');
      expect(body.baseBranch).toBe('trunk');
      expect(body).not.toHaveProperty('task');
    });

    it.each([
      ['a bare box with a repo', { repo: 'acme/app' }, 'trunk'],
      ['a bare box with no repo', {}, undefined],
      ['a task dispatch', { repo: 'acme/app', task: { taskType: 'code_writing', prompt: 'x', repo: { slug: 'acme/app', baseBranch: 'trunk' } } }, undefined],
    ] as const)('sends a top-level baseBranch only for %s', async (_name, extra, expected) => {
      const built = await buildSandboxCreateBody({
        id: 'sb-1', workspaceId: 'ws-a', provider: 'anthropic', model: 'Claude',
        creds: { claudeToken: 'sk-ant-oat-claude' }, githubToken: 'gh', mcpServerIds: null,
        baseBranch: 'trunk', ...extra,
      });
      if (!built.ok) throw new Error(built.error);
      expect(built.body.baseBranch).toBe(expected);
    });

    it.each([
      [undefined, true],
      [true, true],
      [false, false],
    ] as const)('stores internetAccess %s and creates the box with access %s', async (flag, open) => {
      const wb = await createSandboxWorkbench(flag === undefined ? {} : { internetAccess: flag });
      expect((await getWorkbench(wb.id))?.settings).toEqual(flag === undefined ? {} : { internetAccess: flag });
      expect(fleet.created[0].policy?.egress).toEqual(open ? { mode: 'open' } : undefined);
    });

    it.each(['false', 1, null, {}])('rejects a non-boolean internetAccess value: %s', async (internetAccess) => {
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude', internetAccess,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('internetAccess must be a boolean');
      expect(fleet.created).toEqual([]);
    });

    it.each([
      ['claude', { openaiKey: 'oa-codex' }],
      ['codex', { claudeToken: 'sk-ant-oat-claude' }],
    ] as const)('refuses a %s workbench when that subscription is not connected', async (agent, held) => {
      creds = held;
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('agent_not_connected');
      expect(fleet.created).toEqual([]);
    });

    it('fails visibly, with the reason, when the clone fails', async () => {
      scriptedFleet((script) => (script.includes('git clone') ? { exitCode: 128, stderr: 'fatal: repository not found' } : null));
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude',
      });
      await vi.waitFor(async () => expect((await getWorkbench(res.body.data.id))?.status).toBe('error'));
      const got = await call('GET', `/workbenches/${res.body.data.id}`);
      expect(got.body.data.error).toContain('repository not found');
    });

    it('puts the workspace branch prefix on a new branch, never on an explicit one', async () => {
      await testDb.db.update(workspaces).set({ settings: { sessionBranchPrefix: 'tom/' } }).where(eq(workspaces.id, 'ws-a'));
      const fresh = await createSandboxWorkbench();
      expect(fresh.branch).toBe(`tom/${fresh.name}`);
      const named = await createSandboxWorkbench({ branch: 'feat/thing' });
      expect(named.branch).toBe('feat/thing');
      expect(named.name).not.toContain('/');
    });

    it.each([
      ['weak words are dropped', 'look at the flaky login test', 'tom/flaky-login-test'],
      ['a pull request link leads', 'review https://github.com/acme/app/pull/42 for races', 'tom/pr-42-review-races'],
      ['no usable word falls back to the session name', 'can you please do this', null],
    ])('names a new branch from the prompt: %s', async (_label, prompt, expected) => {
      await testDb.db.update(workspaces).set({ settings: { sessionBranchPrefix: 'tom/' } }).where(eq(workspaces.id, 'ws-a'));
      const wb = await createSandboxWorkbench({ prompt });
      expect(wb.branch).toBe(expected ?? `tom/${wb.name}`);
    });

    it('keeps an explicit branch when there is a prompt', async () => {
      const wb = await createSandboxWorkbench({ prompt: 'look at the flaky login test', branch: 'feat/thing' });
      expect(wb.branch).toBe('feat/thing');
    });

    it('starts from a pull request on its head branch, linked', async () => {
      await testDb.db.insert(pullRequests).values({
        id: 'pr-a', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'acme', repo: 'app', number: 42, state: 'open',
        lastSummary: { headBranch: 'feat/thing', baseBranch: 'develop', mergeable: 'MERGEABLE', ciStatus: 'failing_required' },
      });
      const wb = await createSandboxWorkbench({ fromPullRequestId: 'pr-a' });
      expect(wb).toMatchObject({ branch: 'feat/thing', baseBranch: 'develop', pullRequestId: 'pr-a' });
      const got = await call('GET', `/workbenches/${wb.id}`);
      expect(got.body.data.pr).toMatchObject({ number: 42, state: 'open', ciStatus: 'failure' });
    });

    it.each([
      [{ runtime: 'cloud' }, /runtime/],
      [{ agent: 'gemini' }, /agent/],
      [{ branch: 'bad..name' }, /branch/],
      [{ baseBranch: '-x' }, /baseBranch/],
      [{ name: 'Not Valid' }, /name/],
      [{ runtime: 'local' }, /deviceId/],
      [{ repositoryId: 'nope' }, /repository/],
    ])('refuses %j', async (override, message) => {
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude', ...override,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });

    it('refuses a second live workbench with a name already in use', async () => {
      await createSandboxWorkbench({ name: 'oslo' });
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude', name: 'oslo',
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('name_taken');
    });

    it('runs the first prompt once the box is ready', async () => {
      const wb = await createSandboxWorkbench({ prompt: 'add a readme' });
      const chatId = await chatIdOf(wb.id);
      await vi.waitFor(async () => expect((await getChat(chatId))?.turnCount).toBe(1));
      await idle(chatId);
      const events = await call('GET', `/workbenches/chats/${chatId}/events`);
      expect(events.body.data.events[0].event).toMatchObject({
        type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'add a readme' }] },
      });
    });
  });

  describe('a turn', () => {
    it.each(['claude', 'codex'] as const)('resolves a repo image for %s', async (agent) => {
      const wb = await createSandboxWorkbench({ agent });
      const chatId = await chatIdOf(wb.id);
      const attachment = { name: 'shot.png', mimeType: 'image/png', path: '.context/attachments/shot.png' };
      expect((await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'Review this', attachments: [attachment] })).status).toBe(200);
      await idle(chatId);
      const turn = fleet.execs.find((entry) => isAgentTurn(entry.script, agent))!;
      if (agent === 'codex') expect(turn.script).toContain('-i /work/app/.context/attachments/shot.png');
      else expect(turn.script).toContain('/work/app/.context/attachments/shot.png (image/png)');
    });

    it.each([1, 2, 50])('stores the stream in order with %i event(s) per frame, ignoring other commands', async (frameSize) => {
      fleet.frameSize = frameSize;
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      const sent = await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'hello' });
      expect(sent.body.data).toEqual({ queued: false });
      await idle(chatId);

      const page = await call('GET', `/workbenches/chats/${chatId}/events`);
      const events = page.body.data.events;
      expect(events.map((e: Loose) => e.event.type)).toEqual(['user', 'system', 'assistant', 'result']);
      expect(events.map((e: Loose) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(events.every((e: Loose) => e.turn === 1 && e.event.seq === e.seq)).toBe(true);
      // The other command's line carried a different nonce and never got in.
      expect(JSON.stringify(events)).not.toContain('foreign');
      expect(page.body.data.cursor).toBe(4);

      const chat = await getChat(chatId);
      expect(chat).toMatchObject({ status: 'idle', agentSessionId: 'sess-1', turnCount: 1 });
      const live = emitted.filter((e) => e.type === 'workbench:event').flatMap((e) => (e.payload as Loose).events);
      expect(live.map((e: Loose) => e.seq)).toEqual([1, 2, 3, 4]);
    });

    it('copies switched-on instruction files in before the CLI, and a failed copy does not fail the turn', async () => {
      const { putInstructionFile } = await import('../services/workbenches/instructions.js');
      await putInstructionFile('ws-a', {
        key: 'claude-user', agent: 'claude', target: 'user', sourcePath: '~/.claude/CLAUDE.md', content: 'be terse', enabled: true,
      });
      scriptedFleet((script) => (script.includes('.claude/rules') ? { exitCode: 1, stderr: 'disk full' } : null));
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'hi' });
      await idle(chatId);
      const sync = fleet.execs.findIndex((e) => e.script.includes('.claude/rules'));
      const turn = fleet.execs.findIndex((e) => isAgentTurn(e.script));
      expect(sync).toBeGreaterThan(-1);
      expect(sync).toBeLessThan(turn);
      expect(fleet.execs[sync].req.env?.TALYN_F0).toBe(Buffer.from('be terse').toString('base64'));
      expect(await getChat(chatId)).toMatchObject({ status: 'idle', statusMessage: null });
    });

    it('runs no instruction sync for a workspace that never stored a file', async () => {
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'hi' });
      await idle(chatId);
      expect(fleet.execs.some((e) => e.script.includes('.claude/rules') || e.script.includes('AGENTS.md'))).toBe(false);
    });

    it('runs claude as a sandbox turn: checkpoint, fresh credentials, then the CLI', async () => {
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: "- fix 'it'", planMode: true, model: 'claude-opus-5', effort: 'high' });
      await idle(chatId);
      const turn = fleet.execs.find((e) => isAgentTurn(e.script))!;
      expect(turn.follow).toBe(false);
      expect(turn.script).toContain('--permission-mode plan');
      expect(turn.script).toContain('--model claude-opus-5');
      expect(turn.script).toContain('--effort high');
      expect(turn.script).not.toContain('--resume');
      expect(turn.script.endsWith(`-- '- fix '\\''it'\\'''`)).toBe(true);
      expect(turn.req.cwd).toBe('/work/app');
      expect(turn.req.env).toMatchObject({ IS_SANDBOX: '1', TALYN_WORKBENCH_NAME: wb.name, CONDUCTOR_PORT: '3000' });
      expect(turn.req.env?.TALYN_PID_FILE).toContain(turnMarker(chatId));
      // The checkpoint ran before the agent, and the credentials are the box's vendor only.
      const order = fleet.scripts.map((s) => (s.includes('git commit-tree') ? 'checkpoint' : isAgentTurn(s) ? 'agent' : ''));
      expect(order.indexOf('checkpoint')).toBeLessThan(order.indexOf('agent'));
      expect(fleet.credentialPushes[0].creds).toEqual({ githubToken: 'gh-token', anthropicKey: 'sk-ant-oat-claude', repo: 'acme/app' });
      const cps = await call('GET', `/workbenches/chats/${chatId}/checkpoints`);
      expect(cps.body.data).toMatchObject([{ turn: 1, sha: 'c'.repeat(40), ref: `refs/talyn/checkpoints/${chatId}/1` }]);

      // The second turn resumes the session the first one reported.
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'again' });
      await vi.waitFor(async () => expect((await getChat(chatId))?.turnCount).toBe(2));
      await idle(chatId);
      const second = fleet.execs.filter((e) => isAgentTurn(e.script))[1];
      expect(second.script).toContain('--resume sess-1');
      expect(second.script).toContain('--permission-mode bypassPermissions');
      // No effort on the message or the chat runs at High.
      expect(second.script).toContain('--effort high');
    });

    it('queues messages sent while a turn runs and drains them in order', async () => {
      const releases: Array<() => void> = [];
      const prompts: string[] = [];
      scriptedFleet((script) => {
        if (!isAgentTurn(script)) return null;
        prompts.push(script.slice(script.lastIndexOf('-- ') + 3));
        return { stdout: claudeTurnLines('sess-1', 'ok'), hold: new Promise<void>((r) => releases.push(r)) };
      });
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      const post = (text: string) => call('POST', `/workbenches/chats/${chatId}/messages`, { text });

      expect((await post('one')).body.data).toEqual({ queued: false });
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      expect((await post('two')).body.data).toEqual({ queued: true });
      expect((await post('three')).body.data).toEqual({ queued: true });
      expect((await getChat(chatId))?.queuedMessages.map((m) => m.text)).toEqual(['two', 'three']);

      releases[0]();
      await vi.waitFor(() => expect(releases).toHaveLength(2));
      expect((await getChat(chatId))?.queuedMessages.map((m) => m.text)).toEqual(['three']);
      releases[1]();
      await vi.waitFor(() => expect(releases).toHaveLength(3));
      releases[2]();
      await idle(chatId);

      expect(prompts).toEqual(['one', 'two', 'three']);
      const page = await call('GET', `/workbenches/chats/${chatId}/events`);
      const users = page.body.data.events.filter((e: Loose) => e.event.type === 'user');
      expect(users.map((e: Loose) => [e.turn, e.event.message.content[0].text])).toEqual([[1, 'one'], [2, 'two'], [3, 'three']]);
      expect((await getChat(chatId))).toMatchObject({ status: 'idle', turnCount: 3, queuedMessages: [] });
    });

    it('removes a queued message before it runs', async () => {
      let release!: () => void;
      scriptedFleet((script) =>
        isAgentTurn(script)
          ? { stdout: claudeTurnLines('s', 'ok'), hold: new Promise<void>((r) => (release = r)) }
          : null,
      );
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'one' });
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'two' });
      const queued = (await getChat(chatId))!.queuedMessages[0];
      const removed = await call('DELETE', `/workbenches/chats/${chatId}/queue/${queued.id}`);
      expect(removed.body.data.queuedMessages).toEqual([]);
      release();
      await idle(chatId);
      expect((await getChat(chatId))?.turnCount).toBe(1);
    });

    it('marks the chat as an error, with the reason in the transcript, when the agent fails', async () => {
      scriptedFleet((script) =>
        isAgentTurn(script) ? { stdout: [], stderr: 'Error: invalid API key', exitCode: 1 } : null,
      );
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'go' });
      await idle(chatId);
      expect(await getChat(chatId)).toMatchObject({ status: 'error', statusMessage: 'Error: invalid API key' });
      const page = await call('GET', `/workbenches/chats/${chatId}/events`);
      expect(page.body.data.events.at(-1).event).toMatchObject({ type: 'result', is_error: true, result: 'Error: invalid API key' });
    });

    it('refuses the turn, without running the agent, when the subscription has gone', async () => {
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      creds = { openaiKey: 'oa-codex' };
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'go' });
      await idle(chatId);
      expect((await getChat(chatId))?.status).toBe('error');
      expect((await getChat(chatId))?.statusMessage).toMatch(/Claude subscription/);
      expect(fleet.scripts.some((s) => isAgentTurn(s))).toBe(false);
      // Never a push with the key left out, which the gateway would fill from its own custody.
      expect(fleet.credentialPushes).toEqual([]);
    });

    it.each([
      [{ text: '' }, 400],
      [{ text: '   ' }, 400],
      [{}, 400],
      [{ text: 'x', effort: 'extreme' }, 400],
      [{ text: 'x', attachments: [{ name: 'a' }] }, 400],
    ])('refuses the message %j', async (body, status) => {
      const wb = await createSandboxWorkbench();
      const res = await call('POST', `/workbenches/chats/${await chatIdOf(wb.id)}/messages`, body);
      expect(res.status).toBe(status);
    });
  });

  describe('cancel', () => {
    it('stops the agent by its marker, keeps the queue, and does not drain it', async () => {
      let kill!: () => void;
      let started = false;
      scriptedFleet((script) => {
        if (isAgentTurn(script)) {
          started = true;
          return { stdout: [claudeTurnLines('sess-9', 'x')[0]], hold: new Promise<void>((_r, reject) => (kill = () => reject(new Error('killed')))) };
        }
        return null;
      });
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'long job' });
      await vi.waitFor(() => expect(started).toBe(true));
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'later' });

      fleet.handler = ((prev) => async (script, req) => {
        if (script.includes('send INT')) {
          expect(req.env?.TALYN_MARKER).toBe(turnMarker(chatId));
          kill();
          return { exitCode: 0 };
        }
        return prev(script, req);
      })(fleet.handler);
      const res = await call('POST', `/workbenches/chats/${chatId}/cancel`);
      expect(res.status).toBe(200);
      await idle(chatId);

      const chat = await getChat(chatId);
      expect(chat).toMatchObject({ status: 'idle', statusMessage: 'Cancelled', turnCount: 1, agentSessionId: 'sess-9' });
      expect(chat?.queuedMessages.map((m) => m.text)).toEqual(['later']);
      const page = await call('GET', `/workbenches/chats/${chatId}/events`);
      expect(page.body.data.events.at(-1).event).toMatchObject({ type: 'result', subtype: 'cancelled' });
    });

    it('is a no-op on an idle chat', async () => {
      const wb = await createSandboxWorkbench();
      const before = fleet.scripts.length;
      expect((await call('POST', `/workbenches/chats/${await chatIdOf(wb.id)}/cancel`)).status).toBe(200);
      expect(fleet.scripts.length).toBe(before);
    });

    it('settles a turn a dead process left running, and says why', async () => {
      const wb = await createSandboxWorkbench();
      const chatId = await chatIdOf(wb.id);
      await updateChat(chatId, { status: 'running', turnCount: 1,
        turnOwner: 'previous-instance', turnHeartbeatAt: new Date(Date.now() - 91_000) });
      const before = fleet.scripts.length;
      expect(await sweepOrphanedTurns()).toBe(1);
      await vi.waitFor(async () => expect(await getChat(chatId)).toMatchObject({ status: 'error', statusMessage: ORPHAN_MESSAGE }));
      expect(fleet.scripts.slice(before).some((script) => script.includes('pkill'))).toBe(false);
      const page = await call('GET', `/workbenches/chats/${chatId}/events`);
      expect(page.body.data.events.at(-1).event.result).toBe(ORPHAN_MESSAGE);
      expect(await sweepOrphanedTurns()).toBe(0);
    });
  });

  describe('chats', () => {
    it('adds, edits and closes a chat, and a closed one leaves the embedded list', async () => {
      const wb = await createSandboxWorkbench();
      const added = await call('POST', `/workbenches/${wb.id}/chats`, { title: 'Second', planMode: true, effort: 'low' });
      expect(added.body.data).toMatchObject({ title: 'Second', planMode: true, effort: 'low', agent: 'claude', status: 'idle' });
      const edited = await call('PATCH', `/workbenches/chats/${added.body.data.id}`, { title: 'Renamed', model: null, effort: null, planMode: false });
      expect(edited.body.data).toMatchObject({ title: 'Renamed', model: null, effort: null, planMode: false });
      expect((await call('GET', `/workbenches/${wb.id}`)).body.data.chats).toHaveLength(2);

      expect((await call('DELETE', `/workbenches/chats/${added.body.data.id}`)).status).toBe(200);
      const list = await call('GET', '/workbenches?workspaceId=ws-a');
      expect(list.body.data[0].chats.map((c: Loose) => c.title)).toEqual(['Chat']);
      expect((await call('POST', `/workbenches/chats/${added.body.data.id}/messages`, { text: 'x' })).body.code).toBe('chat_closed');
    });

    it.each([
      [{ title: '' }],
      [{ effort: 'nope' }],
      [{ planMode: 'yes' }],
      [{ model: 5 }],
    ])('refuses the chat patch %j', async (patch) => {
      const wb = await createSandboxWorkbench();
      expect((await call('PATCH', `/workbenches/chats/${await chatIdOf(wb.id)}`, patch)).status).toBe(400);
    });
  });

  describe('archive and restore', () => {
    it('answers immediately, then saves and deletes the box', async () => {
      const wb = await createSandboxWorkbench();
      scriptedFleet((script) => (script.includes('PUSHED_BRANCH') ? { stdout: 'PUSHED_BRANCH 3\nSAVED_WORK\n' } : null));
      const res = await call('POST', `/workbenches/${wb.id}/archive`);
      expect(res.body.data).toMatchObject({ status: 'archived' });
      await settleArchivesForTests();
      expect((await getWorkbench(wb.id))?.sandboxState).toBe('deleted');
      expect(res.body.data.archivedAt).toBeTruthy();
      expect(fleet.deleted).toEqual([`${sandboxIdFor(wb.id)}`]);
      const save = fleet.scripts.findIndex((s) => s.includes(`git push origin HEAD:refs/heads/${wb.branch}`));
      expect(save).toBeGreaterThan(-1);
      expect((await call('GET', '/workbenches?workspaceId=ws-a')).body.data).toEqual([]);
      expect((await call('GET', '/workbenches?workspaceId=ws-a&includeArchived=true')).body.data).toHaveLength(1);
    });

    it('keeps the box when the work could not be saved', async () => {
      const wb = await createSandboxWorkbench();
      scriptedFleet((script) => (script.includes('PUSHED_BRANCH') ? { exitCode: 1, stderr: 'remote: Permission denied' } : null));
      const res = await call('POST', `/workbenches/${wb.id}/archive`);
      expect(res.status).toBe(200);
      await settleArchivesForTests();
      expect((await getWorkbench(wb.id))?.statusMessage).toContain('Permission denied');
      expect(fleet.deleted).toEqual([]);
      expect((await getWorkbench(wb.id))?.archivedAt).not.toBeNull();
    });

    it('restores onto a new box, forgets the old sessions, and puts the saved work back', async () => {
      const wb = await createSandboxWorkbench({ internetAccess: false });
      const chatId = await chatIdOf(wb.id);
      await updateChat(chatId, { agentSessionId: 'old-session' });
      await call('POST', `/workbenches/${wb.id}/archive`);
      fleet.scripts.length = 0;

      const res = await call('POST', `/workbenches/${wb.id}/restore`);
      expect(res.body.data).toMatchObject({ status: 'provisioning', archivedAt: null, sandboxId: `${sandboxIdFor(wb.id, 1)}` });
      await vi.waitFor(async () => expect((await getWorkbench(wb.id))?.status).toBe('ready'));
      expect(fleet.created.map((c) => c.id)).toEqual([`${sandboxIdFor(wb.id)}`, `${sandboxIdFor(wb.id, 1)}`]);
      expect(fleet.created.map((c) => c.policy?.egress)).toEqual([undefined, undefined]);
      expect(fleet.scripts.some((s) => s.includes(`git fetch origin refs/talyn/archive/${wb.id}`))).toBe(true);
      expect((await getChat(chatId))?.agentSessionId).toBeNull();
      const page = await call('GET', `/workbenches/chats/${chatId}/events`);
      expect(page.body.data.events.at(-1).event).toMatchObject({ type: 'system', subtype: 'sandbox_restored' });
    });

    it('deletes the workbench, its box and its rows', async () => {
      const wb = await createSandboxWorkbench();
      expect((await call('DELETE', `/workbenches/${wb.id}`)).status).toBe(200);
      expect(fleet.deleted).toEqual([`${sandboxIdFor(wb.id)}`]);
      expect(await getWorkbench(wb.id)).toBeNull();
      expect(emitted.at(-1)).toMatchObject({ type: 'workbench:deleted', payload: { id: wb.id } });
    });
  });

  describe('readiness', () => {
    const readiness = async (user = 'owner-a') => call('GET', '/workbenches/readiness?workspaceId=ws-a', undefined, user);

    it('answers ready with both agents when everything is in place', async () => {
      const res = await readiness();
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        sandbox: { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: true } } },
      });
    });

    it.each([
      ['flag_off', () => vi.stubEnv('WORKBENCHES_ENABLED', 'false'), /WORKBENCHES_ENABLED=false/],
      ['fleet_disabled', () => (fleetRegistered = false), /FLEET_ENABLED=true/],
      ['fleet_not_deployed', () => vi.stubEnv('FLEET_API_TOKEN', ''), /set FLEET_PINNED_ENDPOINT and FLEET_GATEWAY_TOKEN\./],
      [
        'fleet_not_deployed',
        () => {
          vi.stubEnv('FLEET_PINNED_ENDPOINT', 'https://gateway.example');
          vi.stubEnv('FLEET_API_TOKEN', '');
        },
        /set FLEET_GATEWAY_TOKEN\.$/,
      ],
      ['fleet_not_allowed', () => vi.stubEnv('FLEET_ALLOWED', 'false'), /FLEET_ALLOWED=false/],
    ] as const)('reports %s as a reason, with words that say what to do', async (code, setup, message) => {
      setup();
      resetFeatureFlagsForTests();
      const res = await readiness();
      expect(res.status).toBe(200);
      expect(res.body.data.sandbox.ok).toBe(false);
      expect(res.body.data.sandbox.reasons).toHaveLength(1);
      expect(res.body.data.sandbox.reasons[0].code).toBe(code);
      expect(res.body.data.sandbox.reasons[0].message).toMatch(message);
    });

    it.each([
      ['codex not connected', { claudeToken: 'c' }, [], { claude: true, codex: 'agent_not_connected' }, true],
      ['claude not connected', { openaiKey: 'o' }, [], { claude: 'agent_not_connected', codex: true }, true],
      ['claude needs a new sign-in', { claudeToken: 'c', openaiKey: 'o' }, ['claude'], { claude: 'agent_reauth_required', codex: true }, true],
      ['nothing connected', null, [], { claude: 'agent_not_connected', codex: 'agent_not_connected' }, false],
      ['both need a new sign-in', { claudeToken: 'c', openaiKey: 'o' }, ['claude', 'codex'], { claude: 'agent_reauth_required', codex: 'agent_reauth_required' }, false],
    ] as const)('reports each agent on its own: %s', async (_name, held, needsReauth, expected, sandboxOk) => {
      creds = held;
      reauth = [...needsReauth];
      const { sandbox } = (await readiness()).body.data;
      expect(sandbox.ok).toBe(sandboxOk);
      expect(sandbox.reasons).toEqual([]);
      for (const agent of ['claude', 'codex'] as const) {
        const want = expected[agent];
        if (want === true) expect(sandbox.agents[agent]).toEqual({ ok: true });
        else {
          expect(sandbox.agents[agent].ok).toBe(false);
          expect(sandbox.agents[agent].reason.code).toBe(want);
          expect(sandbox.agents[agent].reason.message).toMatch(/Settings → Talyn Fleet/);
        }
      }
    });

    it("answers 404 for another owner's workspace and 400 with no workspace", async () => {
      expect((await readiness('owner-b')).status).toBe(404);
      expect((await call('GET', '/workbenches/readiness')).status).toBe(400);
    });

    it.each([
      ['fleet_not_deployed', 503, () => vi.stubEnv('FLEET_API_TOKEN', '')],
      ['fleet_disabled', 503, () => (fleetRegistered = false)],
      ['fleet_not_allowed', 403, () => vi.stubEnv('FLEET_ALLOWED', 'false')],
      ['agent_reauth_required', 409, () => (reauth = ['claude'])],
    ] as const)('refuses to create a sandbox workbench on %s, and inserts nothing', async (code, status, setup) => {
      setup();
      resetFeatureFlagsForTests();
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude', prompt: 'hi',
      });
      expect([res.status, res.body.code]).toEqual([status, code]);
      expect(res.body.error).toBeTruthy();
      expect(fleet.created).toEqual([]);
      expect((await call('GET', '/workbenches?workspaceId=ws-a&includeArchived=true')).body.data).toEqual([]);
    });

    it('still creates a local workbench, with its first chat embedded, when the fleet is not deployed', async () => {
      vi.stubEnv('FLEET_API_TOKEN', '');
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'local', agent: 'codex', deviceId: 'dev-1', localPath: '/tmp/wt', prompt: 'go',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.chats).toHaveLength(1);
      expect(res.body.data.chats[0]).toMatchObject({ workbenchId: res.body.data.id, agent: 'codex', status: 'idle' });
      expect(res.body.data.chats[0].queuedMessages.map((m: Loose) => m.text)).toEqual(['go']);
    });
  });

  describe('a failed start', () => {
    const NOT_DEPLOYED = 'Talyn Fleet is not configured on this backend: set FLEET_PINNED_ENDPOINT and FLEET_GATEWAY_TOKEN.';

    /** A sandbox workbench whose box could not be created, settled at `error`. */
    async function createFailedWorkbench(err: Error = new FleetNotDeployedError(), extra: Record<string, unknown> = {}): Promise<Loose> {
      fleet.createSandbox = async () => {
        throw err;
      };
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude', ...extra,
      });
      expect(res.status).toBe(200);
      const chatId = await chatIdOf(res.body.data.id);
      await vi.waitFor(async () => {
        expect((await getWorkbench(res.body.data.id))?.status).toBe('error');
        expect((await getChat(chatId))?.status).toBe('error');
      }, { timeout: 5000 });
      return res.body.data;
    }

    const restoreCreate = () => {
      fleet.createSandbox = FakeFleet.prototype.createSandbox;
    };

    it('shows why, marks the box as failed, and drops the queue with the reason in the chat', async () => {
      const wb = await createFailedWorkbench(new FleetNotDeployedError(), { prompt: 'add a readme' });
      expect(await getWorkbench(wb.id)).toMatchObject({ status: 'error', sandboxState: 'error', statusMessage: NOT_DEPLOYED });

      const got = (await call('GET', `/workbenches/${wb.id}`)).body.data;
      expect(got).toMatchObject({ status: 'error', sandboxState: 'error', error: NOT_DEPLOYED });
      expect(got.chats[0]).toMatchObject({ status: 'error', queuedMessages: [] });

      const page = await call('GET', `/workbenches/chats/${got.chats[0].id}/events`);
      expect(page.body.data.events.at(-1).event).toMatchObject({
        type: 'system',
        subtype: 'workbench_failed',
        text: `This session failed to start: ${NOT_DEPLOYED} Your queued message was not sent.`,
        droppedMessages: [{ text: 'add a readme' }],
      });

      const updates = emitted.filter((e) => e.type === 'workbench:updated').map((e) => (e.payload as Loose).workbench);
      expect(updates.at(-1)).toMatchObject({ status: 'error', sandboxState: 'error', error: NOT_DEPLOYED });
      const chats = emitted.filter((e) => e.type === 'workbench:chat').map((e) => (e.payload as Loose).chat);
      expect(chats.at(-1)).toMatchObject({ status: 'error', queuedMessages: [] });
    });

    it.each([
      ['an unreachable fleet', new FleetCapacityError('http://10.0.0.7:8080 refused', undefined, 'unreachable'), 'The sandbox runners are not reachable right now. Try again shortly.'],
      ['a fleet refusal', new FleetHttpError('provider must be anthropic or openai', 400), 'Talyn Fleet refused the request: provider must be anthropic or openai'],
      ['a plain fault', new Error('boom'), 'boom'],
    ])('words %s for a person, never the private endpoint', async (_name, err, message) => {
      const wb = await createFailedWorkbench(err);
      const got = (await call('GET', `/workbenches/${wb.id}`)).body.data;
      expect(got.error).toBe(message);
      expect(got.error).not.toContain('10.0.0.7');
    });

    it('refuses a message with 409 not_ready instead of queueing it', async () => {
      const wb = await createFailedWorkbench();
      const chatId = await chatIdOf(wb.id);
      const res = await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'hello?' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'not_ready', error: 'This session failed to start; retry it.' });
      expect((await getChat(chatId))?.queuedMessages).toEqual([]);
    });

    it('refuses a message to an archived workbench with 409 not_ready', async () => {
      const wb = await createSandboxWorkbench();
      await call('POST', `/workbenches/${wb.id}/archive`);
      const res = await call('POST', `/workbenches/chats/${await chatIdOf(wb.id)}/messages`, { text: 'hi' });
      expect(res.body).toMatchObject({ code: 'not_ready', error: 'This session is archived. Restore it first.' });
      expect(res.status).toBe(409);
    });

    it('still queues a message while the workbench is starting', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      scriptedFleet(async (script) => {
        if (script.includes('git clone')) await held;
        return null;
      });
      const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude' });
      const sent = await call('POST', `/workbenches/chats/${await chatIdOf(res.body.data.id)}/messages`, { text: 'queued' });
      expect([sent.status, sent.body.data]).toEqual([200, { queued: true }]);
      release();
      await vi.waitFor(async () => expect((await getWorkbench(res.body.data.id))?.status).toBe('ready'));
    });

    it('retries onto a new sandbox id, puts the chat back to idle, and becomes ready', async () => {
      const wb = await createFailedWorkbench();
      restoreCreate();
      const res = await call('POST', `/workbenches/${wb.id}/retry`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        status: 'provisioning', sandboxState: 'creating', error: null, sandboxId: `${sandboxIdFor(wb.id, 1)}`,
      });
      expect(fleet.deleted).toEqual([`${sandboxIdFor(wb.id)}`]);
      await vi.waitFor(async () => expect((await getWorkbench(wb.id))?.status).toBe('ready'));
      expect(fleet.created.map((c) => c.id)).toEqual([`${sandboxIdFor(wb.id, 1)}`]);
      expect((await getChat(await chatIdOf(wb.id)))?.status).toBe('idle');
    });

    it('retries past a half-made box the fleet cannot be holding', async () => {
      const wb = await createFailedWorkbench();
      restoreCreate();
      fleet.deleteSandbox = async () => {
        throw new FleetNotDeployedError();
      };
      expect((await call('POST', `/workbenches/${wb.id}/retry`)).status).toBe(200);
      await vi.waitFor(async () => expect((await getWorkbench(wb.id))?.status).toBe('ready'));
    });

    it('refuses a retry, and changes nothing, while the fleet is still not deployed', async () => {
      const wb = await createFailedWorkbench();
      vi.stubEnv('FLEET_API_TOKEN', '');
      const res = await call('POST', `/workbenches/${wb.id}/retry`);
      expect([res.status, res.body.code]).toEqual([503, 'fleet_not_deployed']);
      expect(res.body.error).toBe(NOT_DEPLOYED);
      expect(fleet.deleted).toEqual([]);
      expect(await getWorkbench(wb.id)).toMatchObject({ status: 'error', sandboxId: `${sandboxIdFor(wb.id)}` });
    });

    it.each([
      ['a ready workbench', 'not_failed', async () => (await createSandboxWorkbench()).id],
      ['a local workbench', 'local_runtime', async () => (await createLocalWorkbench()).id],
      ['an archived workbench', 'not_ready', async () => {
        const wb = await createSandboxWorkbench();
        await call('POST', `/workbenches/${wb.id}/archive`);
        return wb.id;
      }],
    ] as const)('refuses to retry %s with 409 %s', async (_name, code, make) => {
      const id = await make();
      const res = await call('POST', `/workbenches/${id}/retry`);
      expect([res.status, res.body.code]).toEqual([409, code]);
    });

    it("answers 404 to a retry of another owner's workbench", async () => {
      const wb = await createFailedWorkbench();
      expect((await call('POST', `/workbenches/${wb.id}/retry`, undefined, 'owner-b')).status).toBe(404);
    });

    it('keeps a pending archive when the fleet is not deployed', async () => {
      const wb = await createFailedWorkbench();
      fleet.deleteSandbox = async () => {
        throw new FleetNotDeployedError();
      };
      const res = await call('POST', `/workbenches/${wb.id}/archive`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'archived' });
      await settleArchivesForTests();
      expect((await getWorkbench(wb.id))?.archivePendingAt).not.toBeNull();
    });

    it('archives a failed workbench that never had a sandbox id, without calling the fleet', async () => {
      const wb = await createFailedWorkbench();
      await updateWorkbench(wb.id, { sandboxId: null });
      const res = await call('POST', `/workbenches/${wb.id}/archive`);
      expect(res.body.data).toMatchObject({ status: 'archived' });
      expect(fleet.deleted).toEqual([]);
      expect(fleet.scripts).toEqual([]);
    });

    it('keeps the archive pending when its box cannot be deleted', async () => {
      const wb = await createSandboxWorkbench();
      fleet.deleteSandbox = async () => {
        throw new FleetNotDeployedError();
      };
      const res = await call('POST', `/workbenches/${wb.id}/archive`);
      expect(res.status).toBe(200);
      await settleArchivesForTests();
      expect((await getWorkbench(wb.id))?.archivePendingAt).not.toBeNull();
      expect((await getWorkbench(wb.id))?.archivedAt).not.toBeNull();
    });

    it('records a fleet failure after answering the archive request', async () => {
      const wb = await createSandboxWorkbench();
      scriptedFleet((script) => {
        if (script.includes('PUSHED_BRANCH')) throw new FleetCapacityError('http://10.0.0.7:8080 down', undefined, 'unreachable');
        return null;
      });
      const res = await call('POST', `/workbenches/${wb.id}/archive`);
      expect(res.status).toBe(200);
      await settleArchivesForTests();
      expect((await getWorkbench(wb.id))?.statusMessage).toBe('The sandbox runners are not reachable right now. Try again shortly.');
    });
  });

  describe('files, diff and scripts', () => {
    it.each(['config', 'files', 'changes', 'diff'])('waits for the sandbox before reading %s', async (route) => {
      const wb = await createSandboxWorkbench();
      await updateWorkbench(wb.id, { status: 'moving' });
      const scripts = fleet.scripts.length;
      let answered = false;
      const request = call('GET', `/workbenches/${wb.id}/${route}`).then((response) => {
        answered = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(answered).toBe(false);
      expect(fleet.scripts).toHaveLength(scripts);
      await updateWorkbench(wb.id, { status: 'ready' });
      expect((await request).status).toBe(200);
    });

    const detectionOutput = [
      `FILES ${Buffer.from('package.json\npackage-lock.json\nuv.lock\n').toString('base64')}`,
      `PACKAGE ${Buffer.from('{"scripts":{"dev":"vite"}}').toString('base64')}`,
    ].join('\n');

    it('returns detected commands without running them during setup', async () => {
      scriptedFleet((script) => script.includes('ls -A') ? { stdout: detectionOutput } : null);
      const wb = await createSandboxWorkbench();
      const res = await call('GET', `/workbenches/${wb.id}/config`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        source: 'none',
        run: [],
        detected: {
          setup: { command: 'npm ci && uv sync', reason: 'from package-lock.json, uv.lock' },
          run: { command: 'npm run dev', reason: 'from the dev script in package.json' },
        },
      });
      expect(res.body.data.setup).toBeUndefined();
      expect(fleet.scripts.some((script) => script === 'npm ci && uv sync' || script === 'npm run dev')).toBe(false);
      expect(emitted.some((event) => event.type === 'workbench:script')).toBe(false);
    });

    it.each(['TALYN', 'CJSON', 'CTOML'])('does not detect commands when %s has config', async (label) => {
      const wb = await createSandboxWorkbench();
      const text = label === 'CJSON' ? '{"scripts":{"setup":"custom"}}' : '[scripts]\nsetup = "custom"';
      scriptedFleet((script) => script.includes('cat .talyn/settings.toml')
        ? { stdout: `${label} ${Buffer.from(text).toString('base64')}\n` } : null);
      const before = fleet.scripts.length;
      const res = await call('GET', `/workbenches/${wb.id}/config`);
      expect(res.body.data.setup.command).toBe('custom');
      expect(res.body.data.detected).toBeUndefined();
      expect(fleet.scripts.slice(before).some((script) => script.includes('ls -A'))).toBe(false);
    });

    it('saves newly detected commands and ignores client command text', async () => {
      const wb = await createSandboxWorkbench();
      scriptedFleet((script) => script.includes('ls -A') ? { stdout: detectionOutput } : null);
      const res = await call('POST', `/workbenches/${wb.id}/config/detected`, { setup: 'untrusted', content: 'untrusted' });
      expect(res.status).toBe(200);
      const write = fleet.scripts.find((script) => script.includes('base64 -d > .talyn/settings.toml'))!;
      expect(write).toBeDefined();
      expect(write).not.toContain('untrusted');
      const encoded = /printf '%s' '([A-Za-z0-9+/=]+)'/.exec(write)![1];
      expect(resolveWorkbenchConfig({ talynToml: Buffer.from(encoded, 'base64').toString('utf8') })).toMatchObject({
        setup: { command: 'npm ci && uv sync' },
        run: [{ command: 'npm run dev' }],
      });
      expect(write).toContain('set -C');
      for (const file of ['.talyn/settings.toml', 'conductor.json', '.conductor/settings.toml']) {
        expect(write).toContain(file);
      }
    });

    it.each(['read', 'write'])('returns 409 when config exists at the %s step', async (step) => {
      const wb = await createSandboxWorkbench();
      scriptedFleet((script) => {
        if (script.includes('ls -A')) return step === 'read' ? { exitCode: 3 } : { stdout: detectionOutput };
        if (script.includes('base64 -d > .talyn/settings.toml')) return { exitCode: 3 };
        return null;
      });
      const res = await call('POST', `/workbenches/${wb.id}/config/detected`);
      expect([res.status, res.body.code]).toEqual([409, 'config_exists']);
      expect(res.body.error).toContain('already exists');
    });

    it('refuses to save when nothing is detected', async () => {
      const wb = await createSandboxWorkbench();
      const res = await call('POST', `/workbenches/${wb.id}/config/detected`);
      expect([res.status, res.body.code]).toEqual([409, 'no_detected_scripts']);
      expect(fleet.scripts.some((script) => script.includes('base64 -d > .talyn/settings.toml'))).toBe(false);
    });

    it.each([['GET', 'config'], ['POST', 'config/detected']])('checks access for %s %s', async (method, route) => {
      const wb = await createSandboxWorkbench();
      const before = fleet.scripts.length;
      expect((await call(method, `/workbenches/${wb.id}/${route}`, undefined, 'owner-b')).status).toBe(404);
      await updateWorkbench(wb.id, { status: 'provisioning' });
      expect((await call(method, `/workbenches/${wb.id}/${route}`)).status).toBe(409);
      expect(fleet.scripts.length).toBe(before);
    });

    it('reads changes in both scopes and keeps the combined fields', async () => {
      const wb = await createSandboxWorkbench();
      const b64 = (s: string) => Buffer.from(s).toString('base64');
      scriptedFleet((script) =>
        script.includes('--numstat')
          ? {
              stdout: [
                `MB ${b64('a'.repeat(40))}`,
                `HEAD ${b64('b'.repeat(40) + '\n')}`,
                `NUMSTAT ${b64('3\t1\tsrc/a.ts\0')}`,
                `NAMES ${b64('M\0src/a.ts\0')}`,
                `UNCOMMITTED_NUMSTAT ${b64('1\t0\tsrc/a.ts\0')}`,
                `UNCOMMITTED_NAMES ${b64('M\0src/a.ts\0')}`,
                `COMMITTED_NUMSTAT ${b64('2\t1\tsrc/a.ts\0')}`,
                `COMMITTED_NAMES ${b64('M\0src/a.ts\0')}`,
                `UNTRACKED ${b64('new.txt\0')}`,
                `COUNTS ${b64('new.txt\t4\n')}`,
              ].join('\n'),
            }
          : null,
      );
      const res = await call('GET', `/workbenches/${wb.id}/changes`);
      expect(res.body.data).toEqual({
        base: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        uncommitted: [
          { path: 'new.txt', status: 'added', added: 4, removed: 0, binary: false },
          { path: 'src/a.ts', status: 'modified', added: 1, removed: 0, binary: false },
        ],
        committed: [{ path: 'src/a.ts', status: 'modified', added: 2, removed: 1, binary: false }],
        uncommittedStats: { added: 5, removed: 0, files: 2 },
        committedStats: { added: 2, removed: 1, files: 1 },
        files: [
          { path: 'new.txt', status: 'added', added: 4, removed: 0, binary: false },
          { path: 'src/a.ts', status: 'modified', added: 3, removed: 1, binary: false },
        ],
      });
      const updated = await refreshDiffStat((await getWorkbench(wb.id))!);
      expect(rowToWorkbench(updated)).toMatchObject({
        diffStat: res.body.data.uncommittedStats,
        uncommittedStats: res.body.data.uncommittedStats,
        committedStats: res.body.data.committedStats,
      });
      expect(emitted.findLast((event) => event.type === 'workbench:updated')?.payload).toMatchObject({
        workbench: expect.objectContaining({ uncommittedStats: res.body.data.uncommittedStats, committedStats: res.body.data.committedStats }),
      });
    });

    it.each(['uncommitted', 'committed', 'combined'])('passes the %s diff scope', async (scope) => {
      const wb = await createSandboxWorkbench();
      scriptedFleet((script) => script.includes('git diff --no-color') ? { stdout: 'scoped patch' } : null);
      const res = await call('GET', `/workbenches/${wb.id}/diff?path=src/a.ts&scope=${scope}`);
      expect(res.status).toBe(200);
      expect(res.body.data.patch).toBe('scoped patch');
      const script = fleet.scripts.findLast((s) => s.includes('git diff --no-color'))!;
      const comparison = scope === 'uncommitted' ? 'HEAD' : scope === 'committed' ? '"$mb" HEAD' : '"$mb"';
      expect(script).toContain(`--find-renames ${comparison} -- src/a.ts`);
    });

    it('refuses an invalid diff scope', async () => {
      const wb = await createSandboxWorkbench();
      const res = await call('GET', `/workbenches/${wb.id}/diff?scope=wrong`);
      expect([res.status, res.body.code]).toEqual([400, 'bad_scope']);
    });

    it.each([
      ['a text file', 'hello\n', { content: 'hello\n', binary: false }],
      ['a binary file', '\u0000\u0001png', { content: Buffer.from('\u0000\u0001png').toString('base64'), binary: true }],
    ])('reads %s', async (_name, content, expected) => {
      const wb = await createSandboxWorkbench();
      scriptedFleet((script) => (script.includes('wc -c') ? { stdout: content } : null));
      expect((await call('GET', `/workbenches/${wb.id}/file?path=src/a.ts`)).body.data).toEqual(expected);
    });

    it.each([
      ['../../etc/passwd', 400, 'bad_path'],
      ['/etc/passwd', 400, 'bad_path'],
    ])('refuses to read %s', async (path, status, code) => {
      const wb = await createSandboxWorkbench();
      const before = fleet.scripts.length;
      const res = await call('GET', `/workbenches/${wb.id}/file?path=${encodeURIComponent(path)}`);
      expect([res.status, res.body.code]).toEqual([status, code]);
      expect(fleet.scripts.length).toBe(before);
    });

    it.each([
      [3, 404, 'file_not_found'],
      [4, 413, 'file_too_large'],
    ])('maps the file read exit %i to %i', async (exitCode, status, code) => {
      const wb = await createSandboxWorkbench();
      scriptedFleet((script) => (script.includes('wc -c') ? { exitCode } : null));
      const res = await call('GET', `/workbenches/${wb.id}/file?path=a`);
      expect([res.status, res.body.code]).toEqual([status, code]);
    });

    it('lists files and returns a patch', async () => {
      const wb = await createSandboxWorkbench();
      scriptedFleet((script) => {
        if (script.startsWith('git ls-files --cached')) return { stdout: 'a.ts\0dir/b c.ts\0' };
        if (script.includes('git diff --no-color --find-renames')) return { stdout: 'diff --git a/a.ts b/a.ts\n' };
        return null;
      });
      expect((await call('GET', `/workbenches/${wb.id}/files`)).body.data).toEqual({ paths: ['a.ts', 'dir/b c.ts'] });
      expect((await call('GET', `/workbenches/${wb.id}/diff?path=a.ts`)).body.data).toEqual({ patch: 'diff --git a/a.ts b/a.ts\n' });
    });

    it('runs a script from the repository config and streams it as frames', async () => {
      const wb = await createSandboxWorkbench();
      const toml = Buffer.from('[scripts]\nrun = "npm run dev"\n').toString('base64');
      scriptedFleet((script) => {
        if (script.includes('cat .talyn/settings.toml')) return { stdout: `TALYN ${toml}\nCJSON \nCTOML \n` };
        if (script === 'npm run dev') return { stdout: ['ready on 3000', 'compiled'], exitCode: 0 };
        return null;
      });
      expect((await call('POST', `/workbenches/${wb.id}/scripts/run`)).status).toBe(200);
      await vi.waitFor(() => expect(emitted.some((e) => e.type === 'workbench:script' && (e.payload as Loose).stream === 'exit')).toBe(true));
      const frames = emitted.filter((e) => e.type === 'workbench:script').map((e) => e.payload as Loose);
      expect(frames.filter((f) => f.stream === 'stdout').map((f) => f.data).join('')).toBe('ready on 3000\ncompiled\n');
      expect(frames.at(-1)).toMatchObject({ workbenchId: wb.id, name: 'run', stream: 'exit', exitCode: 0 });
      expect((await call('POST', `/workbenches/${wb.id}/scripts/missing`)).body.code).toBe('script_not_found');
    });

    it('sends an action as a message, in the workbench\'s own words when it has them', async () => {
      const wb = await createSandboxWorkbench();
      await call('PATCH', `/workbenches/${wb.id}`, { settings: { prompts: { resolve_conflicts: 'Merge {{branch}} with {{baseBranch}}' } } });
      const res = await call('POST', `/workbenches/${wb.id}/actions/resolve_conflicts`);
      const chatId = await chatIdOf(wb.id);
      expect(res.body.data).toEqual({ chatId });
      await idle(chatId);
      const page = await call('GET', `/workbenches/chats/${chatId}/events`);
      expect(page.body.data.events[0].event.message.content[0].text).toBe(`Merge ${wb.branch} with main`);
      expect((await call('POST', `/workbenches/${wb.id}/actions/dance`)).status).toBe(400);
    });

    it('refuses sandbox reads while the workbench is still provisioning', async () => {
      const wb = await createSandboxWorkbench();
      await updateWorkbench(wb.id, { status: 'provisioning' });
      const res = await call('GET', `/workbenches/${wb.id}/changes`);
      expect([res.status, res.body.code]).toEqual([409, 'not_ready']);
    });
  });

  describe('a local workbench', () => {
    it('is ready at once and never touches the fleet', async () => {
      const wb = await createLocalWorkbench();
      expect(wb).toMatchObject({ runtime: 'local', status: 'ready', sandboxId: null, sandboxState: 'none', deviceId: 'dev-1', localPath: '/tmp/wt' });
      expect(fleet.created).toEqual([]);
    });

    it.each([
      ['GET', (id: string) => `/workbenches/${id}/changes`],
      ['GET', (id: string) => `/workbenches/${id}/config`],
      ['POST', (id: string) => `/workbenches/${id}/config/detected`],
      ['GET', (id: string) => `/workbenches/${id}/diff`],
      ['GET', (id: string) => `/workbenches/${id}/file?path=a`],
      ['GET', (id: string) => `/workbenches/${id}/files`],
      ['POST', (id: string) => `/workbenches/${id}/scripts/run`],
      ['POST', (id: string) => `/workbenches/${id}/scripts/run/stop`],
      ['POST', (id: string) => `/workbenches/${id}/actions/fix_checks`],
      ['GET', (id: string) => `/workbenches/${id}/ports/3000/`],
    ] as const)('answers 409 local_runtime for %s %s', async (method, path) => {
      const wb = await createLocalWorkbench();
      const res = await call(method, path(wb.id));
      expect([res.status, res.body.code]).toEqual([409, 'local_runtime']);
      expect(fleet.scripts).toEqual([]);
    });

    it.each(['messages', 'cancel', 'checkpoints/1/restore'])('answers 409 local_runtime for chat %s', async (suffix) => {
      const wb = await createLocalWorkbench();
      const res = await call('POST', `/workbenches/chats/${await chatIdOf(wb.id)}/${suffix}`, { text: 'hi' });
      expect([res.status, res.body.code]).toEqual([409, 'local_runtime']);
    });

    it('stores uploaded events once and reports the chat state', async () => {
      const wb = await createLocalWorkbench();
      const chatId = await chatIdOf(wb.id);
      const events = [1, 2].map((seq) => ({ chatId, seq, turn: 1, event: { seq, type: seq === 1 ? 'user' : 'assistant' } }));
      expect((await call('POST', `/workbenches/chats/${chatId}/local-events`, { events })).body.data).toEqual({ stored: 2 });
      expect((await call('POST', `/workbenches/chats/${chatId}/local-events`, { events })).body.data).toEqual({ stored: 0 });
      expect((await call('GET', `/workbenches/chats/${chatId}/events?after=1`)).body.data.events.map((e: Loose) => e.seq)).toEqual([2]);

      const state = await call('PATCH', `/workbenches/chats/${chatId}/local`, { status: 'running', agentSessionId: 'local-sess' });
      expect(state.body.data).toMatchObject({ status: 'running', agentSessionId: 'local-sess' });
    });

    it('pages a local chat backwards from the newest event, by whole turns', async () => {
      const wb = await createLocalWorkbench();
      const chatId = await chatIdOf(wb.id);
      const events = [1, 2, 3, 4, 5].map((seq) => ({ chatId, seq, turn: seq <= 2 ? 1 : 2, event: { seq, type: 'assistant' } }));
      await call('POST', `/workbenches/chats/${chatId}/local-events`, { events });

      const latest = (await call('GET', `/workbenches/chats/${chatId}/events?before=latest&limit=2`)).body.data;
      expect(latest.events.map((e: Loose) => e.seq)).toEqual([3, 4, 5]);
      expect(latest).toMatchObject({ cursor: 5, oldestSeq: 3, hasOlder: true });

      const older = (await call('GET', `/workbenches/chats/${chatId}/events?before=3&limit=2`)).body.data;
      expect(older.events.map((e: Loose) => e.seq)).toEqual([1, 2]);
      expect(older).toMatchObject({ cursor: 2, oldestSeq: 1, hasOlder: false });

      // The forward mode carries no paging fields, which is how an older client keeps working.
      expect((await call('GET', `/workbenches/chats/${chatId}/events?after=0`)).body.data).not.toHaveProperty('hasOlder');
    });

    it.each(['before=0', 'before=-1', 'before=1.5', 'before=newest', 'before=latest&after=2'])(
      'refuses the events query %s',
      async (query) => {
        const wb = await createLocalWorkbench();
        expect((await call('GET', `/workbenches/chats/${await chatIdOf(wb.id)}/events?${query}`)).status).toBe(400);
      },
    );

    it.each([
      [{ events: 'no' }],
      [{ events: [{ seq: 0, turn: 1, event: { type: 'x' } }] }],
      [{ events: [{ seq: 1, turn: -1, event: { type: 'x' } }] }],
      [{ events: [{ seq: 1, turn: 1, event: 'x' }] }],
      [{ events: [{ seq: 1.5, turn: 1, event: { type: 'x' } }] }],
      [{ events: [{ seq: 1, turn: 1, event: {} }] }],
    ])('refuses the upload %j', async (body) => {
      const wb = await createLocalWorkbench();
      expect((await call('POST', `/workbenches/chats/${await chatIdOf(wb.id)}/local-events`, body)).status).toBe(400);
    });

    it('refuses a bad local chat status', async () => {
      const wb = await createLocalWorkbench();
      expect((await call('PATCH', `/workbenches/chats/${await chatIdOf(wb.id)}/local`, { status: 'sleeping' })).status).toBe(400);
    });

    it.each([
      ['POST', 'local-events', { events: [] }],
      ['PATCH', 'local', { status: 'idle' }],
    ])('refuses %s %s for a sandbox workbench', async (method, suffix, body) => {
      const wb = await createSandboxWorkbench();
      const res = await call(method, `/workbenches/chats/${await chatIdOf(wb.id)}/${suffix}`, body);
      expect([res.status, res.body.code]).toEqual([409, 'sandbox_runtime']);
    });
  });

  describe('a host asking for a workbench box\'s credentials back', () => {
    it.each([
      ['the host it was created on', 'host-1', (id: string) => `${sandboxIdFor(id)}`, { ok: true }],
      ['another host', 'host-2', (id: string) => `${sandboxIdFor(id)}`, { ok: false, reason: 'wrong_host' }],
      ['an unknown box', 'host-1', () => 'talyn-wb-nope', { ok: false, reason: 'unknown_run' }],
    ])('answers %s', async (_name, host, runId, expected) => {
      const wb = await createSandboxWorkbench({ agent: 'codex' });
      const result = await resolveRunCredentials(host, runId(wb.id));
      expect(result).toMatchObject(expected);
      if (result.ok) {
        expect(result.credentials).toEqual({ githubToken: 'gh-token', openaiKey: 'oa-codex', repo: 'acme/app' });
      }
    });

    it('refuses after the archive completes, and when the subscription has gone', async () => {
      const wb = await createSandboxWorkbench();
      creds = { openaiKey: 'oa-codex' };
      expect(await resolveRunCredentials('host-1', `${sandboxIdFor(wb.id)}`)).toEqual({ ok: false, reason: 'credentials_unavailable' });
      creds = { claudeToken: 'sk-ant-oat-claude' };
      await call('POST', `/workbenches/${wb.id}/archive`);
      await settleArchivesForTests();
      expect(await resolveRunCredentials('host-1', `${sandboxIdFor(wb.id)}`)).toEqual({ ok: false, reason: 'run_not_live' });
    });
  });
  describe('the display title', () => {
    const titleOf = async (id: string) => (await getWorkbench(id))?.title ?? null;

    it('names a sandbox session from its first message beside the first turn, and keeps the branch', async () => {
      scriptedFleet((script) => (isTitleScript(script) ? { stdout: '"Explain the Merge Queue."\n' } : null));
      const wb = await createSandboxWorkbench({ prompt: 'explain how the merge queue works' });
      await vi.waitFor(async () => expect(await titleOf(wb.id)).toBe('Explain the Merge Queue'), { timeout: 5000 });
      const row = (await getWorkbench(wb.id))!;
      expect([row.name, row.branch]).toEqual([wb.name, wb.branch]);
      const title = fleet.execs.find((e) => isTitleScript(e.script))!;
      expect(title.script.startsWith('claude -p --output-format text --model haiku')).toBe(true);
      expect(title.req.cwd).toBe('/tmp');
      expect(fleet.execs.filter((e) => isTitleScript(e.script))).toHaveLength(1);
      const updates = emitted.filter((e) => e.type === 'workbench:updated') as Array<{ payload: { workbench: Loose } }>;
      expect(updates.some((e) => e.payload.workbench.title === 'Explain the Merge Queue')).toBe(true);
      // The turn ran as normal.
      await idle(await chatIdOf(wb.id));
      expect((await getChat(await chatIdOf(wb.id)))?.status).toBe('idle');
    });

    it('keeps the name, and still runs the turn, when the title call fails', async () => {
      scriptedFleet((script) => (isTitleScript(script) ? { exitCode: 1, stderr: 'usage limit' } : null));
      const wb = await createSandboxWorkbench({ prompt: 'explain how the merge queue works' });
      const chatId = await chatIdOf(wb.id);
      await vi.waitFor(() => expect(fleet.execs.some((e) => isTitleScript(e.script))).toBe(true), { timeout: 5000 });
      await idle(chatId);
      expect(await getChat(chatId)).toMatchObject({ status: 'idle', turnCount: 1 });
      expect(await titleOf(wb.id)).toBeNull();
    });

    it('applies a generated title only while the session has none', async () => {
      const wb = await createLocalWorkbench();
      const first = await call('PATCH', `/workbenches/${wb.id}`, { generatedTitle: '"Fix login."' });
      expect(first.body.data).toMatchObject({ title: 'Fix login', name: wb.name, branch: wb.branch });
      const second = await call('PATCH', `/workbenches/${wb.id}`, { generatedTitle: 'Something else' });
      expect(second.body.data.title).toBe('Fix login');
    });

    it('never lets a generated title replace a rename', async () => {
      const wb = await createLocalWorkbench();
      await call('PATCH', `/workbenches/${wb.id}`, { name: 'my-name' });
      const res = await call('PATCH', `/workbenches/${wb.id}`, { generatedTitle: 'Fix login' });
      expect(res.body.data).toMatchObject({ name: 'my-name', title: 'my-name', branch: wb.branch });
    });

    it('takes a title a person sets, and clears it with null', async () => {
      const wb = await createLocalWorkbench();
      const set = await call('PATCH', `/workbenches/${wb.id}`, { title: '  My   own  title ' });
      expect(set.body.data.title).toBe('My own title');
      expect((await call('PATCH', `/workbenches/${wb.id}`, { generatedTitle: 'Fix login' })).body.data.title).toBe('My own title');
      expect((await call('PATCH', `/workbenches/${wb.id}`, { title: null })).body.data.title).toBeNull();
    });

    it.each([
      [{ title: 42 }],
      [{ title: 'x'.repeat(101) }],
    ])('refuses the title patch %j', async (patch) => {
      const wb = await createLocalWorkbench();
      expect((await call('PATCH', `/workbenches/${wb.id}`, patch)).status).toBe(400);
    });

    it('ignores a generated title that is junk', async () => {
      const wb = await createLocalWorkbench();
      const res = await call('PATCH', `/workbenches/${wb.id}`, { generatedTitle: 'line one\nline two' });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBeNull();
    });
  });
});
