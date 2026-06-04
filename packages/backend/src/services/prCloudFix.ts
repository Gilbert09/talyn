// Shared helpers for the two background services that fire a cloud
// "take this PR to a clean, mergeable state" run: the auto-keep-mergeable
// watcher (prAutoMergeWatcher) and the merge queue (mergeQueueProcessor).
//
// Both need the same two lookups — which cloud env to dispatch to, and whether
// the PR's linked task is still working — so they live here to avoid drift.

import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  workspaces as workspacesTable,
  environments as environmentsTable,
} from '../db/schema.js';

/** Task statuses that mean a run is still working the PR. */
export const ACTIVE_STATUSES = new Set(['pending', 'queued', 'in_progress']);

/** The workspace owner's PostHog Code env marker, or null if none. */
export async function resolvePostHogEnvId(workspaceId: string): Promise<string | null> {
  const db = getDbClient();
  const rows = await db
    .select({ envId: environmentsTable.id })
    .from(workspacesTable)
    .innerJoin(
      environmentsTable,
      and(
        eq(environmentsTable.ownerId, workspacesTable.ownerId),
        eq(environmentsTable.type, 'posthog_code')
      )
    )
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return rows[0]?.envId ?? null;
}

/** Current status of the PR's most-recently-linked task, or null. */
export async function linkedTaskStatus(taskId: string | null): Promise<string | null> {
  if (!taskId) return null;
  const db = getDbClient();
  const rows = await db
    .select({ status: tasksTable.status })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return rows[0]?.status ?? null;
}
