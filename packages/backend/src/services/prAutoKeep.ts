import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { emitPullRequestUpdated } from './websocket.js';

/**
 * The per-PR "keep this pull request mergeable" switch. Shared by the app's
 * `POST /pull-requests/:id/auto-keep-mergeable` and the public API's
 * `PATCH /v1/pull-requests/{id}`.
 *
 * No plan gate: only the WORKSPACE default needs Unlimited
 * (`AutoKeepDefaultPlanError`, asserted in the workspaces PATCH). The runs the
 * watcher starts are bounded by the task cap.
 */

export type AutoKeepRow = Pick<
  typeof pullRequestsTable.$inferSelect,
  'id' | 'workspaceId' | 'taskId' | 'repositoryId' | 'owner' | 'repo' | 'number' | 'state' | 'lastSummary'
>;

/**
 * The compact watcher state the desktop renders (toggle + badge).
 *
 * Must stay in step with `publicState` in prAutoMergeWatcher — the WS push and
 * this REST read are the same field arriving by two routes, and a client that
 * saw `deferredSince` only over the socket would show the chip on a live
 * update and lose it on every refresh.
 */
export function publicAutoMergeState(
  raw: unknown
): { attempts: number; paused: boolean; deferredSince: string | null } | null {
  const s = raw as { attempts?: number; pausedAt?: string; deferredSince?: string } | null;
  if (!s) return null;
  return {
    attempts: s.attempts ?? 0,
    paused: !!s.pausedAt,
    deferredSince: s.deferredSince ?? null,
  };
}

/**
 * Turn the watcher on or off for one PR. Enabling arms a fresh guard so the
 * next watcher tick fires immediately if the PR already needs work. Disabling
 * clears all watcher bookkeeping.
 */
export async function setAutoKeepMergeable(row: AutoKeepRow, enabled: boolean): Promise<void> {
  const nextState = enabled ? { attempts: 0, accounted: true } : null;
  await getDbClient()
    .update(pullRequestsTable)
    .set({
      autoKeepMergeable: enabled,
      autoMergeState: nextState,
      updatedAt: new Date(),
    })
    .where(eq(pullRequestsTable.id, row.id));

  emitPullRequestUpdated(row.workspaceId, {
    id: row.id,
    taskId: row.taskId,
    repositoryId: row.repositoryId,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    state: row.state,
    lastSummary: row.lastSummary as Record<string, unknown>,
    autoKeepMergeable: enabled,
    autoMergeState: publicAutoMergeState(nextState),
  });
}
