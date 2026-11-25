import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMcpServer, listToolsFor } from '../mcp/server.js';
import { SESSION_ONLY_TOOLS, SESSION_TOKEN_TOOLS } from '../mcp/sessionScope.js';
import { TOOLS, type McpCallContext, type McpToolDefinition } from '../mcp/tools/index.js';

const OWNER = 'user-test';
const SELF: McpCallContext = { session: { tokenId: 'token-1', workbenchId: 's1', depth: 0 } };
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

type Answer = { status: number; body: unknown };
function mockApi(answer: (url: URL) => Answer) {
  const calls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input);
      calls.push(url);
      const { status, body } = answer(url);
      return { ok: status < 400, status, json: async () => body } as Response;
    })
  );
  return { calls };
}

const image = (overrides: Record<string, unknown> = {}) => ({
  status: 200,
  body: { success: true, data: { path: '/tmp/shot.png', mediaType: 'image/png', bytes: 1536, data: PNG_B64, ...overrides } },
});

function tool(): McpToolDefinition {
  return TOOLS.find((t) => t.name === 'talyn_show_image')!;
}

type Result = { isError?: boolean; content: Array<Record<string, unknown>> };
async function callTool(ctx: McpCallContext, name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const server = buildMcpServer(OWNER, ctx);
  try {
    const handlers = (server as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<Result>> })._requestHandlers;
    return await handlers.get('tools/call')!({ method: 'tools/call', params: { name, arguments: args } }, {});
  } finally {
    await server.close();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('talyn_show_image', () => {
  it('is a read-only tool that a session token may call', () => {
    expect(tool()).toBeDefined();
    expect(tool().annotations.readOnlyHint).toBe(true);
    expect(tool().inputSchema).toMatchObject({ required: ['path'] });
    expect(SESSION_TOKEN_TOOLS.has('talyn_show_image')).toBe(true);
    expect(SESSION_ONLY_TOOLS.has('talyn_show_image')).toBe(false);
  });

  it.each<[string, McpCallContext]>([
    ['a session token', SELF],
    ['a user token', {}],
  ])('is listed for %s', (_name, ctx) => {
    expect(listToolsFor(null, ctx).map((t) => t.name)).toContain('talyn_show_image');
  });

  it.each<[string, McpCallContext, Record<string, unknown>, string]>([
    ['the calling session by default', SELF, { path: '/tmp/shot.png' }, 's1'],
    ['its own session by id', SELF, { path: '/tmp/shot.png', session_id: 's1' }, 's1'],
    ['the named session for a user token', {}, { path: '/tmp/shot.png', session_id: 's9' }, 's9'],
  ])('reads %s, live, with the path in the query', async (_name, ctx, args, sessionId) => {
    const { calls } = mockApi(() => image());
    await tool().handler(OWNER, args, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].pathname).toBe(`/api/v1/workbenches/${sessionId}/image`);
    expect(calls[0].searchParams.get('path')).toBe('/tmp/shot.png');
    expect(calls[0].searchParams.get('live')).toBe('1');
  });

  it('encodes a path with spaces and symbols', async () => {
    const { calls } = mockApi(() => image());
    await tool().handler(OWNER, { path: 'shots/a b&c?.png' }, SELF);
    expect(calls[0].searchParams.get('path')).toBe('shots/a b&c?.png');
  });

  it.each<[string, McpCallContext, Record<string, unknown>, string]>([
    ['another session from a session token', SELF, { path: '/tmp/x.png', session_id: 's2' }, 'A session can show images from its own sandbox only.'],
    ['no session from a user token', {}, { path: '/tmp/x.png' }, 'session_id is required'],
    ['no path', SELF, {}, 'path is required'],
    ['a blank path', SELF, { path: '  ' }, 'path is required'],
  ])('refuses %s without calling the API', async (_name, ctx, args, message) => {
    const { calls } = mockApi(() => image());
    await expect(tool().handler(OWNER, args, ctx)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [512, '512 B'],
    [1536, '1.5 KB'],
    [3 * 1024 * 1024, '3.0 MB'],
  ])('says the size of a %i-byte image', async (bytes, size) => {
    mockApi(() => image({ bytes }));
    const result = await tool().handler(OWNER, { path: '/tmp/shot.png' }, SELF);
    expect(result).toEqual({
      content: [
        { type: 'text', text: `Showing /tmp/shot.png (${size})` },
        { type: 'image', data: PNG_B64, mimeType: 'image/png' },
      ],
    });
  });

  it.each(['image/jpeg', 'image/gif', 'image/webp'])('passes the %s type through', async (mediaType) => {
    mockApi(() => image({ mediaType }));
    const result = await tool().handler(OWNER, { path: '/tmp/shot' }, SELF);
    expect(typeof result === 'string' ? null : result.content[1]).toMatchObject({ type: 'image', mimeType: mediaType });
  });

  it('sends the image content unchanged through the MCP server', async () => {
    mockApi(() => image());
    const result = await callTool(SELF, 'talyn_show_image', { path: '/tmp/shot.png' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      { type: 'text', text: 'Showing /tmp/shot.png (1.5 KB)' },
      { type: 'image', data: PNG_B64, mimeType: 'image/png' },
    ]);
  });

  it.each([
    [404, '/tmp/none.png does not exist.'],
    [413, '/tmp/big.png is too large to show (6.0 MB). The limit is 3.5 MB. Take a smaller screenshot or save it as JPEG.'],
    [415, '/home/u/.env is not a PNG, JPEG, GIF or WebP image.'],
  ])('turns a %i refusal into an error result', async (status, message) => {
    mockApi(() => ({ status, body: { success: false, error: message } }));
    const result = await callTool(SELF, 'talyn_show_image', { path: '/tmp/x' });
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: message }] });
  });

  it('refuses another session through the MCP server', async () => {
    const { calls } = mockApi(() => image());
    const result = await callTool(SELF, 'talyn_show_image', { path: '/tmp/x.png', session_id: 's2' });
    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'A session can show images from its own sandbox only.' }] });
    expect(calls).toHaveLength(0);
  });

  it('still wraps a string result from another tool as text', async () => {
    mockApi(() => ({ status: 200, body: { success: true, data: { ts: '123.456' } } }));
    const result = await callTool(SELF, 'talyn_slack_reply', { text: 'Hello' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0].text).toContain('123.456');
  });
});
