import { v4 as uuid } from 'uuid';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type {
  NormalizedWorkflow,
  WorkflowActionOutcome,
  WorkflowCounts,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStats,
  WorkflowTriggerEvent,
  WorkflowWithStats,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { workflowRuns as runsTable, workflows as workflowsTable } from '../../db/schema.js';

/**
 * Reads and writes for the two workflow tables.
 *
 * Two things here are load-bearing beyond plain CRUD:
 *
 *  - **the enabled-workflow read is cached per workspace.** It runs on the
 *    webhook worker's hot path, once per delivery per watching workspace, and a
 *    busy repo delivers many times a minute. The cache is invalidated by every
 *    write rather than only by its TTL, so a user who disables a workflow does
 *    not watch it fire for another minute.
 *  - **stats are aggregated, never stored.** A `runs_total` column drifts the
 *    first time a write path forgets to bump it; an aggregate cannot.
 */

// ---- Row → API shape ------------------------------------------------------

type WorkflowRow = typeof workflowsTable.$inferSelect;
type RunRow = typeof runsTable.$inferSelect;

function rowToWorkflow(row: WorkflowRow): WorkflowDefinition {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    enabled: row.enabled,
    events: (row.events ?? []) as WorkflowTriggerEvent[],
    conditions: (row.conditions ?? {}) as WorkflowDefinition['conditions'],
    actions: (row.actions ?? []) as WorkflowDefinition['actions'],
    maxRunsPerPrPerHour: row.maxRunsPerPrPerHour,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function rowToWorkflowRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workspaceId: row.workspaceId,
    repositoryId: row.repositoryId,
    repoFullName: row.repoFullName,
    prNumber: row.prNumber,
    prTitle: row.prTitle,
    prUrl: row.prUrl,
    prAuthor: row.prAuthor,
    pullRequestId: row.pullRequestId,
    taskId: row.taskId,
    event: row.event as WorkflowTriggerEvent,
    status: row.status as WorkflowRunStatus,
    actions: (row.actions ?? []) as WorkflowActionOutcome[],
    error: row.error,
    retryAfter: row.retryAfter ? row.retryAfter.toISOString() : null,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---- The hot-path cache ---------------------------------------------------

/**
 * How long an enabled-workflow list may be served from memory.
 *
 * Short on purpose: every write invalidates the entry, so the TTL only covers
 * a write made by ANOTHER replica. 30s matches `webhookIndex`'s own refresh
 * interval — the delay before a new workflow starts firing is already bounded
 * by that index, so a tighter TTL here buys nothing.
 */
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  workflows: WorkflowDefinition[];
}

const enabledCache = new Map<string, CacheEntry>();

/** Drop a workspace's cached list. Called by every write. */
export function invalidateWorkflowCache(workspaceId: string): void {
  enabledCache.delete(workspaceId);
}

/** Test hook. */
export function _resetWorkflowStore(): void {
  enabledCache.clear();
}

/**
 * Every enabled workflow in a workspace, memoised. Returns `[]` for a
 * workspace with none, which is the overwhelmingly common answer and the one
 * the cache exists to make free.
 */
export async function enabledWorkflowsFor(
  workspaceId: string,
  nowMs: number = Date.now()
): Promise<WorkflowDefinition[]> {
  const hit = enabledCache.get(workspaceId);
  if (hit && nowMs - hit.at < CACHE_TTL_MS) return hit.workflows;
  const rows = await getDbClient()
    .select()
    .from(workflowsTable)
    .where(and(eq(workflowsTable.workspaceId, workspaceId), eq(workflowsTable.enabled, true)));
  const workflows = rows.map(rowToWorkflow);
  enabledCache.set(workspaceId, { at: nowMs, workflows });
  return workflows;
}

// ---- CRUD ----------------------------------------------------------------

export async function listWorkflows(workspaceId: string): Promise<WorkflowWithStats[]> {
  const rows = await getDbClient()
    .select()
    .from(workflowsTable)
    .where(eq(workflowsTable.workspaceId, workspaceId))
    .orderBy(desc(workflowsTable.createdAt));
  const defs = rows.map(rowToWorkflow);
  const stats = await statsFor(defs.map((d) => d.id));
  return defs.map((d) => ({ ...d, stats: stats.get(d.id) ?? emptyStats() }));
}

/**
 * How many of a workspace's workflows are enabled.
 *
 * Deliberately NOT `listWorkflows(...).filter(...).length`: this runs on every
 * client boot to draw the nav badge, and `listWorkflows` is a `SELECT *` over
 * three jsonb columns plus a seven-aggregate group-by across the entire run
 * history. Here the count never leaves the database and no row ships.
 *
 * The query is built by its own exported function purely so the egress guard in
 * `workflowCount.test.ts` can assert on `.toSQL()` — the same trick
 * `projectionEgress.test.ts` uses to prove a projection without a live DB.
 */
export function countWorkflowsQuery(workspaceId: string) {
  return getDbClient()
    .select({
      enabled: sql<number>`count(*) filter (where ${workflowsTable.enabled})::int`,
    })
    .from(workflowsTable)
    .where(eq(workflowsTable.workspaceId, workspaceId));
}

export async function countWorkflows(workspaceId: string): Promise<WorkflowCounts> {
  const rows = await countWorkflowsQuery(workspaceId);
  return { enabled: Number(rows[0]?.enabled ?? 0) };
}

export async function getWorkflow(id: string): Promise<WorkflowDefinition | null> {
  const rows = await getDbClient()
    .select()
    .from(workflowsTable)
    .where(eq(workflowsTable.id, id))
    .limit(1);
  return rows[0] ? rowToWorkflow(rows[0]) : null;
}

export async function createWorkflow(
  workspaceId: string,
  input: NormalizedWorkflow
): Promise<WorkflowWithStats> {
  const now = new Date();
  const row = {
    id: uuid(),
    workspaceId,
    name: input.name,
    enabled: input.enabled,
    events: input.events,
    conditions: input.conditions,
    actions: input.actions,
    maxRunsPerPrPerHour: input.maxRunsPerPrPerHour,
    createdAt: now,
    updatedAt: now,
  };
  await getDbClient().insert(workflowsTable).values(row);
  invalidateWorkflowCache(workspaceId);
  return { ...rowToWorkflow(row as WorkflowRow), stats: emptyStats() };
}

export async function updateWorkflow(
  id: string,
  workspaceId: string,
  input: NormalizedWorkflow
): Promise<WorkflowWithStats | null> {
  await getDbClient()
    .update(workflowsTable)
    .set({
      name: input.name,
      enabled: input.enabled,
      events: input.events,
      conditions: input.conditions,
      actions: input.actions,
      maxRunsPerPrPerHour: input.maxRunsPerPrPerHour,
      updatedAt: new Date(),
    })
    .where(eq(workflowsTable.id, id));
  invalidateWorkflowCache(workspaceId);
  const def = await getWorkflow(id);
  if (!def) return null;
  const stats = await statsFor([id]);
  return { ...def, stats: stats.get(id) ?? emptyStats() };
}

export async function deleteWorkflow(id: string, workspaceId: string): Promise<void> {
  // `workflow_runs` cascades — deleting a workflow deletes its history, which
  // is the right call for a rule the user has removed: there is nothing left
  // for the history to be the history OF.
  await getDbClient().delete(workflowsTable).where(eq(workflowsTable.id, id));
  invalidateWorkflowCache(workspaceId);
}

// ---- Stats ---------------------------------------------------------------

function emptyStats(): WorkflowStats {
  return {
    runsTotal: 0,
    runs24h: 0,
    runs7d: 0,
    failures7d: 0,
    tasksStarted: 0,
    lastRunAt: null,
    lastStatus: null,
  };
}

/**
 * One aggregate for every workflow in the list.
 *
 * `FILTER (WHERE …)` rather than several round-trips, and
 * `(array_agg(status ORDER BY created_at DESC))[1]` for the newest run's status
 * rather than a second query per workflow — the list page renders all of this
 * at once, so it should cost one query however many workflows there are.
 */
export async function statsFor(workflowIds: string[]): Promise<Map<string, WorkflowStats>> {
  const out = new Map<string, WorkflowStats>();
  if (workflowIds.length === 0) return out;
  const rows = await getDbClient()
    .select({
      workflowId: runsTable.workflowId,
      // `skipped` is excluded from the run counts throughout: a refusal (the
      // rate cap, a guard standing down) is not a time the workflow fired, and
      // counting it would make a looping rule look busy rather than stuck.
      runsTotal: sql<number>`count(*) filter (where ${runsTable.status} <> 'skipped')::int`,
      runs24h: sql<number>`count(*) filter (where ${runsTable.status} <> 'skipped' and ${runsTable.createdAt} > now() - interval '24 hours')::int`,
      runs7d: sql<number>`count(*) filter (where ${runsTable.status} <> 'skipped' and ${runsTable.createdAt} > now() - interval '7 days')::int`,
      // A parked run is not a failure — it is owed work. Counting it as one would
      // put a "problems this week" badge on a workflow that is about to succeed.
      failures7d: sql<number>`count(*) filter (where ${runsTable.status} in ('failed', 'partial') and ${runsTable.createdAt} > now() - interval '7 days')::int`,
      tasksStarted: sql<number>`count(${runsTable.taskId})::int`,
      lastRunAt: sql<Date | null>`max(${runsTable.createdAt})`,
      lastStatus: sql<
        string | null
      >`(array_agg(${runsTable.status} order by ${runsTable.createdAt} desc))[1]`,
    })
    .from(runsTable)
    .where(inArray(runsTable.workflowId, workflowIds))
    .groupBy(runsTable.workflowId);

  for (const r of rows) {
    out.set(r.workflowId, {
      runsTotal: Number(r.runsTotal ?? 0),
      runs24h: Number(r.runs24h ?? 0),
      runs7d: Number(r.runs7d ?? 0),
      failures7d: Number(r.failures7d ?? 0),
      tasksStarted: Number(r.tasksStarted ?? 0),
      lastRunAt: r.lastRunAt ? new Date(r.lastRunAt).toISOString() : null,
      lastStatus: (r.lastStatus as WorkflowRunStatus | null) ?? null,
    });
  }
  return out;
}

// ---- History -------------------------------------------------------------

/**
 * A page of one workflow's history, newest first.
 *
 * Keyset paginated on `created_at` rather than OFFSET: the history grows at the
 * head, so an offset page shifts under the reader between requests. `cursor` is
 * the `createdAt` of the last row the caller already has.
 */
export async function listWorkflowRuns(
  workflowId: string,
  opts: { limit: number; cursor?: string | null }
): Promise<WorkflowRun[]> {
  const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
  const valid = cursorDate && !Number.isNaN(cursorDate.getTime()) ? cursorDate : null;
  const rows = await getDbClient()
    .select()
    .from(runsTable)
    .where(
      valid
        ? and(eq(runsTable.workflowId, workflowId), lt(runsTable.createdAt, valid))
        : eq(runsTable.workflowId, workflowId)
    )
    .orderBy(desc(runsTable.createdAt))
    .limit(opts.limit);
  return rows.map(rowToWorkflowRun);
}
