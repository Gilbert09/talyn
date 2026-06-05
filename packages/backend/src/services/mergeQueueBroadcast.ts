import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { emitPullRequestUpdated } from './websocket.js';

type QueueStatus = 'waiting' | 'fixing' | 'merging' | 'blocked';

/** The minimal row shape the position math needs — satisfied by both the
 *  drizzle select row and the routes' local PullRequestRow interface. */
interface QueueableRow {
  id: string;
  mergeQueued: boolean;
  mergeQueuedAt: Date | null;
  repositoryId: string;
  lastSummary: unknown;
}

function baseBranchOf(row: QueueableRow): string {
  return (row.lastSummary as { baseBranch?: string } | null)?.baseBranch ?? '';
}

/**
 * 1-based merge-queue position per (repo, base branch) group, FIFO ordered by
 * `mergeQueuedAt`. Mirrors the processor's grouping so the badge's "#N" matches
 * the order the PRs will actually merge. Single source of truth shared by the
 * REST list endpoint and the live position broadcast.
 */
export function computeQueuePositions<T extends QueueableRow>(rows: T[]): Map<string, number> {
  const byGroup = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.mergeQueued) continue;
    const key = `${r.repositoryId}|${baseBranchOf(r)}`;
    let arr = byGroup.get(key);
    if (!arr) {
      arr = [];
      byGroup.set(key, arr);
    }
    arr.push(r);
  }
  const positions = new Map<string, number>();
  for (const group of byGroup.values()) {
    group.sort(
      (a, b) => (a.mergeQueuedAt?.getTime() ?? 0) - (b.mergeQueuedAt?.getTime() ?? 0)
    );
    group.forEach((r, i) => positions.set(r.id, i + 1));
  }
  return positions;
}

/**
 * Recompute and broadcast queue positions for every PR currently in the
 * workspace's merge queue. Call after any membership change (enqueue, dequeue,
 * merge) so the "Queued #N" badges on sibling PRs update live — otherwise a
 * single PR's `pull_request:updated` event can't move its neighbours, and the
 * counts only correct themselves on a manual list refresh.
 */
/**
 * Exactly the columns the position math + emit need. Projected so we don't
 * ship cursor columns or the `autoMergeState` blob on every queue change.
 * The `Pick` type makes `tsc` fail if this function reads a column not listed.
 */
const BROADCAST_COLUMNS = {
  id: pullRequestsTable.id,
  taskId: pullRequestsTable.taskId,
  repositoryId: pullRequestsTable.repositoryId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  mergeQueued: pullRequestsTable.mergeQueued,
  mergeQueuedAt: pullRequestsTable.mergeQueuedAt,
  mergeQueueState: pullRequestsTable.mergeQueueState,
  lastSummary: pullRequestsTable.lastSummary,
} as const;

export async function broadcastMergeQueuePositions(workspaceId: string): Promise<void> {
  const db = getDbClient();
  const rows = await db
    .select(BROADCAST_COLUMNS)
    .from(pullRequestsTable)
    .where(
      and(
        eq(pullRequestsTable.workspaceId, workspaceId),
        eq(pullRequestsTable.mergeQueued, true),
        eq(pullRequestsTable.state, 'open')
      )
    );
  const positions = computeQueuePositions(rows);
  for (const row of rows) {
    const s = (row.mergeQueueState as { status?: QueueStatus; attempts?: number } | null) ?? null;
    emitPullRequestUpdated(workspaceId, {
      id: row.id,
      taskId: row.taskId,
      repositoryId: row.repositoryId,
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      state: row.state,
      lastSummary: row.lastSummary as Record<string, unknown>,
      mergeQueued: true,
      mergeQueueState: {
        status: s?.status ?? 'waiting',
        attempts: s?.attempts ?? 0,
        position: positions.get(row.id) ?? 0,
      },
    });
  }
}
