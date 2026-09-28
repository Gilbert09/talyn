import { Router, type Request, type Response } from 'express';
import { inArray } from 'drizzle-orm';
import type { ApiResponse } from '@talyn/shared';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { getDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { LIST_COLUMNS, rowToPublicShape } from './pullRequests.js';
import {
  computeEntryPositions,
  loadActiveEntriesForWorkspace,
  rowToEntrySnapshot,
} from '../services/mergeQueue/store.js';
import { toPublicMergeQueue } from '../services/mergeQueue/legacy.js';
import { codeReviewRefusalReason, userMayUseCodeReview } from '../services/codeReviewAccess.js';
import { recentReviewsForWorkspace } from '../services/codeReview/store.js';
import { codeReviewsForPrs } from '../services/codeReview/public.js';
import { lensEffectiveness } from '../services/codeReview/findings.js';

/**
 * Every review this workspace has run, newest first.
 *
 * A cohort view rather than a per-pull-request one: the sheet's Findings tab
 * answers "what is wrong with THIS pull request", and this answers "where should
 * I look first", which previously meant opening each pull request in turn to
 * find out whether it had anything.
 *
 * Mounted BELOW `ownerScope`, like workflows and loops, so the RLS policies are
 * the second line of defence behind `requireWorkspaceAccess`.
 *
 * Gated here as well as in the nav. Hiding a nav item is not a gate — the CLI,
 * the MCP server and plain `curl` all walk past one.
 */

/**
 * How many reviews the panel asks for.
 *
 * Not a display cap dressed up as a limit: a review carries severity counts and
 * a PR identity, and this endpoint builds those in a fixed number of queries
 * regardless of the row count, so the number is about how far back a person
 * plausibly scrolls rather than about cost. Anything older is reachable from the
 * pull request itself, which is where a review belongs once it is history.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function codeReviewRoutes(): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response<ApiResponse<unknown>>) => {
    const user = assertUser(req);
    if (!(await userMayUseCodeReview({ distinctId: user.id, email: user.email }))) {
      return res.status(403).json({
        success: false,
        error: `Code review is not available: ${codeReviewRefusalReason()}`,
        code: 'code_review_unavailable',
      });
    }

    const workspaceId = String(req.query.workspaceId ?? '');
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const requested = Number(req.query.limit);
    const limit =
      Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

    const reviews = await recentReviewsForWorkspace(workspaceId, limit);
    if (!reviews.length) return res.json({ success: true, data: { reviews: [] } });

    const prIds = reviews.map((r) => r.pullRequestId);
    // The same batch builder the pull-request list uses: a fixed number of
    // queries for the whole page rather than four per row.
    //
    // The PR row is serialized in FULL, exactly as the pull-request list
    // serializes it, so the panel can hand it to the detail sheet as a seed.
    // Without one the sheet opens blank and spins until its own fetch returns —
    // which is the whole of "the panel takes a while to load". A narrower shape
    // would be smaller and would not be a seed.
    const [payloads, prRows, queueEntries] = await Promise.all([
      codeReviewsForPrs(prIds),
      getDbClient()
        .select(LIST_COLUMNS)
        .from(pullRequestsTable)
        .where(inArray(pullRequestsTable.id, prIds)),
      // One indexed query for the workspace, the same call the list makes.
      loadActiveEntriesForWorkspace(workspaceId).catch(() => []),
    ]);

    const positions = computeEntryPositions(queueEntries);
    const queueByPrId = new Map(
      queueEntries.map((entry) => [
        entry.pullRequestId,
        toPublicMergeQueue(rowToEntrySnapshot(entry), positions.get(entry.id) ?? 0),
      ])
    );

    const prById = new Map(prRows.map((p) => [p.id, p]));
    // Typed structurally rather than against the client's CodeReviewListItem:
    // the backend must not import the front-end package, and the shape is
    // asserted by the route's tests instead.
    const items: { review: unknown; pullRequest: Record<string, unknown> }[] = [];
    for (const review of reviews) {
      const payload = payloads.get(review.pullRequestId);
      const pr = prById.get(review.pullRequestId);
      // A review whose pull request has gone is not shown. It is not an error —
      // the row is kept for the audit — but there is nothing to click through to.
      if (!payload || !pr) continue;
      items.push({
        review: payload,
        pullRequest: {
          ...rowToPublicShape(pr),
          mergeQueue: queueByPrId.get(pr.id) ?? null,
          codeReview: payload,
        },
      });
    }

    res.json({ success: true, data: { reviews: items } });
  });

  /**
   * How each lens has performed for this workspace.
   *
   * Its own route rather than a field on the list, because it answers a
   * different question on a different clock: the list is "what needs me now",
   * this is "is this reviewer worth its cost", and it is read on the settings
   * page rather than on every poll of a pull-request list.
   */
  router.get('/lenses', async (req: Request, res: Response<ApiResponse<unknown>>) => {
    const user = assertUser(req);
    if (!(await userMayUseCodeReview({ distinctId: user.id, email: user.email }))) {
      return res.status(403).json({
        success: false,
        error: `Code review is not available: ${codeReviewRefusalReason()}`,
        code: 'code_review_unavailable',
      });
    }
    const workspaceId = String(req.query.workspaceId ?? '');
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    res.json({ success: true, data: { lenses: await lensEffectiveness(workspaceId) } });
  });

  return router;
}
