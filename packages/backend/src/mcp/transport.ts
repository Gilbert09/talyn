import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './server.js';

/**
 * The hosted MCP endpoint, mounted at `/api/v1/mcp` (behind requireMcpToken).
 * Runs the Streamable-HTTP transport in STATELESS mode: a fresh transport +
 * server per request, torn down when the response closes. Stateless keeps it
 * simple and horizontally safe (no in-memory session affinity) — the tools are
 * request/response shaped, so we don't need server-initiated SSE streams.
 */
export function mcpRoutes(): Router {
  const router = Router();

  const handle = async (req: Request, res: Response): Promise<void> => {
    const ownerId = req.mcpOwnerId;
    if (!ownerId) {
      res.status(401).json({ success: false, error: 'Unauthenticated' });
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(ownerId);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      // Express already parsed the JSON body (global express.json()).
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'MCP request failed' });
      }
    }
  };

  // POST carries JSON-RPC calls. GET/DELETE are part of the transport contract
  // (SSE stream / session teardown); in stateless mode the transport answers
  // them appropriately (405 for the unsupported GET stream).
  router.post('/', handle);
  router.get('/', handle);
  router.delete('/', handle);

  return router;
}
