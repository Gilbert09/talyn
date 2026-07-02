#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { instrument } from '@posthog/mcp';
import { TOOLS } from './tools.js';
import { createAnalyticsClient, analyticsIdentity } from './analytics.js';

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
    const toolName = req.params.name;
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${toolName}` }],
      };
    }
    try {
      const text = await tool.handler(
        (req.params.arguments ?? {}) as Record<string, unknown>
      );
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: (err as Error).message }],
      };
    }
  });

  // PostHog MCP analytics (`$mcp_*` auto-capture) — instrument() wraps the
  // EXISTING tools/call handler, so it must run after the handlers above are
  // registered. No-op when analytics is disabled.
  const posthog = createAnalyticsClient();
  if (posthog) {
    instrument(server, posthog, { identify: analyticsIdentity() });
  }

  // Flush buffered analytics before the process goes away.
  const shutdown = async (): Promise<void> => {
    if (posthog) await posthog.shutdown().catch(() => undefined);
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
