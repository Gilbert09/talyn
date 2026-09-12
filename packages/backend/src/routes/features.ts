import { Router } from 'express';
import type { ApiResponse, Features } from '@talyn/shared';
import { workflowsEnabled } from '../services/workflowsAccess.js';

/**
 * Which allow-listed features the calling user may see.
 *
 * Mounted PRE-`ownerScope`, next to `/users` and `/billing`: the answer is about
 * the account, not about a workspace's rows, and there is nothing here for RLS
 * to filter.
 *
 * It exists as its own route rather than a field on the workspace payload so the
 * next flag costs one boolean instead of a schema change — and so nothing is
 * tempted to treat a capability as workspace configuration a client could set.
 *
 * Workflows is a released feature now, so this answers `true` unless somebody
 * has pulled its kill switch. It is kept as a capability answer rather than
 * hardcoded `true` precisely so the switch reaches the UI: a deployment that
 * turns the engine off should not leave a nav item pointing at routes that 403.
 */
export function featureRoutes(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const features: Features = {
      workflows: workflowsEnabled(),
    };
    res.json({ success: true, data: features } as ApiResponse<Features>);
  });

  return router;
}
