import { afterEach, describe, expect, it, vi } from 'vitest';
import { SANDBOX_SIZES } from '@talyn/shared';
import { SESSION_TOKEN_TOOLS } from '../mcp/sessionScope.js';
import { TOOLS, type McpCallContext, type McpToolDefinition } from '../mcp/tools/index.js';

/** `talyn_resize_session`: whom a session token may resize, what it sends, and what it tells the agent. */

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

const answer = (overrides: Record<string, unknown> = {}) => ({
  outcome: 'after_turn', size: 'large', rememberedForRepository: false, continued: false, ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('talyn_resize_session', () => {
  it('is in the session allow-list, with a size enum that matches the sizes', () => {
    expect(SESSION_TOKEN_TOOLS.has('talyn_resize_session')).toBe(true);
    const schema = tool('resize_session').inputSchema as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.required).toEqual(['size']);
    expect(schema.properties.size.enum).toEqual(Object.keys(SANDBOX_SIZES));
    expect(Object.keys(schema.properties).sort()).toEqual(['continue_with', 'reason', 'remember_for_repository', 'session_id', 'size']);
    expect(tool('resize_session').annotations.destructiveHint).toBeUndefined();
  });

  it('resizes the calling session by default, and tells it to end its turn', async () => {
    const { calls } = mockApi({ 'PUT /api/v1/workbenches/s1/sandbox-size': () => answer() });
    const text = await tool('resize_session').handler(OWNER, { size: 'large' }, FROM_SESSION);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ size: 'large' });
    expect(text).toContain('Large · 12 GB');
    expect(text).toContain('when its current turn ends');
    expect(text).toContain('End your turn now.');
    expect(text).toContain('transcript says why');
  });

  it('passes the reason, the repository flag and the message to continue with', async () => {
    const { calls } = mockApi({
      'PUT /api/v1/workbenches/s1/sandbox-size': () => answer({ rememberedForRepository: true, continued: true }),
    });
    const text = await tool('resize_session').handler(
      OWNER,
      { size: 'large', reason: 'Kafka needs memory.', remember_for_repository: true, continue_with: 'Run the tests again.' },
      FROM_SESSION
    );
    expect(calls[0].body).toEqual({ size: 'large', reason: 'Kafka needs memory.', rememberForRepository: true, continueWith: 'Run the tests again.' });
    expect(text).toContain('continue_with message after the move');
    expect(text).toContain('New sessions of this repository also get this size.');
  });

  it.each([
    ['moving', 'is moving session s2 to a Large · 12 GB sandbox now'],
    ['after_turn', 'moves session s2 to a Large · 12 GB sandbox when its current turn ends'],
    ['unchanged', 'Session s2 already runs on a Large · 12 GB sandbox. Nothing moves.'],
  ])('reports %s for a session of the thread, with no end-your-turn line', async (outcome, expected) => {
    mockApi({
      'GET /api/v1/workbenches/s2': () => session(),
      'PUT /api/v1/workbenches/s2/sandbox-size': () => answer({ outcome }),
    });
    const text = await tool('resize_session').handler(OWNER, { session_id: 's2', size: 'large' }, FROM_THREAD);
    expect(text).toContain(expected);
    expect(text).not.toContain('End your turn');
  });

  it.each([
    ['a session outside the thread', FROM_THREAD, session({ id: 'other', threadId: 'thread9' })],
    ['a sibling, from a session that is not a thread', FROM_SESSION, session({ id: 'other', threadId: 'thread1' })],
    ['a session in no thread', FROM_THREAD, session({ id: 'other', threadId: null })],
  ])('refuses %s, and changes nothing', async (_name, ctx, target) => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches/other': () => target });
    await expect(tool('resize_session').handler(OWNER, { session_id: 'other', size: 'large' }, ctx)).rejects.toThrow(
      'A session can resize itself, or a session in its thread.'
    );
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('lets a person (no session token) resize any session they own, without a scope read', async () => {
    const { calls } = mockApi({ 'PUT /api/v1/workbenches/other/sandbox-size': () => answer() });
    await tool('resize_session').handler(OWNER, { session_id: 'other', size: 'large' }, undefined);
    expect(calls.map((c) => c.method)).toEqual(['PUT']);
  });

  it.each([
    ['no size', { session_id: 's1' }, FROM_SESSION],
    ['no session from a person token', { size: 'large' }, undefined],
  ])('needs %s', async (_name, args, ctx) => {
    const { calls } = mockApi({});
    await expect(tool('resize_session').handler(OWNER, args, ctx)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('turns a local session refusal into the plain message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 409,
        json: async () => ({ success: false, error: 'local', code: 'local_runtime' }),
      }))
    );
    await expect(tool('resize_session').handler(OWNER, { size: 'large' }, FROM_SESSION)).rejects.toThrow(
      "This session runs on the user's own machine"
    );
  });
});
