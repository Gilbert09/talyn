import { eq, sql, type SQL } from 'drizzle-orm';
import { DEFAULT_AUTO_ARCHIVE_IDLE_DAYS } from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { workbenches } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { tryWithAdvisoryLock } from '../advisoryLock.js';
import { archiveWorkbench } from './lifecycle.js';
import { readFleetRecord } from './sandboxStatus.js';

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
 * An archive normally wakes the box to run the archive script and save its
 * work. An idle session's box almost always sleeps (suspended, or hibernated
 * in storage, where waking it restores GiBs), so the sweep reads the fleet's
 * record WITHOUT waking anything:
 *  - the box runs: the ordinary archive;
 *  - the box sleeps or is gone: nothing changed since it went to sleep, so if
 *    a save confirmed storage holds all of its work after the last activity
 *    (`work_checked_at`), the stored checkpoint becomes the archive and the box
 *    is deleted, never woken. The archive script is skipped, and the note says so;
 *  - otherwise the session is skipped and logged, and a person can archive it.
 *
 * An hourly pass is enough for a window counted in days. A pass takes at most
 * IDLE_PASS_LIMIT sessions, one at a time. A running box still costs a save,
 * and the limit stops the first pass after a deploy from saving hundreds at
 * once. A sleeping box costs storage copies only, so 50 an hour clears a
 * backlog in a day or two without a burst of storage traffic.
 */
export const IDLE_POLLER = 'workbench-idle-archive-sweep';
export const IDLE_SWEEP_INTERVAL_MS = 60 * 60_000;
export const IDLE_PASS_LIMIT = 50;
/** Rows read per pass, so sessions that are skipped cannot starve the ones behind them. */
const IDLE_SCAN_LIMIT = 500;
/** A skipped session is not read from the fleet again for this long, and is logged once. */
const SKIP_RETRY_MS = 6 * 60 * 60_000;
const skipped = new Map<string, number>();
const IDLE_LOCK = 'workbench-idle-archive';

const w = workbenches;

/** The window for the workspace of the row, in days. Null: off. */
const windowDays = sql`(SELECT CASE
    WHEN s.settings -> 'autoArchiveIdleDays' IS NULL THEN ${DEFAULT_AUTO_ARCHIVE_IDLE_DAYS}::numeric
    WHEN jsonb_typeof(s.settings -> 'autoArchiveIdleDays') = 'number'
      THEN NULLIF((s.settings ->> 'autoArchiveIdleDays')::numeric, 0)
    ELSE NULL END
  FROM workspaces s WHERE s.id = ${w.workspaceId})`;

const lastActivity = sql`GREATEST(
      ${w.createdAt}, COALESCE(${w.lastActivityAt}, ${w.createdAt}),
      COALESCE((SELECT max(GREATEST(c.updated_at, COALESCE(c.turn_started_at, c.created_at)))
        FROM workbench_chats c WHERE c.workbench_id = ${w.id}), ${w.createdAt}))`;

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
    AND ${w.settings} -> 'restartRequestedAt' IS NULL
    AND ${windowDays} IS NOT NULL
    AND ${lastActivity} < ${at} - ${windowDays} * interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM workbench_chats c WHERE c.workbench_id = ${w.id}
      AND (c.status = 'running' OR c.drain_pending OR jsonb_array_length(c.queued_messages) > 0))
    AND NOT EXISTS (SELECT 1 FROM workbench_script_runs r WHERE r.workbench_id = ${w.id} AND r.running)
    AND NOT EXISTS (SELECT 1 FROM workbench_wakeups k WHERE k.workbench_id = ${w.id} AND k.status = 'scheduled')
    AND NOT EXISTS (SELECT 1 FROM workbench_background_jobs j WHERE j.workbench_id = ${w.id}
      AND j.status = 'running' AND j.keep_awake_until > ${at})
    AND (${w.pullRequestId} IS NULL OR NOT EXISTS (
      SELECT 1 FROM pull_requests p WHERE p.id = ${w.pullRequestId} AND (p.merge_queued OR p.auto_keep_mergeable))
      AND NOT EXISTS (SELECT 1 FROM merge_queue_entries q WHERE q.pull_request_id = ${w.pullRequestId}
        AND q.status NOT IN ('merged', 'removed')))
  )`;
}

/**
 * How an archive that a person or a merge asked for treats the box, read
 * without waking it. `running`: the ordinary archive (also when the fleet did
 * not answer, because the archive was asked for). `from_saved`: the box sleeps
 * or is gone, and a save newer than the last activity holds all of its work,
 * so the stored checkpoint becomes the archive. `wake`: the box sleeps and no
 * such save exists, so the archive wakes it to save the work.
 */
export type ArchiveBoxSource = 'running' | 'from_saved' | 'wake';

export async function archiveBoxSource(id: string): Promise<ArchiveBoxSource> {
  const [row] = await getPoolDbClient().select({
    workspaceId: w.workspaceId, fleetHost: w.fleetHost, sandboxId: w.sandboxId, runtime: w.runtime, kind: w.kind,
    sandboxState: w.sandboxState, checkedAt: w.workCheckedAt, activityAt: sql<Date | string>`(${lastActivity})`,
  }).from(w).where(eq(w.id, id));
  if (!row?.sandboxId || row.runtime !== 'sandbox' || row.kind === 'thread' || row.sandboxState === 'deleted') return 'running';
  const read = await readFleetRecord(
    { workspaceId: row.workspaceId, fleetHost: row.fleetHost, sandboxId: row.sandboxId }, Date.now(), { fresh: true },
  );
  if (!read.ok) return 'running';
  const awake = !read.terminal && !read.retired && ['queued', 'starting', 'idle', 'busy'].includes(read.sandbox.status);
  if (awake) return 'running';
  const savedAfterActivity = row.checkedAt && row.checkedAt.getTime() >= new Date(row.activityAt).getTime();
  return savedAfterActivity ? 'from_saved' : 'wake';
}

/** Tests start with no remembered skips. */
export function resetIdleSkipsForTests(): void { skipped.clear(); }

/** One pass. Returns the ids it archived. */
export async function sweepIdleSessions(now = new Date(), limit = IDLE_PASS_LIMIT): Promise<string[]> {
  const db = getPoolDbClient();
  const candidates = await db.select({
    id: w.id, workspaceId: w.workspaceId, fleetHost: w.fleetHost, sandboxId: w.sandboxId,
    checkedAt: w.workCheckedAt, activityAt: sql<Date | string>`(${lastActivity})`,
  }).from(w)
    .where(idleArchiveGuard(now)).orderBy(w.createdAt, w.id).limit(Math.max(limit, IDLE_SCAN_LIMIT));
  const archived: string[] = [];
  for (const candidate of candidates) {
    if (archived.length >= limit) break;
    if ((skipped.get(candidate.id) ?? 0) > Date.now()) continue;
    const skip = (why: string) => {
      if (!skipped.has(candidate.id)) console.warn(`[workbench] idle archive of ${candidate.id} skipped: ${why}`);
      skipped.set(candidate.id, Date.now() + SKIP_RETRY_MS);
      if (skipped.size > 5000) skipped.clear();
    };
    const [ws] = await db.select({ days: sql<string | null>`(${windowDays})` }).from(w).where(eq(w.id, candidate.id));
    const days = Math.max(1, Math.round(Number(ws?.days ?? DEFAULT_AUTO_ARCHIVE_IDLE_DAYS)));
    try {
      let fromSaved = false;
      if (candidate.sandboxId) {
        const read = await readFleetRecord(
          { workspaceId: candidate.workspaceId, fleetHost: candidate.fleetHost, sandboxId: candidate.sandboxId }, Date.now(), { fresh: true },
        );
        // A failed read says nothing about the box: leave it rather than wake it.
        if (!read.ok) { skip('the fleet did not answer'); continue; }
        const awake = !read.terminal && !read.retired && ['queued', 'starting', 'idle', 'busy'].includes(read.sandbox.status);
        if (!awake) {
          const savedAfterActivity = candidate.checkedAt && candidate.checkedAt.getTime() >= new Date(candidate.activityAt).getTime();
          if (!savedAfterActivity) {
            skip('the box sleeps and no save is newer than its last activity');
            continue;
          }
          fromSaved = true;
        }
      }
      const row = await archiveWorkbench(candidate.id, { idle: { guard: idleArchiveGuard(now), days, fromSaved } });
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
