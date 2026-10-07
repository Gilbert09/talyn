import { Router } from 'express';
import type { ApiResponse, GithubHealth } from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import { githubHealthMonitor } from '../services/githubHealthMonitor.js';

/**
 * State of the systems Talyn depends on, as opposed to state of a workspace.
 *
 * Mounted PRE-`ownerScope`, next to `/features`: the answer is the same for
 * every caller and reads no table, so an owner-scoped transaction would pin a
 * pooled connection to filter nothing. It still needs a signed-in caller.
 */
export function systemRoutes(): Router {
  const router = Router();

  // Whether GitHub itself is up. In-memory counters and the last read of
  // GitHub's status page: no GitHub call and no database query happen here.
  router.get('/github-health', (req, res) => {
    assertUser(req);
    res.json({ success: true, data: githubHealthMonitor.refresh() } as ApiResponse<GithubHealth>);
  });

  return router;
}
