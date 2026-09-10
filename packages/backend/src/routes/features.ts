import { Router } from 'express';
import type { ApiResponse, Features } from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import { isWorkflowsAllowedEmail, workflowsSubsystemEnabled } from '../services/workflowsAccess.js';

/**
 * Which allow-listed features the calling user may see.
 *
 * Mounted PRE-`ownerScope`, next to `/users` and `/billing`: the answer is about
 * the account, not about a workspace's rows, and there is nothing here for RLS
 * to filter.
 *
 * Keyed on the CALLER's email rather than a workspace's owner. The two agree for
 * every workspace this user owns, which is all of them today, and the engine's
 * own gate (`workspaceMayUseWorkflows`) is owner-keyed because a webhook has no
 * caller. This endpoint only decides whether to draw a nav item, so the caller
 * is the right subject: it answers "can I use this", not "may this workspace be
 * automated".
 *
 * It exists as its own route rather than a field on the workspace payload so the
 * next flag costs one boolean instead of a schema change — and so nothing is
 * tempted to treat a capability as workspace configuration a client could set.
 */
export function featureRoutes(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const email = assertUser(req).email;
    const features: Features = {
      workflows: workflowsSubsystemEnabled() && isWorkflowsAllowedEmail(email),
    };
    res.json({ success: true, data: features } as ApiResponse<Features>);
  });

  return router;
}
