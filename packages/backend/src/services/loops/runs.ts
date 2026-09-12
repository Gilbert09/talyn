import { v4 as uuid } from 'uuid';
import { and, asc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  LOOP_FAILURE_LIMIT,
  nextLoopRun,
  type LoopConcurrency,
  type LoopDisabledReason,
  type LoopProvider,
  type LoopRunFailureCode,
  type LoopRunStatus,
  type LoopRunTrigger,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { loopRuns as runsTable, loops as loopsTable, tasks as tasksTable } from '../../db/schema.js';

/**
 * The scheduler's queries: find what is due, claim it, settle it, advance it.
 *
 * Everything here is written so that no two replicas can do the same firing
 * twice and no crash can lose one. The mechanism is a unique index, not a lock
 * — see {@link claimFiring}.
 */

/** The statuses a run passes through before it is settled. */
export const ACTIVE_RUN_STATUSES: LoopRunStatus[] = ['waiting_slot', 'queued', 'running'];

/**
 * How long a task-limited run waits before trying again.
 *
 * One sweep interval: there is no point re-asking faster than the loop that
 * would ask, and a slot frees when some other task finishes rather than on a
 * schedule of its own.
 */
export const WAITING_SLOT_RETRY_MS = 30_000;

/**
 * The columns a firing needs. An explicit projection typed with `Pick`, so a
 * consumer that later reads a column this drops fails `tsc` rather than
 * silently re-bloating the query — the house rule for anything on a poll loop.
 */
export const DUE_LOOP_COLUMNS = {
  id: loopsTable.id,
  workspaceId: loopsTable.workspaceId,
  name: loopsTable.name,
  prompt: loopsTable.prompt,
  cron: loopsTable.cron,
  timezone: loopsTable.timezone,
  provider: loopsTable.provider,
  model: loopsTable.model,
  concurrency: loopsTable.concurrency,
  repositoryId: loopsTable.repositoryId,
  repoFullName: loopsTable.repoFullName,
  nextRunAt: loopsTable.nextRunAt,
  consecutiveFailures: loopsTable.consecutiveFailures,
} as const;

export type DueLoop = Pick<typeof loopsTable.$inferSelect, keyof typeof DUE_LOOP_COLUMNS>;

/**
 * Enabled loops whose occurrence has arrived, oldest first.
 *
 * Due-ness is judged by `now()` in the DATABASE, not by this process's clock.
 * Postgres is already the single arbiter of the tick lock, so making it the
 * single clock too means replica skew cannot make two replicas disagree about
 * what is due. (The unique claim would catch the disagreement anyway; this
 * stops a skewed replica firing early in the first place.)
 *
 * `limit` bounds the TICK, not the work: a backlog drains over several ticks
 * rather than creating a hundred cloud tasks in one breath.
 */
export async function dueLoops(limit: number): Promise<DueLoop[]> {
  return getDbClient()
    .select(DUE_LOOP_COLUMNS)
    .from(loopsTable)
    .where(and(eq(loopsTable.enabled, true), lte(loopsTable.nextRunAt, sql`now()`)))
    .orderBy(asc(loopsTable.nextRunAt))
    .limit(limit);
}

export interface ClaimedRun {
  id: string;
  /** False when the row already existed — another replica, or our own retry. */
  fresh: boolean;
  status: LoopRunStatus;
  taskId: string | null;
}

/**
 * Claim one firing by inserting its run row.
 *
 * THE INSERT IS THE CLAIM. `UNIQUE (loop_id, scheduled_for)` makes a second
 * attempt at the same occurrence a conflict rather than a second cloud task, so
 * there is no advisory lock in the fire path and no distributed dedupe cache.
 *
 * It is a stronger key than the workflows engine's `(workflow_id, delivery_id)`:
 * a webhook delivery id is an opaque token each replica must have RECEIVED,
 * while a scheduled instant is derived from the loop's own stored
 * `next_run_at`. Two actors that both believe a firing is owed cannot compute
 * different keys for it.
 *
 * The consequence to respect: `next_run_at` must only ever hold an exact
 * occurrence instant. Rounding it, nudging it, or writing "now" into it would
 * hand two replicas two different keys for one firing.
 */
export async function claimFiring(
  loop: DueLoop,
  scheduledFor: Date,
  trigger: LoopRunTrigger = 'schedule'
): Promise<ClaimedRun> {
  const id = uuid();
  const inserted = await getDbClient()
    .insert(runsTable)
    .values({
      id,
      loopId: loop.id,
      workspaceId: loop.workspaceId,
      scheduledFor,
      trigger,
      repositoryId: loop.repositoryId,
      repoFullName: loop.repoFullName,
      provider: loop.provider,
      model: loop.model,
      status: 'queued',
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: [runsTable.loopId, runsTable.scheduledFor] })
    .returning({ id: runsTable.id });

  if (inserted[0]) return { id: inserted[0].id, fresh: true, status: 'queued', taskId: null };

  // Somebody else owns this occurrence — or we do, from a tick that died
  // between claiming and dispatching. Hand the caller what is actually there so
  // it can finish the job rather than start a second one.
  const existing = await getDbClient()
    .select({ id: runsTable.id, status: runsTable.status, taskId: runsTable.taskId })
    .from(runsTable)
    .where(and(eq(runsTable.loopId, loop.id), eq(runsTable.scheduledFor, scheduledFor)))
    .limit(1);
  const row = existing[0];
  if (!row) {
    // The conflicting row has been deleted between the insert and this read.
    // Vanishingly rare (the loop would have to be deleted mid-tick), and the
    // honest answer is "not ours" rather than a retry loop.
    return { id, fresh: false, status: 'skipped', taskId: null };
  }
  return { id: row.id, fresh: false, status: row.status as LoopRunStatus, taskId: row.taskId };
}

/** Whether this loop has another run in flight — the overlap probe. */
export async function hasActiveRun(loopId: string, excludeRunId: string): Promise<boolean> {
  const rows = await getDbClient()
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(
      and(
        eq(runsTable.loopId, loopId),
        inArray(runsTable.status, ACTIVE_RUN_STATUSES),
        ne(runsTable.id, excludeRunId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export interface SettleInput {
  status: LoopRunStatus;
  failureCode?: LoopRunFailureCode | null;
  error?: string | null;
  taskId?: string | null;
  retryAfter?: Date | null;
}

/**
 * Move a run to its next state.
 *
 * Guarded on the run still being active, which is what makes the two settlement
 * paths — the in-process `task:status` listener and the sweep's durable
 * backstop — safe to both fire. The loser's update matches no rows instead of
 * overwriting the winner's answer.
 */
export async function settleRun(runId: string, input: SettleInput): Promise<boolean> {
  const terminal = input.status !== 'waiting_slot' && input.status !== 'queued' && input.status !== 'running';
  const rows = await getDbClient()
    .update(runsTable)
    .set({
      status: input.status,
      failureCode: input.failureCode ?? null,
      error: input.error ?? null,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      retryAfter: input.retryAfter ?? null,
      settledAt: terminal ? new Date() : null,
    })
    .where(and(eq(runsTable.id, runId), inArray(runsTable.status, ACTIVE_RUN_STATUSES)))
    .returning({ id: runsTable.id });
  return rows.length > 0;
}

/**
 * Record that this run got its task.
 *
 * Moves the run to `queued` as well as attaching the id, and that is not
 * cosmetic: a run parked on the plan limit is `waiting_slot` with a
 * `retry_after`, and a retry that only attached the task would leave it parked
 * — retried forever, with a task already running behind it.
 *
 * `dispatched_at` is written because `task_id` cannot be trusted to remember:
 * its FK is ON DELETE SET NULL.
 */
export async function markDispatched(runId: string, taskId: string): Promise<void> {
  await getDbClient()
    .update(runsTable)
    .set({
      taskId,
      dispatchedAt: new Date(),
      status: 'queued',
      failureCode: null,
      error: null,
      retryAfter: null,
    })
    .where(eq(runsTable.id, runId));
}

/**
 * Move the schedule on, or switch the loop off when it has no future.
 *
 * A compare-and-set on the `next_run_at` we read. A user who edits the cron
 * mid-tick has their route handler write a new value; without the CAS this
 * update would then clobber it with an occurrence of the OLD schedule, and the
 * loop would fire once more on a schedule it no longer has.
 */
export async function advanceSchedule(loop: DueLoop, from: Date): Promise<Date | null> {
  const next = nextLoopRun(loop.cron, loop.timezone, from);
  if (!next) {
    await disableLoop(loop.id, 'never_fires');
    return null;
  }
  await getDbClient()
    .update(loopsTable)
    .set({ nextRunAt: next, updatedAt: new Date() })
    .where(and(eq(loopsTable.id, loop.id), eq(loopsTable.nextRunAt, loop.nextRunAt as Date)));
  return next;
}

/** Switch a loop off with a reason the UI can explain. */
export async function disableLoop(
  loopId: string,
  reason: LoopDisabledReason
): Promise<void> {
  await getDbClient()
    .update(loopsTable)
    .set({ enabled: false, disabledReason: reason, nextRunAt: null, updatedAt: new Date() })
    .where(eq(loopsTable.id, loopId));
}

/**
 * Count a failure, and switch the loop off once they stop looking like bad luck.
 *
 * This is what stops a loop whose fleet subscription was revoked from spending
 * a task slot every hour until somebody notices. Any success resets the count
 * (see {@link clearFailures}), so a loop that fails on Monday and works on
 * Tuesday never approaches the limit.
 */
export async function recordFailure(loopId: string): Promise<void> {
  const rows = await getDbClient()
    .update(loopsTable)
    .set({
      consecutiveFailures: sql`${loopsTable.consecutiveFailures} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(loopsTable.id, loopId))
    .returning({ failures: loopsTable.consecutiveFailures });
  if ((rows[0]?.failures ?? 0) >= LOOP_FAILURE_LIMIT) {
    await disableLoop(loopId, 'too_many_failures');
  }
}

export async function clearFailures(loopId: string): Promise<void> {
  await getDbClient()
    .update(loopsTable)
    .set({ consecutiveFailures: 0 })
    .where(eq(loopsTable.id, loopId));
}

/**
 * Runs parked on the plan's task limit whose retry is due.
 *
 * Reads through the partial `idx_loop_runs_active` index, so the cost is the
 * number of parked runs rather than the size of the history.
 */
export async function dueWaitingSlots(limit: number): Promise<
  {
    runId: string;
    loopId: string;
    scheduledFor: Date;
  }[]
> {
  const rows = await getDbClient()
    .select({
      runId: runsTable.id,
      loopId: runsTable.loopId,
      scheduledFor: runsTable.scheduledFor,
    })
    .from(runsTable)
    .where(and(eq(runsTable.status, 'waiting_slot'), lte(runsTable.retryAfter, sql`now()`)))
    .orderBy(asc(runsTable.retryAfter))
    .limit(limit);
  return rows;
}

/**
 * Whether a newer firing of the same loop has been claimed.
 *
 * The give-up condition for a parked run, and deliberately not an attempt cap.
 * A cron payload is "it is time", which does not go stale until the NEXT time
 * arrives — so a daily loop may wait most of a day for a free task slot, and an
 * every-five-minutes loop gives up in five. That is the right answer in both
 * cases, and no number chosen in advance would be.
 */
export async function isSuperseded(loopId: string, scheduledFor: Date): Promise<boolean> {
  const rows = await getDbClient()
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(
      and(eq(runsTable.loopId, loopId), sql`${runsTable.scheduledFor} > ${scheduledFor}`)
    )
    .limit(1);
  return rows.length > 0;
}

export interface ActiveRunRow {
  runId: string;
  loopId: string;
  workspaceId: string;
  status: LoopRunStatus;
  taskId: string | null;
  createdAt: Date;
  dispatchedAt: Date | null;
  taskStatus: string | null;
}

/**
 * Every run still in flight, with the status of the task behind it.
 *
 * The durable half of settlement. The in-process `task:status` listener is
 * faster but per-replica — a task finished by the replica that is not running
 * this sweep still has to be noticed, and a deploy in the middle drops the
 * event entirely. This query is what makes that a delay rather than a run stuck
 * at `running` forever.
 *
 * Selects only `tasks.status`, never the row: `tasks.transcript` is routinely
 * megabytes.
 */
export async function activeRunsWithTaskStatus(limit: number): Promise<ActiveRunRow[]> {
  return getDbClient()
    .select({
      runId: runsTable.id,
      loopId: runsTable.loopId,
      workspaceId: runsTable.workspaceId,
      status: sql<LoopRunStatus>`${runsTable.status}`,
      taskId: runsTable.taskId,
      createdAt: runsTable.createdAt,
      dispatchedAt: runsTable.dispatchedAt,
      taskStatus: tasksTable.status,
    })
    .from(runsTable)
    .leftJoin(tasksTable, eq(tasksTable.id, runsTable.taskId))
    .where(inArray(runsTable.status, ['queued', 'running']))
    .orderBy(asc(runsTable.createdAt))
    .limit(limit);
}

/** A run row the recovery path needs, by its claim key. */
export async function runByClaim(
  loopId: string,
  scheduledFor: Date
): Promise<{ id: string; status: LoopRunStatus; taskId: string | null } | null> {
  const rows = await getDbClient()
    .select({ id: runsTable.id, status: runsTable.status, taskId: runsTable.taskId })
    .from(runsTable)
    .where(and(eq(runsTable.loopId, loopId), eq(runsTable.scheduledFor, scheduledFor)))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, status: row.status as LoopRunStatus, taskId: row.taskId } : null;
}

/**
 * Runs claimed but never dispatched — the crash-window orphans.
 *
 * `dispatched_at IS NULL` is what separates these from a run whose task was
 * DELETED: both end up with a null `task_id`, but only one of them ever had a
 * task. Without that column this query would reap the deleted-task case too,
 * five minutes late and under the wrong name.
 */
export async function orphanedClaims(olderThan: Date, limit: number) {
  return getDbClient()
    .select({ runId: runsTable.id, loopId: runsTable.loopId, workspaceId: runsTable.workspaceId })
    .from(runsTable)
    .where(
      and(
        eq(runsTable.status, 'queued'),
        isNull(runsTable.taskId),
        isNull(runsTable.dispatchedAt),
        sql`${runsTable.createdAt} < ${olderThan}`
      )
    )
    .limit(limit);
}

/** The concurrency setting is read back on the fire path; keep the cast local. */
export function concurrencyOf(loop: DueLoop): LoopConcurrency {
  return loop.concurrency === 'allow' ? 'allow' : 'skip';
}

/** The provider a run dispatches at, narrowed from the stored text column. */
export function providerOf(loop: DueLoop): LoopProvider {
  return loop.provider === 'selfhosted' ? 'selfhosted' : 'posthog_code';
}
