import { Router, type Request, type Response } from 'express';
import {
  includedWeightedSeconds,
  isInsightsSection,
  usagePeriodFor,
  type ApiResponse,
  type InsightsComputeResponse,
  type InsightsResponseBySection,
  type InsightsSection,
} from '@talyn/shared';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { readPeriod } from '../services/billing/usage/periods.js';
import { resolveUsageTier } from '../services/billing/usage/tier.js';
import { insightsRefusalReason, userMayUseInsights } from '../services/insights/access.js';
import { loadAgents, loadCompute, loadOutput, loadSpeed, loadTop, type InsightsScope } from '../services/insights/queries.js';
import { parseInsightsRange } from '../services/insights/range.js';

/**
 * Insights: one workspace's usage analytics, one section per request.
 *
 *   GET /insights/:section?workspaceId=&range=7d|30d|period
 *   GET /insights/:section?workspaceId=&from=&to=
 *
 * `section` is compute | agents | output | speed | top. Mounted PRE-ownerScope,
 * like `/billing`: the usage tables are backend-pool-only (RLS on, no policy),
 * so every query runs on the pool and is scoped here. The caller must own the
 * workspace (`requireWorkspaceAccess`), and the usage ledger is also filtered
 * by the caller's id as its owner. Gated by the `usage-insights` flag on the
 * CALLER, the subject `GET /features` answers for.
 */

async function refuseUnlessEnabled(req: Request, res: Response): Promise<boolean> {
  const user = assertUser(req);
  if (await userMayUseInsights({ distinctId: user.id, email: user.email })) return false;
  res.status(403).json({
    success: false,
    error: `Insights is not available: ${insightsRefusalReason()}.`,
    code: 'insights_unavailable',
  });
  return true;
}

type Loader<S extends InsightsSection> = (scope: InsightsScope, period: InsightsComputeResponse['period']) => Promise<InsightsResponseBySection[S]>;

const LOADERS: { [S in InsightsSection]: Loader<S> } = {
  compute: (scope, period) => loadCompute(scope, period),
  agents: (scope) => loadAgents(scope),
  output: (scope) => loadOutput(scope),
  speed: (scope) => loadSpeed(scope),
  top: (scope) => loadTop(scope),
};

export function insightsRoutes(): Router {
  const router = Router();

  router.get('/:section', async (req, res) => {
    const section = req.params.section;
    if (!isInsightsSection(section)) {
      return res.status(404).json({ success: false, error: 'section must be compute, agents, output, speed or top.' });
    }
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) return res.status(400).json({ success: false, error: 'workspaceId is required' });
    if (await refuseUnlessEnabled(req, res)) return;
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const ownerId = assertUser(req).id;
    const now = new Date();
    const usageTier = await resolveUsageTier(ownerId);
    const period = usagePeriodFor({ now, anchor: usageTier.periodAnchor });
    const range = parseInsightsRange(req.query as Record<string, unknown>, now, period);
    if ('error' in range) return res.status(400).json({ success: false, error: range.error });

    let periodSummary: InsightsComputeResponse['period'] = null;
    if (section === 'compute') {
      // A read only: a period with no row yet has used nothing.
      const row = await readPeriod(ownerId, period.start);
      periodSummary = {
        tier: usageTier.tier,
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        includedWsec: Number(row?.includedWsec ?? includedWeightedSeconds(usageTier.tier)),
        usedWsec: Number(row?.usedWsec ?? 0),
        creditMicrosUsed: Number(row?.creditMicrosUsed ?? 0),
      };
    }
    const data = await (LOADERS[section] as Loader<typeof section>)({ ...range, ownerId, workspaceId }, periodSummary);
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  return router;
}
