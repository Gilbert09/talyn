import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { SANDBOX_SIZES } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn, type ExecReply } from './helpers/fakeFleet.js';
import { repositories, workspaces } from '../db/schema.js';

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
      expect(fleet.scripts.some((s) => s.includes('info/exclude'))).toBe(false);
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
