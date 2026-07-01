#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';
import { captureToolCall, shutdownAnalytics } from './analytics.js';

async function main(): Promise<void> {
  const server = new Server(
    { name: 'talyn', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as {
        type: 'object';
        properties?: Record<string, unknown>;
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const startedAt = Date.now();
    const toolName = req.params.name;
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      captureToolCall({
        tool: toolName,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: 'unknown tool',
      });
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${toolName}` }],
      };
    }
    try {
      const text = await tool.handler(
        (req.params.arguments ?? {}) as Record<string, unknown>
      );
      captureToolCall({ tool: toolName, ok: true, durationMs: Date.now() - startedAt });
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      const message = (err as Error).message;
      captureToolCall({
        tool: toolName,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
      };
    }
  });

  // Flush buffered analytics before the process goes away.
  const shutdown = async (): Promise<void> => {
    await shutdownAnalytics();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('fastowl-mcp error:', err);
  process.exit(1);
});
