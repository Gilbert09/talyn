import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import {
  CODE_REVIEW_SEVERITY_ORDER,
  codeReviewDedupeKey,
  EMPTY_CODE_REVIEW_COUNTS,
  severityAtOrAbove,
  type CodeReviewCounts,
  type CodeReviewDismissReason,
  type CodeReviewSeverity,
  type RawCodeReviewFinding,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { prCodeReviewFindings } from '../../db/schema.js';

/**
 * Writing and reading findings.
 *
 * The interesting half is `upsertFindings`, which is where a re-review either
 * merges into the record the user has already triaged or destroys it. Everything
 * there is about the second cycle rather than the first.
 */

/**
 * A finding as the app lists it. Deliberately WITHOUT the big columns —
 * forty findings of body-plus-suggestion is a few hundred kilobytes, and neither
 * the PR-row decoration nor a websocket broadcast has any use for them.
 */
export const FINDING_LIST_COLUMNS = {
  id: prCodeReviewFindings.id,
  reviewId: prCodeReviewFindings.reviewId,
  severity: prCodeReviewFindings.severity,
  category: prCodeReviewFindings.category,
  lenses: prCodeReviewFindings.lenses,
  filePath: prCodeReviewFindings.filePath,
  lineStart: prCodeReviewFindings.lineStart,
  lineEnd: prCodeReviewFindings.lineEnd,
  anchorVerified: prCodeReviewFindings.anchorVerified,
  title: prCodeReviewFindings.title,
  confidence: prCodeReviewFindings.confidence,
  verdict: prCodeReviewFindings.verdict,
  disposition: prCodeReviewFindings.disposition,
  dismissedReason: prCodeReviewFindings.dismissedReason,
  firstSeenCycle: prCodeReviewFindings.firstSeenCycle,
  lastSeenCycle: prCodeReviewFindings.lastSeenCycle,
  seenCount: prCodeReviewFindings.seenCount,
  createdAt: prCodeReviewFindings.createdAt,
} as const;

export type FindingListRow = Pick<
  typeof prCodeReviewFindings.$inferSelect,
  keyof typeof FINDING_LIST_COLUMNS
>;

/** One expanded finding, or the set a fix run is about to be handed. */
export const FINDING_DETAIL_COLUMNS = {
  ...FINDING_LIST_COLUMNS,
  body: prCodeReviewFindings.body,
  suggestion: prCodeReviewFindings.suggestion,
  anchor: prCodeReviewFindings.anchor,
  verdictReason: prCodeReviewFindings.verdictReason,
  dedupeKey: prCodeReviewFindings.dedupeKey,
} as const;

export type FindingDetailRow = Pick<
  typeof prCodeReviewFindings.$inferSelect,
  keyof typeof FINDING_DETAIL_COLUMNS
>;

/** Dispositions a user is still being asked about. */
export const ACTIVE_DISPOSITIONS = ['open', 'selected'] as const;

export interface UpsertFindingsInput {
  reviewId: string;
  workspaceId: string;
  pullRequestId: string;
  cycle: number;
  headSha: string;
  runId: string;
  lens: string;
  findings: RawCodeReviewFinding[];
  /** Which anchors were found verbatim in the file at this sha. */
  verified: (finding: RawCodeReviewFinding) => boolean;
}

export interface UpsertFindingsResult {
  added: number;
  merged: number;
}

/**
 * Record one unit's findings, merging into what is already there.
 *
 * # The conflict branch is the whole design
 *
 * On a second cycle almost every finding already exists, and what happens to the
 * existing row decides whether the feature is trustworthy:
 *
 * - `seenCount` and the last-seen sha/cycle move; `firstSeen*` never does, so
 *   "this has been here for three commits" stays answerable.
 * - The severity takes the WORSE of the two. A lens that downgrades something
 *   another lens called a blocker must not quietly defuse it.
 * - The lens list is a UNION. Two lenses reaching the same finding is agreement,
 *   and recording both is what makes that visible.
 * - The verdict resets. The old judgement was about the old code.
 * - `dismissed` SURVIVES. A user who said no must not be asked again on every
 *   push, or the dismiss button means nothing — the same stickiness
 *   `reviewHiddenAt` has, for the same reason.
 * - `fixed` and `stale` do NOT survive: a finding whose key comes back goes back
 *   to `open`, which is how the app can say "this came back" instead of claiming
 *   a fix that did not hold.
 */
export async function upsertFindings(
  input: UpsertFindingsInput
): Promise<UpsertFindingsResult> {
  if (!input.findings.length) return { added: 0, merged: 0 };
  const db = getDbClient();
  let added = 0;
  let merged = 0;

  for (const finding of input.findings) {
    const anchorVerified = input.verified(finding);
    const dedupeKey = codeReviewDedupeKey({
      filePath: finding.file,
      title: finding.title,
      anchor: finding.anchor,
      anchorVerified,
    });

    const result = await db
      .insert(prCodeReviewFindings)
      .values({
        id: uuid(),
        reviewId: input.reviewId,
        workspaceId: input.workspaceId,
        pullRequestId: input.pullRequestId,
        dedupeKey,
        severity: finding.severity,
        category: finding.category,
        lenses: [input.lens],
        filePath: finding.file,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
        anchor: finding.anchor || null,
        anchorVerified,
        title: finding.title,
        body: finding.body,
        suggestion: finding.suggestion,
        confidence: finding.confidence,
        sourceRunId: input.runId,
        firstSeenHeadSha: input.headSha,
        lastSeenHeadSha: input.headSha,
        firstSeenCycle: input.cycle,
        lastSeenCycle: input.cycle,
      })
      .onConflictDoUpdate({
        target: [prCodeReviewFindings.reviewId, prCodeReviewFindings.dedupeKey],
        set: {
          lastSeenHeadSha: input.headSha,
          lastSeenCycle: input.cycle,
          seenCount: sql`${prCodeReviewFindings.seenCount} + 1`,
          // The WORSE of the two severities wins, by the order's index.
          severity: sql`CASE WHEN ${severityRank(prCodeReviewFindings.severity)} <= ${CODE_REVIEW_SEVERITY_ORDER.indexOf(finding.severity)} THEN ${prCodeReviewFindings.severity} ELSE ${finding.severity} END`,
          // Union, so agreement accumulates rather than the last writer winning.
          lenses: sql`(
            SELECT COALESCE(jsonb_agg(DISTINCT value), '[]'::jsonb)
            FROM jsonb_array_elements(${prCodeReviewFindings.lenses} || ${JSON.stringify([input.lens])}::jsonb) AS value
          )`,
          lineStart: finding.lineStart,
          lineEnd: finding.lineEnd,
          body: finding.body,
          suggestion: finding.suggestion,
          confidence: finding.confidence,
          // The old verdict was about the old code.
          verdict: 'unvalidated',
          verdictReason: null,
          // `dismissed` and `discarded` are sticky; anything else comes back to
          // `open` when its key reappears.
          disposition: sql`CASE WHEN ${prCodeReviewFindings.disposition} IN ('dismissed','discarded') THEN ${prCodeReviewFindings.disposition} ELSE 'open' END`,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: prCodeReviewFindings.id,
        seenCount: prCodeReviewFindings.seenCount,
      });

    const row = result[0];
    if (row && row.seenCount > 1) merged += 1;
    else added += 1;
  }

  return { added, merged };
}

/** Drizzle cannot index a readonly tuple in SQL, so rank in SQL instead. */
function severityRank(column: typeof prCodeReviewFindings.severity) {
  return sql`CASE ${column} WHEN 'blocker' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END`;
}

/**
 * Everything not seen this cycle goes stale.
 *
 * Not deleted: the user may want to know a finding went away, and deleting
 * destroys the record of what the review used to say. A dismissal is left alone —
 * it was already answered — and so is a `fixed` finding, which the next cycle
 * either confirms by silence or contradicts by bringing the key back.
 */
export async function markStale(reviewId: string, cycle: number): Promise<number> {
  const updated = await getDbClient()
    .update(prCodeReviewFindings)
    .set({ disposition: 'stale', updatedAt: new Date() })
    .where(
      and(
        eq(prCodeReviewFindings.reviewId, reviewId),
        inArray(prCodeReviewFindings.disposition, [...ACTIVE_DISPOSITIONS]),
        sql`${prCodeReviewFindings.lastSeenCycle} < ${cycle}`
      )
    )
    .returning({ id: prCodeReviewFindings.id });
  return updated.length;
}

/**
 * Discard everything on record — the explicit reset.
 *
 * For a branch force-pushed into something unrelated, where carrying findings
 * forward would be nonsense. Never inferred: the obvious signal (the new head's
 * merge-base with the reviewed sha not being that sha) is also true of every
 * ordinary rebase, so auto-detecting it would throw away the user's dismissals
 * routinely. The user asks for this.
 */
export async function discardFindings(reviewId: string): Promise<number> {
  const updated = await getDbClient()
    .update(prCodeReviewFindings)
    .set({ disposition: 'discarded', updatedAt: new Date() })
    .where(
      and(
        eq(prCodeReviewFindings.reviewId, reviewId),
        sql`${prCodeReviewFindings.disposition} <> 'discarded'`
      )
    )
    .returning({ id: prCodeReviewFindings.id });
  return updated.length;
}

export async function listFindings(
  reviewId: string,
  options: { includeInactive?: boolean } = {}
): Promise<FindingListRow[]> {
  const where = options.includeInactive
    ? eq(prCodeReviewFindings.reviewId, reviewId)
    : and(
        eq(prCodeReviewFindings.reviewId, reviewId),
        inArray(prCodeReviewFindings.disposition, [...ACTIVE_DISPOSITIONS])
      );
  return getDbClient()
    .select(FINDING_LIST_COLUMNS)
    .from(prCodeReviewFindings)
    .where(where)
    .orderBy(asc(severityRank(prCodeReviewFindings.severity)), desc(prCodeReviewFindings.createdAt));
}

export async function getFinding(findingId: string): Promise<FindingDetailRow | null> {
  const rows = await getDbClient()
    .select(FINDING_DETAIL_COLUMNS)
    .from(prCodeReviewFindings)
    .where(eq(prCodeReviewFindings.id, findingId))
    .limit(1);
  return rows[0] ?? null;
}

/** The selected findings, with their bodies — what a fix prompt is built from. */
export async function findingsForFix(
  reviewId: string,
  findingIds: string[]
): Promise<FindingDetailRow[]> {
  if (!findingIds.length) return [];
  return getDbClient()
    .select(FINDING_DETAIL_COLUMNS)
    .from(prCodeReviewFindings)
    .where(
      and(
        eq(prCodeReviewFindings.reviewId, reviewId),
        inArray(prCodeReviewFindings.id, findingIds),
        inArray(prCodeReviewFindings.disposition, [...ACTIVE_DISPOSITIONS])
      )
    )
    .orderBy(asc(severityRank(prCodeReviewFindings.severity)));
}

/**
 * The candidates the judging pass reads: everything this cycle produced that
 * nobody has ruled on yet.
 */
export async function findingsForJudging(
  reviewId: string,
  cycle: number
): Promise<FindingDetailRow[]> {
  return getDbClient()
    .select(FINDING_DETAIL_COLUMNS)
    .from(prCodeReviewFindings)
    .where(
      and(
        eq(prCodeReviewFindings.reviewId, reviewId),
        eq(prCodeReviewFindings.lastSeenCycle, cycle),
        inArray(prCodeReviewFindings.disposition, [...ACTIVE_DISPOSITIONS])
      )
    )
    .orderBy(asc(severityRank(prCodeReviewFindings.severity)));
}

/**
 * Apply a judging pass's verdict.
 *
 * The keeps are named; everything else this cycle produced is `rejected`. That
 * polarity is deliberate — the judge emits what survives, so a judge that fails
 * to mention a candidate has dropped it, and a judge whose output we could not
 * parse at all leaves every candidate `unvalidated` rather than silently
 * rejecting the lot.
 */
export async function applyJudgement(
  reviewId: string,
  cycle: number,
  keptKeys: string[],
  runId: string,
  /**
   * Why the judge dropped each candidate, keyed by dedupe key — which is exactly
   * the `id` the judge prompt hands it, so no mapping is needed.
   *
   * Optional because a judge on an older prompt will not send any, and a missing
   * reason must degrade to "rejected, reason unrecorded" rather than to a failed
   * judging pass.
   */
  droppedReasons: ReadonlyMap<string, string> = new Map()
): Promise<{ confirmed: number; rejected: number }> {
  const db = getDbClient();
  const confirmed = keptKeys.length
    ? await db
        .update(prCodeReviewFindings)
        .set({ verdict: 'confirmed', validatedByRunId: runId, updatedAt: new Date() })
        .where(
          and(
            eq(prCodeReviewFindings.reviewId, reviewId),
            eq(prCodeReviewFindings.lastSeenCycle, cycle),
            inArray(prCodeReviewFindings.dedupeKey, keptKeys)
          )
        )
        .returning({ id: prCodeReviewFindings.id })
    : [];

  const rejected = await db
    .update(prCodeReviewFindings)
    .set({
      verdict: 'rejected',
      validatedByRunId: runId,
      // A rejected candidate is not shown and not counted, but it is kept: it is
      // the evidence for "is the judge too strict", which is the first question
      // anybody will ask about finding quality.
      disposition: 'stale',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(prCodeReviewFindings.reviewId, reviewId),
        eq(prCodeReviewFindings.lastSeenCycle, cycle),
        eq(prCodeReviewFindings.verdict, 'unvalidated'),
        inArray(prCodeReviewFindings.disposition, [...ACTIVE_DISPOSITIONS])
      )
    )
    .returning({ id: prCodeReviewFindings.id });


  // Written per key rather than in the bulk update because the reason differs per
  // row. N is small — a cycle is capped at 40 findings and the judge only reports
  // on what it dropped — and the alternative is a CASE expression nobody can read.
  for (const [key, reason] of droppedReasons) {
    if (!reason) continue;
    await db
      .update(prCodeReviewFindings)
      .set({ verdictReason: reason.slice(0, 2000) })
      .where(
        and(
          eq(prCodeReviewFindings.reviewId, reviewId),
          eq(prCodeReviewFindings.lastSeenCycle, cycle),
          eq(prCodeReviewFindings.dedupeKey, key),
          eq(prCodeReviewFindings.verdict, 'rejected')
        )
      );
  }

  return { confirmed: confirmed.length, rejected: rejected.length };
}

export async function setDisposition(
  findingId: string,
  disposition: 'open' | 'selected' | 'dismissed',
  options: { reason?: CodeReviewDismissReason | null; userId?: string | null } = {}
): Promise<void> {
  await getDbClient()
    .update(prCodeReviewFindings)
    .set({
      disposition,
      dismissedReason: disposition === 'dismissed' ? (options.reason ?? null) : null,
      dispositionAt: new Date(),
      dispositionBy: options.userId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(prCodeReviewFindings.id, findingId));
}

/** Mark the selected findings provisionally fixed when a fix run completes. */
export async function markFixed(
  reviewId: string,
  findingIds: string[],
  taskId: string
): Promise<number> {
  if (!findingIds.length) return 0;
  const updated = await getDbClient()
    .update(prCodeReviewFindings)
    .set({
      disposition: 'fixed',
      fixTaskId: taskId,
      fixedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(prCodeReviewFindings.reviewId, reviewId),
        inArray(prCodeReviewFindings.id, findingIds)
      )
    )
    .returning({ id: prCodeReviewFindings.id });
  return updated.length;
}

/** Put them back when a fix run did not land, so nothing claims a fix it lacks. */
export async function unmarkFixed(reviewId: string, taskId: string): Promise<number> {
  const updated = await getDbClient()
    .update(prCodeReviewFindings)
    .set({ disposition: 'open', fixTaskId: null, fixedAt: null, updatedAt: new Date() })
    .where(
      and(eq(prCodeReviewFindings.reviewId, reviewId), eq(prCodeReviewFindings.fixTaskId, taskId))
    )
    .returning({ id: prCodeReviewFindings.id });
  return updated.length;
}

/**
 * Severity counts, computed rather than stored.
 *
 * `loops/store.ts` has the rule: a stored count drifts the first time a write
 * path forgets to bump it. One grouped count over the open-findings partial index
 * answers this, and the PR list does it once per page rather than per row.
 */
export async function severityCounts(reviewId: string): Promise<CodeReviewCounts> {
  const rows = await getDbClient()
    .select({
      severity: prCodeReviewFindings.severity,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(prCodeReviewFindings)
    .where(
      and(
        eq(prCodeReviewFindings.reviewId, reviewId),
        inArray(prCodeReviewFindings.disposition, [...ACTIVE_DISPOSITIONS])
      )
    )
    .groupBy(prCodeReviewFindings.severity);

  const counts: CodeReviewCounts = { ...EMPTY_CODE_REVIEW_COUNTS };
  for (const row of rows) {
    if (row.severity in counts) counts[row.severity as CodeReviewSeverity] = row.count;
  }
  return counts;
}

/**
 * What became of every candidate this review raised.
 *
 * Counts ALL of them regardless of disposition — a rejected finding is the
 * interesting half. The ratio is the most informative single fact about a
 * review's quality: on the first real one the judging pass kept one of six, and
 * without saying so a short list is indistinguishable from a shallow review.
 */
export async function funnelCounts(
  reviewId: string
): Promise<{ raised: number; kept: number; rejected: number }> {
  const rows = await getDbClient()
    .select({
      verdict: prCodeReviewFindings.verdict,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(prCodeReviewFindings)
    .where(eq(prCodeReviewFindings.reviewId, reviewId))
    .groupBy(prCodeReviewFindings.verdict);

  const funnel = { raised: 0, kept: 0, rejected: 0 };
  for (const row of rows) {
    funnel.raised += row.count;
    if (row.verdict === 'confirmed') funnel.kept += row.count;
    if (row.verdict === 'rejected') funnel.rejected += row.count;
  }
  return funnel;
}

export async function countDismissed(reviewId: string): Promise<number> {
  const rows = await getDbClient()
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(prCodeReviewFindings)
    .where(
      and(
        eq(prCodeReviewFindings.reviewId, reviewId),
        eq(prCodeReviewFindings.disposition, 'dismissed')
      )
    );
  return rows[0]?.count ?? 0;
}

/**
 * Whether an unresolved blocker stands in this review's way.
 *
 * What the merge queue parks on, and the conditions are deliberately narrow:
 * the finding must be a blocker, must have survived judging, and must still be
 * open. A candidate the judge rejected, or one the user dismissed, holds nothing
 * up — otherwise a single wrong finding could wedge a merge with no way out but
 * a database edit.
 */
export async function hasOpenBlocker(reviewId: string): Promise<boolean> {
  const rows = await getDbClient()
    .select({ id: prCodeReviewFindings.id })
    .from(prCodeReviewFindings)
    .where(
      and(
        eq(prCodeReviewFindings.reviewId, reviewId),
        eq(prCodeReviewFindings.severity, 'blocker'),
        eq(prCodeReviewFindings.verdict, 'confirmed'),
        inArray(prCodeReviewFindings.disposition, [...ACTIVE_DISPOSITIONS])
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** How many findings are at or above the app's reporting bar. */
export function openCountOf(counts: CodeReviewCounts, threshold: CodeReviewSeverity): number {
  return CODE_REVIEW_SEVERITY_ORDER.filter((s) => severityAtOrAbove(s, threshold)).reduce(
    (sum, s) => sum + counts[s],
    0
  );
}
