import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  codeReviewPhasePlan,
  CODE_REVIEW_REPORTING_BAR,
  EMPTY_CODE_REVIEW_COUNTS,
  isCodeReviewPreset,
  type CodeReviewCounts,
  type CodeReviewPhase,
  type CodeReviewPublic,
  type CodeReviewSession,
  type CodeReviewSessionReport,
  type CodeReviewSeverity,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  prCodeReviewEvents,
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
import { deferredSinceOf, hasDeferredUnit, settledUnitCount } from './decide.js';
import { owningWorkbenchesForPrs } from '../workbenches/prSessions.js';
import { SESSION_REPORT_SENT } from './sessionReport.js';

/** The event code of a cycle's plan, which records the lenses it skipped. */
export const CYCLE_PLANNED = 'cycle_planned';

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
  /** When the longest wait for a runner began, when a unit records it. */
  deferredSince: Date | null;
  currentHead: string | null;
  /** The session that owns the pull request, resolved now rather than stored. */
  session: CodeReviewSession | null;
  /** The report-back of the review's current cycle, if one went. */
  sessionReport: CodeReviewSessionReport | null;
  /** How many of Talyn's lenses this cycle's plan skipped. */
  lensesNotNeeded: number;
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
    lensesNotNeeded: facts.lensesNotNeeded,
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
      ? (facts.deferredSince ?? review.phaseStartedAt ?? review.updatedAt).toISOString()
      : null,
    fixTaskId: review.fixTaskId ?? null,
    lastFix: null,
    startedAt: review.phaseStartedAt ? review.phaseStartedAt.toISOString() : null,
    finishedAt:
      phase === 'ready' || phase === 'failed' || phase === 'cancelled' || phase === 'fixed'
        ? review.updatedAt.toISOString()
        : null,
    session: facts.session,
    sessionReport: facts.sessionReport,
  };
}

/**
 * How many of Talyn's lenses each review's current cycle skipped, in one query.
 *
 * Read from the cycle's own plan, not from today's preset: a preset that grows
 * a lens must not make every older review say that a lens sat out. A cycle
 * that is not planned yet has skipped nothing. Degrades to an empty map.
 */
export async function lensesNotNeededFor(
  reviews: Pick<ReviewRow, 'id' | 'cycle' | 'phase'>[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const planned = reviews.filter((r) => !CODE_REVIEW_UNPLANNED_PHASES.has(r.phase));
  if (!planned.length) return out;
  const cycleOf = new Map(planned.map((r) => [r.id, r.cycle]));
  try {
    const rows = await getDbClient()
      .select({ reviewId: prCodeReviewEvents.reviewId, detail: prCodeReviewEvents.detail })
      .from(prCodeReviewEvents)
      .where(
        and(
          inArray(prCodeReviewEvents.reviewId, [...cycleOf.keys()]),
          eq(prCodeReviewEvents.code, CYCLE_PLANNED)
        )
      )
      .orderBy(desc(prCodeReviewEvents.at));
    for (const row of rows) {
      if (out.has(row.reviewId)) continue;
      const detail = (row.detail ?? {}) as { cycle?: unknown; skippedLenses?: unknown };
      // An older plan has no cycle, and the latest plan is the current cycle's.
      if (detail.cycle !== undefined && Number(detail.cycle) !== cycleOf.get(row.reviewId)) {
        out.set(row.reviewId, 0);
        continue;
      }
      out.set(row.reviewId, Array.isArray(detail.skippedLenses) ? detail.skippedLenses.length : 0);
    }
  } catch (err) {
    console.warn('[code-review] could not read the cycle plans:', err);
  }
  return out;
}

/** A cycle in these phases has not chosen its lenses yet. */
const CODE_REVIEW_UNPLANNED_PHASES: ReadonlySet<string> = new Set(['idle', 'queued', 'preparing']);

/**
 * The report-back of each review's current cycle, in one query. An older
 * cycle's report is not shown: its findings are not the ones on screen.
 * Degrades to an empty map, like the session lookup.
 */
export async function sessionReportsFor(
  reviews: Pick<ReviewRow, 'id' | 'cycle'>[]
): Promise<Map<string, CodeReviewSessionReport>> {
  const out = new Map<string, CodeReviewSessionReport>();
  if (!reviews.length) return out;
  const cycleOf = new Map(reviews.map((r) => [r.id, r.cycle]));
  try {
    const rows = await getDbClient()
      .select({ reviewId: prCodeReviewEvents.reviewId, at: prCodeReviewEvents.at, detail: prCodeReviewEvents.detail })
      .from(prCodeReviewEvents)
      .where(
        and(
          inArray(prCodeReviewEvents.reviewId, [...cycleOf.keys()]),
          eq(prCodeReviewEvents.code, SESSION_REPORT_SENT)
        )
      )
      .orderBy(desc(prCodeReviewEvents.at));
    for (const row of rows) {
      const detail = (row.detail ?? {}) as { cycle?: unknown; workbenchId?: unknown; findingIds?: unknown };
      if (out.has(row.reviewId) || Number(detail.cycle) !== cycleOf.get(row.reviewId)) continue;
      if (typeof detail.workbenchId !== 'string') continue;
      out.set(row.reviewId, {
        workbenchId: detail.workbenchId,
        sentAt: row.at.toISOString(),
        findingCount: Array.isArray(detail.findingIds) ? detail.findingIds.length : 0,
      });
    }
  } catch (err) {
    console.warn('[code-review] could not read the session reports:', err);
  }
  return out;
}

export async function toPublicReview(
  review: ReviewRow,
  options: { headSha?: string | null } = {}
): Promise<CodeReviewPublic> {
  const [counts, dismissedCount, funnel, runs, bars, sessions, reports, notNeeded] = await Promise.all([
    severityCounts(review.id),
    countDismissed(review.id),
    funnelCounts(review.id),
    runsForCycle(review.id, review.cycle),
    reportingBarsFor([review.workspaceId]),
    owningWorkbenchesForPrs(review.workspaceId, [review.pullRequestId]),
    sessionReportsFor([review]),
    lensesNotNeededFor([review]),
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
    deferredSince: deferredSinceOf(runs, review.cycle),
    currentHead,
    session: sessions.get(review.pullRequestId) ?? null,
    sessionReport: reports.get(review.id) ?? null,
    lensesNotNeeded: notNeeded.get(review.id) ?? 0,
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

    const workspaceIds = [...new Set(reviews.map((r) => r.workspaceId))];
    const [countRows, settledRows, deferredRows, heads, bars, sessions, reports, notNeeded] = await Promise.all([
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
        .select({
          reviewId: prCodeReviewRuns.reviewId,
          cycle: prCodeReviewRuns.cycle,
          since: sql<Date | string | null>`min(${prCodeReviewRuns.capacityWaitSince})`,
        })
        .from(prCodeReviewRuns)
        .where(
          and(
            inArray(prCodeReviewRuns.reviewId, reviewIds),
            eq(prCodeReviewRuns.status, 'claimed'),
            isNull(prCodeReviewRuns.dispatchedAt)
          )
        )
        .groupBy(prCodeReviewRuns.reviewId, prCodeReviewRuns.cycle),
      db
        .select({ id: pullRequestsTable.id, lastSummary: pullRequestsTable.lastSummary })
        .from(pullRequestsTable)
        .where(inArray(pullRequestsTable.id, pullRequestIds)),
      // One query for the page, not one per review — a list usually spans one
      // workspace, and never enough to be worth a read each.
      reportingBarsFor(workspaceIds),
      // One query for the page. It degrades to no links rather than failing.
      owningWorkbenchesForPrs(workspaceIds, pullRequestIds),
      sessionReportsFor(reviews),
      lensesNotNeededFor(reviews),
    ]);

    const headById = new Map(
      heads.map((h) => [h.id, ((h.lastSummary ?? {}) as { headSha?: string }).headSha ?? null])
    );

    const deferredRow = (review: ReviewRow) =>
      deferredRows.find((r) => r.reviewId === review.id && r.cycle === review.cycle);

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
          deferred: Boolean(deferredRow(review)),
          deferredSince: toDate(deferredRow(review)?.since),
          currentHead: headById.get(review.pullRequestId) ?? null,
          session: sessions.get(review.pullRequestId) ?? null,
          sessionReport: reports.get(review.id) ?? null,
          lensesNotNeeded: notNeeded.get(review.id) ?? 0,
        })
      );
    }
    return out;
  } catch (err) {
    console.warn('[code-review] could not build the payloads for a pull-request list:', err);
    return out;
  }
}

/** A raw `min(timestamptz)`: a Date from some drivers, a string from others. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
