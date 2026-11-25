import { CODE_REVIEW_PHASE_AT_REST, type CodeReviewPhase } from './codeReview.js';
import type { WorkbenchChatStatus, WorkbenchKind } from './workbench.js';

/**
 * "Code complete": the session finished its work and the pull request holds it.
 *
 * One rule for every client (the end-of-chat review card and the header badge
 * on web, desktop and mobile) and for the backend (the review that starts by
 * itself at turn end). Pure, so each caller collects the facts its own way and
 * all of them decide the same way.
 *
 * A session is code complete when all of these are true:
 *  - it is a session, not a thread, and it is not archived;
 *  - it has at least one chat, every chat is idle (no turn running, no question
 *    open, no failed turn) and no chat has a queued message;
 *  - it has an OPEN pull request;
 *  - no background job and no session script runs;
 *  - the branch has no uncommitted changes and no unpushed commits.
 *
 * An unknown count (null or absent) does not block. A client can only know what
 * the backend sends, and the backend fills these in a few seconds after a turn.
 */

/** Why a session is not code complete. */
export type CodeCompleteBlocker =
  | 'thread'
  | 'archived'
  | 'no_chat'
  | 'turn_running'
  | 'turn_queued'
  | 'chat_not_idle'
  | 'no_pull_request'
  | 'pull_request_not_open'
  | 'background_job_running'
  | 'script_running'
  | 'uncommitted_changes'
  | 'unpushed_commits';

/** One chat, as the rule reads it. */
export interface CodeCompleteChat {
  status: WorkbenchChatStatus;
  queuedMessages?: readonly unknown[] | null;
  /** A closed chat does not count. */
  closedAt?: string | Date | null;
}

export interface CodeCompleteInput {
  /** Absent reads as `session`. */
  kind?: WorkbenchKind | null;
  archived?: boolean;
  chats: readonly CodeCompleteChat[] | null | undefined;
  /** The linked pull request's state. Null or absent: no pull request. */
  pullRequestState: 'open' | 'closed' | 'merged' | null | undefined;
  runningBackgroundJobs: number;
  runningScripts: number;
  /** Files with uncommitted changes. Null or absent: not known. */
  uncommittedFiles?: number | null;
  /** Commits on the branch that are not on GitHub. Null or absent: not known. */
  unpushedCommits?: number | null;
}

/** Every reason the session is not code complete. Empty when it is. */
export function codeCompleteBlockers(input: CodeCompleteInput): CodeCompleteBlocker[] {
  const blockers: CodeCompleteBlocker[] = [];
  if (input.kind === 'thread') blockers.push('thread');
  if (input.archived) blockers.push('archived');
  const chats = (input.chats ?? []).filter((chat) => !chat.closedAt);
  if (chats.length === 0) blockers.push('no_chat');
  if (chats.some((chat) => chat.status === 'running')) blockers.push('turn_running');
  if (chats.some((chat) => (chat.queuedMessages?.length ?? 0) > 0)) blockers.push('turn_queued');
  if (chats.some((chat) => chat.status !== 'idle' && chat.status !== 'running')) blockers.push('chat_not_idle');
  if (!input.pullRequestState) blockers.push('no_pull_request');
  else if (input.pullRequestState !== 'open') blockers.push('pull_request_not_open');
  if (input.runningBackgroundJobs > 0) blockers.push('background_job_running');
  if (input.runningScripts > 0) blockers.push('script_running');
  if ((input.uncommittedFiles ?? 0) > 0) blockers.push('uncommitted_changes');
  if ((input.unpushedCommits ?? 0) > 0) blockers.push('unpushed_commits');
  return blockers;
}

/** True when the session is code complete. See {@link codeCompleteBlockers}. */
export function isSessionCodeComplete(input: CodeCompleteInput): boolean {
  return codeCompleteBlockers(input).length === 0;
}

/**
 * The review of the pull request, as the code-complete card shows it:
 *  - `none`: no review for the current head (never run, cancelled, or the head
 *    moved past the findings). The card offers "Run code review".
 *  - `waiting`: a cycle runs and waits for a runner.
 *  - `running`: a cycle runs.
 *  - `failed`: the cycle for this head did not finish.
 *  - `done`: the cycle for this head finished; the findings are current. Also
 *    a cycle for an older head whose findings went to the session and that has
 *    no open findings left (see {@link reviewHandledBySession}).
 */
export type SessionReviewState = 'none' | 'waiting' | 'running' | 'failed' | 'done';

/** The fields of a code review that {@link sessionReviewState} reads. */
export interface SessionReviewFacts {
  phase: CodeReviewPhase;
  staleForHead: boolean;
  deferredSince?: string | null;
  /** Absent from an older backend: then a stale review stays `none`. */
  openCount?: number;
  sessionReport?: unknown;
}

/**
 * True when the findings of a finished cycle went to the session (the
 * report-back) and the session fixed or dismissed every one of them. The head
 * then moved because of the fixes, so the stale review still counts as done:
 * the card must not offer a new review as if nothing happened, and the header
 * must not show the fixed findings as open.
 */
export function reviewHandledBySession(review: SessionReviewFacts | null | undefined): boolean {
  if (!review || !review.staleForHead || !review.sessionReport) return false;
  if (review.phase !== 'ready' && review.phase !== 'fixed') return false;
  return review.openCount === 0;
}

export function sessionReviewState(review: SessionReviewFacts | null | undefined): SessionReviewState {
  if (!review) return 'none';
  if (!CODE_REVIEW_PHASE_AT_REST[review.phase]) return review.deferredSince ? 'waiting' : 'running';
  if (reviewHandledBySession(review)) return 'done';
  if (review.phase === 'idle' || review.phase === 'cancelled' || review.staleForHead) return 'none';
  return review.phase === 'failed' ? 'failed' : 'done';
}

/**
 * Blockers that hide the end-of-chat review card even while a review of the
 * pull request exists: the session has no open pull request or no chat, it is
 * a thread or archived, or a turn runs (the turn's own output is at the end).
 */
const REVIEW_CARD_HIDDEN_BY: ReadonlySet<CodeCompleteBlocker> = new Set<CodeCompleteBlocker>([
  'thread',
  'archived',
  'no_chat',
  'turn_running',
  'no_pull_request',
  'pull_request_not_open',
]);

/**
 * Does the end-of-chat review card show? Always when the session is code
 * complete. When it is not, the card still shows a review that runs, waits,
 * failed or finished, so a review never runs with nothing in the chat. A
 * running script, a background job or work that is not pushed must not hide
 * it. Only the "Ready for review" offer (state `none`) needs code complete.
 */
export function sessionReviewCardShown(blockers: readonly CodeCompleteBlocker[], state: SessionReviewState): boolean {
  if (blockers.length === 0) return true;
  if (state === 'none') return false;
  return blockers.every((blocker) => !REVIEW_CARD_HIDDEN_BY.has(blocker));
}

/**
 * Has the head `headSha` had a review already? The auto-start asks this, so
 * it starts at most one cycle per head. A cycle that targets the head counts
 * when it ran, failed or was cancelled: a person who cancelled it chose so.
 */
export function reviewCoversHead(
  review: { phase: CodeReviewPhase; reviewedHeadSha: string | null; targetHeadSha: string | null } | null | undefined,
  headSha: string,
): boolean {
  if (!review || !headSha) return false;
  if (!CODE_REVIEW_PHASE_AT_REST[review.phase]) return true;
  if (review.reviewedHeadSha === headSha) return true;
  return review.targetHeadSha === headSha && review.phase !== 'idle';
}
