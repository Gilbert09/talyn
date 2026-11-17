import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_TOKEN_TOOLS } from '../mcp/sessionScope.js';
import { TOOLS, type McpCallContext, type McpToolDefinition } from '../mcp/tools/index.js';

/** `talyn_continue_as_thread`: which session may turn itself into a thread, what it sends, and what it tells the agent. */

const OWNER = 'user-test';
const FROM_SESSION: McpCallContext = { session: { tokenId: 'token-1', workbenchId: 's1', depth: 0 } };
const FROM_CHILD: McpCallContext = { session: { tokenId: 'token-2', workbenchId: 's1', depth: 1 } };

function tool(name: string): McpToolDefinition {
  const t = TOOLS.find((x) => x.name === `talyn_${name}`);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
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
      return { ok: true, status: 200, json: async () => ({ success: true, data: route(url, body) ?? null }) } as Response;
    })
  );
  return { calls };
}

const session = (overrides: Record<string, unknown> = {}) => ({
  id: 's1', workspaceId: 'ws1', name: 'address-fix', title: 'Address review', kind: 'session', threadId: null,
  runtime: 'sandbox', agent: 'claude', settings: {}, chats: [], ...overrides,
});
const thread = { id: 't1', workspaceId: 'ws1', name: 'address-fix-2', title: 'Address review', kind: 'thread', threadId: null };

afterEach(() => vi.unstubAllGlobals());

describe('talyn_continue_as_thread', () => {
  it('is in the session allow-list, with no required argument', () => {
    expect(SESSION_TOKEN_TOOLS.has('talyn_continue_as_thread')).toBe(true);
    const schema = tool('continue_as_thread').inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual([]);
    expect(Object.keys(schema.properties).sort()).toEqual(['prompt', 'session_id']);
    expect(tool('continue_as_thread').description).toContain('ask them first');
  });

  it.each([
    ['with a prompt', { prompt: 'Start sessions on infra, then charts.' }, { prompt: 'Start sessions on infra, then charts.' }],
    ['without a prompt', {}, {}],
    ['with a blank prompt', { prompt: '   ' }, {}],
  ])('turns the calling session into a thread %s, and tells it to end its turn', async (_name, args, expectedBody) => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'POST /api/v1/workbenches/s1/thread': () => thread,
    });
    const text = await tool('continue_as_thread').handler(OWNER, args, FROM_SESSION);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /api/v1/workbenches/s1',
      'POST /api/v1/workbenches/s1/thread',
    ]);
    expect(calls[1].body).toEqual(expectedBody);
    expect(text).toContain('Started thread t1 ("Address review")');
    expect(text).toContain('Session s1 is now part of it.');
    expect(text).toContain('End your turn now.');
  });

  it.each([
    ['another session', FROM_SESSION, { session_id: 's2' }, 'A session can turn only itself into a thread.'],
    ['a session another session started', FROM_CHILD, {}, 'Another session started this session'],
  ])('refuses %s before it reads anything', async (_name, ctx, args, message) => {
    const { calls } = mockApi({});
    await expect(tool('continue_as_thread').handler(OWNER, args, ctx)).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it.each([
    ['a thread', session({ kind: 'thread' }), 'This is already a thread.'],
    ['a session in a thread', session({ threadId: 't9' }), 'Session s1 is already in thread t9.'],
  ])('refuses %s, and changes nothing', async (_name, row, message) => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches/s1': () => row });
    await expect(tool('continue_as_thread').handler(OWNER, {}, FROM_SESSION)).rejects.toThrow(message);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('lets a person (no session token) continue any session as a thread, with no end-your-turn line', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/s2': () => session({ id: 's2' }),
      'POST /api/v1/workbenches/s2/thread': () => thread,
    });
    const text = await tool('continue_as_thread').handler(OWNER, { session_id: 's2' }, undefined);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(text).not.toContain('End your turn');
  });

  it('needs a session from a person token', async () => {
    const { calls } = mockApi({});
    await expect(tool('continue_as_thread').handler(OWNER, {}, undefined)).rejects.toThrow('session_id is required');
    expect(calls).toEqual([]);
  });

  it('turns a local-runtime refusal into a plain message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (new URL(input).pathname.endsWith('/thread')) {
          return { ok: false, status: 409, json: async () => ({ success: false, error: 'local', code: 'local_runtime' }) } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ success: true, data: session() }) } as Response;
      })
    );
    await expect(tool('continue_as_thread').handler(OWNER, {}, FROM_SESSION)).rejects.toThrow('Talyn desktop app');
  });
});
