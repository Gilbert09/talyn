import { taskNeedsHumanOpen, type Task, type TaskStatus } from '@talyn/shared';

export function taskDisplayStatus(task: Pick<Task, 'status' | 'metadata' | 'completedAt'>): TaskStatus {
  return task.status === 'needs_human' && !taskNeedsHumanOpen(task)
    ? 'completed'
    : task.status;
}
