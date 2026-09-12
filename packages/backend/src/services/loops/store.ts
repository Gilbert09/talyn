import { v4 as uuid } from 'uuid';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  nextLoopRun,
  type LoopConcurrency,
  type LoopDefinition,
  type LoopDisabledReason,
  type LoopProvider,
  type LoopRun,
  type LoopRunFailureCode,
  type LoopRunStatus,
  type LoopRunTrigger,
  type LoopStats,
  type LoopWithStats,
  type NormalizedLoop,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  loopRuns as runsTable,
  loops as loopsTable,
  pullRequests as prTable,
  tasks as tasksTable,
} from '../../db/schema.js';

/**
 * Reads and writes for the two loop tables.
 *
 * Beyond plain CRUD, two things here carry weight:
 *
 *  - **`next_run_at` is computed on every write that can move it.** A create, a
 *    schedule edit and an enable all recompute it from the cron expression; a
 *    disable clears it. Nothing else in the system may set that column except
 *    the scheduler advancing it, because it is simultaneously the schedule and
 *    half of the idempotency key.
 *  - **Stats are aggregated, never stored.** A `runs_total` column drifts the
 *    first time a write path forgets to bump it; an aggregate cannot.
 */

type LoopRow = typeof loopsTable.$inferSelect;
type RunRow = typeof runsTable.$inferSelect;

/**
 * The joined task columns a run row carries into the history.
 *
 * An explicit projection, not a `SELECT *` on `tasks`: that table holds
 * `transcript`, which is routinely megabytes of conversation log. A history
 * page listing fifty runs would ship fifty transcripts to render a status pill.
 */
const RUN_TASK_COLUMNS = {
  taskStatus: tasksTable.status,
  taskCompletedAt: tasksTable.completedAt,
  // `pull_requests` stores no URL column — the app builds one from these three
  // everywhere it needs a link, so this join does the same rather than adding a
  // column whose only job is to be redundant.
  taskPrOwner: prTable.owner,
  taskPrRepo: prTable.repo,
  taskPrNumber: prTable.number,
} as const;

export function rowToLoop(row: LoopRow): LoopDefinition {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    enabled: row.enabled,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    provider: row.provider as LoopProvider,
    model: row.model,
    concurrency: row.concurrency as LoopConcurrency,
    repositoryId: row.repositoryId,
    repoFullName: row.repoFullName,
    nextRunAt: row.nextRunAt ? row.nextRunAt.toISOString() : null,
    disabledReason: (row.disabledReason as LoopDisabledReason | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function rowToLoopRun(
  row: RunRow,
  task?: {
    taskStatus: string | null;
    taskCompletedAt: Date | null;
    taskPrOwner: string | null;
    taskPrRepo: string | null;
    taskPrNumber: number | null;
  } | null
): LoopRun {
  return {
    id: row.id,
    loopId: row.loopId,
    workspaceId: row.workspaceId,
    scheduledFor: row.scheduledFor.toISOString(),
    trigger: row.trigger as LoopRunTrigger,
    repositoryId: row.repositoryId,
    repoFullName: row.repoFullName,
    provider: row.provider as LoopProvider,
    model: row.model,
    taskId: row.taskId,
    status: row.status as LoopRunStatus,
    failureCode: (row.failureCode as LoopRunFailureCode | null) ?? null,
    error: row.error,
    retryAfter: row.retryAfter ? row.retryAfter.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
    task:
      row.taskId && task?.taskStatus
        ? {
            id: row.taskId,
            status: task.taskStatus,
            completedAt: task.taskCompletedAt ? task.taskCompletedAt.toISOString() : null,
            prUrl:
              task.taskPrOwner && task.taskPrRepo && task.taskPrNumber
                ? `https://github.com/${task.taskPrOwner}/${task.taskPrRepo}/pull/${task.taskPrNumber}`
                : null,
            prNumber: task.taskPrNumber ?? null,
          }
        : null,
  };
}

// ---- CRUD ----------------------------------------------------------------

export async function listLoops(workspaceId: string): Promise<LoopWithStats[]> {
  const rows = await getDbClient()
    .select()
    .from(loopsTable)
    .where(eq(loopsTable.workspaceId, workspaceId))
    .orderBy(desc(loopsTable.createdAt));
  const defs = rows.map(rowToLoop);
  const stats = await statsFor(defs.map((d) => d.id));
  return defs.map((d) => ({ ...d, stats: stats.get(d.id) ?? emptyStats() }));
}

/**
 * How many of a workspace's loops are enabled — the nav badge.
 *
 * Its own query rather than `listLoops(...).filter(...)`, for the reason
 * `countWorkflowsQuery` gives: this runs on every client boot, and the list
 * read is a `SELECT *` plus a group-by across the whole run history. Here the
 * count never leaves the database. Exported as a query so the egress test can
 * assert on `.toSQL()` without a live DB.
 */
export function countLoopsQuery(workspaceId: string) {
  return getDbClient()
    .select({
      enabled: sql<number>`count(*) filter (where ${loopsTable.enabled})::int`,
    })
    .from(loopsTable)
    .where(eq(loopsTable.workspaceId, workspaceId));
}

export async function countLoops(workspaceId: string): Promise<{ enabled: number }> {
  const rows = await countLoopsQuery(workspaceId);
  return { enabled: Number(rows[0]?.enabled ?? 0) };
}

export async function getLoop(id: string): Promise<LoopDefinition | null> {
  const rows = await getDbClient()
    .select()
    .from(loopsTable)
    .where(eq(loopsTable.id, id))
    .limit(1);
  return rows[0] ? rowToLoop(rows[0]) : null;
}

/**
 * When an enabled loop with this schedule next fires, or null when it never
 * does (`0 0 30 2 *`) or the loop is disabled.
 *
 * A disabled loop has no next run on purpose. Re-enabling recomputes from
 * `now`, which is what makes "turn it back on" mean *resume*, rather than
 * "fire everything that was missed while it was off".
 */
function scheduleFrom(input: NormalizedLoop, from: Date): Date | null {
  if (!input.enabled) return null;
  return nextLoopRun(input.cron, input.timezone, from);
}

export async function createLoop(
  workspaceId: string,
  input: NormalizedLoop
): Promise<LoopWithStats> {
  const now = new Date();
  const row = {
    id: uuid(),
    workspaceId,
    name: input.name,
    enabled: input.enabled,
    prompt: input.prompt,
    cron: input.cron,
    timezone: input.timezone,
    provider: input.provider,
    model: input.model,
    concurrency: input.concurrency,
    repositoryId: input.repositoryId,
    repoFullName: input.repoFullName,
    nextRunAt: scheduleFrom(input, now),
    disabledReason: null,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
  await getDbClient().insert(loopsTable).values(row);
  return { ...rowToLoop(row as LoopRow), stats: emptyStats() };
}

/**
 * Replace a loop wholesale.
 *
 * `next_run_at` is always recomputed, never carried over: the caller may have
 * changed the cron, the timezone or the enabled flag, and each of those moves
 * the next occurrence. Recomputing unconditionally is cheaper than working out
 * which edits matter, and it cannot be got wrong.
 *
 * `disabled_reason` and `consecutive_failures` are cleared, because any save is
 * the user saying the loop is now as they want it — leaving "turned off after
 * five failures" on a loop somebody has just fixed and re-enabled would switch
 * it off again on the next failure rather than the fifth.
 */
export async function updateLoop(
  id: string,
  input: NormalizedLoop
): Promise<LoopWithStats | null> {
  const now = new Date();
  await getDbClient()
    .update(loopsTable)
    .set({
      name: input.name,
      enabled: input.enabled,
      prompt: input.prompt,
      cron: input.cron,
      timezone: input.timezone,
      provider: input.provider,
      model: input.model,
      concurrency: input.concurrency,
      repositoryId: input.repositoryId,
      repoFullName: input.repoFullName,
      nextRunAt: scheduleFrom(input, now),
      disabledReason: null,
      consecutiveFailures: 0,
      updatedAt: now,
    })
    .where(eq(loopsTable.id, id));
  const def = await getLoop(id);
  if (!def) return null;
  const stats = await statsFor([id]);
  return { ...def, stats: stats.get(id) ?? emptyStats() };
}

export async function deleteLoop(id: string): Promise<void> {
  // `loop_runs` cascades: a rule the user has removed leaves nothing for a
  // history to be the history OF.
  await getDbClient().delete(loopsTable).where(eq(loopsTable.id, id));
}

// ---- Stats ---------------------------------------------------------------

function emptyStats(): LoopStats {
  return { runsTotal: 0, runs7d: 0, failures7d: 0, lastRunAt: null, lastStatus: null };
}

/**
 * One aggregate per loop, in one query however many loops there are.
 *
 * `skipped` is excluded from the run counts throughout — an overlap refusal is
 * not a time the loop fired, and counting it would make a loop that is standing
 * down every minute look like the busiest one on the page.
 *
 * `lastRunAt`/`lastStatus` deliberately DO include skips: the last thing that
 * happened is the last thing that happened, and hiding a wall of skips is how a
 * loop that has not run for a week looks healthy.
 */
export async function statsFor(loopIds: string[]): Promise<Map<string, LoopStats>> {
  const out = new Map<string, LoopStats>();
  if (loopIds.length === 0) return out;
  const rows = await getDbClient()
    .select({
      loopId: runsTable.loopId,
      runsTotal: sql<number>`count(*) filter (where ${runsTable.status} <> 'skipped')::int`,
      runs7d: sql<number>`count(*) filter (where ${runsTable.status} <> 'skipped' and ${runsTable.createdAt} > now() - interval '7 days')::int`,
      // `waiting_slot` is owed work, not a failure. Badging it as one would put
      // a problem marker on a loop that is about to run perfectly well.
      failures7d: sql<number>`count(*) filter (where ${runsTable.status} = 'failed' and ${runsTable.createdAt} > now() - interval '7 days')::int`,
      lastRunAt: sql<Date | null>`max(${runsTable.createdAt})`,
      lastStatus: sql<
        string | null
      >`(array_agg(${runsTable.status} order by ${runsTable.createdAt} desc))[1]`,
    })
    .from(runsTable)
    .where(inArray(runsTable.loopId, loopIds))
    .groupBy(runsTable.loopId);

  for (const r of rows) {
    out.set(r.loopId, {
      runsTotal: Number(r.runsTotal ?? 0),
      runs7d: Number(r.runs7d ?? 0),
      failures7d: Number(r.failures7d ?? 0),
      lastRunAt: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
      lastStatus: (r.lastStatus as LoopRunStatus | null) ?? null,
    });
  }
  return out;
}

// ---- History -------------------------------------------------------------

/**
 * A page of one loop's history, newest first.
 *
 * Keyset paginated on `created_at` rather than OFFSET: the history grows at the
 * head, so an offset page shifts under the reader between requests.
 *
 * The task is LEFT-joined, and through it the PR the run opened. A left join
 * because `task_id` is nullable in two different ways — a run that never got as
 * far as creating one, and a run whose task was later deleted — and both must
 * still render.
 */
export async function listLoopRuns(
  loopId: string,
  opts: { limit: number; cursor?: string | null }
): Promise<LoopRun[]> {
  const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
  const valid = cursorDate && !Number.isNaN(cursorDate.getTime()) ? cursorDate : null;
  const rows = await getDbClient()
    .select({ run: runsTable, ...RUN_TASK_COLUMNS })
    .from(runsTable)
    .leftJoin(tasksTable, eq(tasksTable.id, runsTable.taskId))
    .leftJoin(prTable, eq(prTable.id, tasksTable.pullRequestId))
    .where(
      valid
        ? and(eq(runsTable.loopId, loopId), lt(runsTable.createdAt, valid))
        : eq(runsTable.loopId, loopId)
    )
    .orderBy(desc(runsTable.createdAt))
    .limit(opts.limit);
  return rows.map((r) => rowToLoopRun(r.run, r));
}

/** One run with its task join — what a settle broadcasts. */
export async function getLoopRun(id: string): Promise<LoopRun | null> {
  const rows = await getDbClient()
    .select({ run: runsTable, ...RUN_TASK_COLUMNS })
    .from(runsTable)
    .leftJoin(tasksTable, eq(tasksTable.id, runsTable.taskId))
    .leftJoin(prTable, eq(prTable.id, tasksTable.pullRequestId))
    .where(eq(runsTable.id, id))
    .limit(1);
  return rows[0] ? rowToLoopRun(rows[0].run, rows[0]) : null;
}
