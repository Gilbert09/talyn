/**
 * Per-task "someone is looking at this" registry — the gate for cloud
 * transcript streaming.
 *
 * Streaming a cloud run's SSE log is purely a UI concern (status, PR
 * linkage, and finalisation all come from the provider's REST poll), so
 * the poller only keeps a stream open for tasks marked watched here.
 * The desktop marks a task on the task screen's mount (refresh-logs)
 * and re-announces every 30s over POST /tasks/:id/watch; the TTL
 * tolerates two missed heartbeats before the poller tears the stream
 * down.
 *
 * Pure in-memory, intentionally not persisted (same reasoning as
 * prFocus): the heartbeat re-announces within 30s of a backend restart,
 * and an unwatched stream costs at most one extra TTL window.
 */

const WATCH_TTL_MS = 90_000;

const watchedAt = new Map<string, number>(); // taskId → last heartbeat ms

/** Mark `taskId` as currently viewed. Idempotent; refreshes the TTL. */
export function markWatched(taskId: string): void {
  watchedAt.set(taskId, Date.now());
}

/** Drop the watch (task finalized, aborted, deleted, or explicit unwatch). */
export function clearWatched(taskId: string): void {
  watchedAt.delete(taskId);
}

/**
 * Has a viewer announced itself within the TTL? Expired entries are
 * cleaned up on read (prFocus pattern).
 */
export function isWatched(taskId: string): boolean {
  const at = watchedAt.get(taskId);
  if (at === undefined) return false;
  if (Date.now() - at > WATCH_TTL_MS) {
    watchedAt.delete(taskId);
    return false;
  }
  return true;
}

/** Test helper. Empties the registry. */
export function _resetTaskWatch(): void {
  watchedAt.clear();
}

export const TASK_WATCH_CONSTANTS = { WATCH_TTL_MS };
