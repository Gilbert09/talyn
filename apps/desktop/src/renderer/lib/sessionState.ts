import type { Workbench, WorkbenchChat } from '@talyn/shared';
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
 * that waits for you, then the pull request's state.
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
  | 'pr_attention'
  | 'ready_to_merge'
  | 'pr_waiting'
  | 'draft'
  | 'merged'
  | 'closed'
  | 'unshipped'
  | 'idle';

export interface SessionState {
  kind: SessionStateKind;
  /** Plain words for the tooltip and for assistive tech. */
  label: string;
}

export function sessionState(
  workbench: Pick<Workbench, 'status' | 'sandboxState' | 'diffStat' | 'committedStats' | 'archivedAt'>,
  chats: Pick<WorkbenchChat, 'id' | 'status'>[],
  unread: Record<string, true>,
  pr: SessionPr | null
): SessionState {
  if (workbench.status === 'error' || workbench.sandboxState === 'error') {
    return { kind: 'failed', label: 'Failed to start' };
  }
  if (chats.some((c) => c.status === 'error')) return { kind: 'failed', label: 'A chat failed' };
  if (workbench.status === 'provisioning' || workbench.sandboxState === 'creating') {
    return { kind: 'starting', label: 'Starting' };
  }
  if (chats.some((c) => c.status === 'running')) return { kind: 'working', label: 'Working' };
  if (chats.some((c) => c.status === 'awaiting_input')) {
    return { kind: 'needs_reply', label: 'Waiting for your answer' };
  }
  if (chats.some((c) => unread[c.id])) return { kind: 'needs_reply', label: 'New reply' };

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
  if ((workbench.diffStat?.files ?? 0) > 0 || (workbench.committedStats?.files ?? 0) > 0) {
    return { kind: 'unshipped', label: 'Changes with no pull request yet' };
  }
  return { kind: 'idle', label: 'Idle' };
}
