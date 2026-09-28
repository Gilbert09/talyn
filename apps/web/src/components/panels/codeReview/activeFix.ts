import { TASK_STATUS_TERMINAL, type TaskStatus } from '@talyn/shared';

/**
 * The agent run working a pull request right now, or null when none is.
 *
 * Read off the PULL REQUEST's linked task rather than the review's own
 * `fixTaskId`, because most of the runs a person wants to see on a review row
 * were not started by the review: the sheet's "Fix with agent", the merge
 * queue and the auto-keep watcher all produce an ordinary `pr_response` task
 * against the same pull request. A PR is only ever allowed ONE active task
 * (`activePrTaskId` refuses a second), so its `taskId` — which holds the most
 * recently attached run — is the right thing to ask. Keying off `fixTaskId`
 * would light up for review auto-fixes alone and stay dark for every other
 * run, which is the state the Code review list was in.
 *
 * A task id the store has never heard of answers null. The store carries the
 * workspace's live tasks, so an id it cannot resolve is one that finished long
 * enough ago to have fallen out — "unknown" therefore means finished, not
 * "might be running". Answering the other way would leave a spinner on a row
 * for ever whenever a task aged out mid-run.
 *
 * Duplicated in apps/desktop on purpose: the renderer is a deliberate fork.
 */
export function activeFixStatus(
  taskId: string | null | undefined,
  statusById: ReadonlyMap<string, TaskStatus>
): TaskStatus | null {
  if (!taskId) return null;
  const status = statusById.get(taskId);
  if (!status) return null;
  // Derived from TASK_STATUS_TERMINAL rather than listing the active statuses,
  // so a new TaskStatus routes the compiler here instead of silently reading
  // as "not running".
  return TASK_STATUS_TERMINAL[status] ? null : status;
}
