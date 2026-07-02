import { Express, NextFunction, Request, Response } from 'express';
import { workspaceRoutes } from './workspaces.js';
import { environmentRoutes } from './environments.js';
import { taskRoutes } from './tasks.js';
import { githubRoutes, githubPublicRoutes } from './github.js';
import { posthogRoutes } from './posthog.js';
import { cloudProviderRoutes } from './cloudProviders.js';
import { repositoryRoutes } from './repositories.js';
import { skillRoutes } from './skills.js';
import { pullRequestRoutes } from './pullRequests.js';
import { debugRoutes } from './debug.js';
import { userRoutes } from './users.js';
import { mcpTokenRoutes } from './mcpTokens.js';
import { mcpRoutes } from '../mcp/transport.js';
import { requireMcpToken } from '../mcp/requireMcpToken.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, wrapAsyncRoutes } from '../middleware/asyncHandler.js';
import { ownerScope } from '../middleware/ownerScope.js';

export function setupRoutes(app: Express): void {
  const api = '/api/v1';

  // Every router is wrapped so async handler rejections flow into the
  // arity-4 error middleware below (Express 4 doesn't catch them itself —
  // an unwrapped rejection is a hung request + an unhandledRejection).
  const mount = wrapAsyncRoutes;

  // Public routes: the GitHub OAuth callback is hit by GitHub's browser
  // redirect, not by our authenticated desktop client, so it must stay
  // unauth'd. State-token validation inside the handler prevents CSRF.
  app.use(`${api}/github`, mount(githubPublicRoutes()));

  // The hosted MCP endpoint authenticates with a personal MCP token (not a
  // Supabase JWT), so it mounts BEFORE requireAuth with its own gate. The
  // tool handlers call the authenticated REST API below over loopback with
  // internal-proxy headers, so owner scoping still applies end-to-end.
  app.use(`${api}/mcp`, asyncHandler(requireMcpToken), mount(mcpRoutes()));

  // Everything below is authenticated. The middleware populates req.user
  // and refuses requests without a valid Supabase JWT.
  app.use(`${api}`, asyncHandler(requireAuth));

  // Developer-only internals view (requests, polling, WebSocket). Global,
  // not workspace-scoped — see routes/debug.ts. Mounted BEFORE the owner-scope
  // middleware so it stays a cross-tenant operator surface (and so it never
  // runs inside an owner-scoped transaction).
  app.use(`${api}/debug`, mount(debugRoutes()));

  // Account-level self-service (wipe). Pre-ownerScope: deletes the caller's
  // own users row, which RLS blocks from the authenticated role; handlers
  // hard-scope every query to req.user.id instead. See routes/users.ts.
  app.use(`${api}/users`, mount(userRoutes()));

  // Owner-scoped DB enforcement for the data routers below: runs each request
  // inside a transaction that drops to the `authenticated` role so Postgres RLS
  // filters every query to req.user (see db/scope.ts).
  app.use(`${api}`, ownerScope);

  app.use(`${api}/workspaces`, mount(workspaceRoutes()));
  app.use(`${api}/environments`, mount(environmentRoutes()));
  app.use(`${api}/tasks`, mount(taskRoutes()));
  app.use(`${api}/github`, mount(githubRoutes()));
  // Generic cloud-provider surface (list + credential CRUD). The
  // `/posthog` routes remain as a back-compat alias for the existing
  // desktop Settings card.
  app.use(`${api}/cloud-providers`, mount(cloudProviderRoutes()));
  app.use(`${api}/posthog`, mount(posthogRoutes()));
  app.use(`${api}/repositories`, mount(repositoryRoutes()));
  app.use(`${api}/pull-requests`, mount(pullRequestRoutes()));
  app.use(`${api}/skills`, mount(skillRoutes()));
  // Personal MCP-token management (mint/list/revoke). The tokens authenticate
  // the `/mcp` endpoint mounted above.
  app.use(`${api}/mcp-tokens`, mount(mcpTokenRoutes()));

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
  });

  // Arity-4 is load-bearing: Express only treats a middleware as an error
  // handler when it declares exactly four parameters.
  app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    console.error('API Error:', err);
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ success: false, error: err.message });
  });
}
