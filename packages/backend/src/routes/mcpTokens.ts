import { Router } from 'express';
import type {
  ApiResponse,
  CreateMcpTokenRequest,
  CreateMcpTokenResponse,
  McpToken,
} from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import { createToken, listTokens, revokeToken } from '../services/mcpToken.js';

/**
 * Personal MCP-token management for the calling user. Mounted AFTER
 * requireAuth + ownerScope: every query is owner-scoped via RLS, and the
 * caller manages only their own tokens. The hosted `/mcp` endpoint these
 * tokens authenticate is mounted separately, before auth (see mcp/).
 */
export function mcpTokenRoutes(): Router {
  const router = Router();

  // GET /mcp-tokens — the caller's active tokens (no secrets).
  router.get('/', async (req, res) => {
    const tokens = await listTokens(assertUser(req).id);
    res.json({ success: true, data: tokens } as ApiResponse<McpToken[]>);
  });

  // POST /mcp-tokens — mint a token. The plaintext is returned exactly once.
  router.post('/', async (req, res) => {
    const body = (req.body ?? {}) as CreateMcpTokenRequest;
    if (body.expiresInDays != null && typeof body.expiresInDays !== 'number') {
      res.status(400).json({ success: false, error: 'expiresInDays must be a number' });
      return;
    }
    const result = await createToken(assertUser(req).id, {
      name: body.name,
      expiresInDays: body.expiresInDays,
    });
    res.status(201).json({ success: true, data: result } as ApiResponse<CreateMcpTokenResponse>);
  });

  // DELETE /mcp-tokens/:id — revoke. 404 if it isn't the caller's active token.
  router.delete('/:id', async (req, res) => {
    const ok = await revokeToken(assertUser(req).id, req.params.id);
    if (!ok) {
      res.status(404).json({ success: false, error: 'token not found' });
      return;
    }
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}
