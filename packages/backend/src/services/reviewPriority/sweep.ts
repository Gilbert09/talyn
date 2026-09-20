// The clock behind the review-ranking model: backfill once, retrain rarely.
//
// Deliberately slow. Review habits move over months, not minutes, so this is
// nothing like the 30s PR poll — a retrain that ran often would spend real CPU
// and GraphQL points to compute almost exactly the same five numbers.
//
// The gate here asks about the workspace OWNER rather than a caller, because a
// sweep has no caller. That is also the gate that actually bounds the spend:
// the backfill reads a viewer's whole review history, and the GraphQL point
// budget is shared per rate-limit ACCOUNT, so an ungated sweep would take
// points from the poller and the merge queue for every workspace on the same
// installation.

import { and, eq, sql } from 'drizzle-orm';
import { githubService } from '../github.js';
import { getPoolDbClient } from '../../db/client.js';
import { workspaces as workspacesTable, reviewRankModels } from '../../db/schema.js';
import { workspaceHasFeature } from '../featureFlags.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { runWithoutScope } from '../../db/client.js';
import { debugBus } from '../debugBus.js';
import { TickGuard } from '../tickGuard.js';
import { backfillReviewHistory, hasBackfilled } from './backfill.js';
import { trainReviewRank } from './trainer.js';

/** How often the sweep looks. Habits do not move faster than this. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Retrain when the history has grown by this many events since the last fit. */
export const RETRAIN_EVENT_DELTA = 25;

/** …or when the last fit is this old, whichever comes first. */
export const RETRAIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface SweepOutcome {
  workspaces: number;
  backfilled: number;
  trained: number;
}

/**
 * Should this viewer be retrained?
 *
 * Age OR growth, not both: a viewer who reviews nothing for a month still
 * benefits from a refit once their old rows age out of relevance, and one who
 * reviews thirty PRs in a week should not wait a week for the model to notice.
 */
export function shouldRetrain(
  lastTrainedAt: Date | null,
  lastNEvents: number,
  currentEvents: number,
  now: number,
): boolean {
  if (!lastTrainedAt) return true;
  if (currentEvents - lastNEvents >= RETRAIN_EVENT_DELTA) return true;
  return now - lastTrainedAt.getTime() >= RETRAIN_MAX_AGE_MS;
}

async function sweepWorkspace(workspaceId: string): Promise<{ backfilled: boolean; trained: boolean }> {
  // The owner gate. Asked per workspace rather than once, so taking the flag
  // away from one account stops its spend on the next tick.
  if (!(await workspaceHasFeature('reviewPriority', workspaceId))) {
    return { backfilled: false, trained: false };
  }

  const viewerLogin = await githubService.getViewerLogin(workspaceId);
  if (!viewerLogin) return { backfilled: false, trained: false };

  let backfilled = false;
  if (!(await hasBackfilled(workspaceId, viewerLogin))) {
    const result = await backfillReviewHistory(workspaceId, viewerLogin);
    backfilled = result.rows > 0;
    // A deferred (budget-limited) read leaves `backfilledAt` null, so the next
    // sweep resumes rather than training on a third of a history and reporting
    // the resulting model as this person's.
    if (result.deferred) return { backfilled, trained: false };
  }

  const db = getPoolDbClient();
  const [existing] = await db
    .select({ trainedAt: reviewRankModels.trainedAt, nEvents: reviewRankModels.nEvents })
    .from(reviewRankModels)
    .where(
      and(
        eq(reviewRankModels.workspaceId, workspaceId),
        eq(reviewRankModels.viewerLogin, viewerLogin),
      ),
    )
    .limit(1);

  // The current event count, cheaply, so a retrain is not run to discover that
  // nothing changed. One aggregate beats loading every row.
  const [{ events }] = (await db.execute(sql`
    SELECT COUNT(*)::int AS events
    FROM review_history
    WHERE workspace_id = ${workspaceId}
      AND viewer_login = ${viewerLogin}
      AND reviewed_at IS NOT NULL
  `)) as unknown as Array<{ events: number }>;

  // A brand-new row from the backfill has `trainedAt` defaulted to now but has
  // never been fitted, which `nEvents = 0` is what distinguishes.
  const neverFitted = !existing || existing.nEvents === 0;
  if (!neverFitted && !shouldRetrain(existing.trainedAt, existing.nEvents, events, Date.now())) {
    return { backfilled, trained: false };
  }

  await trainReviewRank(workspaceId, viewerLogin);
  return { backfilled, trained: true };
}

/**
 * One pass over every workspace.
 *
 * Errors are logged and swallowed PER WORKSPACE: one account whose GitHub token
 * was revoked must not stop the sweep for everybody else, and there is nothing
 * a caller could do with the throw anyway — this runs on a timer.
 */
export async function runReviewPrioritySweep(): Promise<SweepOutcome> {
  const outcome: SweepOutcome = { workspaces: 0, backfilled: 0, trained: 0 };
  const db = getPoolDbClient();
  const rows = await db.select({ id: workspacesTable.id }).from(workspacesTable);
  for (const row of rows) {
    outcome.workspaces++;
    try {
      const result = await sweepWorkspace(row.id);
      if (result.backfilled) outcome.backfilled++;
      if (result.trained) outcome.trained++;
    } catch (err) {
      console.warn(
        `[review-priority] sweep failed for workspace ${row.id.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return outcome;
}

class ReviewPrioritySweep {
  private timer: NodeJS.Timeout | null = null;
  // Generous, because a backfill is 32 paginated GraphQL round-trips and a slow
  // GitHub is not a wedged sweep.
  private guard = new TickGuard('review_priority_sweep', 30 * 60_000);

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'review_priority_sweep',
      SWEEP_INTERVAL_MS,
      'Reads each viewer\'s own GitHub review history once, then refits the Reviews tab\'s ranking model when it has grown or gone stale. Hourly, because reviewing habits do not move faster than that.'
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests, which drive a tick directly rather than on a timer. */
  async tick(): Promise<SweepOutcome> {
    const empty: SweepOutcome = { workspaces: 0, backfilled: 0, trained: 0 };
    if (!this.guard.tryBegin()) return empty;
    const startedAt = Date.now();
    let outcome = empty;
    let error: unknown;
    try {
      // One replica at a time. Two sweeps backfilling the same viewer would
      // each spend ~510 GraphQL points to compute the same five numbers, out of
      // a budget the poller and the merge queue share.
      //
      // `acquired: false` means another replica is already sweeping — not an
      // error, and nothing to retry: the next hour will do.
      const result = await guardCrossReplica('review_priority_sweep:tick', async () =>
        runReviewPrioritySweep()
      );
      if (result.acquired && result.result) outcome = result.result;
      return outcome;
    } catch (err) {
      error = err;
      throw err;
    } finally {
      this.guard.end();
      debugBus.pollerTick('review_priority_sweep', {
        durationMs: Date.now() - startedAt,
        ok: !error,
        // The ERROR, not its message: drizzle reports "Failed query: select …"
        // and puts the reason in `cause`, and a red card naming the query but
        // not the cause is the one that costs an hour.
        error,
      });
    }
  }
}

export const reviewPrioritySweep = new ReviewPrioritySweep();

/** Wrapped so the timer's work never inherits a request's transaction handle. */
export function initReviewPrioritySweep(): void {
  runWithoutScope(() => reviewPrioritySweep.init());
}
