import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeFleet, type ExecReply } from './helpers/fakeFleet.js';
import { pullRequests, repositories, workspaces } from '../db/schema.js';

/**
 * Create PR: the chat turn with the `create_pr` intent, which opens the PR
 * when it ends, and the commit-push-open route, against a fake fleet with
 * GitHub and the PR monitor stubbed.
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

const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { GitHubApiError, githubService } = await import('../services/github.js');
const { prMonitorService } = await import('../services/prMonitor.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { getChat, getWorkbench, listChats, listEvents } = await import('../services/workbenches/store.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

interface Json {
  status: number;
  body: { success: boolean; data?: Loose; error?: string; code?: string };
}

const PR_TEXT =
  'I added the thing and its tests.\n\n```talyn-pr\n{"title":"feat: add the thing","body":"## Summary\\nAdds it.","commitMessage":"feat: wip","draft":false}\n```';

function claudeResult(text: string, isError = false): string[] {
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    JSON.stringify({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: text }),
  ];
}

/** What the box's git answers, per step. */
interface GitWorld {
  status?: string;
  ahead?: string;
  push?: ExecReply;
  commit?: ExecReply;
}

describe('workbench Create PR', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let fleet: FakeFleet;
  let world: GitWorld;
  let turnReply: ExecReply;

  async function call(method: string, path: string, body?: unknown): Promise<Json> {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-user': 'owner-a', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: (await resp.json()) as Json['body'] };
  }

  async function sandboxWorkbench(agent: 'claude' | 'codex' = 'claude'): Promise<Loose> {
    const res = await call('POST', '/workbenches', { workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'sandbox', agent });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect((await getWorkbench(res.body.data.id))?.status).toBe('ready'), { timeout: 5000 });
    return res.body.data;
  }

  async function localWorkbench(): Promise<Loose> {
    const res = await call('POST', '/workbenches', {
      workspaceId: 'ws-a', repositoryId: 'repo-a', runtime: 'local', agent: 'claude', deviceId: 'dev-1', localPath: '/tmp/wt',
    });
    return res.body.data;
  }

  /** Scripts run after provisioning, so a test reads only its own. */
  let mark = 0;
  const scriptsSinceMark = () => fleet.scripts.slice(mark);

  const createPr = vi.fn();
  const findExisting = vi.fn();
  const watch = vi.fn();

  beforeEach(async () => {
    emitted.length = 0;
    world = { status: '', ahead: '2\n' };
    turnReply = { stdout: claudeResult(PR_TEXT) };
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values([{ id: 'ws-a', ownerId: 'owner-a', name: 'A' }]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main' },
    ]);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    createPr.mockReset().mockResolvedValue({ number: 7, html_url: 'https://github.com/acme/app/pull/7' });
    findExisting.mockReset().mockResolvedValue(null);
    watch.mockReset().mockImplementation(async ({ number }: { number: number }) => {
      await testDb.db.insert(pullRequests).values({
        id: `pr-${number}`, workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'acme', repo: 'app', number, state: 'open',
        lastSummary: { headBranch: 'x', mergeable: 'MERGEABLE', ciStatus: 'passing' },
      });
      return { ok: true, rowId: `pr-${number}`, alreadyTracked: false, summary: {} };
    });
    vi.spyOn(githubService, 'createPullRequest').mockImplementation(createPr);
    vi.spyOn(githubService, 'findOpenPullRequestForHead').mockImplementation(findExisting);
    vi.spyOn(prMonitorService, 'watchPullRequest').mockImplementation(watch);

    fleet = new FakeFleet();
    fleet.handler = async (script) => {
      if (script.startsWith('claude ') || script.startsWith('codex ')) return turnReply;
      if (script.includes('git status --porcelain')) return { stdout: world.status ?? '' };
      if (script.includes('git commit -m')) return world.commit ?? { exitCode: 0 };
      if (script.includes('rev-list --count')) return { stdout: world.ahead ?? '' };
      if (script.includes('git push -u origin HEAD')) return world.push ?? { exitCode: 0 };
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
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
    setWorkbenchFleetClientForTests(null);
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  describe('a Create PR turn', () => {
    /** Send a message and wait for its turn, and anything it opens, to finish. */
    async function sendAndSettle(chatId: string, body: Record<string, unknown>): Promise<Loose[]> {
      const res = await call('POST', `/workbenches/chats/${chatId}/messages`, body);
      expect(res.status).toBe(200);
      await vi.waitFor(async () => expect((await getChat(chatId))?.status).not.toBe('running'), { timeout: 5000 });
      return (await listEvents(chatId, 0, 200)).events.map((e: Loose) => e.event);
    }

    const createPrMessage = { text: 'Create a pull request', intent: 'create_pr' };
    const prEvents = (events: Loose[]) => events.filter((e) => e.type === 'talyn_pr');

    it('gives Claude the hidden instructions as a system prompt, keeps the short text, and opens the PR', async () => {
      const wb = await sandboxWorkbench();
      const chatId = (await listChats(wb.id))[0].id;
      mark = fleet.scripts.length;
      world.status = ' M src/a.ts\n';
      const events = await sendAndSettle(chatId, createPrMessage);

      const script = scriptsSinceMark().find((s) => s.startsWith('claude '))!;
      expect(script).toContain('--append-system-prompt');
      expect(script).toContain('Do not commit, push or open the pull request');
      expect(script).toContain('```talyn-pr');
      expect(script.trimEnd().endsWith("-- 'Create a pull request'")).toBe(true);

      const user = events.find((e) => e.type === 'user' && e.talyn?.kind === 'user_message');
      expect(user.message.content).toEqual([{ type: 'text', text: 'Create a pull request' }]);
      expect(user.talyn.intent).toBe('create_pr');
      expect(JSON.stringify(events)).not.toContain('Do not commit, push');

      expect(createPr).toHaveBeenCalledTimes(1);
      expect(createPr).toHaveBeenCalledWith('ws-a', 'acme', 'app', {
        title: 'feat: add the thing', head: wb.branch, base: 'main', body: '## Summary\nAdds it.', draft: false,
      });
      expect(scriptsSinceMark().find((s) => s.includes('git commit -m'))).toContain("git commit -m 'feat: wip'");
      expect(prEvents(events)).toEqual([
        expect.objectContaining({ type: 'talyn_pr', ok: true, number: 7, url: 'https://github.com/acme/app/pull/7', existing: false }),
      ]);
      // The outcome comes after the turn's result, in the same turn.
      expect(events.findIndex((e) => e.type === 'talyn_pr')).toBeGreaterThan(events.findIndex((e) => e.type === 'result'));
      expect((await getWorkbench(wb.id))?.pullRequestId).toBe('pr-7');
      expect(emitted.some((e) => e.type === 'workbench:updated' && (e.payload as Loose).workbench.pullRequestId === 'pr-7')).toBe(true);
      expect((await getChat(chatId))?.status).toBe('idle');
    });

    it('puts the hidden instructions in front of a Codex prompt, and still stores the short text', async () => {
      const wb = await sandboxWorkbench('codex');
      const chatId = (await listChats(wb.id))[0].id;
      mark = fleet.scripts.length;
      turnReply = {
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 't' }),
          JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: PR_TEXT } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
        ],
      };
      const events = await sendAndSettle(chatId, createPrMessage);
      const script = scriptsSinceMark().find((s) => s.startsWith('codex '))!;
      expect(script).not.toContain('--append-system-prompt');
      expect(script).toContain('Do not commit, push or open the pull request');
      expect(script).toContain('Create a pull request');
      const user = events.find((e) => e.type === 'user' && e.talyn?.kind === 'user_message');
      expect(user.message.content).toEqual([{ type: 'text', text: 'Create a pull request' }]);
      expect(prEvents(events)).toEqual([expect.objectContaining({ ok: true, number: 7 })]);
    });

    it('appends the session’s extra Create PR instructions', async () => {
      const wb = await sandboxWorkbench();
      await call('PATCH', `/workbenches/${wb.id}`, { settings: { prompts: { create_pr: 'Mention the ticket.' } } });
      const chatId = (await listChats(wb.id))[0].id;
      mark = fleet.scripts.length;
      await sendAndSettle(chatId, createPrMessage);
      expect(scriptsSinceMark().find((s) => s.startsWith('claude '))).toContain('Mention the ticket.');
    });

    it('says so in the thread when the reply has no talyn-pr block, and opens nothing', async () => {
      const wb = await sandboxWorkbench();
      const chatId = (await listChats(wb.id))[0].id;
      mark = fleet.scripts.length;
      turnReply = { stdout: claudeResult('I am not sure what to write.') };
      const events = await sendAndSettle(chatId, createPrMessage);
      expect(prEvents(events)).toEqual([
        expect.objectContaining({ ok: false, message: 'The agent did not return a pull request title. Press Create PR to try again.' }),
      ]);
      expect(createPr).not.toHaveBeenCalled();
      expect(scriptsSinceMark().some((s) => s.includes('git push'))).toBe(false);
    });

    it('opens nothing from a failed turn', async () => {
      const wb = await sandboxWorkbench();
      const chatId = (await listChats(wb.id))[0].id;
      mark = fleet.scripts.length;
      turnReply = { stdout: claudeResult('Not logged in', true), exitCode: 1 };
      const events = await sendAndSettle(chatId, createPrMessage);
      expect(prEvents(events)).toEqual([]);
      expect(createPr).not.toHaveBeenCalled();
      expect(scriptsSinceMark().some((s) => s.includes('git push'))).toBe(false);
      expect((await getChat(chatId))?.status).toBe('error');
    });

    it('records a refused push in the thread', async () => {
      const wb = await sandboxWorkbench();
      const chatId = (await listChats(wb.id))[0].id;
      world.push = { exitCode: 128, stderr: 'remote: Write access to repository not granted.\nfatal: error: 403' };
      const events = await sendAndSettle(chatId, createPrMessage);
      const [outcome] = prEvents(events);
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/^GitHub refused the push\. The Talyn GitHub App needs Contents: Read & write on acme\/app\./);
      expect(createPr).not.toHaveBeenCalled();
      expect((await getChat(chatId))?.status).toBe('idle');
    });

    it('leaves an ordinary message alone, even when its reply holds a talyn-pr block', async () => {
      const wb = await sandboxWorkbench();
      const chatId = (await listChats(wb.id))[0].id;
      mark = fleet.scripts.length;
      const events = await sendAndSettle(chatId, { text: 'Tidy up the tests' });
      expect(scriptsSinceMark().find((s) => s.startsWith('claude '))).not.toContain('--append-system-prompt');
      expect(prEvents(events)).toEqual([]);
      expect(createPr).not.toHaveBeenCalled();
    });

    it('refuses an unknown intent', async () => {
      const wb = await sandboxWorkbench();
      const chatId = (await listChats(wb.id))[0].id;
      const res = await call('POST', `/workbenches/chats/${chatId}/messages`, { text: 'x', intent: 'merge' });
      expect([res.status, res.body.code]).toEqual([400, 'bad_intent']);
    });
  });

  describe('creating', () => {
    const input = { title: 'feat: add the thing', body: 'Body', base: 'main', draft: true, commitMessage: 'feat: wip' };

    it('commits uncommitted work, pushes, opens the PR and links it', async () => {
      const wb = await sandboxWorkbench();
      mark = fleet.scripts.length;
      world.status = ' M src/a.ts\n';
      const res = await call('POST', `/workbenches/${wb.id}/pull-request`, input);
      expect(res.status).toBe(200);
      const scripts = scriptsSinceMark();
      const order = ['git status --porcelain', 'git commit -m', 'rev-list --count', 'git push -u origin HEAD'].map((needle) =>
        scripts.findIndex((s) => s.includes(needle)),
      );
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(scripts.find((s) => s.includes('git commit -m'))).toContain("git add -A\ngit commit -m 'feat: wip'");
      expect(createPr).toHaveBeenCalledWith('ws-a', 'acme', 'app', {
        title: 'feat: add the thing', head: wb.branch, base: 'main', body: 'Body', draft: true,
      });
      expect(res.body.data).toMatchObject({ pullRequest: { number: 7, url: 'https://github.com/acme/app/pull/7' }, existing: false });
      expect(res.body.data.workbench).toMatchObject({ pullRequestId: 'pr-7', pr: { number: 7 } });
      expect((await getWorkbench(wb.id))?.pullRequestId).toBe('pr-7');
      expect(emitted.some((e) => e.type === 'workbench:updated' && (e.payload as Loose).workbench.pullRequestId === 'pr-7')).toBe(true);
    });

    it('commits with the title when there is no drafted message, quoted as one argument', async () => {
      const wb = await sandboxWorkbench();
      mark = fleet.scripts.length;
      world.status = '?? new.txt\n';
      await call('POST', `/workbenches/${wb.id}/pull-request`, { ...input, title: "fix: it's $(done)", commitMessage: '' });
      expect(scriptsSinceMark().find((s) => s.includes('git commit -m'))).toContain(`git commit -m 'fix: it'\\''s $(done)'`);
    });

    it('does not commit a clean tree', async () => {
      const wb = await sandboxWorkbench();
      mark = fleet.scripts.length;
      expect((await call('POST', `/workbenches/${wb.id}/pull-request`, input)).status).toBe(200);
      expect(scriptsSinceMark().some((s) => s.includes('git commit -m'))).toBe(false);
      expect(scriptsSinceMark().some((s) => s.includes('git push -u origin HEAD'))).toBe(true);
    });

    it('refuses when the branch has nothing ahead of the base, before pushing', async () => {
      const wb = await sandboxWorkbench();
      mark = fleet.scripts.length;
      world.ahead = '0\n';
      const res = await call('POST', `/workbenches/${wb.id}/pull-request`, { ...input, base: 'develop' });
      expect([res.status, res.body.code]).toEqual([409, 'nothing_to_open']);
      expect(res.body.error).toBe('There is nothing to open a pull request for: the branch has no commits ahead of develop.');
      expect(scriptsSinceMark().some((s) => s.includes('git push'))).toBe(false);
      expect(createPr).not.toHaveBeenCalled();
    });

    it('says the GitHub App needs write access when the push gets a 403', async () => {
      const wb = await sandboxWorkbench();
      world.push = {
        exitCode: 128,
        stderr:
          "remote: Write access to repository not granted.\nfatal: unable to access 'http://127.0.0.1:8080/gh/acme/app.git/': The requested URL returned error: 403",
      };
      const res = await call('POST', `/workbenches/${wb.id}/pull-request`, input);
      expect([res.status, res.body.code]).toEqual([409, 'push_failed']);
      expect(res.body.error).toMatch(/^GitHub refused the push\. The Talyn GitHub App needs Contents: Read & write on acme\/app\.\n/);
      expect(res.body.error).toContain('returned error: 403');
      expect(createPr).not.toHaveBeenCalled();
    });

    it('says why a commit failed', async () => {
      const wb = await sandboxWorkbench();
      world.status = ' M a.ts\n';
      world.commit = { exitCode: 1, stderr: 'pre-commit hook failed: lint' };
      const res = await call('POST', `/workbenches/${wb.id}/pull-request`, input);
      expect([res.status, res.body.code]).toEqual([409, 'commit_failed']);
      expect(res.body.error).toContain('pre-commit hook failed: lint');
    });

    it('links the open PR when GitHub says one already exists for the branch', async () => {
      const wb = await sandboxWorkbench();
      createPr.mockRejectedValue(
        new GitHubApiError(
          'GitHub API error 422 Unprocessable Entity: Validation Failed (A pull request already exists for acme:x.) (GitHub request-id: r1)',
          422,
        ),
      );
      findExisting.mockResolvedValue({ number: 5, html_url: 'https://github.com/acme/app/pull/5' });
      const res = await call('POST', `/workbenches/${wb.id}/pull-request`, input);
      expect(res.status).toBe(200);
      expect(findExisting).toHaveBeenCalledWith('ws-a', 'acme', 'app', wb.branch);
      expect(res.body.data).toMatchObject({ existing: true, pullRequest: { number: 5 }, workbench: { pullRequestId: 'pr-5' } });
    });

    it.each<[string, string, number, string, RegExp]>([
      [
        'no commits between',
        'GitHub API error 422 Unprocessable Entity: Validation Failed (No commits between main and x) (GitHub request-id: r)',
        409,
        'nothing_to_open',
        /^There is nothing to open a pull request for/,
      ],
      [
        'another validation error',
        'GitHub API error 422 Unprocessable Entity: Validation Failed (base: invalid) (GitHub request-id: r)',
        422,
        'github_refused',
        /^GitHub did not open the pull request: Validation Failed \(base: invalid\)$/,
      ],
      [
        'a 403',
        'GitHub API error 403 Forbidden: Resource not accessible by integration (GitHub request-id: r)',
        409,
        'github_refused',
        /^GitHub did not open the pull request: Resource not accessible by integration$/,
      ],
    ])('maps a GitHub refusal: %s', async (_name, message, status, code, expected) => {
      const wb = await sandboxWorkbench();
      createPr.mockRejectedValue(new GitHubApiError(message, Number(/error (\d+)/.exec(message)![1])));
      const res = await call('POST', `/workbenches/${wb.id}/pull-request`, input);
      expect([res.status, res.body.code]).toEqual([status, code]);
      expect(res.body.error).toMatch(expected);
    });

    it('still answers when tracking the new PR fails', async () => {
      const wb = await sandboxWorkbench();
      watch.mockRejectedValue(new Error('graphql down'));
      const res = await call('POST', `/workbenches/${wb.id}/pull-request`, input);
      expect(res.status).toBe(200);
      expect(res.body.data.pullRequest.number).toBe(7);
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['no title', { ...input, title: '  ' }, 'bad_title'],
      ['a bad base branch', { ...input, base: 'a..b' }, 'bad_base'],
      ['a non-boolean draft', { ...input, draft: 'yes' }, 'bad_draft'],
      ['pushed on a sandbox session', { ...input, pushed: true }, 'sandbox_runtime'],
    ])('answers 400 for %s', async (_name, body, code) => {
      const wb = await sandboxWorkbench();
      const res = await call('POST', `/workbenches/${wb.id}/pull-request`, body);
      expect([res.status, res.body.code]).toEqual([400, code]);
      expect(createPr).not.toHaveBeenCalled();
    });

    it('opens the PR for a local session that has pushed, without the fleet', async () => {
      const wb = await localWorkbench();
      mark = fleet.scripts.length;
      const res = await call('POST', `/workbenches/${wb.id}/pull-request`, { ...input, pushed: true });
      expect(res.status).toBe(200);
      expect(scriptsSinceMark()).toEqual([]);
      expect(createPr).toHaveBeenCalled();
      expect(res.body.data.workbench.pullRequestId).toBe('pr-7');
    });

    it('refuses a local session that has not pushed', async () => {
      const wb = await localWorkbench();
      const res = await call('POST', `/workbenches/${wb.id}/pull-request`, input);
      expect([res.status, res.body.code]).toEqual([409, 'local_runtime']);
    });

    it('is no longer a prompt action', async () => {
      const wb = await sandboxWorkbench();
      const res = await call('POST', `/workbenches/${wb.id}/actions/create_pr`);
      expect([res.status, res.body.code]).toEqual([400, 'bad_action']);
    });
  });
});
