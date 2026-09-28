import { and, eq, inArray } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable } from '../../db/schema.js';
import {
  buildReviewFixPrompt,
  type CodeReviewPhase,
  type CodeReviewSeverity,
} from '@talyn/shared';
import { captureWorkspaceEvent } from '../analytics.js';
import { captureFixSettled } from './analytics.js';
import { TaskLimitError } from '../billing/entitlements.js';
import { createCloudTask } from '../taskCreate.js';
import { githubService } from '../github.js';
import { resolveCloudEnv } from '../prCloudFix.js';
import { workspacePromptTemplate } from '../promptTemplates.js';
import { workspaceMayUseCodeReview } from '../codeReviewAccess.js';
import {
  findingsForFix,
  markFixed,
  markSelectedForFix,
  unmarkFixed,
} from './findings.js';
import { scheduleReviewEvaluation } from './evaluator.js';
import { onQueueMembershipChanged } from '../mergeQueue/triggers.js';
import { appendReviewEvent, casTransition, getPrForReview, type ReviewRow } from './store.js';
import { workspaceReviewSettings } from './cycle.js';

/**
 * Fixing the findings a user ticked.
 *
 * # Why this IS an ordinary task
 *
 * Everything else in this service exists because a review's units cannot be tasks.
 * The fix run is the opposite: it SHOULD be one, and being one is what makes it
 * safe. An ordinary `pr_response` task inherits `activePrTaskId`, which means a
 * review fix and a merge-queue fix share the one row a pull request is allowed —
 * so the two cannot both be pushing to the same branch at the same time. That
 * collision is exactly what those guards were written for.
 *
 * It also means the run appears in the Tasks list with a transcript, which is what
 * a user wants from something that just changed their branch.
 *
 * # The three-phase claim
 *
 * A direct port of the merge queue's `fireFixRun`, and the shape is the point:
 * claim first so a losing race creates no task, create second, link third so a
 * lost link can cancel the task it just made. A crash between the first and second
 * leaves the review `fixing` with no task id, which the reconciler re-fires.
 */

export type FixOutcome =
  | { ok: true; taskId: string }
  | { ok: false; code: 'not_available' | 'nothing_selected' | 'busy' | 'no_provider' | 'deferred'; message: string };

export async function startFixRun(
  review: ReviewRow,
  findingIds: string[],
  userId: string | null
): Promise<FixOutcome> {
  if (!findingIds.length) {
    return { ok: false, code: 'nothing_selected', message: 'Pick at least one finding to fix.' };
  }
  if (!(await workspaceMayUseCodeReview(review.workspaceId))) {
    return {
      ok: false,
      code: 'not_available',
      message: 'Code review is not available for this workspace.',
    };
  }

  const findings = await findingsForFix(review.id, findingIds);
  if (!findings.length) {
    return {
      ok: false,
      code: 'nothing_selected',
      message: 'Those findings are no longer open — refresh the review.',
    };
  }

  const pr = await getPrForReview(review.pullRequestId);
  if (!pr) {
    return { ok: false, code: 'busy', message: 'That pull request is not tracked any more.' };
  }

  const target = await resolveCloudEnv(review.workspaceId);
  if (!target) {
    return {
      ok: false,
      code: 'no_provider',
      message: 'No agent is connected for this workspace, so there is nothing to fix with.',
    };
  }

  // PHASE ONE: claim. Whoever wins this CAS owns the dispatch; a concurrent
  // evaluation loses here and creates no task at all.
  const claimed = await casTransition(
    review.id,
    review.version,
    { phase: 'fixing', phaseStartedAt: new Date(), fixStartedAt: new Date(), fixTaskId: null },
    {
      fromPhase: review.phase as CodeReviewPhase,
      toPhase: 'fixing',
      trigger: 'user:fix',
      code: 'fix_claimed',
      message: `Fixing ${findings.length} finding(s).`,
      detail: { findingIds: findings.map((f) => f.id), userId },
    }
  );
  if (!claimed) {
    return { ok: false, code: 'busy', message: 'The review changed while the fix was starting.' };
  }

  const summary = (pr.lastSummary ?? {}) as {
    title?: string;
    headBranch?: string;
    baseBranch?: string;
  };
  const settings = await workspaceReviewSettings(review.workspaceId);
  const template = await workspacePromptTemplate(review.workspaceId, 'review_fix');

  const prompt = buildReviewFixPrompt({
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    pr: {
      url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
      title: summary.title ?? '',
      headBranch: summary.headBranch ?? '',
      baseBranch: summary.baseBranch ?? '',
    },
    findings: findings.map((f) => ({
      severity: f.severity as CodeReviewSeverity,
      filePath: f.filePath,
      lineStart: f.lineStart,
      lineEnd: f.lineEnd,
      title: f.title,
      body: f.body,
      suggestion: f.suggestion,
    })),
    summaryComment: settings.fixSummaryComment,
    provider: target.provider,
    template,
  });

  // PHASE TWO: create.
  let task;
  try {
    task = await createCloudTask({
      workspaceId: review.workspaceId,
      type: 'pr_response',
      title: `Fix ${findings.length} review finding(s) on ${pr.owner}/${pr.repo}#${pr.number}`,
      description: `Code review fix for ${pr.owner}/${pr.repo}#${pr.number}`,
      prompt,
      repositoryId: review.repositoryId,
      assignedEnvironmentId: target.envId,
      pullRequestId: review.pullRequestId,
      codeReview: {
        reviewId: review.id,
        cycle: review.cycle,
        findingIds: findings.map((f) => f.id),
      },
    });
  } catch (err) {
    if (err instanceof TaskLimitError) {
      // The plan's TASK cap, not its review cap — the user is allowed this cycle
      // and simply has no machine slot for it yet. Rolled back to `ready` so the
      // findings stay actionable, reported as a visible wait rather than a
      // refusal, and retried when a task finishes. Exactly what the merge queue
      // does with the same collision.
      await rollBackToReady(review, 'deferred_task_limit', 'Waiting for a task slot.');
      void captureWorkspaceEvent(review.workspaceId, 'paywall_deferred', {
        source: 'code_review',
        gate: 'task_limit',
        limit: err.limit,
        active: err.active,
      });
      return {
        ok: false,
        code: 'deferred',
        message:
          'Your other tasks are using every slot on the free plan. This fix will start when one finishes.',
      };
    }
    await rollBackToReady(review, 'fix_failed', err instanceof Error ? err.message : String(err));
    throw err;
  }

  // PHASE THREE: link. A lost link means somebody else moved the review, and the
  // task we just made has nobody to report to — so it is cancelled rather than
  // left to push commits nothing is watching.
  const linked = await casTransition(
    review.id,
    review.version + 1,
    { fixTaskId: task.id },
    {
      fromPhase: 'fixing',
      toPhase: 'fixing',
      trigger: 'user:fix',
      code: 'fix_fired',
      message: 'Fix run started.',
      detail: { taskId: task.id },
    }
  );
  if (!linked) {
    await cancelUndispatchedTask(task.id);
    return { ok: false, code: 'busy', message: 'The review changed while the fix was starting.' };
  }

  // Only AFTER the link, so a fix that lost the race leaves no finding claiming
  // to be worked on by a task that was just cancelled. Best-effort: the run is
  // already going, and failing here would report a started fix as a failure.
  await markSelectedForFix(
    review.id,
    findings.map((f) => f.id),
    task.id
  ).catch((err) => {
    console.warn(`[code-review] marking findings in flight for ${review.id} failed:`, err);
    return 0;
  });

  return { ok: true, taskId: task.id };
}

/**
 * The fix task reached a terminal status.
 *
 * Settled from the `task:status` domain event, with the reconciler as the backstop
 * — a task that completes during a deploy would otherwise leave the review
 * `fixing` for ever, which is the failure Loops needed its settle sweep for.
 *
 * A completed fix marks its findings `fixed`, and that is PROVISIONAL on purpose.
 * The push makes a new commit, the next cycle reads it, and a finding whose key
 * comes back flips to `open` again — so the app can say "this came back" rather
 * than carrying a fix that did not hold.
 */
export async function settleFixRun(
  review: ReviewRow,
  taskId: string,
  status: string
): Promise<void> {
  const findingIds = await fixFindingIds(review, taskId);
  void captureFixSettled(review, status, findingIds.length);

  if (status === 'completed') {
    const pushed = await pushedCommit(review);
    const fixed = await markFixed(review.id, findingIds, taskId, pushed);
    await casTransition(
      review.id,
      review.version,
      { phase: 'fixed', phaseStartedAt: new Date() },
      {
        fromPhase: 'fixing',
        toPhase: 'fixed',
        trigger: 'task:terminal',
        code: 'fix_landed',
        message: `${fixed} finding(s) marked fixed, pending the next review.`,
        detail: { taskId, fixed, headSha: pushed },
      }
    );
    scheduleReviewEvaluation(review.id, 'task:terminal');
    // A landed fix is the other way a parked merge-queue entry gets released.
    void onQueueMembershipChanged(review.pullRequestId, 'code_review:fixed');
    return;
  }

  // Failed, cancelled, or standing down for a person. Nothing was proven fixed,
  // so nothing is marked fixed — the findings go back on the list.
  await unmarkFixed(review.id, taskId);
  await rollBackToReady(
    review,
    status === 'needs_human' ? 'fix_needs_human' : 'fix_failed',
    status === 'needs_human'
      ? 'The fix run stopped and needs a person.'
      : 'The fix run did not land. The findings are still here.'
  );
  scheduleReviewEvaluation(review.id, 'task:terminal');
}

/**
 * The commit the fix run pushed, or null.
 *
 * Read from GitHub rather than from the cached summary, because the push and the
 * task's completion reach Talyn by different routes — the webhook that moves
 * `last_summary.headSha` routinely has not landed yet when the task reports
 * done, so the cached head is still the one the review read.
 *
 * Answers null on three different "we cannot name a commit" cases, and they are
 * deliberately the same answer: the head is unchanged (the run completed without
 * pushing), GitHub would not say, or the pull request has gone. A wrong sha here
 * is a link to somebody else's commit presented as the fix for a finding, which
 * is the `findPullRequestUrl` failure in a smaller frame.
 */
async function pushedCommit(review: ReviewRow): Promise<string | null> {
  try {
    const pr = await getPrForReview(review.pullRequestId);
    if (!pr) return null;
    const fresh = await githubService.getPullRequest(
      review.workspaceId,
      pr.owner,
      pr.repo,
      pr.number
    );
    const head = fresh.head?.sha ?? null;
    return head && head !== review.reviewedHeadSha ? head : null;
  } catch (err) {
    console.warn(`[code-review] reading the fix commit for ${review.id} failed:`, err);
    return null;
  }
}

async function fixFindingIds(review: ReviewRow, taskId: string): Promise<string[]> {
  const rows = await getDbClient()
    .select({ metadata: tasksTable.metadata })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const link = (rows[0]?.metadata as { codeReview?: { cycle?: number; findingIds?: unknown } } | null)
    ?.codeReview;
  // The cycle guard matters: a reused task row carries the link to the run
  // happening now, and a stale one must not settle findings from a later cycle.
  if (!link || link.cycle !== review.cycle) return [];
  return Array.isArray(link.findingIds) ? link.findingIds.filter((id): id is string => typeof id === 'string') : [];
}

async function rollBackToReady(
  review: ReviewRow,
  code: string,
  message: string
): Promise<void> {
  const moved = await casTransition(
    review.id,
    review.version + 1,
    { phase: 'ready', phaseStartedAt: new Date(), fixTaskId: null, lastError: message, lastErrorAt: new Date() },
    { fromPhase: 'fixing', toPhase: 'ready', trigger: 'executor', code, message }
  );
  if (!moved) {
    // The version moved under us; record what happened anyway so the timeline is
    // not silent about a fix that did not start.
    await appendReviewEvent(review.id, {
      toPhase: 'ready',
      trigger: 'executor',
      code,
      message,
    });
  }
}

async function cancelUndispatchedTask(taskId: string): Promise<void> {
  // Only while it is still waiting to be picked up. A task already dispatched has
  // a sandbox, and cancelling it here would leave that sandbox running with its
  // row marked cancelled.
  await getDbClient()
    .update(tasksTable)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(tasksTable.id, taskId), inArray(tasksTable.status, ['pending', 'queued'])));
}
