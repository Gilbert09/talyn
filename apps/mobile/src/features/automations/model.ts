import {
  LOOP_DISABLED_REASON_LABELS, LOOP_RUN_FAILURE_LABELS, LOOP_RUN_STATUS_LABELS, WORKFLOW_ACTION_LABELS, WORKFLOW_EVENT_LABELS,
  WORKFLOW_RUN_STATUS_LABELS, describeSchedule, describeWorkflowActions, describeWorkflowTrigger, loopToInput,
  type LoopInput, type LoopRun, type LoopRunStatus, type LoopWithStats, type WorkflowInput, type WorkflowRun,
  type WorkflowRunStatus, type WorkflowWithStats,
} from '@talyn/shared';

import type { Tone } from '../../components/UI';

export type AutomationKind = 'workflow' | 'loop';
export interface Badge { label: string; tone: Tone }

const RUN_TONE: Record<WorkflowRunStatus | LoopRunStatus, Tone> = {
  running: 'information', queued: 'information', waiting_slot: 'warning', pending_retry: 'warning',
  succeeded: 'success', partial: 'warning', failed: 'destructive', skipped: 'muted',
};

/** A run's status as a pill, with web's own words for it. */
export function workflowRunBadge(status: WorkflowRunStatus): Badge {
  return { label: WORKFLOW_RUN_STATUS_LABELS[status] ?? status, tone: RUN_TONE[status] ?? 'muted' };
}
export function loopRunBadge(status: LoopRunStatus): Badge {
  return { label: LOOP_RUN_STATUS_LABELS[status] ?? status, tone: RUN_TONE[status] ?? 'muted' };
}

/** "When PR opened → add labels", like the web row. */
export function workflowSummary(workflow: Pick<WorkflowWithStats, 'events' | 'actions'>): string {
  const trigger = describeWorkflowTrigger(workflow).toLowerCase();
  const actions = describeWorkflowActions(workflow).toLowerCase();
  return actions ? `When ${trigger} → ${actions}` : `When ${trigger}`;
}

/** "Every day at 09:00 (Europe/London) · posthog/posthog". */
export function loopSummary(loop: Pick<LoopWithStats, 'cron' | 'timezone' | 'repoFullName'>): string {
  return [describeSchedule(loop.cron, loop.timezone), loop.repoFullName].filter(Boolean).join(' · ');
}

/** Why the engine turned a loop off, or null when a person did or it is on. */
export function loopDisabledText(loop: Pick<LoopWithStats, 'disabledReason'>): string | null {
  return loop.disabledReason ? LOOP_DISABLED_REASON_LABELS[loop.disabledReason] ?? null : null;
}

/** "in 5m", "in 3h", "due now", "Paused". Mirrors web `relativeFuture`. */
export function nextRunText(loop: Pick<LoopWithStats, 'enabled' | 'nextRunAt'>, now = Date.now()): string {
  if (!loop.enabled) return 'Paused';
  if (!loop.nextRunAt) return 'Not scheduled';
  const at = Date.parse(loop.nextRunAt);
  if (!Number.isFinite(at)) return 'Not scheduled';
  const mins = Math.round((at - now) / 60_000);
  // The sweep runs every 30 seconds, so a loop a minute overdue is about to fire.
  if (mins <= 0) return 'Next run due now';
  if (mins < 60) return `Next run in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Next run in ${hours}h`;
  return `Next run in ${Math.round(hours / 24)}d`;
}

/** "2 problems this week", or null. */
export function problemsText(failures7d: number): string | null {
  if (failures7d <= 0) return null;
  return `${failures7d} problem${failures7d === 1 ? '' : 's'} this week`;
}

/** The whole-workflow replace web sends to flip `enabled`. The route takes no partial update. */
export function workflowToggleInput(workflow: WorkflowWithStats, enabled: boolean): WorkflowInput {
  return {
    name: workflow.name, enabled, events: workflow.events, conditions: workflow.conditions,
    actions: workflow.actions, maxRunsPerPrPerHour: workflow.maxRunsPerPrPerHour,
  };
}
export function loopToggleInput(loop: LoopWithStats, enabled: boolean): LoopInput {
  return { ...loopToInput(loop), enabled };
}

/** The list with one item's `enabled` changed, for the optimistic switch. */
export function withEnabled<T extends { id: string; enabled: boolean }>(items: readonly T[], id: string, enabled: boolean): T[] {
  return items.map((item) => item.id === id ? { ...item, enabled } : item);
}

/** Title and detail of a workflow run row. */
export function workflowRunText(run: Pick<WorkflowRun, 'prNumber' | 'prTitle' | 'repoFullName' | 'event' | 'actions' | 'error'>): { title: string; detail: string } {
  const failed = run.actions.find((action) => !action.ok);
  const problem = failed ? `${WORKFLOW_ACTION_LABELS[failed.type] ?? failed.type}: ${failed.error ?? 'did not run'}` : run.error;
  return {
    title: run.prTitle || `Pull request #${run.prNumber}`,
    detail: problem ?? [run.repoFullName, WORKFLOW_EVENT_LABELS[run.event] ?? run.event].filter(Boolean).join(' · '),
  };
}

/** Title and detail of a loop run row. */
export function loopRunText(run: Pick<LoopRun, 'trigger' | 'failureCode' | 'error' | 'repoFullName'>): { title: string; detail: string } {
  const problem = run.failureCode ? LOOP_RUN_FAILURE_LABELS[run.failureCode] ?? run.error : run.error;
  return { title: run.trigger === 'manual' ? 'Run now' : 'Scheduled run', detail: problem ?? run.repoFullName };
}
