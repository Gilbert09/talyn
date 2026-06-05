import type { Task, TaskType, TaskStatus, TaskPriority } from '@fastowl/shared';
import { tasks as tasksTable } from '../db/schema.js';

/**
 * Map a `tasks` DB row to the shared `Task` shape the desktop renders.
 *
 * Lives here (not in `routes/tasks.ts`) so the route AND `taskCreate` can both
 * serialize without a route↔service import cycle — `taskCreate` needs it to
 * broadcast the `task:created` WS event with the same shape the REST list/get
 * endpoints return.
 */
export function rowToTask(
  row: typeof tasksTable.$inferSelect,
  opts: { includeTranscript?: boolean } = {}
): Task {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    title: row.title,
    description: row.description,
    prompt: row.prompt ?? undefined,
    repositoryId: row.repositoryId ?? undefined,
    branch: row.branch ?? undefined,
    assignedEnvironmentId: row.assignedEnvironmentId ?? undefined,
    result: (row.result as Task['result']) ?? undefined,
    metadata: (row.metadata as Task['metadata']) ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : undefined,
    transcript: opts.includeTranscript
      ? ((row.transcript as Task['transcript']) ?? undefined)
      : undefined,
  };
}
