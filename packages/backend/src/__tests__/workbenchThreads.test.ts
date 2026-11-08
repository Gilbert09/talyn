import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { SANDBOX_SIZES } from '@talyn/shared';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, type ExecReply } from './helpers/fakeFleet.js';
import { pullRequests, repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { resetTodiexContextCacheForTests } from '../services/todiexContext.js';

/**
 * Threads, end to end against a fake fleet: a workbench with no repository
 * that runs on a small box with no clone, hidden from clients that did not ask
 * for threads, and the "continue as thread" path.
 */

const emitted: Array<{ workspaceId: string; type: string; payload: unknown }> = [];

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: (workspaceId: string, event: { type: string; payload: unknown }) => {
    emitted.push({ workspaceId, type: event.type, payload: event.payload });
  },
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

vi.mock('../services/repoDefaultBranch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/repoDefaultBranch.js')>()),
  reconcileDefaultBranch: async (input: { stored: string }) => input.stored || 'main',
}));

const { settleArchivesForTests } = await import('../services/workbenches/lifecycle.js');
const { workbenchRoutes } = await import('../routes/workbenches.js');
const { workbenchPullRequestRoutes } = await import('../routes/workbenchPullRequests.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { githubService } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { getChat, getWorkbench, listChats, listEvents } = await import('../services/workbenches/store.js');
const { capabilityFor } = await import('../services/websocket.js');
const { continueAsThreadMessage } = await import('../services/workbenches/create.js');
const { announceThreadSession, notifyThread, notifyThreadsOfMergedPr, threadWakeText } = await import('../services/workbenches/threads.js');
const { prMonitorService } = await import('../services/prMonitor.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

interface Json {
  status: number;
  body: { success: boolean; data?: Loose; error?: string; code?: string };
}

describe('threads', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let fleet: FakeFleet;
  const inboxRequests: Record<string, unknown>[] = [];
  const inboxEvents: Record<string, unknown>[] = [];
  const inboxKeys = new Set<string>();

  async function call(method: string, path: string, body?: unknown, user = 'owner-a'): Promise<Json> {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: (await resp.json()) as Json['body'] };
  }

  function scriptedFleet(turn: (script: string) => ExecReply | null = () => null): void {
    fleet.handler = async (script) => {
      const custom = turn(script);
      if (custom) return custom;
      if (isAgentTurn(script) || isAgentTurn(script, 'codex')) return { stdout: claudeTurnLines('sess-1', 'done') };
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
  }

  const ready = (id: string) =>
    vi.waitFor(async () => expect((await getWorkbench(id))?.status).toBe('ready'), { timeout: 5000 });
  const idle = (chatId: string) =>
    vi.waitFor(async () => expect((await getChat(chatId))?.status).not.toBe('running'), { timeout: 5000 });

  async function createThread(extra: Record<string, unknown> = {}): Promise<Loose> {
    const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', kind: 'thread', runtime: 'sandbox', agent: 'claude', ...extra });
    expect(res.status, res.body.error).toBe(200);
    await ready(res.body.data.id);
    return res.body.data;
  }

  async function createSession(extra: Record<string, unknown> = {}): Promise<Loose> {
    const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude', ...extra });
    expect(res.status, res.body.error).toBe(200);
    await ready(res.body.data.id);
    return res.body.data;
  }

  beforeEach(async () => {
    emitted.length = 0;
    inboxRequests.length = 0;
    inboxEvents.length = 0;
    inboxKeys.clear();
    resetTodiexContextCacheForTests();
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
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
    ]);
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    fleet = new FakeFleet();
    scriptedFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());

    const app = express();
    app.use(express.json());
    app.post('/api/ingest/events', (req, res) => {
      const event = req.body as Record<string, unknown>;
      inboxRequests.push(event);
      const key = String(event.dedupeKey);
      if (!inboxKeys.has(key)) {
        inboxKeys.add(key);
        inboxEvents.push(event);
      }
      res.json({ ok: true });
    });
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/workbenches', wrapAsyncRoutes(workbenchPullRequestRoutes()));
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

  describe('creating a thread', () => {
    it('announces the first sandbox session once and ignores later sessions and threads', async () => {
      vi.stubEnv('TODIEX_URL', base);
      vi.stubEnv('TODIEX_TOKEN', 'tdx_test');

      const first = await createSession();
      await vi.waitFor(() => expect(inboxEvents).toHaveLength(1));
      expect(inboxEvents[0]).toMatchObject({
        kind: 'workspace.first_session',
        level: 'success',
        title: 'A started its first Talyn session',
        metadata: { workspace_id: 'ws-a', repository: 'acme/app', session_id: first.id },
        dedupeKey: 'workspace:ws-a:first_session',
      });
      expect(inboxEvents[0].message).toContain('acme/app');

      await createSession();
      await vi.waitFor(() => expect(inboxRequests).toHaveLength(2));
      await createThread();
      await new Promise((r) => setTimeout(r, 50));
      expect(inboxRequests).toHaveLength(2);
      expect(inboxEvents).toHaveLength(1);
    });

    it('announces a local first session too, and says it is local', async () => {
      vi.stubEnv('TODIEX_URL', base);
      vi.stubEnv('TODIEX_TOKEN', 'tdx_test');

      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'local', agent: 'claude', deviceId: 'dev-1', localPath: '/tmp/app',
      });
      expect(res.status, res.body.error).toBe(200);
      await vi.waitFor(() => expect(inboxEvents).toHaveLength(1));
      expect(inboxEvents[0]).toMatchObject({
        kind: 'workspace.first_session',
        metadata: { workspace_id: 'ws-a', session_id: res.body.data.id, runtime: 'local' },
        dedupeKey: 'workspace:ws-a:first_session',
      });
      expect(inboxEvents[0].message).toContain('Local session started for acme/app.');
    });

    it('stores no repository and boots the smallest box with no clone', async () => {
      const thread = await createThread();
      expect(thread).toMatchObject({ kind: 'thread', repositoryId: null, repoFullName: '', branch: '', threadId: null });

      const row = await getWorkbench(thread.id);
      expect(row).toMatchObject({ kind: 'thread', repositoryId: null, repoFullName: '', status: 'ready', pullRequestId: null });

      expect(fleet.created).toHaveLength(1);
      const body = fleet.created[0];
      const smallest = Object.values(SANDBOX_SIZES).reduce((a, b) => (b.memMib < a.memMib ? b : a));
      expect(body.memMib).toBe(smallest.memMib);
      expect(body.milliVcpu).toBe(smallest.milliVcpu);
      expect(body).not.toHaveProperty('repo');
      expect(body).not.toHaveProperty('bake');
      expect(body.policy?.github?.readAllRepos).toBe(true);

      expect(fleet.scripts.some((s) => s.includes('git clone'))).toBe(false);
      expect(fleet.scripts.some((s) => s.includes('settings.toml'))).toBe(false);
      expect(fleet.scripts).toContain('mkdir -p /work');
    });

    it.each([
      ['a repository', { repositoryId: 'repo-a' }],
      ['a branch', { branch: 'feature' }],
      ['a base branch', { baseBranch: 'main' }],
      ['a pull request', { fromPullRequestId: 'pr-1' }],
      ['the local runtime', { runtime: 'local', deviceId: 'd', localPath: '/x' }],
      ['an unknown kind', { kind: 'folder' }],
    ])('refuses %s', async (_name, extra) => {
      const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', kind: 'thread', runtime: 'sandbox', agent: 'claude', ...extra });
      expect(res.status).toBe(400);
      expect(fleet.created).toHaveLength(0);
    });

    it('still needs a repository for a session', async () => {
      const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', runtime: 'sandbox', agent: 'claude' });
      expect(res.status).toBe(400);
    });

    it('runs a turn with no checkpoint, no repository instructions, no diff and no pull request', async () => {
      // A user-wide file, so the instruction sync runs at all.
      const put = await call('PUT', '/workbenches/instructions', {
        workspaceId: 'ws-a',
        file: { key: 'claude-user', agent: 'claude', target: 'user', sourcePath: '~/.claude/CLAUDE.md', content: 'be terse', enabled: true },
      });
      expect(put.status).toBe(200);
      const thread = await createThread();
      const chatId = (await listChats(thread.id))[0].id;
      fleet.scripts.length = 0;
      const sent = await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'plan the work' });
      expect(sent.status).toBe(200);
      await idle(chatId);
      await vi.waitFor(() => expect(fleet.scripts.some((s) => isAgentTurn(s))).toBe(true));

      const agentTurn = fleet.scripts.find((s) => isAgentTurn(s)) ?? '';
      expect(agentTurn).not.toContain('talyn-pr');
      expect(fleet.scripts.some((s) => s.includes('talyn-user.md'))).toBe(true);
      expect(fleet.scripts.some((s) => s.includes('CLAUDE.local.md.talyn-tmp'))).toBe(false);
      expect(fleet.scripts.some((s) => s.includes('touch "$ex"'))).toBe(false);
      expect(fleet.scripts.some((s) => s.includes('git commit-tree'))).toBe(false);
      expect(fleet.scripts.some((s) => s.includes('git diff'))).toBe(false);
      expect((await getChat(chatId))?.status).toBe('idle');
    });
  });

  describe('repository routes on a thread', () => {
    it.each([
      ['/changes', { files: [], base: '', headSha: '' }],
      ['/diff', { patch: '' }],
      ['/files', { paths: [] }],
    ])('answers GET %s empty', async (path, expected) => {
      const thread = await createThread();
      fleet.scripts.length = 0;
      const res = await call('GET', `/workbenches/${thread.id}${path}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject(expected);
      expect(fleet.scripts).toHaveLength(0);
    });

    it('answers GET /config with no scripts and no exec', async () => {
      const thread = await createThread();
      fleet.scripts.length = 0;
      const res = await call('GET', `/workbenches/${thread.id}/config`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ source: 'none' });
      expect(fleet.scripts).toHaveLength(0);
    });

    it.each([
      ['POST', '/pull-request', { title: 'x' }],
      ['POST', '/actions/fix_checks', {}],
      ['POST', '/scripts/run', {}],
      ['POST', '/config/detected', {}],
      ['POST', '/branch-name', {}],
      ['GET', '/patch', undefined],
      ['POST', '/pull-request/link', { number: 1 }],
      ['POST', '/pull-request/unlink', {}],
      ['GET', '/pull-requests/open', undefined],
      ['POST', '/pull-request/adopt', {}],
    ])('refuses %s %s with thread_no_repository', async (method, path, body) => {
      const thread = await createThread();
      const res = await call(method, `/workbenches/${thread.id}${path}`, body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('thread_no_repository');
    });
  });

  describe('the list', () => {
    it('hides threads unless the client asks for them', async () => {
      const thread = await createThread();
      const session = await createSession();

      const plain = await call('GET', '/workbenches?workspaceId=ws-a');
      expect(plain.body.data.map((w: Loose) => w.id)).toEqual([session.id]);

      const both = await call('GET', '/workbenches?workspaceId=ws-a&kinds=session,thread');
      expect(both.body.data.map((w: Loose) => w.id).sort()).toEqual([session.id, thread.id].sort());

      const threads = await call('GET', '/workbenches?workspaceId=ws-a&kinds=thread');
      expect(threads.body.data.map((w: Loose) => w.id)).toEqual([thread.id]);
    });

    it.each(['', 'folder', 'session,folder'])('refuses kinds=%s', async (kinds) => {
      const res = await call('GET', `/workbenches?workspaceId=ws-a&kinds=${kinds}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('bad_kinds');
    });
  });

  describe('a session in a thread', () => {
    it('records its thread', async () => {
      const thread = await createThread();
      const session = await createSession({ threadId: thread.id });
      expect(session.threadId).toBe(thread.id);
      expect((await getWorkbench(session.id))?.threadId).toBe(thread.id);
    });

    it('refuses a thread id that is a session', async () => {
      const other = await createSession();
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent: 'claude', threadId: other.id,
      });
      expect(res.status).toBe(400);
    });

    it("refuses another workspace's thread", async () => {
      const thread = await createThread();
      await testDb.db.insert(repositories).values({
        id: 'repo-b', workspaceId: 'ws-b', name: 'other/app', url: 'https://github.com/other/app', defaultBranch: 'main',
      });
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-b', repositoryId: 'repo-b', runtime: 'sandbox', agent: 'claude', threadId: thread.id,
      }, 'owner-b');
      expect(res.status).toBe(400);
    });

    it('refuses a thread inside a thread', async () => {
      const thread = await createThread();
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', kind: 'thread', runtime: 'sandbox', agent: 'claude', threadId: thread.id,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('continue as thread', () => {
    it('links the session to a new thread whose first message recaps the chat', async () => {
      const session = await createSession({ prompt: 'fix the login bug' });
      const sessionChat = (await listChats(session.id))[0].id;
      await idle(sessionChat);
      await vi.waitFor(async () => expect((await getChat(sessionChat))?.turnCount).toBe(1));

      const res = await call('POST', `/workbenches/${session.id}/thread`, { prompt: 'now do the same in the API' });
      expect(res.status, res.body.error).toBe(200);
      const thread = res.body.data;
      expect(thread).toMatchObject({ kind: 'thread', repositoryId: null });
      expect((await getWorkbench(session.id))?.threadId).toBe(thread.id);
      expect(emitted.some((e) => e.type === 'workbench:updated' && (e.payload as Loose).workbench.id === session.id
        && (e.payload as Loose).workbench.threadId === thread.id)).toBe(true);

      await ready(thread.id);
      const chatId = (await listChats(thread.id))[0].id;
      await idle(chatId);
      const { events } = await listEvents(chatId, 0, 100);
      const first = events.find((e) => (e.event as Loose).talyn?.kind === 'user_message')?.event as Loose;
      expect(first.talyn.origin).toBe('talyn');
      const text = first.message.content[0].text as string;
      expect(text).toContain(`session id ${session.id}`);
      expect(text).toContain('User: fix the login bug');
      expect(text).toContain('Assistant: done');
      expect(text).toContain('The person asks:\n\nnow do the same in the API');
    });

    it('refuses a thread', async () => {
      const thread = await createThread();
      const res = await call('POST', `/workbenches/${thread.id}/thread`, {});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('already_thread');
    });

    it("refuses another owner's session", async () => {
      const session = await createSession();
      const res = await call('POST', `/workbenches/${session.id}/thread`, {}, 'owner-b');
      expect(res.status).toBe(404);
    });

    it.each([
      ['no conversation and no prompt', '', null, ['has no conversation yet', 'wait for the person']],
      ['a recap and a prompt', 'User: hi', 'go on', ['so far:\n\nUser: hi', 'The person asks:\n\ngo on']],
    ])('writes the first message for %s', (_name, recap, prompt, parts) => {
      const text = continueAsThreadMessage(
        { id: 'wb-1', name: 'login', title: null, repoFullName: 'acme/app', branch: 'fix-login' },
        recap,
        prompt,
      );
      expect(text).toContain('"login" (session id wb-1) on acme/app, branch fix-login');
      for (const part of parts) expect(text).toContain(part);
    });
  });

  describe('sessions report to their thread', () => {
    const threadChat = async (threadId: string) => (await listChats(threadId))[0].id;
    const eventsOf = async (chatId: string) => (await listEvents(chatId, 0, 500)).events.map((e) => e.event as Loose);
    const cards = async (chatId: string) => (await eventsOf(chatId)).filter((e) => e.type === 'talyn_thread');
    const talynMessages = async (chatId: string) =>
      (await eventsOf(chatId)).filter((e) => e.talyn?.kind === 'user_message' && e.talyn?.origin === 'talyn');

    it('writes a card and wakes the thread when a session finishes a turn, and the woken turn wakes nothing', async () => {
      const thread = await createThread();
      const chatId = await threadChat(thread.id);
      const session = await createSession({ threadId: thread.id, prompt: 'fix the login bug' });

      await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(1), { timeout: 5000 });
      const [card] = await cards(chatId);
      expect(card).toMatchObject({ action: 'session_finished', sessionId: session.id, repo: 'acme/app', status: 'idle' });
      const [wake] = await talynMessages(chatId);
      expect(wake.message.content[0].text).toContain(`[Talyn] Session "${session.name}" (session id ${session.id}) on acme/app finished its turn.`);
      expect(wake.message.content[0].text).toContain('talyn_list_thread_sessions');

      // The woken thread turn runs and ends with no new card or message: a thread never notifies.
      await vi.waitFor(async () => expect((await getChat(chatId))?.turnCount).toBe(1), { timeout: 5000 });
      await idle(chatId);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await cards(chatId)).toHaveLength(1);
      expect(await talynMessages(chatId)).toHaveLength(1);
      expect((await getChat(chatId))?.turnCount).toBe(1);
      // The thread's agent was told it runs in a thread.
      expect(fleet.scripts.filter((s) => isAgentTurn(s)).some((s) => s.includes('This is a Talyn thread'))).toBe(true);
    });

    it('writes a card and wakes the thread when a session links a pull request', async () => {
      const thread = await createThread();
      const chatId = await threadChat(thread.id);
      const session = await createSession({ threadId: thread.id });
      await testDb.db.insert(pullRequests).values({
        id: 'pr-1', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'acme', repo: 'app', number: 7, state: 'open',
        lastSummary: { headBranch: session.branch, createdAt: new Date().toISOString() },
      });
      const got = await call('GET', `/workbenches/${session.id}`);
      expect(got.body.data.pullRequestId).toBe('pr-1');

      await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(1), { timeout: 5000 });
      expect(await cards(chatId)).toEqual([
        expect.objectContaining({ action: 'pr_opened', sessionId: session.id, prUrl: 'https://github.com/acme/app/pull/7' }),
      ]);
      expect((await talynMessages(chatId))[0].message.content[0].text).toContain('opened a pull request: https://github.com/acme/app/pull/7');
    });

    it('writes a start card with no wake when a thread starts a session', async () => {
      const thread = await createThread();
      const chatId = await threadChat(thread.id);
      const session = await createSession({ threadId: thread.id });
      await announceThreadSession(session.id);
      expect(await cards(chatId)).toEqual([expect.objectContaining({ action: 'session_started', sessionId: session.id })]);
      expect(await talynMessages(chatId)).toHaveLength(0);
      expect((await getChat(chatId))?.turnCount).toBe(0);
      expect(emitted.some((e) => e.type === 'workbench:event' && (e.payload as Loose).chatId === chatId)).toBe(true);
    });

    it('keeps one waiting wake when several sessions change during a thread turn', async () => {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const thread = await createThread();
      const chatId = await threadChat(thread.id);
      scriptedFleet((script) => (isAgentTurn(script) && script.includes('hold the thread')
        ? { stdout: claudeTurnLines('sess-t', 'ok'), hold } : null));
      await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'hold the thread' });
      await vi.waitFor(async () => expect((await getChat(chatId))?.status).toBe('running'));

      const first = await createSession({ threadId: thread.id, prompt: 'one' });
      const second = await createSession({ threadId: thread.id, prompt: 'two' });
      await vi.waitFor(async () => expect(await cards(chatId)).toHaveLength(2), { timeout: 5000 });
      expect((await cards(chatId)).map((c) => c.sessionId).sort()).toEqual([first.id, second.id].sort());
      const queued = (await getChat(chatId))!.queuedMessages;
      expect(queued).toHaveLength(1);
      expect(queued[0].origin).toBe('talyn');
      release();
      await vi.waitFor(async () => expect((await getChat(chatId))?.turnCount).toBe(2), { timeout: 5000 });
    });

    it('pauses on the second unchanged event and writes one pause card', async () => {
      const thread = await createThread();
      const chatId = await threadChat(thread.id);
      const session = await createSession({ threadId: thread.id });
      const child = (await getWorkbench(session.id))!;

      await notifyThread(child, 'session_finished');
      await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(1), { timeout: 5000 });
      await idle(chatId);
      await notifyThread(child, 'session_finished');
      expect((await cards(chatId)).at(-1)?.action).toBe('paused');
      await notifyThread(child, 'session_finished');
      expect((await cards(chatId)).filter((card) => card.action === 'paused')).toHaveLength(1);
      expect(await talynMessages(chatId)).toHaveLength(1);
    });

    it('wakes for progress without a count limit, then pauses until a person writes', async () => {
      const thread = await createThread();
      const chatId = await threadChat(thread.id);
      const session = await createSession({ threadId: thread.id });

      for (let count = 1; count <= 15; count++) {
        await testDb.db.update(workbenches).set({ pushedHeadShas: [`sha-${count}`] }).where(eq(workbenches.id, session.id));
        await notifyThread((await getWorkbench(session.id))!, 'session_finished');
        await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(count), { timeout: 5000 });
        await idle(chatId);
      }

      await testDb.db.insert(pullRequests).values({
        id: 'progress-pr', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'acme', repo: 'app', number: 8,
        state: 'open', lastSummary: { headSha: 'sha-15', ciStatus: 'pending' },
      });
      await testDb.db.update(workbenches).set({ pullRequestId: 'progress-pr' }).where(eq(workbenches.id, session.id));
      await notifyThread((await getWorkbench(session.id))!, 'pr_opened');
      await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(16), { timeout: 5000 });
      await idle(chatId);

      await testDb.db.update(pullRequests).set({ lastSummary: { headSha: 'sha-15', ciStatus: 'failed' } }).where(eq(pullRequests.id, 'progress-pr'));
      await notifyThread((await getWorkbench(session.id))!, 'session_finished');
      await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(17), { timeout: 5000 });
      await idle(chatId);

      const childChatId = (await listChats(session.id))[0].id;
      await testDb.db.update(workbenchChats).set({ status: 'error' }).where(eq(workbenchChats.id, childChatId));
      await notifyThread((await getWorkbench(session.id))!, 'session_finished');
      await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(18), { timeout: 5000 });
      await idle(chatId);

      await notifyThread((await getWorkbench(session.id))!, 'session_finished');
      expect((await cards(chatId)).at(-1)?.action).toBe('paused');
      expect(await talynMessages(chatId)).toHaveLength(18);

      await notifyThread((await getWorkbench(session.id))!, 'session_finished');
      expect((await cards(chatId)).filter((card) => card.action === 'paused')).toHaveLength(1);
      expect(await talynMessages(chatId)).toHaveLength(18);

      expect((await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'Please continue.' })).status).toBe(200);
      await idle(chatId);
      await notifyThread((await getWorkbench(session.id))!, 'session_finished');
      await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(19), { timeout: 5000 });
    });

    it('tells the thread when a local session in it waits for an answer, then when it finishes', async () => {
      const thread = await createThread();
      const chatId = await threadChat(thread.id);
      const res = await call('POST', '/workbenches', {
        workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'local', agent: 'claude', deviceId: 'dev-1', localPath: '/tmp/wt', threadId: thread.id,
      });
      expect(res.status).toBe(200);
      const localChat = (await listChats(res.body.data.id))[0].id;
      await call('PATCH', `/workbenches/chats/${localChat}/local`, { status: 'running' });
      expect(await cards(chatId)).toHaveLength(0);
      await call('PATCH', `/workbenches/chats/${localChat}/local`, { status: 'awaiting_input' });
      await vi.waitFor(async () => expect(await cards(chatId)).toHaveLength(1));
      expect((await cards(chatId))[0]).toMatchObject({ action: 'needs_input', status: 'awaiting_input' });
      await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(1));
      await idle(chatId);

      await call('PATCH', `/workbenches/chats/${localChat}/local`, { status: 'running' });
      await call('PATCH', `/workbenches/chats/${localChat}/local`, { status: 'idle' });
      await vi.waitFor(async () => expect(await cards(chatId)).toHaveLength(2));
      expect((await cards(chatId))[1]).toMatchObject({ action: 'session_finished', status: 'idle' });
    });

    describe('a merged pull request', () => {
      async function linkPr(sessionId: string, state: 'open' | 'merged', id = 'merge-pr', number = 9): Promise<void> {
        await testDb.db.insert(pullRequests).values({
          id, workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'acme', repo: 'app', number, state: 'open',
          lastSummary: { headBranch: 'b', createdAt: new Date().toISOString() },
        });
        await testDb.db.update(workbenches).set({ pullRequestId: id }).where(eq(workbenches.id, sessionId));
        if (state === 'merged') {
          await testDb.db.update(pullRequests).set({ state, mergedAt: new Date(Date.now() + 1000) }).where(eq(pullRequests.id, id));
        }
      }

      it('writes a card and wakes the thread one time, however often the merge is seen', async () => {
        const thread = await createThread();
        const chatId = await threadChat(thread.id);
        const session = await createSession({ threadId: thread.id });
        await linkPr(session.id, 'merged');

        await notifyThreadsOfMergedPr('merge-pr');
        await notifyThreadsOfMergedPr('merge-pr');
        await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(1), { timeout: 5000 });
        await idle(chatId);
        await notifyThreadsOfMergedPr('merge-pr');

        expect(await cards(chatId)).toEqual([
          expect.objectContaining({ action: 'pr_merged', sessionId: session.id, prUrl: 'https://github.com/acme/app/pull/9' }),
        ]);
        expect(await talynMessages(chatId)).toHaveLength(1);
        expect((await talynMessages(chatId))[0].message.content[0].text)
          .toContain(`The pull request of session "${session.name}" (session id ${session.id}) on acme/app merged: https://github.com/acme/app/pull/9.`);
      });

      it('wakes the thread when the webhook path marks the pull request merged', async () => {
        const thread = await createThread();
        const chatId = await threadChat(thread.id);
        const session = await createSession({ threadId: thread.id });
        await linkPr(session.id, 'open');

        expect(await prMonitorService.markPrTerminal([{ repositoryId: 'repo-a' }], 9, { merged: true, mergedAt: new Date(Date.now() + 1000) })).toBe(1);
        await vi.waitFor(async () => expect(await talynMessages(chatId)).toHaveLength(1), { timeout: 5000 });
        expect((await cards(chatId)).map((card) => card.action)).toEqual(['pr_merged']);
      });

      it.each([
        ['an open pull request', 'open', true],
        ['a session outside a thread', 'merged', false],
      ] as const)('does nothing for %s', async (_name, state, inThread) => {
        const thread = await createThread();
        const chatId = await threadChat(thread.id);
        const session = await createSession(inThread ? { threadId: thread.id } : {});
        await linkPr(session.id, state);
        await notifyThreadsOfMergedPr('merge-pr');
        expect(await cards(chatId)).toHaveLength(0);
        expect(await talynMessages(chatId)).toHaveLength(0);
      });

      it('does nothing for a pull request linked after it merged', async () => {
        const thread = await createThread();
        const chatId = await threadChat(thread.id);
        const session = await createSession({ threadId: thread.id });
        await linkPr(session.id, 'merged');
        await testDb.db.update(pullRequests).set({ mergedAt: new Date(Date.now() - 1000) }).where(eq(pullRequests.id, 'merge-pr'));
        await notifyThreadsOfMergedPr('merge-pr');
        expect(await cards(chatId)).toHaveLength(0);
      });

      it('does nothing when the thread is archived', async () => {
        const thread = await createThread();
        const chatId = await threadChat(thread.id);
        const session = await createSession({ threadId: thread.id });
        await linkPr(session.id, 'merged');
        await testDb.db.update(workbenches).set({ archivedAt: new Date() }).where(eq(workbenches.id, thread.id));
        await notifyThreadsOfMergedPr('merge-pr');
        expect(await cards(chatId)).toHaveLength(0);
      });
    });

    it('does nothing for a session outside a thread', async () => {
      const thread = await createThread();
      const chatId = await threadChat(thread.id);
      const session = await createSession({ prompt: 'alone' });
      await idle((await listChats(session.id))[0].id);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await cards(chatId)).toHaveLength(0);
    });

    it.each([
      ['session_finished', 'idle', undefined, 'finished its turn.'],
      ['session_finished', 'idle', 'https://x/pull/1', 'finished its turn. Its pull request is https://x/pull/1.'],
      ['session_finished', 'error', undefined, 'stopped with an error.'],
      ['pr_opened', 'idle', 'https://x/pull/1', 'opened a pull request: https://x/pull/1.'],
      ['needs_input', 'awaiting_input', undefined, 'is waiting for an answer.'],
    ] as const)('words the wake for %s (%s, %s)', (action, status, prUrl, expected) => {
      const text = threadWakeText({ action, status, sessionId: 's1', name: 'api', repo: 'acme/api', ...(prUrl ? { prUrl } : {}) });
      expect(text.split('\n')[0]).toBe(`[Talyn] Session "api" (session id s1) on acme/api ${expected}`);
    });

    it.each([
      ['https://x/pull/1', 'merged: https://x/pull/1.'],
      [undefined, 'merged.'],
    ] as const)('words the merge wake (%s)', (prUrl, expected) => {
      const text = threadWakeText({ action: 'pr_merged', status: 'idle', sessionId: 's1', name: 'api', repo: 'acme/api', ...(prUrl ? { prUrl } : {}) });
      expect(text.split('\n')[0]).toBe(`[Talyn] The pull request of session "api" (session id s1) on acme/api ${expected}`);
    });
  });

  describe('old clients', () => {
    it.each([
      ['a thread row', { type: 'workbench:updated', payload: { workbench: { kind: 'thread' } } }, 'threads'],
      ['a session row', { type: 'workbench:updated', payload: { workbench: { kind: 'session' } } }, null],
      ['a row from an older server', { type: 'workbench:updated', payload: { workbench: {} } }, null],
      ['a chat', { type: 'workbench:chat', payload: { chat: {} } }, null],
      ['a malformed payload', { type: 'workbench:updated', payload: null }, null],
    ])('needs the right capability for %s', (_name, event, expected) => {
      expect(capabilityFor({ ...event, timestamp: '' } as Loose)).toBe(expected);
    });
  });
});
