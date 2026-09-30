import type { Features } from '@talyn/shared';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { debugBus } from '../services/debugBus.js';
import { callApi } from './api.js';
import { TOOLS } from './tools/index.js';

export function listToolsFor(features: Features | null) {
  return TOOLS.filter((tool) => !tool.feature || features?.[tool.feature] !== false).map(
    (tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; properties?: Record<string, unknown> },
      annotations: tool.annotations,
    })
  );
}

/**
 * Build an MCP `Server` bound to a single owner. The CallTool handler runs the
 * matching tool as `ownerId` and records each invocation on the debug bus
 * (name + ok + duration only — never arguments or secrets) so the Debug
 * panel's event stream stays honest.
 */
export function buildMcpServer(ownerId: string): Server {
  const server = new Server({ name: 'talyn', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let features: Features | null = null;
    if (TOOLS.some((tool) => tool.feature)) {
      try {
        features = await callApi<Features>(ownerId, 'GET', '/features');
      } catch {
        // A temporary failure must not hide tools. Each route still checks access.
      }
    }
    return { tools: listToolsFor(features) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = TOOLS.find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }],
      };
    }
    const startedAt = Date.now();
    try {
      const text = await tool.handler(
        ownerId,
        (req.params.arguments ?? {}) as Record<string, unknown>
      );
      debugBus.recordEvent({
        service: 'mcp',
        action: tool.name,
        summary: 'ok',
        ok: true,
        meta: { durationMs: Date.now() - startedAt },
      });
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debugBus.recordEvent({
        service: 'mcp',
        action: tool.name,
        summary: message,
        ok: false,
        meta: { durationMs: Date.now() - startedAt },
      });
      return { isError: true, content: [{ type: 'text' as const, text: message }] };
    }
  });

  return server;
}
