import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeMcpServer } from '../services/mcpServers/probe.js';

afterEach(() => vi.unstubAllGlobals());

describe('MCP tool discovery', () => {
  it.each([false, true])('reads metadata across pages (repeated cursor: %s)', async (repeat) => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      let result: unknown = {};
      if (request.method === 'initialize') result = { serverInfo: { name: 'Example' } };
      if (request.method === 'tools/list') {
        result = request.params.cursor
          ? { tools: [{ name: 'second', description: 'Read documents.' }], ...(repeat ? { nextCursor: 'page2' } : {}) }
          : { tools: [{ name: 'first', title: 'First tool', description: 'Search documents.', inputSchema: { secret: 'not retained' } }, null], nextCursor: 'page2' };
      }
      return new Response(JSON.stringify({ id: request.id, result }));
    }));
    const result = await probeMcpServer({ url: 'https://example.com/mcp', authKind: 'none' });
    expect(result.ok).toBe(true);
    expect(requests.filter((request) => request.method === 'tools/list')).toHaveLength(2);
    if (repeat) {
      expect(result.toolNames).toBeUndefined();
      expect(result.detail).toContain('repeats pages');
    } else {
      expect(result.toolNames).toEqual(['first', 'second']);
      expect(result.tools).toEqual([
        { name: 'first', title: 'First tool', description: 'Search documents.' },
        { name: 'second', description: 'Read documents.' },
      ]);
    }
  });
});

describe('MCP probe failures', () => {
  it('reports the cause rather than "fetch failed"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND box.tailnet.ts.net'), { code: 'ENOTFOUND' }),
      });
    }));
    const result = await probeMcpServer({ url: 'https://box.tailnet.ts.net/mcp', authKind: 'none' });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('could not reach the server: the address cannot be resolved from Talyn’s servers. Check its exact private route');
  });
});

describe('Streamable HTTP probes', () => {
  it('reads complete SSE events, sends initialized, and closes the session', async () => {
    const requests: string[] = [];
    const cancelled = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
      if (init.method === 'DELETE') {
        requests.push('DELETE');
        expect(new Headers(init.headers).get('mcp-session-id')).toBe('session-1');
        return new Response(null, { status: 204 });
      }
      const message = JSON.parse(init.body as string);
      requests.push(message.method);
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const result = message.method === 'initialize'
        ? { serverInfo: { name: 'Private server' }, protocolVersion: '2025-06-18' }
        : { tools: [{ name: 'read_documents' }] };
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`: heartbeat\r\n\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":${message.id},"result":${JSON.stringify(result)}}\r\n\r\n`));
        },
        cancel: cancelled,
      }), { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' } });
    }));
    const result = await probeMcpServer({ url: 'https://example.com/mcp', authKind: 'bearer', secret: 'probe-test-value' });
    expect(result.ok).toBe(true);
    expect(result.toolNames).toEqual(['read_documents']);
    expect(requests).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
    expect(cancelled).toHaveBeenCalledTimes(2);
  });
  it('rejects an initialize redirect without replaying it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://other.example.com/mcp' } })));
    const result = await probeMcpServer({ url: 'https://example.com/mcp', authKind: 'bearer', secret: 'probe-test-value' });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('redirected');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
