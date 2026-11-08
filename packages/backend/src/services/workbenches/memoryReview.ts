import { v4 as uuid } from 'uuid';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  fleetAgentForModel,
  memoryReviewCadenceOf,
  memoryReviewPeriodStart,
  memoryReviewPrompt,
  MEMORY_REVIEW_THREAD_NAME,
  MIN_ENTRIES_FOR_MEMORY_REVIEW,
  type FleetAgent,
  type MemoryReviewRun,
  type MemoryReviewState,
  type MemoryReviewStatus,
  type MemoryReviewTrigger,
  type WorkspaceSettings,
} from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { memoryReviewRuns as runs, users, workspaces } from '../../db/schema.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { workspaceHasFeature } from '../featureFlags.js';
import { fleetAgentStatus } from '../selfHosted/credentials.js';
import { workspaceAgentModel, workspaceFleetModel } from '../selfHosted/fleetModel.js';
import { TickGuard } from '../tickGuard.js';
import { requestArchiveAfterTurn } from './autoArchive.js';
import { createWorkbench } from './create.js';
import { WorkbenchError } from './errors.js';

/**
 * Memory review: a thread that Talyn starts to clean up a workspace's memory
 * (`memoryReview.ts` in `@talyn/shared`). The schedule is the workspace
 * setting plus a row per period in `memory_review_runs`, never a timer, so a
 * deploy loses nothing. The insert of the period row is the claim: two
 * replicas compute the same key, and only the winner starts a thread.
 *
 * The thread uses the ordinary `talyn_memory_*` tools. Its source
 * (`memory_review`) widens what those tools see to every entry of the
 * workspace (`mcp/tools/memory.ts`).
 */

const db = () => getPoolDbClient();

/** How often the sweep looks. A review is at most daily, so an hour is early enough. */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** The first sweep after boot. Every push to main redeploys, so an hourly timer alone could never fire. */
export const BOOT_DELAY_MS = 90_000;
/** How many runs `GET /workbenches/memory/reviews` returns. */
const RECENT_RUNS = 5;

type RunRow = typeof runs.$inferSelect;

function toRun(row: RunRow): MemoryReviewRun {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    trigger: row.trigger as MemoryReviewTrigger,
    status: row.status as MemoryReviewStatus,
    workbenchId: row.workbenchId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMemoryReviewRuns(workspaceId: string, limit = RECENT_RUNS): Promise<MemoryReviewRun[]> {
  const rows = await db()
    .select()
    .from(runs)
    .where(eq(runs.workspaceId, workspaceId))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows.map(toRun);
}

async function workspaceSettings(workspaceId: string): Promise<WorkspaceSettings | null> {
  const [row] = await db()
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return (row?.settings as WorkspaceSettings | null) ?? null;
}

export async function memoryReviewState(workspaceId: string): Promise<MemoryReviewState> {
  return {
    cadence: memoryReviewCadenceOf(await workspaceSettings(workspaceId)),
    runs: await listMemoryReviewRuns(workspaceId),
  };
}

/** The newest review that started a thread. */
async function lastStartedRun(workspaceId: string): Promise<RunRow | null> {
  const [row] = await db()
    .select()
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), eq(runs.status, 'started')))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row ?? null;
}

/** Whether a review thread still works: a turn runs, or a message waits for the box. */
async function reviewInProgress(workbenchId: string | null): Promise<boolean> {
  if (!workbenchId) return false;
  const result = await db().execute(sql`
    SELECT 1 AS busy FROM workbench_chats c JOIN workbenches w ON w.id = c.workbench_id
    WHERE c.workbench_id = ${workbenchId} AND w.archived_at IS NULL AND c.closed_at IS NULL
      AND (c.status = 'running' OR jsonb_array_length(c.queued_messages) > 0)
    LIMIT 1
  `);
  return rowsOf(result).length > 0;
}

/**
 * The live entries, and how many of them changed after `since`. A change that
 * the last review thread made itself does not count, or each review would make
 * the next one run.
 */
export async function memoryChangeStats(
  workspaceId: string,
  since: Date | null,
  reviewWorkbenchId: string | null,
): Promise<{ live: number; changed: number }> {
  const sinceIso = since ? since.toISOString() : null;
  const result = await db().execute(sql`
    SELECT
      count(*)::int AS live,
      count(*) FILTER (
        WHERE ${sinceIso}::timestamptz IS NULL
          OR (updated_at > ${sinceIso}::timestamptz
            AND coalesce(source ->> 'workbenchId', '') <> ${reviewWorkbenchId ?? ''})
      )::int AS changed
    FROM workspace_memories
    WHERE workspace_id = ${workspaceId} AND forgotten_at IS NULL
  `);
  const [row] = rowsOf<{ live: number | string; changed: number | string }>(result);
  return { live: Number(row?.live ?? 0), changed: Number(row?.changed ?? 0) };
}

/** The connected agent to run the review on: the workspace's chosen one when it is connected. */
async function reviewAgentModel(workspaceId: string): Promise<{ agent: FleetAgent; model: string }> {
  const { connectedAgents } = await fleetAgentStatus(workspaceId);
  if (connectedAgents.length === 0) {
    throw new WorkbenchError(
      'Talyn Fleet has no Claude or Codex subscription connected. Connect one in Settings → Talyn Fleet.',
      409,
      'agent_not_connected',
    );
  }
  const preferred = await workspaceFleetModel(workspaceId);
  const preferredAgent = preferred ? fleetAgentForModel(preferred) : null;
  const agent = preferredAgent && connectedAgents.includes(preferredAgent) ? preferredAgent : connectedAgents[0];
  return { agent, model: await workspaceAgentModel(workspaceId, agent) };
}

async function workspaceOwner(workspaceId: string): Promise<{ id: string; email: string } | null> {
  const [row] = await db()
    .select({ id: users.id, email: users.email })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row ?? null;
}

/**
 * Claim the period and start the review thread. Null when another caller
 * already claimed this period. A failure to start the thread is kept on the
 * row as `failed`, so the app can show why.
 *
 * The previous review thread is archived (after its turn, when one runs), so
 * the sidebar holds one review thread at a time.
 */
export async function startMemoryReview(
  workspaceId: string,
  opts: { trigger: MemoryReviewTrigger; periodStart: Date },
): Promise<MemoryReviewRun | null> {
  const previous = await lastStartedRun(workspaceId);
  const id = uuid();
  const [claimed] = await db()
    .insert(runs)
    .values({ id, workspaceId, periodStart: opts.periodStart, trigger: opts.trigger, status: 'starting' })
    .onConflictDoNothing({ target: [runs.workspaceId, runs.periodStart] })
    .returning();
  if (!claimed) return null;

  let update: Partial<RunRow>;
  try {
    const owner = await workspaceOwner(workspaceId);
    if (!owner) throw new WorkbenchError('The workspace owner no longer exists.', 409, 'owner_missing');
    const { agent, model } = await reviewAgentModel(workspaceId);
    const thread = await createWorkbench(
      {
        workspaceId,
        kind: 'thread',
        runtime: 'sandbox',
        agent,
        model,
        prompt: memoryReviewPrompt(),
        namingText: MEMORY_REVIEW_THREAD_NAME,
        source: { kind: 'memory_review', runId: id },
      },
      owner,
    );
    update = { status: 'started', workbenchId: thread.id };
  } catch (err) {
    update = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
  const [row] = await db().update(runs).set(update).where(eq(runs.id, id)).returning();

  if (update.status === 'started' && previous?.workbenchId) {
    await requestArchiveAfterTurn(previous.workbenchId).catch((err) => {
      console.warn(`[memory-review] could not archive the previous review thread ${previous.workbenchId}:`, err);
    });
  }
  return toRun(row ?? { ...claimed, ...update });
}

/** Why a request for a review now is refused, or null. */
export async function manualReviewRefusal(workspaceId: string): Promise<WorkbenchError | null> {
  const settings = await workspaceSettings(workspaceId);
  if (settings?.sessionMemory === false) {
    return new WorkbenchError('Session memory is off for this workspace.', 409, 'memory_off');
  }
  const last = await lastStartedRun(workspaceId);
  if (await reviewInProgress(last?.workbenchId ?? null)) {
    return new WorkbenchError('A memory review is already running.', 409, 'memory_review_running');
  }
  const { live } = await memoryChangeStats(workspaceId, null, null);
  if (live < MIN_ENTRIES_FOR_MEMORY_REVIEW) {
    return new WorkbenchError('There is nothing to review: the workspace has fewer than two memory entries.', 409, 'memory_review_too_few');
  }
  return null;
}

export type MemoryReviewSkip =
  | 'cadence_off'
  | 'memory_off'
  | 'already_ran'
  | 'flag_off'
  | 'running'
  | 'too_few_entries'
  | 'unchanged';

export type MemoryReviewSweepResult = { started: MemoryReviewRun } | { skipped: MemoryReviewSkip };

/** Start this period's scheduled review for one workspace, when one is due. */
export async function sweepMemoryReviewWorkspace(
  workspaceId: string,
  settings: WorkspaceSettings | null,
  now: Date,
): Promise<MemoryReviewSweepResult> {
  const cadence = memoryReviewCadenceOf(settings);
  const periodStart = memoryReviewPeriodStart(cadence, now);
  if (!periodStart) return { skipped: 'cadence_off' };
  if (settings?.sessionMemory === false) return { skipped: 'memory_off' };

  const [existing] = await db()
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), eq(runs.periodStart, periodStart)))
    .limit(1);
  if (existing) return { skipped: 'already_ran' };

  // The owner gate, after the cheap checks: a sweep has no caller.
  if (!(await workspaceHasFeature('memoryReview', workspaceId)).enabled) return { skipped: 'flag_off' };

  const last = await lastStartedRun(workspaceId);
  if (await reviewInProgress(last?.workbenchId ?? null)) return { skipped: 'running' };
  const stats = await memoryChangeStats(workspaceId, last?.createdAt ?? null, last?.workbenchId ?? null);
  if (stats.live < MIN_ENTRIES_FOR_MEMORY_REVIEW) return { skipped: 'too_few_entries' };
  if (stats.changed === 0) return { skipped: 'unchanged' };

  const started = await startMemoryReview(workspaceId, { trigger: 'schedule', periodStart });
  return started ? { started } : { skipped: 'already_ran' };
}

/** One pass over the workspaces that set a cadence. One workspace's failure does not stop the rest. */
export async function runMemoryReviewSweep(now = new Date()): Promise<{ started: number; skipped: number }> {
  const rows = await db()
    .select({ id: workspaces.id, settings: workspaces.settings })
    .from(workspaces)
    .where(sql`${workspaces.settings} ->> 'memoryReview' IN ('daily', 'weekly', 'monthly')`);
  const outcome = { started: 0, skipped: 0 };
  for (const row of rows) {
    try {
      const result = await sweepMemoryReviewWorkspace(row.id, row.settings as WorkspaceSettings | null, now);
      if ('started' in result) outcome.started++;
      else outcome.skipped++;
    } catch (err) {
      console.warn(`[memory-review] sweep failed for workspace ${row.id.slice(0, 8)}:`, err instanceof Error ? err.message : err);
    }
  }
  return outcome;
}

const POLLER = 'memory_review_sweep';
const MAX_TICK_MS = 10 * 60_000;

class MemoryReviewSweep {
  private timer: NodeJS.Timeout | null = null;
  private bootTimer: NodeJS.Timeout | null = null;
  private guard = new TickGuard(POLLER, MAX_TICK_MS);

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      POLLER,
      SWEEP_INTERVAL_MS,
      'Starts a memory review thread for each workspace whose review period is due and whose memory changed since the last review.',
    );
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    this.bootTimer = setTimeout(() => void this.tick(), BOOT_DELAY_MS);
    this.bootTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.timer = null;
    this.bootTimer = null;
  }

  async tick(): Promise<void> {
    if (!this.guard.tryBegin()) return;
    const startedAt = Date.now();
    let error: unknown;
    try {
      await guardCrossReplica(`${POLLER}:tick`, () => runMemoryReviewSweep(), { maxHoldMs: MAX_TICK_MS });
    } catch (err) {
      error = err;
      console.warn('[memory-review] sweep failed:', err);
    } finally {
      this.guard.end();
      debugBus.pollerTick(POLLER, { durationMs: Date.now() - startedAt, ok: !error, error });
    }
  }
}

export const memoryReviewSweep = new MemoryReviewSweep();

/** Wrapped so the timer's work never inherits a request's transaction handle. */
export function initMemoryReviewSweep(): void {
  runWithoutScope(() => memoryReviewSweep.init());
}

function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  // postgres-js returns the rows array itself; pglite wraps them in `{ rows }`.
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}
