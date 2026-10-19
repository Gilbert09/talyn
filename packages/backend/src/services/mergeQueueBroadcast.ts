import { and, eq, inArray } from 'drizzle-orm';
import { getDbClient, runWithoutScope } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { emitPullRequestUpdated } from './websocket.js';
import { toPublicMergeQueue } from './mergeQueue/legacy.js';
import {
  computeEntryPositions,
  loadActiveEntriesForWorkspace,
  rowToEntrySnapshot,
} from './mergeQueue/store.js';

/**
 * Drop a PR out of the merge queue — spread into any `.set()` that flips a
 * row terminal (merged/closed). Single definition shared by the processor,
 * the monitor's closed-sweep, and the routes' terminal reconcile, so no path
 * can flip `state` while leaking stale queue bookkeeping (which once left a
 * merged PR holding the head slot's "#1" badge forever).
 */
export const QUEUE_RESET_COLUMNS = {
  mergeQueued: false,
  mergeQueuedAt: null,
  mergeQueueState: null,
} as const;

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
 * Exactly the columns the position math + emit need. Projected so we don't
 * ship cursor columns or the `lastSummary` / `autoMergeState` blobs on every
 * queue change. The `Pick` type makes `tsc` fail if this module reads a column
 * not listed.
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
} as const;

type BroadcastRow = Pick<typeof pullRequestsTable.$inferSelect, keyof typeof BROADCAST_COLUMNS>;

/**
 * Calls for one workspace inside this window share one run. A merge, a close
 * and a toggle often land together, and each run reads the whole queue.
 */
export const BROADCAST_COALESCE_MS = 300;

/**
 * How long the memo below is trusted. Another replica's emits reach the same
 * clients through Redis and never update this process's memo, so after this
 * the next run sends every row again. It bounds how long a badge can stay
 * wrong after a deploy overlap.
 */
const MEMO_MAX_AGE_MS = 5 * 60_000;

interface QueueMemo {
  /** PR id → the JSON of the `mergeQueue` payload this process last sent. */
  byPr: Map<string, string>;
  trustedSince: number;
}

interface BroadcastSlot {
  /** The run that has not started reading yet. New calls join it. */
  pending: Promise<void> | null;
  /** The run that is reading or emitting now. */
  running: Promise<void> | null;
}

const memos = new Map<string, QueueMemo>();
const slots = new Map<string, BroadcastSlot>();
/** Bumped by the test reset, so a run scheduled before it never reads. */
let generation = 0;

/**
 * Tell the memo what another emitter sent for one PR (the executor's mirror,
 * a dequeue). Without this a later run compares against a value the client no
 * longer holds and skips a row it must send. `null` = the PR left the queue.
 */
export function noteMergeQueueEmitted(
  workspaceId: string,
  pullRequestId: string,
  mergeQueue: Record<string, unknown> | null
): void {
  const memo = memos.get(workspaceId);
  if (!memo) return;
  if (mergeQueue === null) memo.byPr.delete(pullRequestId);
  else memo.byPr.set(pullRequestId, JSON.stringify(mergeQueue));
}

/** Tests: forget every memo, and cancel every run that has not started. */
export function _resetMergeQueueBroadcasts(): void {
  generation++;
  memos.clear();
  slots.clear();
}

/**
 * Recompute and broadcast queue positions for every PR in the workspace's
 * merge queue. Call after any membership change (enqueue, dequeue, merge) so
 * the "Queued #N" badges on sibling PRs update live — otherwise a single PR's
 * `pull_request:updated` event can't move its neighbours.
 *
 * Coalesced per workspace: calls within {@link BROADCAST_COALESCE_MS} share
 * one run, which reads on the pool after the window. Only rows whose payload
 * changed since this process last sent it are emitted, and a row that left
 * gets its clearing emit. The promise resolves when the run that covers this
 * call has finished, and never rejects.
 */
export function broadcastMergeQueuePositions(workspaceId: string): Promise<void> {
  let slot = slots.get(workspaceId);
  if (!slot) {
    slot = { pending: null, running: null };
    slots.set(workspaceId, slot);
  }
  if (slot.pending) return slot.pending;
  const own = slot;
  const gen = generation;
  // Off any request scope: the run starts after the response, when the
  // request's transaction has committed and its handle is dead.
  const pending = runWithoutScope(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, BROADCAST_COALESCE_MS));
    if (gen !== generation) return;
    // One run at a time per workspace, so emits leave in the order they read.
    if (own.running) await own.running;
    own.pending = null;
    const run = runBroadcast(workspaceId).catch((err) => {
      console.warn(
        `[mergeQueue] position broadcast failed for workspace ${workspaceId}:`,
        err instanceof Error ? err.message : err
      );
    });
    own.running = run;
    await run;
    if (own.running === run) own.running = null;
    if (!own.pending && !own.running && slots.get(workspaceId) === own) {
      slots.delete(workspaceId);
    }
  });
  own.pending = pending;
  return pending;
}

function emitQueueState(
  workspaceId: string,
  row: BroadcastRow,
  mergeQueue: Record<string, unknown> | null
): void {
  emitPullRequestUpdated(workspaceId, {
    id: row.id,
    taskId: row.taskId,
    repositoryId: row.repositoryId,
    owner: row.owner,
    repo: row.repo,
    number: row.number,
    state: row.state,
    // Empty, not omitted: released clients merge this into the summary they
    // hold, and an absent one throws in their merge. `{}` changes nothing.
    lastSummary: {},
    mergeQueued: mergeQueue !== null,
    mergeQueue,
  });
}

async function runBroadcast(workspaceId: string): Promise<void> {
  const db = getDbClient();
  // The live memo, not a copy: a note another emitter makes while this run
  // reads lands in it, so the comparison below sees what the client holds.
  const prior = memos.get(workspaceId);
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
  // Positions come from the ENTRIES, not from the pull_requests rows: the entry
  // table is the source of queue state, and its position is per (repo, base)
  // group — which is what the desktop renders. The rows are still needed for
  // the emit's identity fields.
  const entries = await loadActiveEntriesForWorkspace(workspaceId, db);
  // Rank only over entries whose PR is still open AND still flagged queued.
  //
  // This sweep is usually triggered the instant a PR leaves the queue — the
  // monitor sets state='merged' and calls straight into here. The entry for
  // that PR is still active at this point: it is `decide` that terminates it,
  // on the group evaluation the snapshot event triggers a moment later. Ranking
  // over the raw entry list would leave the merged PR occupying #1 and every
  // survivor one place too low, until that evaluation landed.
  const liveIds = new Set(rows.map((r) => r.id));
  const ranked = entries.filter((e) => liveIds.has(e.pullRequestId));
  const positions = computeEntryPositions(ranked);
  const entryByPr = new Map(ranked.map((e) => [e.pullRequestId, e]));

  const current = new Map<string, { row: BroadcastRow; mergeQueue: Record<string, unknown> }>();
  for (const row of rows) {
    const entry = entryByPr.get(row.id);
    // A row still flagged mergeQueued with no active entry is mid-transition —
    // the entry closed and the flag has not been cleared yet. Emitting a
    // position for it would put a phantom back on the queue page.
    if (!entry) continue;
    current.set(row.id, {
      row,
      mergeQueue: toPublicMergeQueue(rowToEntrySnapshot(entry), positions.get(entry.id) ?? 0),
    });
  }

  // Rows this process last showed as queued and that are not queued now. Most
  // already had a clear from the path that removed them; one more is cheap,
  // and a badge left on a PR that is out of the queue is not.
  const left = prior ? [...prior.byPr.keys()].filter((id) => !current.has(id)) : [];
  const leftRows =
    left.length === 0
      ? []
      : await db
          .select(BROADCAST_COLUMNS)
          .from(pullRequestsTable)
          .where(
            and(
              eq(pullRequestsTable.workspaceId, workspaceId),
              inArray(pullRequestsTable.id, left)
            )
          );

  // No await from here on, so no other emitter can send between the emits
  // below and the memo write that records them.
  const now = Date.now();
  const trusted = prior !== undefined && now - prior.trustedSince < MEMO_MAX_AGE_MS;
  const held = new Map<string, string>();
  for (const [id, { row, mergeQueue }] of current) {
    const key = JSON.stringify(mergeQueue);
    if (!trusted || prior.byPr.get(id) !== key) emitQueueState(workspaceId, row, mergeQueue);
    held.set(id, key);
  }
  for (const row of leftRows) emitQueueState(workspaceId, row, null);

  if (held.size === 0) {
    memos.delete(workspaceId);
  } else {
    memos.set(workspaceId, { byPr: held, trustedSince: trusted ? prior.trustedSince : now });
  }
}
