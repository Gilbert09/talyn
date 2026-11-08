import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_TOKEN_TOOLS } from '../mcp/sessionScope.js';
import { TOOLS, type McpCallContext, type McpToolDefinition } from '../mcp/tools/index.js';

/** `talyn_restart_session`: whom a session token may restart, what it sends, and what it tells the agent. */

const OWNER = 'user-test';
const FROM_SESSION: McpCallContext = { session: { tokenId: 'token-1', workbenchId: 's1', depth: 0 } };
const FROM_THREAD: McpCallContext = { session: { tokenId: 'token-2', workbenchId: 'thread1', depth: 0 } };

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
  id: 's2', workspaceId: 'ws1', name: 'child', kind: 'session', threadId: 'thread1', runtime: 'sandbox', agent: 'claude',
  settings: {}, chats: [], ...overrides,
});

const answer = (overrides: Record<string, unknown> = {}) => ({ outcome: 'after_turn', continued: false, ...overrides });

afterEach(() => vi.unstubAllGlobals());

describe('talyn_restart_session', () => {
  it('is in the session allow-list, with no required argument', () => {
    expect(SESSION_TOKEN_TOOLS.has('talyn_restart_session')).toBe(true);
    const schema = tool('restart_session').inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.required).toEqual([]);
    expect(Object.keys(schema.properties).sort()).toEqual(['continue_with', 'reason', 'session_id']);
    expect(tool('restart_session').annotations.destructiveHint).toBeUndefined();
    expect(tool('restart_session').description).toContain('MCP server');
  });

  it('restarts the calling session by default, and tells it to end its turn', async () => {
    const { calls } = mockApi({ 'POST /api/v1/workbenches/s1/restart': () => answer() });
    const text = await tool('restart_session').handler(OWNER, {}, FROM_SESSION);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({});
    expect(text).toContain('when its current turn ends');
    expect(text).toContain("current MCP servers");
    expect(text).toContain('End your turn now.');
    expect(text).toContain('transcript says why');
  });

  it('passes the reason and the message to continue with', async () => {
    const { calls } = mockApi({ 'POST /api/v1/workbenches/s1/restart': () => answer({ continued: true }) });
    const text = await tool('restart_session').handler(
      OWNER,
      { reason: 'Load the Polar server.', continue_with: 'Read the Polar orders.' },
      FROM_SESSION
    );
    expect(calls[0].body).toEqual({ reason: 'Load the Polar server.', continueWith: 'Read the Polar orders.' });
    expect(text).toContain('continue_with message after the restart');
  });

  it.each([
    ['restarting', 'is restarting session s2 on a fresh sandbox now'],
    ['after_turn', 'restarts session s2 on a fresh sandbox when its current turn ends'],
  ])('reports %s for a session of the thread, with no end-your-turn line', async (outcome, expected) => {
    mockApi({
      'GET /api/v1/workbenches/s2': () => session(),
      'POST /api/v1/workbenches/s2/restart': () => answer({ outcome }),
    });
    const text = await tool('restart_session').handler(OWNER, { session_id: 's2' }, FROM_THREAD);
    expect(text).toContain(expected);
    expect(text).not.toContain('End your turn');
  });

  it.each([
    ['a session outside the thread', FROM_THREAD, session({ id: 'other', threadId: 'thread9' })],
    ['a sibling, from a session that is not a thread', FROM_SESSION, session({ id: 'other', threadId: 'thread1' })],
    ['a session in no thread', FROM_THREAD, session({ id: 'other', threadId: null })],
  ])('refuses %s, and changes nothing', async (_name, ctx, target) => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches/other': () => target });
    await expect(tool('restart_session').handler(OWNER, { session_id: 'other' }, ctx)).rejects.toThrow(
      'A session can restart itself, or a session in its thread.'
    );
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('lets a person (no session token) restart any session they own, without a scope read', async () => {
    const { calls } = mockApi({ 'POST /api/v1/workbenches/other/restart': () => answer() });
    await tool('restart_session').handler(OWNER, { session_id: 'other' }, undefined);
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('needs a session from a person token', async () => {
    const { calls } = mockApi({});
    await expect(tool('restart_session').handler(OWNER, {}, undefined)).rejects.toThrow('session_id is required');
    expect(calls).toEqual([]);
  });
});
