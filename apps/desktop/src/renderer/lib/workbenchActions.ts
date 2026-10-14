import type { Workbench, WorkbenchNextAction } from '@talyn/shared';
import { MENU_COMMANDS } from '../../main/menuCommands';
import { NEXT_ACTION_LABEL, workbenchNextAction, type WorkbenchPrLike } from './workbenchFormat';

/**
 * The header's action cycle: Create PR → Resolve conflicts → Fix checks →
 * Merge → Archive. The primary button follows `nextWorkbenchAction`; the
 * chevron menu lists every action that applies now. Shortcuts and the
 * palette reach the header through `requestWorkbenchAction`, so a key press
 * gets the same confirmations as a click.
 */

export type WorkbenchAction = Exclude<WorkbenchNextAction, null>;

export const WORKBENCH_ACTION_ORDER: readonly WorkbenchAction[] = [
  'create_pr',
  'resolve_conflicts',
  'fix_checks',
  'merge',
  'archive',
];

/** The shortcut registry id of each action, or null for one with no chord. */
export const WORKBENCH_ACTION_SHORTCUT: Record<WorkbenchAction, string | null> = {
  create_pr: 'workbench.createPr',
  resolve_conflicts: null,
  fix_checks: 'workbench.fixChecks',
  merge: 'workbench.merge',
  archive: 'workbench.archive',
};

export const PROMPT_ACTIONS: ReadonlySet<WorkbenchAction> = new Set(['create_pr', 'resolve_conflicts', 'fix_checks']);

/** The chord of an action ('mod+shift+p'), read from the menu table so the two cannot disagree. */
export function workbenchActionKeys(action: WorkbenchAction): string | null {
  const id = WORKBENCH_ACTION_SHORTCUT[action];
  return id ? (MENU_COMMANDS.find((c) => c.id === id)?.keys ?? null) : null;
}

export function workbenchActionLabel(action: WorkbenchAction): string {
  return NEXT_ACTION_LABEL[action];
}

export function isArchivedWorkbench(workbench: Pick<Workbench, 'status' | 'archivedAt'>): boolean {
  return workbench.status === 'archived' || Boolean(workbench.archivedAt);
}

/** The primary button's action, or null when the right move is to wait. */
export function primaryWorkbenchAction(
  workbench: Pick<Workbench, 'diffStat' | 'status' | 'archivedAt'>,
  pr: WorkbenchPrLike | null
): WorkbenchAction | null {
  if (isArchivedWorkbench(workbench)) return null;
  return workbenchNextAction(workbench, pr);
}

/**
 * Every action that applies now, in cycle order. Wider than the primary:
 * Create PR is offered before the diff stat arrives, Merge while checks are
 * still running (GitHub refuses it if the branch rules say no), and Archive
 * always.
 */
export function availableWorkbenchActions(
  workbench: Pick<Workbench, 'diffStat' | 'status' | 'archivedAt'>,
  pr: WorkbenchPrLike | null
): WorkbenchAction[] {
  if (isArchivedWorkbench(workbench)) return [];
  const out = new Set<WorkbenchAction>();
  const primary = primaryWorkbenchAction(workbench, pr);
  if (primary) out.add(primary);
  if (!pr) out.add('create_pr');
  else if (pr.state === 'open') {
    const conflicting = pr.summary.mergeable === 'CONFLICTING';
    const ci = pr.summary.ciStatus;
    if (conflicting) out.add('resolve_conflicts');
    if (ci === 'failing_required' || ci === 'failing_optional') out.add('fix_checks');
    if (!conflicting && !pr.summary.draft) out.add('merge');
  }
  out.add('archive');
  return WORKBENCH_ACTION_ORDER.filter((a) => out.has(a));
}

export const WORKBENCH_ACTION_EVENT = 'talyn:workbench-action';

export interface WorkbenchActionRequest {
  workbenchId: string;
  action: WorkbenchAction;
}

/** Ask the open workbench's header to run an action, confirmations included. */
export function requestWorkbenchAction(workbenchId: string, action: WorkbenchAction): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<WorkbenchActionRequest>(WORKBENCH_ACTION_EVENT, { detail: { workbenchId, action } })
  );
}
