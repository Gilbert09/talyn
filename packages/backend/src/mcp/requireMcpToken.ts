import type { NextFunction, Request, Response } from 'express';
import { extractBearerToken } from '../middleware/auth.js';
import { validateToken } from '../services/mcpToken.js';
import {
  isSessionMcpToken,
  validateSessionMcpToken,
  type SessionMcpBinding,
} from '../services/sessionMcpToken.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Resolved owner of the personal MCP token on a `/mcp` request. */
      mcpOwnerId?: string;
      /** Set when the token is a session sandbox's own (`talyn_mcs_`). */
      mcpSession?: SessionMcpBinding;
    }
  }
}

/**
 * Authenticate a `/mcp` request with a personal MCP token or a session
 * sandbox's own token (NOT a Supabase JWT — this endpoint is mounted before
 * requireAuth). On success, stashes the resolved owner id, and for a session
 * token the session it is bound to; the tool handlers then call the REST API
 * as that owner.
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
  if (isSessionMcpToken(token)) {
    const session = await validateSessionMcpToken(token);
    if (!session) {
      unauthorized(res, 'Invalid session MCP token, or its session is archived or deleted');
      return;
    }
    req.mcpOwnerId = session.ownerId;
    req.mcpSession = session.session;
    next();
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
  res.setHeader('WWW-Authenticate', 'Bearer realm="talyn-mcp"');
  res.status(401).json({ success: false, error });
}
