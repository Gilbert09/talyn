import { eq, sql, type SQL } from 'drizzle-orm';
import { DEFAULT_AUTO_ARCHIVE_IDLE_DAYS } from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { workbenches } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { tryWithAdvisoryLock } from '../advisoryLock.js';
import { archiveWorkbench } from './lifecycle.js';

/**
 * Archive a session with no activity for the workspace's window (7 days by
 * default, `settings.autoArchiveIdleDays`, 0 or null = off).
 *
 * Activity is the newest of: the session's creation, its chats' own
 * `updated_at` (every event append and queue change writes it) and turn start,
 * and `workbenches.last_activity_at` (terminal input, a script start, a
 * restore). `workbenches.updated_at` is NOT used: status polling and diff
 * refreshes write it on sessions nobody touches.
 *
 * An hourly pass is enough for a window counted in days. It archives at most
 * IDLE_PASS_LIMIT sessions, one at a time, so the first pass after a deploy
 * does not save and delete hundreds of boxes at once; the rest follow on the
 * next passes.
 */
export const IDLE_POLLER = 'workbench-idle-archive-sweep';
export const IDLE_SWEEP_INTERVAL_MS = 60 * 60_000;
export const IDLE_PASS_LIMIT = 50;
const IDLE_LOCK = 'workbench-idle-archive';

const w = workbenches;

/** The window for the workspace of the row, in days. Null: off. */
const windowDays = sql`(SELECT CASE
    WHEN s.settings -> 'autoArchiveIdleDays' IS NULL THEN ${DEFAULT_AUTO_ARCHIVE_IDLE_DAYS}::numeric
    WHEN jsonb_typeof(s.settings -> 'autoArchiveIdleDays') = 'number'
      THEN NULLIF((s.settings ->> 'autoArchiveIdleDays')::numeric, 0)
    ELSE NULL END
  FROM workspaces s WHERE s.id = ${w.workspaceId})`;

/**
 * Whether the row is an idle session that may be archived at `now`. Used to
 * pick candidates and again inside the claiming UPDATE, so a session that woke
 * up between the two is left alone.
 */
export function idleArchiveGuard(now: Date): SQL {
  const at = sql`${now.toISOString()}::timestamptz`;
  return sql`(
    ${w.kind} = 'session' AND ${w.runtime} = 'sandbox'
    AND ${w.archivedAt} IS NULL AND ${w.status} IN ('ready', 'error')
    AND ${w.archivePendingAt} IS NULL AND ${w.restoreRequestedAt} IS NULL
    AND ${w.settings} ->> 'archiveAfterTurn' IS NULL
    AND ${w.settings} ->> 'archiveOnIdle' IS NULL
    AND ${w.settings} -> 'resizeTo' IS NULL
    AND ${windowDays} IS NOT NULL
    AND GREATEST(
      ${w.createdAt}, COALESCE(${w.lastActivityAt}, ${w.createdAt}),
      COALESCE((SELECT max(GREATEST(c.updated_at, COALESCE(c.turn_started_at, c.created_at)))
        FROM workbench_chats c WHERE c.workbench_id = ${w.id}), ${w.createdAt})
    ) < ${at} - ${windowDays} * interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM workbench_chats c WHERE c.workbench_id = ${w.id}
      AND (c.status = 'running' OR c.drain_pending OR jsonb_array_length(c.queued_messages) > 0))
    AND NOT EXISTS (SELECT 1 FROM workbench_script_runs r WHERE r.workbench_id = ${w.id} AND r.running)
    AND (${w.pullRequestId} IS NULL OR NOT EXISTS (
      SELECT 1 FROM pull_requests p WHERE p.id = ${w.pullRequestId} AND (p.merge_queued OR p.auto_keep_mergeable))
      AND NOT EXISTS (SELECT 1 FROM merge_queue_entries q WHERE q.pull_request_id = ${w.pullRequestId}
        AND q.status NOT IN ('merged', 'removed')))
  )`;
}

/** One pass. Returns the ids it archived. */
export async function sweepIdleSessions(now = new Date(), limit = IDLE_PASS_LIMIT): Promise<string[]> {
  const db = getPoolDbClient();
  const candidates = await db.select({ id: w.id, workspaceId: w.workspaceId }).from(w)
    .where(idleArchiveGuard(now)).orderBy(w.createdAt, w.id).limit(limit);
  const archived: string[] = [];
  for (const candidate of candidates) {
    const [ws] = await db.select({ days: sql<string | null>`(${windowDays})` }).from(w).where(eq(w.id, candidate.id));
    const days = Math.max(1, Math.round(Number(ws?.days ?? DEFAULT_AUTO_ARCHIVE_IDLE_DAYS)));
    try {
      const row = await archiveWorkbench(candidate.id, { idle: { guard: idleArchiveGuard(now), days } });
      if (row) archived.push(candidate.id);
    } catch (err) {
      console.warn(`[workbench] idle archive of ${candidate.id} failed:`, err);
    }
  }
  return archived;
}

let running = false;

/** The timer's tick: one replica at a time (try-lock), timed on the debug bus. */
export async function idleArchiveTick(now = new Date()): Promise<string[]> {
  if (running) return [];
  running = true;
  const started = Date.now();
  let error: unknown;
  try {
    const outcome = await tryWithAdvisoryLock(getPoolDbClient(), IDLE_LOCK,
      () => runWithoutScope(() => sweepIdleSessions(now)));
    return outcome.acquired ? outcome.result ?? [] : [];
  } catch (err) {
    error = err;
    return [];
  } finally {
    running = false;
    debugBus.pollerTick(IDLE_POLLER, { durationMs: Date.now() - started, ok: !error, error });
  }
}
