import { Express } from 'express';
import { workspaceRoutes } from './workspaces.js';
import { environmentRoutes } from './environments.js';
import { taskRoutes } from './tasks.js';
import { githubRoutes, githubPublicRoutes } from './github.js';
import { posthogRoutes } from './posthog.js';
import { cloudProviderRoutes } from './cloudProviders.js';
import { repositoryRoutes } from './repositories.js';
import { pullRequestRoutes } from './pullRequests.js';
import { debugRoutes } from './debug.js';
import { requireAuth } from '../middleware/auth.js';
import { ownerScope } from '../middleware/ownerScope.js';

export function setupRoutes(app: Express): void {
  const api = '/api/v1';

  // Public routes: the GitHub OAuth callback is hit by GitHub's browser
  // redirect, not by our authenticated desktop client, so it must stay
  // unauth'd. State-token validation inside the handler prevents CSRF.
  app.use(`${api}/github`, githubPublicRoutes());

  // Everything below is authenticated. The middleware populates req.user
  // and refuses requests without a valid Supabase JWT.
  app.use(`${api}`, requireAuth);

  // Developer-only internals view (requests, polling, WebSocket). Global,
  // not workspace-scoped — see routes/debug.ts. Mounted BEFORE the owner-scope
  // middleware so it stays a cross-tenant operator surface (and so it never
  // runs inside an owner-scoped transaction).
  app.use(`${api}/debug`, debugRoutes());

  // Owner-scoped DB enforcement for the data routers below: runs each request
  // inside a transaction that drops to the `authenticated` role so Postgres RLS
  // filters every query to req.user (see db/scope.ts).
  app.use(`${api}`, ownerScope);

  app.use(`${api}/workspaces`, workspaceRoutes());
  app.use(`${api}/environments`, environmentRoutes());
  app.use(`${api}/tasks`, taskRoutes());
  app.use(`${api}/github`, githubRoutes());
  // Generic cloud-provider surface (list + credential CRUD). The
  // `/posthog` routes remain as a back-compat alias for the existing
  // desktop Settings card.
  app.use(`${api}/cloud-providers`, cloudProviderRoutes());
  app.use(`${api}/posthog`, posthogRoutes());
  app.use(`${api}/repositories`, repositoryRoutes());
  app.use(`${api}/pull-requests`, pullRequestRoutes());

  app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Not found' });
  });

  app.use((err: Error, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    console.error('API Error:', err);
    res.status(500).json({ success: false, error: err.message });
  });
}
