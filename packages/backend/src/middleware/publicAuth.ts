import type { NextFunction, Request, Response } from 'express';
import { scopeAllows, type ApiScope } from '@talyn/shared';
import { extractBearerToken } from './auth.js';
import { validateApiToken, type ApiTokenPrincipal, type ApiTokenRefusal } from '../services/apiTokens.js';
import { publicApiRefusalReason, userMayUsePublicApi } from '../services/public/access.js';
import { PublicApiError } from '../services/public/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The personal access token on a `/v1` request. */
      apiToken?: ApiTokenPrincipal;
    }
  }
}

const CHALLENGE = 'Bearer realm="talyn-api"';

const REFUSAL_COPY: Record<ApiTokenRefusal, string> = {
  invalid_token: 'The token is not a valid Talyn API token.',
  token_revoked: 'This token was revoked. Create a new one in Settings → Developer.',
  token_expired: 'This token has expired. Create a new one in Settings → Developer.',
  account_not_allowed: 'This account may not use this deployment.',
};

function unauthorized(code: string, message: string): PublicApiError {
  return new PublicApiError(401, code, message, {
    headers: { 'WWW-Authenticate': `${CHALLENGE}, error="invalid_token"` },
  });
}

/**
 * Authenticate a `/v1` request with a personal access token, then check the
 * `publicApi` flag for the token's OWNER.
 *
 * Only `talyn_pat_` tokens pass. A Supabase JWT, an MCP token or a session
 * token is `invalid_token`: those are for the apps, the MCP server and a
 * session's own agent.
 *
 * On success `req.user` is the owner, so every existing service and access
 * check works unchanged, and `req.apiToken` carries the scopes and the
 * workspace binding. A token never acts as an admin.
 */
export async function requireApiToken(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const raw = extractBearerToken(req.headers.authorization);
  if (!raw) {
    throw new PublicApiError(401, 'missing_token', 'Send a personal access token as "Authorization: Bearer talyn_pat_...".', {
      headers: { 'WWW-Authenticate': CHALLENGE },
    });
  }
  const result = await validateApiToken(raw);
  if (!result.ok) {
    if (result.reason === 'account_not_allowed') {
      throw new PublicApiError(403, 'account_not_allowed', REFUSAL_COPY.account_not_allowed);
    }
    throw unauthorized(result.reason, REFUSAL_COPY[result.reason]);
  }
  const principal = result.principal;
  if (!(await userMayUsePublicApi({ distinctId: principal.ownerId, email: principal.email }))) {
    throw new PublicApiError(403, 'public_api_unavailable', `The Talyn API is not available: ${publicApiRefusalReason()}.`);
  }
  req.apiToken = principal;
  req.user = { id: principal.ownerId, email: principal.email, isAdmin: false };
  next();
}

/** The token on a request that passed {@link requireApiToken}. */
export function assertApiToken(req: Request): ApiTokenPrincipal {
  if (!req.apiToken) throw new Error('assertApiToken called before requireApiToken');
  return req.apiToken;
}

/**
 * Refuse a request whose token lacks `scope`. 403 with the scope it needs, in
 * the body and in the challenge (RFC 6750 `insufficient_scope`).
 */
export function requireScope(scope: ApiScope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = assertApiToken(req);
    if (!scopeAllows(token.scopes, scope)) {
      throw new PublicApiError(403, 'insufficient_scope', `This token does not have the "${scope}" scope.`, {
        details: { required_scope: scope },
        headers: { 'WWW-Authenticate': `${CHALLENGE}, error="insufficient_scope", scope="${scope}"` },
      });
    }
    next();
  };
}
