import { isSandboxSize, UNATTENDED_SANDBOX_SIZE, type SandboxSize, type Task, type TaskSource } from '@talyn/shared';
import { sizeForSession } from '../workbenches/sandboxSize.js';

/*
 * The size of a task's box. A leaf module, so the box gate in `taskCreate`
 * can ask what the executor will boot without importing the executor (and
 * the poller and queue behind it) into every module that creates a task.
 */

/** Sources that start a run nobody is watching. Their boxes are `small`. */
const UNATTENDED_SOURCES: ReadonlySet<TaskSource> = new Set(['auto_keep', 'merge_queue', 'code_review', 'loop', 'workflow']);

/** True for a run started by a loop, the merge queue, auto-keep, a workflow or a review fix. */
export function isUnattendedTask(task: Pick<Task, 'metadata'>): boolean {
  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  if (meta.unattended === true) return true;
  return typeof meta.source === 'string' && UNATTENDED_SOURCES.has(meta.source as TaskSource);
}

/**
 * The size of a task's box. A size the person chose for this run wins
 * (`metadata.sandboxSize`). Otherwise an unattended run gets
 * {@link UNATTENDED_SANDBOX_SIZE}, and an attended one the repository's size,
 * as a session on that repository would. A quota-failover re-dispatch reads
 * the same metadata, so it keeps the size of the run it replaces.
 */
export async function taskSandboxSize(task: Pick<Task, 'metadata' | 'repositoryId' | 'workspaceId'>): Promise<SandboxSize> {
  const chosen = ((task.metadata ?? {}) as Record<string, unknown>).sandboxSize;
  if (isSandboxSize(chosen)) return chosen;
  if (isUnattendedTask(task)) return UNATTENDED_SANDBOX_SIZE;
  return sizeForSession({ repositoryId: task.repositoryId ?? null, workspaceId: task.workspaceId });
}

