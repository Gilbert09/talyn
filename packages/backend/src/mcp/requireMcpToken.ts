import type { NextFunction, Request, Response } from 'express';
import { extractBearerToken } from '../middleware/auth.js';
import { validateToken } from '../services/mcpToken.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Resolved owner of the personal MCP token on a `/mcp` request. */
      mcpOwnerId?: string;
    }
  }
}

/**
 * Authenticate a `/mcp` request with a personal MCP token (NOT a Supabase
 * JWT — this endpoint is mounted before requireAuth). On success, stashes the
 * resolved owner id; the tool handlers then call the REST API as that owner.
 * On failure, answers 401 with a `WWW-Authenticate` challenge per the MCP
 * spec's bearer-token expectation.
 */
export async function requireMcpToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    unauthorized(res, 'Missing bearer token');
    return;
  }
  const result = await validateToken(token);
  if (!result) {
    unauthorized(res, 'Invalid, expired, or revoked MCP token');
    return;
  }
  req.mcpOwnerId = result.ownerId;
  next();
}

function unauthorized(res: Response, error: string): void {
  res.setHeader('WWW-Authenticate', 'Bearer realm="fastowl-mcp"');
  res.status(401).json({ success: false, error });
}
