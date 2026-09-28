import { and, asc, eq } from 'drizzle-orm';
import {
  CODE_REVIEW_PHASE_AT_REST,
  CODE_REVIEW_REPORTING_BAR,
  severityAtOrAbove,
  type CodeReviewPhase,
  type CodeReviewPromptFinding,
  type CodeReviewSeverity,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { prCodeReviewFindings } from '../../db/schema.js';
import { FINDING_DETAIL_COLUMNS, severityRank } from './findings.js';
import { getReviewForPr } from './store.js';
import { reportingBarsFor } from './workspaceSettings.js';

/**
 * The review findings an ordinary "fix this pull request" run should be told
 * about.
 *
 * Read from ONE place so the PR panel's Fix button, the merge queue's remediation
 * run and the auto-keep watcher cannot disagree about which findings count — they
 * all dispatch through `startPrMergeableRun`, which calls this.
 *
 * # The bar, and why each part of it is here
 *
 * - **Only a review at rest.** A cycle still running has findings nobody has
 *   judged yet, and handing an agent a candidate the judge is about to throw out
 *   is how the pipeline's whole precision argument gets spent on a commit.
 * - **Only the current head.** This is the same rule the merge queue's park
 *   follows, for a sharper reason here: a finding names a file and a line, and an
 *   agent sent to fix one on a commit that has moved will edit whatever now
 *   occupies those lines. Silence is the correct answer when the review is
 *   behind — the run still does its own job, and the app is already telling the
 *   user their review is stale.
 * - **Only judge-confirmed.** `hasOpenBlocker`'s rule, and the reason is the
 *   same: a candidate the judging pass rejected must not be able to make an agent
 *   change working code.
 * - **Only at or above the workspace's reporting bar.** The user is not being
 *   shown the nitpicks, so a fix run must not quietly act on them. Whatever the
 *   list says is what the agent gets.
 *
 * Returns an empty list — never null, never a throw — whenever any of that fails.
 * This decorates a dispatch that must happen either way, so it cannot be a reason
 * the fix does not start.
 */
export async function findingsForMergeableRun(
  pullRequestId: string,
  currentHeadSha: string | null | undefined
): Promise<{ headShaShort: string | null; findings: CodeReviewPromptFinding[] } | undefined> {
  if (!currentHeadSha) return undefined;

  const review = await getReviewForPr(pullRequestId);
  if (!review) return undefined;
  if (!CODE_REVIEW_PHASE_AT_REST[review.phase as CodeReviewPhase]) return undefined;
  if (!review.reviewedHeadSha || review.reviewedHeadSha !== currentHeadSha) return undefined;

  const bars = await reportingBarsFor([review.workspaceId]);
  const bar = bars.get(review.workspaceId) ?? CODE_REVIEW_REPORTING_BAR;

  const rows = await getDbClient()
    .select(FINDING_DETAIL_COLUMNS)
    .from(prCodeReviewFindings)
    .where(
      and(
        eq(prCodeReviewFindings.reviewId, review.id),
        eq(prCodeReviewFindings.verdict, 'confirmed'),
        // `open` only, NOT `ACTIVE_DISPOSITIONS`: a `selected` finding is already
        // in flight on its own fix task, and `activePrTaskId` means this run and
        // that one cannot both exist — so if we can see a `selected` finding here
        // it belongs to a task that is gone, and the settle path will put it back
        // to `open`. Waiting for that is better than two prompts claiming it.
        eq(prCodeReviewFindings.disposition, 'open')
      )
    )
    .orderBy(asc(severityRank(prCodeReviewFindings.severity)));

  const findings = rows
    .filter((row) => severityAtOrAbove(row.severity as CodeReviewSeverity, bar))
    .map((row) => ({
      severity: row.severity as CodeReviewSeverity,
      filePath: row.filePath,
      lineStart: row.lineStart,
      lineEnd: row.lineEnd,
      title: row.title,
      body: row.body,
      suggestion: row.suggestion,
    }));

  if (!findings.length) return undefined;
  return { headShaShort: review.reviewedHeadSha.slice(0, 7), findings };
}
