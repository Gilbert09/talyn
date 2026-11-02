import { and, eq, sql } from 'drizzle-orm';
import type { NeedsHumanResolution, Task } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable } from '../../db/schema.js';
import { emitTaskUpdate } from '../websocket.js';

/**
 * Mark a merge-queue fix task's `needs_human` request as resolved, because the
 * queue moved on without the person: GitHub showed the PR clean and the queue
 * submitted it, the entry left its `agent_needs_human` park, or the PR merged.
 * Without this the task kept its amber "Needs you" chip after the PR merged.
 *
 * Writes `metadata.needsHumanResolved` (read by `taskNeedsHumanOpen` in
 * @talyn/shared) and never the status: the run's outcome stays a fact, and no
 * new `TaskStatus` is needed.
 *
 * One atomic UPDATE, guarded on `status = 'needs_human'`, so a row the next
 * dispatch has already reused is left alone. Idempotent: an existing
 * resolution is kept. Best-effort: a failure here must never stop the queue.
 */
export async function resolveNeedsHumanTask(taskId: string, note: string): Promise<void> {
  try {
    const resolution: NeedsHumanResolution = {
      at: new Date().toISOString(),
      by: 'merge_queue',
      note,
    };
    const rows = await getDbClient()
      .update(tasksTable)
      .set({
        metadata: sql`COALESCE(${tasksTable.metadata}, '{}'::jsonb) || jsonb_build_object('needsHumanResolved', ${JSON.stringify(resolution)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tasksTable.id, taskId),
          eq(tasksTable.status, 'needs_human'),
          sql`(${tasksTable.metadata} -> 'needsHumanResolved') IS NULL`
        )
      )
      .returning({ workspaceId: tasksTable.workspaceId, metadata: tasksTable.metadata });
    const row = rows[0];
    if (row) {
      emitTaskUpdate(row.workspaceId, taskId, {
        metadata: (row.metadata ?? {}) as Task['metadata'],
      });
    }
  } catch (err) {
    console.warn(
      `[mergeQueue] could not mark task ${taskId} needs_human as resolved:`,
      err instanceof Error ? err.message : err
    );
  }
}
