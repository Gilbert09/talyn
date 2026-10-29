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
      return { ok: true, status: 200, json: async () => ({ success: true, data: route(url, body) ?? null }) } as Response;
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
  // Credential surfaces
  'talyn_list_mcp_servers', 'talyn_get_mcp_server', 'talyn_test_mcp_server', 'talyn_set_mcp_server_enabled',
  'talyn_delete_mcp_server', 'talyn_connect_mcp_server', 'talyn_create_mcp_server',
  // Account
  'talyn_get_billing_status', 'talyn_list_cloud_providers', 'talyn_whats_new',
  // Workspace configuration
  'talyn_add_repository', 'talyn_remove_repository',
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
    'talyn_archive_session', 'talyn_create_session', 'talyn_list_sessions', 'talyn_set_merge_queue',
    'talyn_get_merge_queue_timeline', 'talyn_set_merge_queue_stack', 'talyn_list_pull_requests',
    'talyn_create_task', 'talyn_list_loops', 'talyn_get_workflow', 'talyn_get_skill', 'talyn_list_repositories',
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
  ])('refuses %s %j on itself', async (name, args, message) => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches/s1': () => session() });
    await expect(tool(name).handler(OWNER, args, SELF)).rejects.toThrow(message);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['cancel_session_turn', { chat_id: 'other-chat' }, 'POST /api/v1/workbenches/chats/other-chat/cancel'],
    ['send_session_message', { chat_id: 'other-chat', text: 'hi' }, 'POST /api/v1/workbenches/chats/other-chat/messages'],
    ['restore_session', { session_id: 's2' }, 'POST /api/v1/workbenches/s2/restore'],
  ])('lets %s %j act on another session', async (name, args, route) => {
    const { calls } = mockApi({
      [route]: () => (name === 'restore_session' ? session({ id: 's2' }) : { queued: false }),
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
  });

  it.each(['depth', 'rate'] as const)('creates nothing when the %s cap refuses', async (reason) => {
    vi.mocked(reserveSessionCreate).mockRejectedValue(new SessionSpawnRefusedError(`refused: ${reason}`, reason));
    const { calls } = mockApi({});
    const result = await callTool(SELF, 'talyn_create_session', args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(`refused: ${reason}`);
    expect(calls).toHaveLength(0);
    expect(recordSessionSpawn).not.toHaveBeenCalled();
  });

  it('leaves a user token uncapped', async () => {
    mockApi({ 'POST /api/v1/workbenches': () => session({ id: 'child' }) });
    await tool('create_session').handler(OWNER, args);
    expect(reserveSessionCreate).not.toHaveBeenCalled();
    expect(recordSessionSpawn).not.toHaveBeenCalled();
  });
});
