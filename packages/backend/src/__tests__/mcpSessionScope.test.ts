import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Features } from '@talyn/shared';
import { buildMcpServer, listToolsFor } from '../mcp/server.js';
import { SESSION_TOKEN_TOOLS } from '../mcp/sessionScope.js';
import { TOOLS, type McpCallContext, type McpToolDefinition } from '../mcp/tools/index.js';
import {
  chatWorkbenchId,
  recordSessionSpawn,
  reserveSessionCreate,
  SessionSpawnRefusedError,
} from '../services/sessionMcpToken.js';

vi.mock('../services/sessionMcpToken.js', async (original) => ({
  ...(await original<typeof import('../services/sessionMcpToken.js')>()),
  reserveSessionCreate: vi.fn(async () => undefined),
  recordSessionSpawn: vi.fn(async () => undefined),
  chatWorkbenchId: vi.fn(async (chatId: string) => (chatId.startsWith('self') ? 's1' : 's2')),
}));

vi.mock('../services/workbenches/threads.js', () => ({ announceSessionSpawn: vi.fn(async () => undefined) }));
const { announceSessionSpawn } = await import('../services/workbenches/threads.js');

const OWNER = 'user-test';
const SELF: McpCallContext = { session: { tokenId: 'token-1', workbenchId: 's1', depth: 0 } };

const features: Features = {
  workflows: true,
  loops: true,
  mcpServers: true,
  reviewPriority: true,
  reviewRankingCandidate: false,
  reviewRankingExport: false,
  teams: false,
  workbenches: true,
  trunkMergeEta: false,
  reviewPriorityMode: true,
};

/** A route result that the mock answers as a refusal with this status. */
class ApiRefusal {
  constructor(readonly status: number, readonly message: string) {}
}

type Route = (url: URL, body: unknown) => unknown;
function mockApi(routes: Record<string, Route>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      const route = routes[`${method} ${url.pathname}`];
      if (!route) throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      const out = route(url, body);
      if (out instanceof ApiRefusal) {
        return { ok: false, status: out.status, json: async () => ({ success: false, error: out.message }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: out ?? null }) } as Response;
    })
  );
  return { calls };
}

const session = (overrides: Record<string, unknown> = {}) => ({
  id: 's1', workspaceId: 'ws1', repositoryId: 'r1', repoFullName: 'acme/web', name: 'oslo',
  branch: 'tom/oslo', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', sandboxState: 'running',
  status: 'ready', pullRequestId: null, settings: {}, diffStat: null, archivedAt: null,
  chats: [{ id: 'self-chat', title: 'Chat', status: 'running', agent: 'claude', model: null, queuedMessages: [] }],
  ...overrides,
});

function tool(name: string): McpToolDefinition {
  const t = TOOLS.find((x) => x.name === `talyn_${name}`);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

type Handler = (request: unknown, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[]; tools?: { name: string }[] }>;
function handlersOf(server: ReturnType<typeof buildMcpServer>) {
  return (server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
}
async function callTool(ctx: McpCallContext, name: string, args: Record<string, unknown> = {}) {
  const server = buildMcpServer(OWNER, ctx);
  try {
    return await handlersOf(server).get('tools/call')!({ method: 'tools/call', params: { name, arguments: args } }, {});
  } finally {
    await server.close();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const EXCLUDED = [
  'talyn_list_spaces',
  // Credential surfaces
  'talyn_list_mcp_servers', 'talyn_get_mcp_server', 'talyn_test_mcp_server', 'talyn_set_mcp_server_enabled',
  'talyn_delete_mcp_server', 'talyn_connect_mcp_server', 'talyn_create_mcp_server',
  // Account
  'talyn_get_billing_status', 'talyn_list_cloud_providers', 'talyn_whats_new',
  // Undoes a person's own choice of what to track
  'talyn_untrack_pull_request',
  // Workspace configuration
  'talyn_add_repository', 'talyn_remove_repository', 'talyn_revert_setup_step',
  'talyn_create_skill', 'talyn_update_skill', 'talyn_delete_skill',
  'talyn_create_workflow', 'talyn_update_workflow', 'talyn_set_workflow_enabled', 'talyn_delete_workflow',
  'talyn_create_loop', 'talyn_update_loop', 'talyn_set_loop_enabled', 'talyn_delete_loop', 'talyn_run_loop_now',
];

describe('session token tool scope', () => {
  it('names only real tools', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const name of SESSION_TOKEN_TOOLS) expect(names.has(name)).toBe(true);
  });

  it('decides every tool: each is either allowed or deliberately excluded', () => {
    const undecided = TOOLS.map((t) => t.name).filter((n) => !SESSION_TOKEN_TOOLS.has(n) && !EXCLUDED.includes(n));
    expect(undecided).toEqual([]);
  });

  it.each(EXCLUDED)('excludes %s', (name) => {
    expect(SESSION_TOKEN_TOOLS.has(name)).toBe(false);
  });

  it.each([
    'talyn_archive_session', 'talyn_retry_session', 'talyn_create_session', 'talyn_list_sessions', 'talyn_set_merge_queue',
    'talyn_get_merge_queue_timeline', 'talyn_set_merge_queue_stack', 'talyn_list_pull_requests',
    'talyn_create_task', 'talyn_list_loops', 'talyn_get_workflow', 'talyn_get_skill', 'talyn_list_repositories',
    'talyn_memory_write', 'talyn_memory_search', 'talyn_memory_read', 'talyn_memory_forget', 'talyn_memory_list',
    'talyn_list_setup_steps', 'talyn_close_pull_request', 'talyn_track_pull_request', 'talyn_list_slack_channels',
    'talyn_slack_reply',
  ])('allows %s', (name) => {
    expect(SESSION_TOKEN_TOOLS.has(name)).toBe(true);
  });

  it('lists only allowed tools for a session token, and every tool for a user token', () => {
    expect(listToolsFor(features, SELF).map((t) => t.name).sort()).toEqual([...SESSION_TOKEN_TOOLS].sort());
    expect(listToolsFor(features).map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });

  it('ListTools on a session server hides excluded tools', async () => {
    mockApi({ 'GET /api/v1/features': () => features });
    const server = buildMcpServer(OWNER, SELF);
    const result = await handlersOf(server).get('tools/list')!({ method: 'tools/list', params: {} }, {});
    await server.close();
    const names = result.tools!.map((t) => t.name);
    expect(names).toContain('talyn_archive_session');
    expect(names).not.toContain('talyn_create_mcp_server');
  });

  it.each(['talyn_create_mcp_server', 'talyn_get_billing_status', 'talyn_delete_loop', 'talyn_add_repository'])(
    'refuses %s for a session token without calling the API',
    async (name) => {
      const { calls } = mockApi({});
      const result = await callTool(SELF, name, { workspace_id: 'ws1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('is not available inside a session');
      expect(calls).toHaveLength(0);
    }
  );

  it('runs an allowed tool for a session token', async () => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches': () => [session()] });
    const result = await callTool(SELF, 'talyn_list_sessions', { workspace_id: 'ws1' });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('posts a Slack reply for the calling session only', async () => {
    const { calls } = mockApi({ 'POST /api/v1/workbenches/s1/slack-reply': () => ({ ts: '123.456' }) });
    const result = await callTool(SELF, 'talyn_slack_reply', { text: 'Hello' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('123.456');
    expect(calls).toEqual([expect.objectContaining({ method: 'POST', body: { text: 'Hello' } })]);

    const refused = await callTool(SELF, 'talyn_slack_reply', { text: 'Hello', session_id: 's2' });
    expect(refused.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('leaves a user token able to call an excluded tool', async () => {
    const { calls } = mockApi({ 'GET /api/v1/billing/status': () => ({ plan: 'free' }) });
    await callTool({}, 'talyn_get_billing_status');
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('session self-calls', () => {
  it('defers archiving its own session to the end of the turn', async () => {
    const { calls } = mockApi({ 'POST /api/v1/workbenches/s1/archive': () => session() });
    const text = await tool('archive_session').handler(OWNER, { session_id: 's1' }, SELF);
    expect(calls).toEqual([expect.objectContaining({ method: 'POST', body: { afterTurn: true } })]);
    expect(text).toBe(
      'This session will be archived when this reply ends. Finish the reply now, and do not start more work.'
    );
  });

  it('reports an immediate archive when no turn was running', async () => {
    mockApi({ 'POST /api/v1/workbenches/s1/archive': () => session({ archivedAt: '2999-01-01T00:00:00Z', status: 'archived' }) });
    expect(await tool('archive_session').handler(OWNER, { session_id: 's1' }, SELF)).toContain('archived');
  });

  it.each<[string, McpCallContext]>([
    ['another session from a session token', SELF],
    ['its own id from a user token', {}],
  ])('archives %s immediately', async (_name, ctx) => {
    const id = ctx.session ? 's2' : 's1';
    const { calls } = mockApi({ [`POST /api/v1/workbenches/${id}/archive`]: () => session({ id, archivedAt: '2999-01-01T00:00:00Z' }) });
    await tool('archive_session').handler(OWNER, { session_id: id }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toBeUndefined();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['cancel_session_turn', { session_id: 's1' }, 'That would stop the reply'],
    ['cancel_session_turn', { chat_id: 'self-chat' }, 'That would stop the reply'],
    ['send_session_message', { session_id: 's1', text: 'hi' }, 'This is your own session'],
    ['send_session_message', { chat_id: 'self-other-chat', text: 'hi' }, 'This is your own session'],
    ['restore_session', { session_id: 's1' }, 'There is nothing to restore'],
    ['retry_session', { session_id: 's1' }, 'There is nothing to retry'],
  ])('refuses %s %j on itself', async (name, args, message) => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches/s1': () => session() });
    await expect(tool(name).handler(OWNER, args, SELF)).rejects.toThrow(message);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['cancel_session_turn', { chat_id: 'other-chat' }, 'POST /api/v1/workbenches/chats/other-chat/cancel'],
    ['send_session_message', { chat_id: 'other-chat', text: 'hi' }, 'POST /api/v1/workbenches/chats/other-chat/messages'],
    ['restore_session', { session_id: 's2' }, 'POST /api/v1/workbenches/s2/restore'],
    ['retry_session', { session_id: 's2' }, 'POST /api/v1/workbenches/s2/retry'],
  ])('lets %s %j act on another session', async (name, args, route) => {
    const { calls } = mockApi({
      [route]: () => (['restore_session', 'retry_session'].includes(name) ? session({ id: 's2' }) : { queued: false }),
      'GET /api/v1/workbenches/s2': () => session({ id: 's2' }),
    });
    await tool(name).handler(OWNER, args, SELF);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toContain(route);
  });

  it('looks up a chat only for a session token', async () => {
    mockApi({ 'POST /api/v1/workbenches/chats/self-chat/cancel': () => null });
    await tool('cancel_session_turn').handler(OWNER, { chat_id: 'self-chat' });
    expect(chatWorkbenchId).not.toHaveBeenCalled();
  });
});

describe('tracking a PR from a session', () => {
  const url = 'https://github.com/acme/api/pull/7';
  const pr = {
    id: 'pr-7',
    summary: {
      number: 7, title: 'Fix', repoFullName: 'acme/api', draft: false, reviewDecision: null,
      checks: { total: 0, passed: 0, failed: 0, inProgress: 0 },
    },
  };

  it.each<[string, Record<string, unknown>]>([
    ['no workspace_id', { url }],
    ["the session's own workspace_id", { url, workspace_id: 'ws1' }],
    ['add_repository: false', { url, add_repository: false }],
  ])("tracks in the session's workspace with %s", async (_name, args) => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'POST /api/v1/pull-requests/watch': () => pr,
    });
    await tool('track_pull_request').handler(OWNER, args, SELF);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ workspaceId: 'ws1', url, confirmAddRepo: false });
    expect(calls.some((c) => c.url.pathname === '/api/v1/workspaces')).toBe(false);
  });

  it('refuses add_repository before any request', async () => {
    const { calls } = mockApi({});
    await expect(
      tool('track_pull_request').handler(OWNER, { url, add_repository: true }, SELF)
    ).rejects.toThrow('add_repository is not available inside a session');
    expect(calls).toHaveLength(0);
  });

  it('refuses another workspace', async () => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches/s1': () => session() });
    await expect(
      tool('track_pull_request').handler(OWNER, { url, workspace_id: 'ws2' }, SELF)
    ).rejects.toThrow("only in the session's workspace");
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('tells the session to ask the person when the repository is not watched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).pathname === '/api/v1/workbenches/s1'
          ? ({ ok: true, status: 200, json: async () => ({ success: true, data: session() }) } as Response)
          : ({
              ok: false,
              status: 409,
              json: async () => ({ success: false, error: 'Repository is not watched', code: 'repo_not_watched' }),
            } as Response)
      )
    );
    const text = await tool('track_pull_request').handler(OWNER, { url }, SELF);
    expect(text).toContain('Ask the person to add it in the Talyn app');
    expect(text).not.toContain('add_repository: true');
  });

  it('is callable through a session server', async () => {
    mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'POST /api/v1/pull-requests/watch': () => pr,
    });
    const result = await callTool(SELF, 'talyn_track_pull_request', { url });
    expect(result.isError).toBeFalsy();
  });
});

describe('sessions started by a session', () => {
  const args = { workspace_id: 'ws1', repository_id: 'r1', agent: 'claude' };

  it('reserves a slot before creating and records the parent after', async () => {
    const order: string[] = [];
    vi.mocked(reserveSessionCreate).mockImplementation(async () => { order.push('reserve'); });
    vi.mocked(recordSessionSpawn).mockImplementation(async () => { order.push('record'); });
    mockApi({ 'POST /api/v1/workbenches': () => { order.push('create'); return session({ id: 'child' }); } });
    await tool('create_session').handler(OWNER, args, SELF);
    expect(order).toEqual(['reserve', 'create', 'record']);
    expect(reserveSessionCreate).toHaveBeenCalledWith(SELF.session);
    expect(recordSessionSpawn).toHaveBeenCalledWith('child', SELF.session);
    expect(announceSessionSpawn).toHaveBeenCalledWith('s1', 'child');
  });

  it('creates nothing when the depth limit refuses', async () => {
    const reason = 'depth';
    vi.mocked(reserveSessionCreate).mockRejectedValue(new SessionSpawnRefusedError(`refused: ${reason}`, reason));
    const { calls } = mockApi({});
    const result = await callTool(SELF, 'talyn_create_session', args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`refused: ${reason}`);
    expect(calls).toHaveLength(0);
    expect(recordSessionSpawn).not.toHaveBeenCalled();
  });

  it('puts a session a thread starts into that thread, and announces it there', async () => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: 's1' });
    const { calls } = mockApi({ 'POST /api/v1/workbenches': () => session({ id: 'child', threadId: 's1' }) });
    await tool('create_session').handler(OWNER, args, SELF);
    expect(calls[0].body).toMatchObject({ threadId: 's1', repositoryId: 'r1' });
    expect(announceSessionSpawn).toHaveBeenCalledWith('s1', 'child');
  });

  it('leaves the thread out and announces the child in its parent session', async () => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: null });
    const { calls } = mockApi({ 'POST /api/v1/workbenches': () => session({ id: 'child' }) });
    await tool('create_session').handler(OWNER, args, SELF);
    expect(calls[0].body).not.toHaveProperty('threadId');
    expect(announceSessionSpawn).toHaveBeenCalledWith('s1', 'child');
  });

  it('leaves a user token uncapped', async () => {
    mockApi({ 'POST /api/v1/workbenches': () => session({ id: 'child' }) });
    await tool('create_session').handler(OWNER, args);
    expect(reserveSessionCreate).not.toHaveBeenCalled();
    expect(recordSessionSpawn).not.toHaveBeenCalled();
    expect(announceSessionSpawn).not.toHaveBeenCalled();
  });
});

describe('sessions started by a session in a space', () => {
  const SPACE = 'space-1';
  const team = (overrides: Record<string, unknown> = {}) => ({
    id: 'team-1', name: 'Acme', role: 'member', homeWorkspaceId: 'ws1',
    spaces: [{ id: SPACE, name: 'Warehouse' }], ...overrides,
  });
  const spaceRoutes = (overrides: Record<string, Route> = {}) => ({
    'GET /api/v1/teams': () => [team()],
    'GET /api/v1/workspaces': () => [{ id: 'ws1', repos: [{ id: 'r1', name: 'acme/web' }, { id: 'r2', name: 'acme/other' }] }],
    [`GET /api/v1/spaces/${SPACE}/repositories`]: () => [{ spaceId: SPACE, repoFullName: 'Acme/Web', githubRepoId: 1 }],
    [`POST /api/v1/spaces/${SPACE}/sessions`]: () => ({ workbench: session({ id: 'child' }), workspaceId: 'ws1', addedRepository: false }),
    'POST /api/v1/workbenches': () => session({ id: 'child' }),
    ...overrides,
  });
  const created = (calls: { method: string; url: URL; body: unknown }[]) =>
    calls.filter((call) => call.method === 'POST').map((call) => ({ path: call.url.pathname, body: call.body }));

  it('starts the child in the parent session space', async () => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: null, spaceId: SPACE });
    const { calls } = mockApi(spaceRoutes());
    const result = await tool('create_session').handler(OWNER, {
      repository_id: 'r1', agent: 'claude', prompt: 'Second PR', branch: 'tom/two', internet_access: true,
    }, SELF);
    expect(created(calls)).toEqual([{
      path: `/api/v1/spaces/${SPACE}/sessions`,
      body: { repoFullName: 'Acme/Web', agent: 'claude', prompt: 'Second PR', branch: 'tom/two', internetAccess: true },
    }]);
    expect(result).toContain(`team space "Warehouse" (${SPACE})`);
    expect(recordSessionSpawn).toHaveBeenCalledWith('child', SELF.session);
    expect(announceSessionSpawn).toHaveBeenCalledWith('s1', 'child');
  });

  it.each([
    ['repository_full_name', { repository_full_name: 'acme/web' }],
    ['auto_create_pr true, which is already the default in a space', { repository_id: 'r1', auto_create_pr: true }],
    ['the home workspace as workspace_id', { repository_id: 'r1', workspace_id: 'ws1' }],
  ])('inherits the space with %s', async (_name, extra) => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: null, spaceId: SPACE });
    const { calls } = mockApi(spaceRoutes());
    await tool('create_session').handler(OWNER, { agent: 'claude', ...extra }, SELF);
    expect(created(calls)).toEqual([{ path: `/api/v1/spaces/${SPACE}/sessions`, body: { repoFullName: 'Acme/Web', agent: 'claude' } }]);
  });

  it('lets an explicit space_id win over the parent space', async () => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: null, spaceId: SPACE });
    const { calls } = mockApi({
      'POST /api/v1/spaces/space-2/sessions': () => ({ workbench: session({ id: 'child' }), workspaceId: 'ws1', addedRepository: false }),
    });
    await tool('create_session').handler(OWNER, { space_id: 'space-2', repository_full_name: 'acme/web', agent: 'claude' }, SELF);
    expect(created(calls)).toEqual([{ path: '/api/v1/spaces/space-2/sessions', body: { repoFullName: 'acme/web', agent: 'claude' } }]);
  });

  it('starts in Personal when space_id is "personal"', async () => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: null, spaceId: SPACE });
    const { calls } = mockApi(spaceRoutes());
    const result = await tool('create_session').handler(OWNER, {
      space_id: 'Personal', workspace_id: 'ws1', repository_id: 'r1', agent: 'claude', auto_create_pr: false,
    }, SELF);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(['POST /api/v1/workbenches']);
    expect(calls[0].body).toMatchObject({ repositoryId: 'r1', autoCreatePr: false });
    expect(result).not.toContain('team space');
  });

  it.each([
    ['the parent has no space', { threadId: null, spaceId: null }],
    ['the parent is a thread', { threadId: 's1', spaceId: null }],
  ])('does not inherit when %s', async (_name, reserved) => {
    vi.mocked(reserveSessionCreate).mockResolvedValue(reserved);
    const { calls } = mockApi(spaceRoutes());
    const result = await tool('create_session').handler(OWNER, { workspace_id: 'ws1', repository_id: 'r1', agent: 'claude' }, SELF);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(['POST /api/v1/workbenches']);
    expect(result).not.toContain('team space');
  });

  it('does not look for a space for a user token', async () => {
    const { calls } = mockApi(spaceRoutes());
    await tool('create_session').handler(OWNER, { workspace_id: 'ws1', repository_id: 'r1', agent: 'claude' });
    expect(reserveSessionCreate).not.toHaveBeenCalled();
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(['POST /api/v1/workbenches']);
  });

  it.each([
    ['pull_request_id is given', { pull_request_id: 'pr1' }, {}, 'pull_request_id is not supported in a space.'],
    ['workspace_id is not the home workspace of the team', { workspace_id: 'ws2' }, {}, 'workspace_id is not your home workspace'],
    ['the repository is not in the space', {}, { 'GET /api/v1/workspaces': () => [{ id: 'ws1', repos: [{ id: 'r1', name: 'acme/other' }] }] }, 'acme/other is not a repository of the space.'],
    ['the space is archived or the owner left the team', {}, { 'GET /api/v1/teams': () => [team({ spaces: [] })] }, 'the space is archived, or you are no longer a member of its team.'],
    ['the owner has no team any more', {}, { 'GET /api/v1/teams': () => [] }, 'the space is archived, or you are no longer a member of its team.'],
    ['the owner has no home workspace', {}, { 'GET /api/v1/teams': () => [team({ homeWorkspaceId: null })] }, 'you have no home workspace'],
    ['the spaces API refuses', {}, { 'GET /api/v1/teams': () => new ApiRefusal(403, 'Spaces are off') }, 'the team space is not available (Spaces are off).'],
  ])('falls back to Personal when %s', async (_name, extra, routes, reason) => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: null, spaceId: SPACE });
    const { calls } = mockApi(spaceRoutes(routes));
    const args = { workspace_id: 'ws1', repository_id: 'r1', agent: 'claude', ...extra };
    const result = await tool('create_session').handler(OWNER, args, SELF);
    expect(created(calls)).toEqual([{ path: '/api/v1/workbenches', body: expect.objectContaining({ repositoryId: 'r1', workspaceId: args.workspace_id }) }]);
    expect(result).toContain("Started in Personal, not in this session's team space:");
    expect(result).toContain(reason);
    expect(recordSessionSpawn).toHaveBeenCalledWith('child', SELF.session);
  });

  it('keeps pull_request_id on the Personal fallback', async () => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: null, spaceId: SPACE });
    const { calls } = mockApi(spaceRoutes());
    await tool('create_session').handler(OWNER, { workspace_id: 'ws1', repository_id: 'r1', agent: 'claude', pull_request_id: 'pr1' }, SELF);
    expect(created(calls)[0].body).toMatchObject({ fromPullRequestId: 'pr1' });
  });

  it('refuses a fallback that has no repository_id for Personal', async () => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: null, spaceId: SPACE });
    const { calls } = mockApi(spaceRoutes());
    await expect(
      tool('create_session').handler(OWNER, { repository_full_name: 'acme/missing', agent: 'claude' }, SELF)
    ).rejects.toThrow('acme/missing is not a repository of the space. Pass repository_id to start in Personal.');
    expect(created(calls)).toEqual([]);
  });

  it('refuses auto_create_pr false and creates nothing, so the space is not lost', async () => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: null, spaceId: SPACE });
    const { calls } = mockApi(spaceRoutes());
    await expect(
      tool('create_session').handler(OWNER, { repository_id: 'r1', agent: 'claude', auto_create_pr: false }, SELF)
    ).rejects.toThrow('auto_create_pr false is not supported there');
    expect(calls).toHaveLength(0);
    expect(recordSessionSpawn).not.toHaveBeenCalled();
  });

  it('reports a failure of the space route and does not start a Personal session', async () => {
    vi.mocked(reserveSessionCreate).mockResolvedValue({ threadId: null, spaceId: SPACE });
    const { calls } = mockApi(spaceRoutes({ [`POST /api/v1/spaces/${SPACE}/sessions`]: () => new ApiRefusal(409, 'No sandbox') }));
    await expect(tool('create_session').handler(OWNER, { repository_id: 'r1', agent: 'claude' }, SELF)).rejects.toThrow('No sandbox');
    expect(created(calls).map((call) => call.path)).toEqual([`/api/v1/spaces/${SPACE}/sessions`]);
  });

  it('says in the tool description that the space is inherited', () => {
    const t = tool('create_session');
    expect(t.description).toContain('puts it in the same space by default');
    const spaceArg = (t.inputSchema.properties as Record<string, { description: string }>).space_id;
    expect(spaceArg.description).toContain('Pass "personal" to start in Personal');
    expect(spaceArg.description).toContain('Default from a session in a space: that space');
  });
});
