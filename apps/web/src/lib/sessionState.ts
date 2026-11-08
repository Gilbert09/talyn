import type { Workbench, WorkbenchBackground, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from './api';
import type { WorkbenchPrLike } from './workbenchFormat';
import { primaryWorkbenchAction } from './workbenchActions';

type SessionPr = Pick<PRRow, 'number' | 'state'> & { summary: WorkbenchPrLike['summary'] };

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
 * sidebar row. In priority order: a failure, then live work, then a reply
 * that waits for you, then a running background job, then the pull request's
 * state, then a scheduled wake-up. A new pull request that is the only unseen
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
  | 'pr_opened'
  | 'pr_attention'
  | 'ready_to_merge'
  | 'pr_waiting'
  | 'draft'
  | 'merged'
  | 'closed'
  | 'unshipped'
  | 'wakeup'
  | 'idle';

export interface SessionState {
  kind: SessionStateKind;
  /** Plain words for the tooltip and for assistive tech. */
  label: string;
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
  if (chats.some((c) => (c.queuedMessages?.length ?? 0) > 0)) return { kind: 'working', label: 'A message waits for the sandbox' };
  if (chats.some((c) => c.status === 'awaiting_input')) {
    return { kind: 'needs_reply', label: 'Waiting for your answer' };
  }
  if (chats.some((c) => unread[c.id])) {
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
