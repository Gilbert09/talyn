import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { eq } from 'drizzle-orm';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { pullRequests, repositories, workbenches, workspaces } from '../db/schema.js';
import type { SandboxRun } from '../services/workbenches/cheapAgent.js';
import type { SandboxExecResult } from '../services/workbenches/sandboxRuntime.js';

/**
 * A LOCAL session's branch name after its first turn (reserve → the desktop
 * renames → confirm), the allocated-branch rules for local sessions, and the
 * row following a `rename_branch` turn.
 */

const emitted: Array<{ type: string; payload: unknown }> = [];
const sent: Array<{ chatId: string; input: { text: string; intent?: string } }> = [];

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: (_workspaceId: string, event: { type: string; payload: unknown }) => {
    emitted.push({ type: event.type, payload: event.payload });
  },
}));

vi.mock('../services/workbenches/turns.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/turns.js')>()),
  sendMessage: async (chatId: string, input: { text: string; intent?: string }) => {
    sent.push({ chatId, input });
    return { queued: false };
  },
}));

const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { githubService } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { BRANCH_NAMING_MAX_TURNS, followBranchRename } = await import('../services/workbenches/branchName.js');
const { runWorkbenchAction } = await import('../services/workbenches/actions.js');
const { normaliseMessage } = await import('../services/workbenches/turns.js');
const { getWorkbench, insertChat, insertWorkbench, localSessionTurnCount, storeNumberedEvents, updateChat, updateWorkbench } =
  await import('../services/workbenches/store.js');

const START = 'tom/look-login';
const FAR_FUTURE = new Date('2099-01-01T00:00:00Z');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

describe('local branch naming', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let onGithub: Set<string>;

  async function call(method: string, path: string, body?: unknown, user = 'owner-a'): Promise<{ status: number; body: Loose }> {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: await resp.json() };
  }

  const reserve = (body: Record<string, unknown> = {}, user?: string) =>
    call('POST', '/workbenches/wb-1/branch-name', { chatId: 'chat-1', ...body }, user);
  const confirm = (from: string, to: string) => call('POST', '/workbenches/wb-1/branch-name/confirm', { from, to });
  const row = async () => (await getWorkbench('wb-1'))!;
  const namedAt = async (id = 'wb-1') =>
    (await testDb.db.select({ at: workbenches.branchNamedAt }).from(workbenches).where(eq(workbenches.id, id)))[0].at;
  const turnsDone = async (chatId: string, turns: number) => {
    const events = Array.from({ length: turns }, (_, i) => ({ chatId, seq: i + 1, turn: i + 1, event: { type: 'user', seq: i + 1 } }));
    await storeNumberedEvents(chatId, events);
  };
  const otherSession = (id: string, branch: string, allocatedBranch = true) => insertWorkbench({
    id, workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: id, branch, allocatedBranch,
    baseBranch: 'main', runtime: 'local', agent: 'claude', status: 'ready', deviceId: 'dev-1', localPath: `/tmp/${id}`,
  });

  beforeEach(async () => {
    emitted.length = 0;
    sent.length = 0;
    onGithub = new Set();
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A', settings: { sessionBranchPrefix: 'tom/' } },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values({
      id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r', defaultBranch: 'main',
    });
    await insertWorkbench({
      id: 'wb-1', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: 'look-login',
      branch: START, allocatedBranch: true, baseBranch: 'main', runtime: 'local', agent: 'claude', status: 'ready',
      deviceId: 'dev-1', localPath: '/tmp/wt',
    });
    await insertChat({ id: 'chat-1', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
    await turnsDone('chat-1', 1);
    vi.spyOn(githubService, 'branchExists').mockImplementation(async (_ws, _owner, _repo, branch) => onGithub.has(branch));

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
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  describe('reserve', () => {
    it("answers 404 for another owner's session and changes nothing", async () => {
      const res = await reserve({ title: 'Fix the login redirect' }, 'owner-b');
      expect(res.status).toBe(404);
      expect(await namedAt()).toBeNull();
      expect((await call('POST', '/workbenches/wb-1/branch-name/confirm', { from: START, to: 'tom/x' }, 'owner-b')).status).toBe(404);
    });

    it('refuses a sandbox session', async () => {
      await updateWorkbench('wb-1', { runtime: 'sandbox', sandboxId: 'talyn-wb-wb-1' });
      const res = await reserve({ title: 'Fix the login redirect' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('sandbox_runtime');
    });

    it('checks without claiming, so the desktop asks its model only for a session that may move', async () => {
      const res = await reserve();
      expect(res.body.data).toEqual({ outcome: 'suggest' });
      expect(await namedAt()).toBeNull();
      expect((await row()).branch).toBe(START);
    });

    it('reserves a prefixed, unique name from the PR title without moving the row', async () => {
      const res = await reserve({ title: 'fix(auth): Fix the login redirect loop' });
      expect(res.body.data).toEqual({ outcome: 'rename', from: START, to: 'tom/fix-login-redirect-loop' });
      expect((await row()).branch).toBe(START);
      expect(await namedAt()).not.toBeNull();
      expect(emitted.filter((e) => e.type === 'workbench:updated')).toEqual([]);
    });

    it("reads a model's answer the way the sandbox path does", async () => {
      const res = await reserve({ suggestion: '`feature/fix-login-redirect`' });
      expect(res.body.data).toEqual({ outcome: 'rename', from: START, to: 'tom/fix-login-redirect' });
    });

    it('takes the next free suffix when another session or GitHub has the name', async () => {
      await otherSession('wb-2', 'tom/fix-login-redirect');
      onGithub.add('tom/fix-login-redirect-2');
      const res = await reserve({ suggestion: 'fix-login-redirect' });
      expect(res.body.data.to).toBe('tom/fix-login-redirect-3');
    });

    it.each([
      ['a branch a person chose', () => updateWorkbench('wb-1', { allocatedBranch: false }), 'chosen_branch'],
      ['a linked PR', async () => {
        await testDb.db.insert(pullRequests).values({
          id: 'pr-1', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number: 1, state: 'open',
          lastSummary: { headBranch: START, headSha: 'abc' },
        });
        await updateWorkbench('wb-1', { pullRequestId: 'pr-1' });
      }, 'has_pr'],
      ['a pushed head', () => updateWorkbench('wb-1', { pushedHeadShas: ['abc'] }), 'pushed'],
      ['an archived session', () => updateWorkbench('wb-1', { archivedAt: FAR_FUTURE }), 'archived'],
      ['a session past the turn cap', () => turnsDone('chat-1', BRANCH_NAMING_MAX_TURNS + 1), 'too_many_turns'],
    ])('keeps the name, and decides, for %s, even in a check', async (_name, arrange, reason) => {
      await arrange();
      expect((await reserve()).body.data).toEqual({ outcome: 'keep', reason });
      expect(await namedAt()).not.toBeNull();
      expect((await reserve({ title: 'Fix the login redirect' })).body.data).toEqual({ outcome: 'keep', reason: 'decided' });
      expect((await row()).branch).toBe(START);
    });

    it.each([
      ['the branch is on GitHub', () => onGithub.add(START), { title: 'Fix the login redirect' }, 'on_github'],
      ['the title has no usable words', () => undefined, { title: '!!!' }, 'no_suggestion'],
      ['the model gave no answer', () => undefined, { suggestion: '' }, 'no_suggestion'],
      ['the name is the one it has', () => undefined, { suggestion: 'look-login' }, 'same_name'],
      ['a suffixed name is the same name', () => updateWorkbench('wb-1', { branch: 'tom/look-login-2' }), { suggestion: 'look-login' }, 'same_name'],
    ])('keeps the name when %s', async (_name, arrange, body, reason) => {
      await arrange();
      const before = (await row()).branch;
      expect((await reserve(body)).body.data).toEqual({ outcome: 'keep', reason });
      expect(await namedAt()).not.toBeNull();
      expect((await row()).branch).toBe(before);
    });

    it('waits, without claiming, while another chat of the session runs a turn', async () => {
      await insertChat({ id: 'chat-2', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Two', agent: 'claude' });
      await updateChat('chat-2', { status: 'running' });
      await updateChat('chat-1', { status: 'running' });
      expect((await reserve({ title: 'Fix the login redirect' })).body.data).toEqual({ outcome: 'not_now', reason: 'turn_running' });
      expect(await namedAt()).toBeNull();
      await updateChat('chat-2', { status: 'idle' });
      expect((await reserve({ title: 'Fix the login redirect' })).body.data.outcome).toBe('rename');
    });

    it('hands out one name per session', async () => {
      expect((await reserve({ title: 'Fix the login redirect' })).body.data.outcome).toBe('rename');
      expect((await reserve({ title: 'Something else entirely' })).body.data).toEqual({ outcome: 'keep', reason: 'decided' });
    });
  });

  describe('confirm', () => {
    it('moves the row after the desktop renamed its branch, and broadcasts it', async () => {
      const { to } = (await reserve({ title: 'Fix the login redirect' })).body.data;
      const res = await confirm(START, to);
      expect(res.body.data.outcome).toBe('renamed');
      expect(res.body.data.workbench.branch).toBe(to);
      expect((await row()).branch).toBe(to);
      expect((await row()).allocatedBranch).toBe(true);
      const event = emitted.find((e) => e.type === 'workbench:updated');
      expect((event?.payload as { workbench: { branch: string } }).workbench.branch).toBe(to);
    });

    it('answers the same when a confirm is sent again', async () => {
      const { to } = (await reserve({ title: 'Fix the login redirect' })).body.data;
      await confirm(START, to);
      expect((await confirm(START, to)).body.data.outcome).toBe('renamed');
    });

    it('refuses when another session took the name after the reservation', async () => {
      const { to } = (await reserve({ title: 'Fix the login redirect' })).body.data;
      await otherSession('wb-2', to);
      expect((await confirm(START, to)).body.data).toEqual({ outcome: 'refused', reason: 'name_taken' });
      expect((await row()).branch).toBe(START);
    });

    it.each([
      ['nothing was reserved', async () => undefined],
      ['the row moved on', async () => updateWorkbench('wb-1', { archivedAt: FAR_FUTURE })],
      ['a person chose the branch since', async () => updateWorkbench('wb-1', { allocatedBranch: false })],
    ])('refuses when %s', async (name, arrange) => {
      if (name !== 'nothing was reserved') await reserve({ title: 'Fix the login redirect' });
      await arrange();
      expect((await confirm(START, 'tom/fix-login-redirect')).body.data).toEqual({ outcome: 'refused', reason: 'row_changed' });
      expect((await row()).branch).toBe(START);
    });

    it('refuses a name that is not a branch name', async () => {
      await reserve({ title: 'Fix the login redirect' });
      expect((await confirm(START, 'bad name')).status).toBe(400);
    });
  });

  describe('a local branch at creation', () => {
    const create = (extra: Record<string, unknown>) => call('POST', '/workbenches', {
      workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'local', agent: 'claude', deviceId: 'dev-1',
      localPath: '/tmp/new', name: 'new-one', ...extra,
    });
    const allocatedOf = async (id: string) => (await getWorkbench(id))!.allocatedBranch;

    it.each([
      ['named by the desktop', { branch: 'tom/fix-thing', branchGenerated: true }, true],
      ['chosen by a person', { branch: 'my-branch' }, false],
      ['flagged with a value that is not true', { branch: 'tom/fix-thing', branchGenerated: 'yes' }, false],
    ])('is Talyn\'s when %s', async (_name, extra, allocated) => {
      const res = await create(extra);
      expect(res.status).toBe(200);
      expect(await allocatedOf(res.body.data.id)).toBe(allocated);
      expect(await namedAt(res.body.data.id)).toBeNull();
    });

    it('stays a plain branch when another session already holds the name', async () => {
      await otherSession('wb-2', 'tom/fix-thing');
      const res = await create({ branch: 'tom/fix-thing', branchGenerated: true });
      expect(res.status).toBe(200);
      expect(await allocatedOf(res.body.data.id)).toBe(false);
    });

    it("stops being Talyn's when the desktop reports a checkout of another branch", async () => {
      const res = await call('PATCH', '/workbenches/wb-1', { branch: 'their-pr-branch' });
      expect(res.status).toBe(200);
      expect(await row()).toMatchObject({ branch: 'their-pr-branch', allocatedBranch: false });
    });
  });

  it('counts a local session\'s turns from its uploaded events, across chats', async () => {
    await insertChat({ id: 'chat-2', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Two', agent: 'claude' });
    await turnsDone('chat-2', 2);
    expect(await localSessionTurnCount('wb-1')).toBe(3);
    await insertChat({ id: 'chat-3', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Three', agent: 'claude' });
    expect(await localSessionTurnCount('wb-1')).toBe(3);
  });

  describe('the rename_branch action', () => {
    const result = (stdout: string, exitCode = 0): SandboxExecResult => ({ exitCode, stdout, stderr: '', stdoutBytes: Buffer.from(stdout) });
    const boxOn = (branch: string, exitCode = 0) => vi.fn<SandboxRun>(async () => result(`${branch}\n`, exitCode));
    const sandbox = () => updateWorkbench('wb-1', { runtime: 'sandbox', sandboxId: 'talyn-wb-wb-1' });

    it('sends its prompt with the rename_branch intent', async () => {
      await sandbox();
      await runWorkbenchAction(await row(), 'rename_branch', 'chat-1');
      expect(sent).toHaveLength(1);
      expect(sent[0].input.intent).toBe('rename_branch');
      await runWorkbenchAction(await row(), 'fix_checks', 'chat-1');
      expect(sent[1].input.intent).toBeUndefined();
    });

    it('is an intent a message may carry', () => {
      expect(normaliseMessage({ text: 'rename it', intent: 'rename_branch' }).intent).toBe('rename_branch');
    });

    it('moves the row to the branch the box has now, a person\'s choice, and links its PR', async () => {
      await sandbox();
      await testDb.db.insert(pullRequests).values({
        id: 'pr-9', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number: 9, state: 'open',
        lastSummary: { headBranch: 'feat/login-redirect', headSha: 'abc', createdAt: FAR_FUTURE.toISOString() },
      });
      const followed = await followBranchRename(await row(), boxOn('feat/login-redirect'));
      expect(followed?.branch).toBe('feat/login-redirect');
      expect(await row()).toMatchObject({ branch: 'feat/login-redirect', allocatedBranch: false, pullRequestId: 'pr-9' });
      expect(await namedAt()).not.toBeNull();
      const event = emitted.find((e) => e.type === 'workbench:updated');
      expect((event?.payload as { workbench: { branch: string } }).workbench.branch).toBe('feat/login-redirect');
    });

    it('does not clash with a Talyn-named branch of the same name elsewhere', async () => {
      await sandbox();
      await otherSession('wb-2', 'tom/taken');
      expect((await followBranchRename(await row(), boxOn('tom/taken')))?.branch).toBe('tom/taken');
    });

    it.each([
      ['the branch did not change', START, 0],
      ['the box is on a detached HEAD', 'HEAD', 0],
      ['git failed', 'whatever', 128],
    ])('changes nothing when %s', async (_name, branch, exitCode) => {
      await sandbox();
      expect(await followBranchRename(await row(), boxOn(branch, exitCode))).toBeNull();
      expect(await row()).toMatchObject({ branch: START, allocatedBranch: true });
      expect(emitted).toEqual([]);
    });

    it('changes nothing for a local session (the desktop follows its own worktree)', async () => {
      const run = boxOn('feat/x');
      expect(await followBranchRename(await row(), run)).toBeNull();
      expect(run).not.toHaveBeenCalled();
    });
  });
});
