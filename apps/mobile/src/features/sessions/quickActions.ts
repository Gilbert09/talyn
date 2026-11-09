import type { PRRow } from '@talyn/client/native';
import { nextWorkbenchAction, prSummaryToNextActionPr, type Workbench, type WorkbenchNextAction } from '@talyn/shared';

import { sessionPr, type SessionPr } from '../../lib/status';
import { workbenchKind } from '../../workflow/model';
import { queueStateLabel } from '../prs/actions';
import { canRetry, canWake, isArchived, runningChat } from './actions';
import { hasChanges, sessionUnavailable } from './model';

/** The header cycle of web `workbenchActions.ts`: Create PR, Resolve conflicts, Fix checks, Merge, Archive. */
export type CycleAction = Exclude<WorkbenchNextAction, null>;
export type QuickActionKind = CycleAction | 'stop' | 'retry' | 'wake' | 'restore' | 'queue_add' | 'queue_status';

export interface QuickAction {
  kind: QuickActionKind;
  label: string;
  /** What the action does, for screen readers. */
  hint: string;
  /** Why it cannot run now, or null. */
  disabledReason: string | null;
}

/** Web `NEXT_ACTION_LABEL`. */
export const CYCLE_LABEL: Record<CycleAction, string> = {
  create_pr: 'Create PR',
  resolve_conflicts: 'Resolve conflicts',
  fix_checks: 'Fix checks',
  merge: 'Merge',
  archive: 'Archive',
};

/** Web `ACTION_HINT`, plus the session actions mobile adds to the row. */
export const QUICK_ACTION_HINT: Record<QuickActionKind, string> = {
  create_pr: 'Asks the agent to write the pull request. Talyn then commits, pushes and opens it.',
  resolve_conflicts: 'Asks the agent to merge the base branch in and resolve the conflicts.',
  fix_checks: 'Asks the agent to fix the failing checks.',
  merge: 'Merges the pull request on GitHub.',
  archive: 'Archives this session.',
  stop: 'Stops the agent turn that runs now.',
  retry: 'Starts the sandbox again.',
  wake: 'Wakes the sandbox so the next message starts sooner.',
  restore: 'Restores this session.',
  queue_add: 'Adds the pull request to the merge queue.',
  queue_status: 'Opens the pull request.',
};

const PROMPT_ACTIONS = new Set<QuickActionKind>(['create_pr', 'resolve_conflicts', 'fix_checks']);
const OFFLINE = 'You are offline.';

/** The PR the cycle reads: the full row when loaded, else the summary the session carries. Mirrors web `prRowAsLike`. */
function prInput(item: Workbench, row: PRRow | null): SessionPr | null {
  return sessionPr(item, row);
}

/**
 * The cycle actions that apply now, in cycle order. Mirrors web
 * `availableWorkbenchActions`, with Archive left to the menu.
 */
export function cycleActions(item: Workbench, row: PRRow | null): CycleAction[] {
  if (isArchived(item) || workbenchKind(item) === 'thread') return [];
  const pr = prInput(item, row);
  const out = new Set<CycleAction>();
  const primary = primaryCycleAction(item, row);
  if (primary && primary !== 'archive') out.add(primary);
  if (!pr && !item.pullRequestId) out.add('create_pr');
  else if (pr?.state === 'open') {
    const conflicting = pr.summary.mergeable === 'CONFLICTING';
    const ci = pr.summary.ciStatus;
    if (conflicting) out.add('resolve_conflicts');
    if (ci === 'failing_required' || ci === 'failing_optional') out.add('fix_checks');
    if (!conflicting && !pr.summary.draft) out.add('merge');
  }
  return (['create_pr', 'resolve_conflicts', 'fix_checks', 'merge'] as const).filter((action) => out.has(action));
}

/** The one cycle action web's header offers, or null when the right move is to wait. Mirrors web `primaryWorkbenchAction`. */
export function primaryCycleAction(item: Workbench, row: PRRow | null): CycleAction | null {
  if (isArchived(item) || workbenchKind(item) === 'thread') return null;
  const pr = prInput(item, row);
  // A linked PR whose summary has not loaded yet is not "no PR". Wait for it.
  if (!pr && item.pullRequestId) return null;
  return nextWorkbenchAction({
    hasChanges: hasChanges(item),
    pr: pr ? prSummaryToNextActionPr({ state: pr.state, mergeable: pr.summary.mergeable ?? undefined, ciStatus: pr.summary.ciStatus ?? undefined }) : null,
  });
}

/** Why a cycle action cannot run now. Mirrors web `disabled(action)`. */
export function cycleDisabledReason(action: CycleAction, item: Workbench, row: PRRow | null): string | null {
  if (PROMPT_ACTIONS.has(action)) return sessionUnavailable(item);
  if (action === 'merge' && !row) return 'The pull request is still loading.';
  return null;
}

export function cycleLabel(action: CycleAction, row: PRRow | null, item: Workbench): string {
  if (action === 'archive' && (row?.state ?? item.pr?.state) === 'merged') return 'Archive session';
  return CYCLE_LABEL[action];
}

/** Whether the header offers the queue for this PR. Web `canQueue`: an open PR on a live session. Only the owner sees a session here. */
export const canQueue = (item: Workbench, row: PRRow | null): row is PRRow =>
  Boolean(row) && !isArchived(item) && workbenchKind(item) === 'session' && row?.state === 'open';

/**
 * The quick actions above the transcript, most urgent first, at most `limit`.
 * Order: Stop a running turn, Retry a failed start, web's primary cycle
 * action, the merge queue, then Wake. Archived work only restores. A thread
 * has no PR actions.
 */
export function primaryActions(item: Workbench, row: PRRow | null,
  options: { selectedChat?: string | null; offline?: boolean; limit?: number } = {}): QuickAction[] {
  const offline = options.offline === true;
  const make = (kind: QuickActionKind, label: string, reason: string | null = null): QuickAction =>
    ({ kind, label, hint: QUICK_ACTION_HINT[kind], disabledReason: offline ? OFFLINE : reason });
  if (isArchived(item)) return [make('restore', 'Restore')];
  const out: QuickAction[] = [];
  if (runningChat(item, options.selectedChat)) out.push(make('stop', 'Stop'));
  if (canRetry(item)) out.push({ ...make('retry', 'Retry'), hint: item.error || item.statusMessage || QUICK_ACTION_HINT.retry });
  const primary = primaryCycleAction(item, row);
  if (primary) out.push(make(primary, cycleLabel(primary, row, item), cycleDisabledReason(primary, item, row)));
  if (canQueue(item, row)) {
    out.push(row.mergeQueued ? { ...make('queue_status', queueStateLabel(row)), disabledReason: null } : make('queue_add', 'Add to merge queue'));
  }
  if (canWake(item)) out.push(make('wake', 'Wake'));
  return out.slice(0, options.limit ?? 2);
}

/** The +/- line count of the branch, or null with no changes. Committed and uncommitted work together. */
export function diffTotals(item: Pick<Workbench, 'diffStat' | 'committedStats' | 'uncommittedStats'>): { files: number; added: number; removed: number } | null {
  const parts = item.uncommittedStats || item.committedStats ? [item.uncommittedStats, item.committedStats] : [item.diffStat];
  const total = { files: 0, added: 0, removed: 0 };
  for (const part of parts) {
    total.files += part?.files ?? 0;
    total.added += part?.added ?? 0;
    total.removed += part?.removed ?? 0;
  }
  return total.files > 0 ? total : null;
}
