import { Router } from 'express';
import type { ApiResponse, Features } from '@talyn/shared';
import { assertUser } from '../middleware/auth.js';
import { featuresForUser } from '../services/featureFlags.js';

/**
 * Which features the calling user may see.
 *
 * Mounted PRE-`ownerScope`, next to `/users` and `/billing`: the answer is about
 * the account, not about a workspace's rows, and there is nothing here for RLS
 * to filter.
 *
 * It exists as its own route rather than a field on the workspace payload so the
 * next flag costs one entry in the shared register instead of a schema change —
 * and so nothing is tempted to treat a capability as workspace configuration a
 * client could set.
 *
 * Since flags moved to PostHog this is evaluated against the CALLER — their
 * Supabase user id as the distinct id, their email as a person property — which
 * is what lets a flag be rolled out to a percentage or a cohort rather than to
 * the whole deployment. It stays a capability answer rather than a hardcoded
 * `true` precisely so a rollback reaches the UI: a deployment that turns the
 * engine off should not leave a nav item pointing at routes that 403.
 *
 * Only the account-scoped flags are here. `fleet` is keyed on the workspace
 * OWNER, who is not always the caller, so the cloud-provider routes answer that
 * one per workspace instead — see `ACCOUNT_FEATURE_FLAGS`.
 */
export function featureRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const user = assertUser(req);
    const features = await featuresForUser({ distinctId: user.id, email: user.email });
    res.json({ success: true, data: features } as ApiResponse<Features>);
  });

  return router;
}
