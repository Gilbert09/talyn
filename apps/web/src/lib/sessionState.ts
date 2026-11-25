import {
  CODE_REVIEW_PHASE_LABELS,
  sessionReviewState,
  type ContextAttentionReason,
  type SessionReviewFacts,
  type SpaceSessionRow,
  type Workbench,
  type WorkbenchBackground,
  type WorkbenchChat,
} from '@talyn/shared';
import type { PRRow } from './api';
import type { WorkbenchPrLike } from './workbenchFormat';
import { primaryWorkbenchAction } from './workbenchActions';

type SessionPr = Pick<PRRow, 'number' | 'state'> & {
  summary: WorkbenchPrLike['summary'];
  /** Only the open PR store has the code review. */
  codeReview?: SessionReviewFacts | null;
};

export function sessionPr(workbench: Pick<Workbench, 'pr'>, storeRow: PRRow | null | undefined): SessionPr | null {
  if (storeRow) return storeRow;
  const pr = workbench.pr;
  if (!pr) return null;
  return {
    number: pr.number,
    state: pr.state,
    summary: {
      url: pr.url,
      mergeable: pr.mergeable === 'conflicting' ? 'CONFLICTING' : pr.mergeable === 'mergeable' ? 'MERGEABLE' : 'UNKNOWN',
      ciStatus: pr.ciStatus === 'success' ? 'passing' : pr.ciStatus === 'failure' ? 'failing_required' : pr.ciStatus === 'pending' ? 'running' : 'none',
    },
  };
}

/**
 * One answer to "what is this session doing, and does it need me?", for the
 * sidebar row. In priority order: a failure, then live work, then a question
 * that waits for you, then a running code review of the pull request, then an
 * unread reply, then a running background job, then the pull request's
 * state (a CI wake-up shows as waiting for CI), then a scheduled wake-up. A new pull request that is the only unseen
 * news (`prOnlyUnseen`) shows the PR mark, not the dot.
 *
 * The PR part reuses the header's next action, so the row and the header
 * always agree: conflicts and failing checks need you, a green PR is ready to
 * merge, and a merged PR is done.
 */
export type SessionStateKind =
  | 'failed'
  | 'starting'
  | 'working'
  | 'needs_reply'
  | 'background_job'
  | 'code_review'
  | 'pr_opened'
  | 'pr_attention'
  | 'ready_to_merge'
  | 'pr_waiting'
  | 'draft'
  | 'merged'
  | 'closed'
  | 'unshipped'
  | 'waiting_ci'
  | 'wakeup'
  | 'idle';

export interface SessionState {
  kind: SessionStateKind;
  /** Plain words for the tooltip and for assistive tech. */
  label: string;
  /** A state that wins over an unread reply sets this, so the row still shows the reply as unread. */
  unread?: boolean;
}

/** Derive the best state available in the compact space-session payload. */
export function spaceSessionState(
  workbench: Pick<SpaceSessionRow, 'id' | 'status' | 'sandboxState' | 'running' | 'pullRequest' | 'archivedAt'>,
): SessionState {
  const chats = workbench.running ? [{ id: workbench.id, status: 'running' as const }] : [];
  const pullRequest = workbench.pullRequest
    ? {
        number: workbench.pullRequest.number,
        state:
          workbench.pullRequest.state === 'merged'
            ? ('merged' as const)
            : workbench.pullRequest.state === 'closed'
              ? ('closed' as const)
              : ('open' as const),
        summary: {
          url: workbench.pullRequest.url,
          mergeable: 'UNKNOWN' as const,
          ciStatus: 'none' as const,
        },
      }
    : null;
  return sessionState(
    {
      status: workbench.status,
      sandboxState: workbench.sandboxState,
      diffStat: null,
      committedStats: null,
      archivedAt: workbench.archivedAt,
    },
    chats,
    {},
    pullRequest,
  );
}

/**
 * Make a row agree with the context rail's badge. The server counts a session
 * that failed, asks a question, has a plan that waits for approval, or has a
 * pull request with conflicts. The client can miss that: a session whose chats
 * are not loaded, a space row, which has no chats and no mergeable state, or a
 * plan, which only the transcript shows. Then the row shows the server's
 * reason. Live work and a failure the client sees win, because the server's
 * answer can be up to 30 seconds old. A reason this client does not know
 * keeps the row's own state.
 */
export function withServerAttention(
  state: SessionState,
  reason: ContextAttentionReason | undefined,
  prNumber?: number | null,
): SessionState {
  if (!reason) return state;
  if (state.kind === 'failed' || state.kind === 'working' || state.kind === 'starting') return state;
  if (reason === 'failed') return { kind: 'failed', label: 'Failed: open it to see why' };
  if (reason === 'reply') return { kind: 'needs_reply', label: 'Waiting for your answer' };
  if (reason === 'plan') return { kind: 'needs_reply', label: 'A plan waits for your approval' };
  if (reason !== 'conflict' || state.kind === 'pr_attention') return state;
  return { kind: 'pr_attention', label: prNumber ? `#${prNumber} has conflicts` : 'The pull request has conflicts' };
}

/** True when a session belongs in the sidebar's active group. */
export function isActiveSessionState(state: SessionState): boolean {
  return state.kind !== 'idle' && state.kind !== 'merged' && state.kind !== 'closed';
}

export function sessionState(
  workbench: Pick<Workbench, 'status' | 'sandboxState' | 'diffStat' | 'committedStats' | 'archivedAt'>,
  chats: (Pick<WorkbenchChat, 'id' | 'status'> & { queuedMessages?: WorkbenchChat['queuedMessages'] })[],
  unread: Record<string, true>,
  pr: SessionPr | null,
  prOnlyUnseen = false,
  background?: Pick<WorkbenchBackground, 'jobs' | 'wakeups'> | null
): SessionState {
  if (workbench.status === 'error' || workbench.sandboxState === 'error') {
    return { kind: 'failed', label: 'Failed to start' };
  }
  if (chats.some((c) => c.status === 'error')) return { kind: 'failed', label: 'A chat failed' };
  if (workbench.status === 'provisioning' || workbench.sandboxState === 'creating') {
    return { kind: 'starting', label: 'Starting' };
  }
  if (chats.some((c) => c.status === 'running')) return { kind: 'working', label: 'Working' };
  // A message that waits for the box is work in progress, not an idle session.
  // An archived session has no box: its queued message waits for a restore.
  if (!workbench.archivedAt && chats.some((c) => (c.queuedMessages?.length ?? 0) > 0)) {
    return { kind: 'working', label: 'A message waits for the sandbox' };
  }
  if (chats.some((c) => c.status === 'awaiting_input')) {
    return { kind: 'needs_reply', label: 'Waiting for your answer' };
  }
  const hasUnread = chats.some((c) => unread[c.id]);
  // The review starts when the agent stops, so an unread reply is usually there too.
  // The review is the newer news: it shows in the icon, and the reply keeps the bold title.
  const review = pr?.state === 'open' ? sessionReviewState(pr.codeReview) : 'none';
  if (pr && (review === 'running' || review === 'waiting')) {
    const label =
      review === 'waiting'
        ? `#${pr.number}: code review waits for a runner`
        : `#${pr.number}: code review running (${CODE_REVIEW_PHASE_LABELS[pr.codeReview!.phase].toLowerCase()})`;
    return hasUnread ? { kind: 'code_review', label, unread: true } : { kind: 'code_review', label };
  }
  if (hasUnread) {
    if (prOnlyUnseen && pr && pr.state === 'open') {
      return { kind: 'pr_opened', label: `Pull request opened: #${pr.number}` };
    }
    return { kind: 'needs_reply', label: 'New reply' };
  }
  if (background?.jobs.some((job) => job.status === 'running')) {
    return { kind: 'background_job', label: 'Background job running' };
  }

  if (pr) {
    if (pr.state === 'merged') return { kind: 'merged', label: `Done: #${pr.number} merged` };
    if (pr.state === 'closed') return { kind: 'closed', label: `#${pr.number} closed` };
    // The agent asked to be woken when CI finishes: say that, not "waiting on checks or review".
    if (background?.wakeups.some((wakeup) => wakeup.status === 'scheduled' && wakeup.ci)) {
      return { kind: 'waiting_ci', label: `#${pr.number}: waiting for CI, then the agent continues` };
    }
    if (pr.summary.draft) return { kind: 'draft', label: `Draft PR #${pr.number}` };
    const next = primaryWorkbenchAction(workbench, { state: pr.state, summary: pr.summary });
    if (next === 'resolve_conflicts') return { kind: 'pr_attention', label: `#${pr.number} has conflicts` };
    // Failing CI is not a session failure: keep the open-PR icon and say it in the label.
    if (next === 'fix_checks') return { kind: 'pr_waiting', label: `#${pr.number} open, checks are failing` };
    if (next === 'merge') return { kind: 'ready_to_merge', label: `#${pr.number} is ready to merge` };
    return { kind: 'pr_waiting', label: `#${pr.number} open, waiting on checks or review` };
  }
  if (background?.wakeups.some((wakeup) => wakeup.status === 'scheduled')) {
    return { kind: 'wakeup', label: 'Wake-up scheduled' };
  }
  if ((workbench.diffStat?.files ?? 0) > 0 || (workbench.committedStats?.files ?? 0) > 0) {
    return { kind: 'unshipped', label: 'Changes with no pull request yet' };
  }
  return { kind: 'idle', label: 'Idle' };
}
