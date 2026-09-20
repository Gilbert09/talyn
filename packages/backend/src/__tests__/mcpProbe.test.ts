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
