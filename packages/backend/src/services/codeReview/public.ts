import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  codeReviewPhasePlan,
  CODE_REVIEW_REPORTING_BAR,
  EMPTY_CODE_REVIEW_COUNTS,
  isCodeReviewPreset,
  type CodeReviewCounts,
  type CodeReviewPhase,
  type CodeReviewPublic,
  type CodeReviewSeverity,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  prCodeReviewFindings,
  prCodeReviewRuns,
  prCodeReviews,
  pullRequests as pullRequestsTable,
} from '../../db/schema.js';
import { reportingBarsFor } from './cycle.js';
import {
  ACTIVE_DISPOSITIONS,
  countDismissed,
  funnelCounts,
  openCountOf,
  severityCounts,
} from './findings.js';
import {
  getPrForReview,
  getReview,
  getReviewForPr,
  runsForCycle,
  REVIEW_COLUMNS,
  type ReviewRow,
} from './store.js';
import { hasDeferredUnit, settledUnitCount } from './decide.js';

/**
 * The one public shape a review takes.
 *
 * `legacy.ts` in the merge queue is the precedent, and so are its rules. Three
 * things are computed HERE rather than at the call sites that need them:
 *
 * - **`headShaShort`**, because three components would each shorten it and one of
 *   them would pick a different length.
 * - **`openCount`**, because the tab badge, the row chip and the sheet header all
 *   need "how many findings am I being asked about", and re-deriving it from
 *   `counts` plus a threshold in three places is three chances to disagree.
 * - **`staleForHead`**, because the pull request's summary and the review can
 *   arrive at a client in either order, so a client deriving it would flicker
 *   between "current" and "behind" on every poll.
 */

/** The per-review facts the shape needs, however they were gathered. */
interface ReviewFacts {
  counts: CodeReviewCounts;
  dismissedCount: number;
  funnel: { raised: number; kept: number; rejected: number };
  /** The workspace's display bar, which decides `openCount`. */
  reportingBar: CodeReviewSeverity;
  runsDone: number;
  deferred: boolean;
  currentHead: string | null;
}

/** Pure: facts in, payload out. Shared by the one-review and the batch paths. */
function shapeReview(review: ReviewRow, facts: ReviewFacts): CodeReviewPublic {
  const preset = isCodeReviewPreset(review.preset) ? review.preset : 'standard';
  const phase = review.phase as CodeReviewPhase;
  return {
    id: review.id,
    preset,
    phase,
    // The phases THIS cycle will walk, which is what makes the bar determinate. A
    // bar that promises five steps and then finds a sixth is worse than one that
    // admits it does not know.
    phasePlan: codeReviewPhasePlan(preset),
    runsDone: facts.runsDone,
    runsTotal: review.runsTotal,
    lensesRun: ((review.lensKeys as string[]) ?? []).slice(),
    // Lens key and name only. This is what lets a client print the skill's name
    // beside a finding instead of its key.
    customReviewers: (review.customReviewers ?? []).map((r) => ({
      lensKey: r.lensKey,
      name: r.name,
    })),
    chunkTotal: review.chunkTotal,
    headSha: review.targetHeadSha,
    headShaShort: review.targetHeadSha.slice(0, 7),
    reviewedHeadSha: review.reviewedHeadSha,
    staleForHead: Boolean(
      review.reviewedHeadSha && facts.currentHead && review.reviewedHeadSha !== facts.currentHead
    ),
    counts: facts.counts,
    // The WORKSPACE's bar, not the shipped constant. `openCount` is what the
    // tab badge, the row chip, the nav badge and the sheet header all show, so
    // applying the bar here rather than in each of them is what stops four
    // surfaces disagreeing about one number.
    openCount: openCountOf(facts.counts, facts.reportingBar),
    dismissedCount: facts.dismissedCount,
    funnel: facts.funnel,
    failureReason: review.lastError ?? null,
    // Mirrors `autoMergeState.deferredSince` field for field, so the desktop's
    // existing deferral announcement covers this with no new mechanism.
    deferredSince: facts.deferred
      ? (review.phaseStartedAt ?? review.updatedAt).toISOString()
      : null,
    fixTaskId: review.fixTaskId ?? null,
    lastFix: null,
    startedAt: review.phaseStartedAt ? review.phaseStartedAt.toISOString() : null,
    finishedAt:
      phase === 'ready' || phase === 'failed' || phase === 'cancelled' || phase === 'fixed'
        ? review.updatedAt.toISOString()
        : null,
  };
}

export async function toPublicReview(
  review: ReviewRow,
  options: { headSha?: string | null } = {}
): Promise<CodeReviewPublic> {
  const [counts, dismissedCount, funnel, runs, bars] = await Promise.all([
    severityCounts(review.id),
    countDismissed(review.id),
    funnelCounts(review.id),
    runsForCycle(review.id, review.cycle),
    reportingBarsFor([review.workspaceId]),
  ]);
  const currentHead =
    options.headSha !== undefined
      ? options.headSha
      : await getPrForReview(review.pullRequestId).then(
          (pr) => ((pr?.lastSummary ?? {}) as { headSha?: string }).headSha ?? null
        );

  return shapeReview(review, {
    counts,
    dismissedCount,
    funnel,
    reportingBar: bars.get(review.workspaceId) ?? CODE_REVIEW_REPORTING_BAR,
    runsDone: settledUnitCount(runs, review.cycle),
    deferred: hasDeferredUnit(runs, review.cycle),
    currentHead,
  });
}

/**
 * The payload for a pull request, or null when it has never been reviewed.
 *
 * Degrades to null with a warning rather than throwing, exactly as
 * `mergeQueueForPr` does: this decorates responses that are useful without it, and
 * a failure here must not turn the pull-request list into a 500.
 */
export async function codeReviewForPr(pullRequestId: string): Promise<CodeReviewPublic | null> {
  try {
    const review = await getReviewForPr(pullRequestId);
    return review ? await toPublicReview(review) : null;
  } catch (err) {
    console.warn(`[code-review] could not build the payload for ${pullRequestId}:`, err);
    return null;
  }
}

export async function publicReviewById(reviewId: string): Promise<CodeReviewPublic | null> {
  const review = await getReview(reviewId);
  return review ? toPublicReview(review) : null;
}

/**
 * The payload for many pull requests at once.
 *
 * Five queries for a whole page rather than four per row. The pull-request list is
 * the app's most-loaded endpoint, and the per-review path costs a grouped count, a
 * dismissed count and a run read each time — fine once, thirty times too much for
 * a list.
 *
 * Degrades to an empty map on failure, for the same reason `codeReviewForPr`
 * degrades to null: a review nobody can build is a missing chip, not a broken page.
 */
export async function codeReviewsForPrs(
  pullRequestIds: string[]
): Promise<Map<string, CodeReviewPublic>> {
  const out = new Map<string, CodeReviewPublic>();
  if (!pullRequestIds.length) return out;

  try {
    const db = getDbClient();
    const reviews = await db
      .select(REVIEW_COLUMNS)
      .from(prCodeReviews)
      .where(inArray(prCodeReviews.pullRequestId, pullRequestIds));
    if (!reviews.length) return out;

    const reviewIds = reviews.map((r) => r.id);

    const [countRows, settledRows, deferredRows, heads, bars] = await Promise.all([
      db
        .select({
          reviewId: prCodeReviewFindings.reviewId,
          severity: prCodeReviewFindings.severity,
          disposition: prCodeReviewFindings.disposition,
          // Grouped in here rather than fetched separately: the funnel is a
          // count over the same rows, so asking for it costs one more GROUP BY
          // column instead of another query per page.
          verdict: prCodeReviewFindings.verdict,
          count: sql<number>`cast(count(*) as int)`,
        })
        .from(prCodeReviewFindings)
        .where(inArray(prCodeReviewFindings.reviewId, reviewIds))
        .groupBy(
          prCodeReviewFindings.reviewId,
          prCodeReviewFindings.severity,
          prCodeReviewFindings.disposition,
          prCodeReviewFindings.verdict
        ),
      db
        .select({
          reviewId: prCodeReviewRuns.reviewId,
          cycle: prCodeReviewRuns.cycle,
          count: sql<number>`cast(count(*) as int)`,
        })
        .from(prCodeReviewRuns)
        .where(
          and(
            inArray(prCodeReviewRuns.reviewId, reviewIds),
            inArray(prCodeReviewRuns.status, ['succeeded', 'failed', 'cancelled', 'skipped'])
          )
        )
        .groupBy(prCodeReviewRuns.reviewId, prCodeReviewRuns.cycle),
      // Units claimed but never dispatched — the "waiting for a runner" state the
      // row shows as an amber chip. One query for the page rather than a run read
      // per review.
      db
        .selectDistinct({ reviewId: prCodeReviewRuns.reviewId, cycle: prCodeReviewRuns.cycle })
        .from(prCodeReviewRuns)
        .where(
          and(
            inArray(prCodeReviewRuns.reviewId, reviewIds),
            eq(prCodeReviewRuns.status, 'claimed'),
            isNull(prCodeReviewRuns.dispatchedAt)
          )
        ),
      db
        .select({ id: pullRequestsTable.id, lastSummary: pullRequestsTable.lastSummary })
        .from(pullRequestsTable)
        .where(inArray(pullRequestsTable.id, pullRequestIds)),
      // One query for the page, not one per review — a list usually spans one
      // workspace, and never enough to be worth a read each.
      reportingBarsFor([...new Set(reviews.map((r) => r.workspaceId))]),
    ]);

    const headById = new Map(
      heads.map((h) => [h.id, ((h.lastSummary ?? {}) as { headSha?: string }).headSha ?? null])
    );

    for (const review of reviews) {
      const counts = { ...EMPTY_CODE_REVIEW_COUNTS };
      let dismissed = 0;
      const funnel = { raised: 0, kept: 0, rejected: 0 };
      for (const row of countRows) {
        if (row.reviewId !== review.id) continue;
        // The funnel counts EVERY candidate, whatever became of it — that is the
        // whole point of it, and filtering to active dispositions below is why
        // it has to be tallied before that guard rather than after.
        funnel.raised += row.count;
        if (row.verdict === 'confirmed') funnel.kept += row.count;
        if (row.verdict === 'rejected') funnel.rejected += row.count;
        if (row.disposition === 'dismissed') dismissed += row.count;
        if (
          !ACTIVE_DISPOSITIONS.includes(row.disposition as (typeof ACTIVE_DISPOSITIONS)[number])
        ) {
          continue;
        }
        if (row.severity in counts) counts[row.severity as keyof typeof counts] += row.count;
      }

      out.set(
        review.pullRequestId,
        shapeReview(review, {
          counts,
          dismissedCount: dismissed,
          funnel,
          reportingBar: bars.get(review.workspaceId) ?? CODE_REVIEW_REPORTING_BAR,
          runsDone:
            settledRows.find((r) => r.reviewId === review.id && r.cycle === review.cycle)?.count ??
            0,
          deferred: deferredRows.some((r) => r.reviewId === review.id && r.cycle === review.cycle),
          currentHead: headById.get(review.pullRequestId) ?? null,
        })
      );
    }
    return out;
  } catch (err) {
    console.warn('[code-review] could not build the payloads for a pull-request list:', err);
    return out;
  }
}
