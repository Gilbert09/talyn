// Code review auto-start: when a session becomes code complete at the end of a
// turn, start a review of its pull request's head, once per head.
//
// Gated by the `codeReviewAutoStartOnComplete` flag (asked for the workspace
// owner). Never for local sessions: the backend cannot see their box.

import {
  codeCompleteBlockers,
  customReviewersForRepo,
  reviewCoversHead,
  type CodeCompleteBlocker,
  type CodeReviewPhase,
  type WorkbenchChatStatus,
} from '@talyn/shared';
import { ownerHasAutoFeatures } from '../billing/entitlements.js';
import { workspaceHasFeature } from '../featureFlags.js';
import { refreshPullRequestById } from '../prRefresh.js';
import { runningJobsQuery } from '../workbenches/backgroundStore.js';
import { storedScriptNames } from '../workbenches/scriptStore.js';
import { listChats, type WorkbenchRow } from '../workbenches/store.js';
import { startReviewCycle } from './cycle.js';
import { countCyclesStartedFor, getPrForReview, getReviewForPr, type ReviewPrRow } from './store.js';
import { workspaceOwner, workspaceReviewSettings } from './workspaceSettings.js';

/**
 * The most cycles the auto-start begins on one pull request. With the
 * report-back on, a review sends findings to the session, the agent pushes a
 * fix, and the next turn end is code complete on a new head: without a bound
 * that loop runs until a review finds nothing. A person can still start more
 * reviews by hand; those do not count.
 */
export const SESSION_AUTO_START_MAX_CYCLES = 3;

export type SessionAutoStartSkip =
  | 'local'
  | 'thread'
  | 'no_pull_request'
  | 'flag_off'
  | 'pull_request_not_open'
  | 'no_head'
  | 'already_reviewed'
  | 'not_code_complete'
  | 'head_not_pushed'
  | 'plan'
  | 'settings_off'
  | 'limit_reached';

export type SessionAutoStartOutcome =
  | { kind: 'started'; reviewId: string; headSha: string }
  | { kind: 'skipped'; reason: SessionAutoStartSkip; blockers?: CodeCompleteBlocker[] }
  | { kind: 'declined'; code: string }
  | { kind: 'failed'; error: string };

function prHead(pr: ReviewPrRow | null): string {
  return ((pr?.lastSummary ?? {}) as { headSha?: string }).headSha ?? '';
}

/** Read the pull request from GitHub again: the turn's own push may not be in the row yet. */
async function refreshedPr(pullRequestId: string): Promise<ReviewPrRow | null> {
  await refreshPullRequestById(pullRequestId);
  return getPrForReview(pullRequestId);
}

/**
 * Start a review when the session is code complete and its pull request's head
 * has had no review. `boxHead` is the box's HEAD sha from the turn-end diff, or
 * null when the box did not answer. Never throws.
 */
export async function startReviewIfCodeComplete(
  wb: WorkbenchRow,
  boxHead: string | null,
): Promise<SessionAutoStartOutcome> {
  try {
    if (wb.runtime !== 'sandbox') return { kind: 'skipped', reason: 'local' };
    if (wb.kind === 'thread') return { kind: 'skipped', reason: 'thread' };
    const pullRequestId = wb.pullRequestId;
    if (!pullRequestId) return { kind: 'skipped', reason: 'no_pull_request' };
    if (!(await workspaceHasFeature('codeReviewAutoStartOnComplete', wb.workspaceId)).enabled) {
      return { kind: 'skipped', reason: 'flag_off' };
    }

    let pr = await getPrForReview(pullRequestId);
    if (!pr || pr.state !== 'open') return { kind: 'skipped', reason: 'pull_request_not_open' };

    const [chats, jobs, scripts] = await Promise.all([
      listChats(wb.id),
      runningJobsQuery(wb.id),
      wb.sandboxId ? storedScriptNames(wb.id, wb.sandboxId) : Promise.resolve([]),
    ]);
    // The box's HEAD against the PR's head is the exact "pushed" test. Without
    // a HEAD, the last work check's count stands in.
    const blockers = codeCompleteBlockers({
      kind: wb.kind === 'thread' ? 'thread' : 'session',
      archived: Boolean(wb.archivedAt),
      chats: chats.map((chat) => ({ status: chat.status as WorkbenchChatStatus, queuedMessages: chat.queuedMessages, closedAt: chat.closedAt })),
      pullRequestState: pr.state as 'open',
      runningBackgroundJobs: jobs.length,
      runningScripts: scripts.length,
      uncommittedFiles: wb.diffStat?.uncommittedStats?.files ?? wb.diffStat?.files ?? null,
      unpushedCommits: boxHead ? 0 : wb.workUnpushedCommits,
    });
    if (blockers.length) return { kind: 'skipped', reason: 'not_code_complete', blockers };

    let head = prHead(pr);
    if (boxHead && head !== boxHead) {
      pr = await refreshedPr(pullRequestId);
      if (!pr || pr.state !== 'open') return { kind: 'skipped', reason: 'pull_request_not_open' };
      head = prHead(pr);
      if (head !== boxHead) return { kind: 'skipped', reason: 'head_not_pushed' };
    }
    if (!head) return { kind: 'skipped', reason: 'no_head' };
    const review = await getReviewForPr(pullRequestId);
    if (review && reviewCoversHead({ ...review, phase: review.phase as CodeReviewPhase }, head)) {
      return { kind: 'skipped', reason: 'already_reviewed' };
    }
    if (review && (await countCyclesStartedFor(review.id, 'session_complete')) >= SESSION_AUTO_START_MAX_CYCLES) {
      return { kind: 'skipped', reason: 'limit_reached' };
    }

    const settings = await workspaceReviewSettings(wb.workspaceId);
    if (!settings.builtInReviewers && !customReviewersForRepo(settings.customReviewers, pr).length) {
      return { kind: 'skipped', reason: 'settings_off' };
    }
    // The plan gate of every automatic review: an automatic start spends box
    // time with nobody asking.
    if (!(await ownerHasAutoFeatures(await workspaceOwner(wb.workspaceId)))) {
      return { kind: 'skipped', reason: 'plan' };
    }

    const outcome = await startReviewCycle({ pullRequestId, auto: true, trigger: 'session_complete' });
    if (!outcome.ok) return { kind: 'declined', code: outcome.code };
    if (!outcome.started) return { kind: 'skipped', reason: 'already_reviewed' };
    return { kind: 'started', reviewId: outcome.review.id, headSha: head };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[code-review] auto-start for session ${wb.id} failed: ${error}`);
    return { kind: 'failed', error };
  }
}
