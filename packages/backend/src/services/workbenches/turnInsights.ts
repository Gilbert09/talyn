import { asc, eq, sql } from 'drizzle-orm';
import {
  computeTurnTiming,
  extractSetupSteps,
  redactSecrets,
  sumTurnTimings,
  type BakeStepResult,
  type TurnTimeReport,
  type TurnToolCall,
  type WorkbenchTiming,
} from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { workbenchChats, workbenchTurnTimings as timings } from '../../db/schema.js';
import { createConcurrencyLimit } from '../concurrencyLimit.js';
import { debugBus } from '../debugBus.js';
import { fleetClientFor, repoDirFor } from './sandboxRuntime.js';
import { hasImageSteps, learningDisabled, noteImageResults, recordSetupSteps, recordStepUses } from './setupLayers.js';
import { getWorkbench, type WorkbenchRow } from './store.js';

/**
 * Work that runs after a turn ends and never holds the turn up: the turn's time
 * report, and setup learning from its tool calls. One read of the transcript
 * per turn, and that read returns only the fields of the tool calls, never
 * whole events.
 */

const db = () => getPoolDbClient();

/** Each job holds a pooled connection for a few queries; two at a time keeps a burst of turn ends off the pool. */
const limit = createConcurrencyLimit(2);
const pending = new Set<Promise<unknown>>();

/** A host is asked for its bake results at most this often per repository. */
const BAKE_CHECK_INTERVAL_MS = 10 * 60_000;
const lastBakeCheck = new Map<string, number>();

/** Command text kept per call. Enough for any install line; a long script is not a setup step. */
const COMMAND_CHARS = 2000;
/** Output kept per FAILED call, head and tail, for "command not found". Output of a call that succeeded is not read. */
const OUTPUT_HEAD_CHARS = 1000;
const OUTPUT_TAIL_CHARS = 2000;

export interface TurnInsightsDeps {
  /** The latest bake results for the session's repository. */
  readBakeSteps?: (row: WorkbenchRow) => Promise<BakeStepResult[] | undefined>;
  now?: () => number;
}

interface LoadedTurn {
  startedAt: number;
  endedAt: number;
  calls: TurnToolCall[];
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

const epoch = (value: unknown): number => (value instanceof Date ? value.getTime() : new Date(String(value)).getTime());

/** The turn's bounds and its tool calls, paired by id, oldest first. */
export async function loadTurnToolCalls(chatId: string, turn: number): Promise<LoadedTurn | null> {
  const [bounds] = rowsOf<{ started_at: unknown; ended_at: unknown }>(await db().execute(sql`
    SELECT min(created_at) AS started_at, max(created_at) AS ended_at
    FROM workbench_events WHERE chat_id = ${chatId} AND turn = ${turn}
  `));
  if (!bounds?.started_at) return null;
  const rows = rowsOf<{
    at: unknown;
    type: string;
    id: string | null;
    name: string | null;
    command: string | null;
    tool_use_id: string | null;
    is_error: boolean | string | null;
    output: string | null;
  }>(await db().execute(sql`
    SELECT e.created_at AS at,
      b.block ->> 'type' AS type,
      b.block ->> 'id' AS id,
      b.block ->> 'name' AS name,
      left(b.block -> 'input' ->> 'command', ${COMMAND_CHARS}) AS command,
      b.block ->> 'tool_use_id' AS tool_use_id,
      coalesce(b.block ->> 'is_error', 'false') = 'true' AS is_error,
      CASE WHEN b.block ->> 'type' = 'tool_result' AND coalesce(b.block ->> 'is_error', 'false') = 'true' THEN (
        SELECT CASE WHEN length(t) <= ${OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS} THEN t
          ELSE left(t, ${OUTPUT_HEAD_CHARS}) || E'\n' || right(t, ${OUTPUT_TAIL_CHARS}) END
        FROM (SELECT CASE jsonb_typeof(b.block -> 'content')
          WHEN 'string' THEN b.block ->> 'content'
          WHEN 'array' THEN (SELECT string_agg(p ->> 'text', E'\n') FROM jsonb_array_elements(b.block -> 'content') AS p WHERE p ->> 'type' = 'text')
          ELSE '' END AS t) AS x
      ) END AS output
    FROM workbench_events e
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(e.event -> 'message' -> 'content') = 'array' THEN e.event -> 'message' -> 'content' ELSE '[]'::jsonb END
    ) AS b(block)
    WHERE e.chat_id = ${chatId} AND e.turn = ${turn}
      AND e.event ->> 'type' IN ('assistant', 'user')
      AND b.block ->> 'type' IN ('tool_use', 'tool_result')
    ORDER BY e.seq
  `));
  const calls = new Map<string, TurnToolCall>();
  for (const row of rows) {
    if (row.type === 'tool_use' && row.id && !calls.has(row.id)) {
      calls.set(row.id, {
        id: row.id,
        name: row.name ?? 'unknown',
        ...(row.command ? { command: row.command } : {}),
        startedAt: epoch(row.at),
        endedAt: null,
      });
    } else if (row.type === 'tool_result' && row.tool_use_id) {
      const call = calls.get(row.tool_use_id);
      if (!call || call.endedAt !== null) continue;
      call.endedAt = epoch(row.at);
      if (row.is_error === true || row.is_error === 't' || row.is_error === 'true') {
        call.isError = true;
        if (row.output) call.output = row.output;
      }
    }
  }
  return { startedAt: epoch(bounds.started_at), endedAt: epoch(bounds.ended_at), calls: [...calls.values()] };
}

export async function storeTurnTiming(chatId: string, turn: number, workbenchId: string, report: TurnTimeReport): Promise<void> {
  const values = {
    wallMs: report.wallMs,
    toolMs: report.toolMs,
    modelMs: report.modelMs,
    calls: report.calls,
    categories: report.categories,
    slowest: report.slowest,
  };
  await db()
    .insert(timings)
    .values({ chatId, turn, workbenchId, ...values })
    .onConflictDoUpdate({ target: [timings.chatId, timings.turn], set: values });
}

async function readBakeStepsFromFleet(row: WorkbenchRow): Promise<BakeStepResult[] | undefined> {
  if (!row.sandboxId) return undefined;
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  const { sandbox } = await client.getSandbox(row.sandboxId);
  return sandbox.layerStepResults ?? sandbox.bakeSteps;
}

/** Take a learned step out of the bake when the bake says it failed. At most every ten minutes per repository. */
async function checkBakeResults(row: WorkbenchRow, deps: TurnInsightsDeps): Promise<void> {
  const repositoryId = row.repositoryId!;
  const now = deps.now?.() ?? Date.now();
  if (now - (lastBakeCheck.get(repositoryId) ?? 0) < BAKE_CHECK_INTERVAL_MS) return;
  lastBakeCheck.set(repositoryId, now);
  if (!(await hasImageSteps(repositoryId))) return;
  const results = await (deps.readBakeSteps ?? readBakeStepsFromFleet)(row);
  if (results?.length) await noteImageResults(repositoryId, results, row.workspaceId);
}

/**
 * The time report and setup learning for one ended turn. Sandbox sessions only:
 * a local turn's events are stored when the desktop uploads them, so their
 * times say nothing about the turn.
 */
export async function analyseTurn(chatId: string, turn: number, deps: TurnInsightsDeps = {}): Promise<TurnTimeReport | null> {
  const [chat] = await db().select({ workbenchId: workbenchChats.workbenchId }).from(workbenchChats).where(eq(workbenchChats.id, chatId)).limit(1);
  if (!chat) return null;
  const row = await getWorkbench(chat.workbenchId);
  if (!row || row.runtime !== 'sandbox') return null;
  const loaded = await loadTurnToolCalls(chatId, turn);
  if (!loaded) return null;
  const report = computeTurnTiming(loaded);
  await storeTurnTiming(chatId, turn, row.id, report);

  if (!row.repositoryId || row.kind === 'thread' || (await learningDisabled(row.repositoryId))) return report;
  const extraction = extractSetupSteps(loaded.calls, { repoDir: repoDirFor(row) });
  for (const refused of extraction.refused) {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'step_refused',
      summary: `Did not learn a setup step: ${refused.reason} Command: ${redactSecrets(refused.command).slice(0, 200)}`,
      workspaceId: row.workspaceId,
      meta: { repositoryId: row.repositoryId, workbenchId: row.id },
    });
  }
  if (extraction.steps.length > 0) {
    await recordSetupSteps({
      repositoryId: row.repositoryId,
      workspaceId: row.workspaceId,
      workbenchId: row.id,
      source: 'learned',
      candidates: extraction.steps,
    });
  }
  await recordStepUses({ repositoryId: row.repositoryId, workbenchId: row.id, calls: loaded.calls });
  await checkBakeResults(row, deps).catch((error) => {
    debugBus.recordEvent({
      service: 'setup_recipe',
      action: 'bake_check_failed',
      summary: 'Could not read the bake results for the setup recipe.',
      ok: false,
      error,
      workspaceId: row.workspaceId,
      meta: { repositoryId: row.repositoryId },
    });
  });
  return report;
}

/** Start {@link analyseTurn} in the background. It never throws: failures go to the debug bus. */
export function scheduleTurnInsights(chatId: string, turn: number, deps?: TurnInsightsDeps): void {
  const job = runWithoutScope(() => limit(() => analyseTurn(chatId, turn, deps)))
    .catch((error: unknown) => {
      debugBus.recordEvent({
        service: 'workbench',
        action: 'turn_insights_failed',
        summary: 'The time report or the setup learning of a turn failed.',
        ok: false,
        error,
        meta: { chatId, turn },
      });
    })
    .finally(() => pending.delete(job));
  pending.add(job);
}

/** Tests: wait for the scheduled jobs. */
export async function settleTurnInsightsForTests(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

export function resetTurnInsightsForTests(): void {
  lastBakeCheck.clear();
}

/** Turns listed in the response. Display only: the totals count every turn. */
const RECENT_TURNS = 50;

/** `GET /workbenches/:id/timing`. Small rows only; the transcript is not read. */
export async function getWorkbenchTiming(workbenchId: string): Promise<WorkbenchTiming> {
  const rows = await db()
    .select({
      chatId: timings.chatId,
      turn: timings.turn,
      wallMs: timings.wallMs,
      toolMs: timings.toolMs,
      modelMs: timings.modelMs,
      calls: timings.calls,
      categories: timings.categories,
      slowest: timings.slowest,
      createdAt: timings.createdAt,
    })
    .from(timings)
    .where(eq(timings.workbenchId, workbenchId))
    .orderBy(asc(timings.createdAt));
  const total = sumTurnTimings(
    workbenchId,
    rows.map((r) => ({
      chatId: r.chatId,
      turn: r.turn,
      wallMs: Number(r.wallMs),
      toolMs: Number(r.toolMs),
      modelMs: Number(r.modelMs),
      calls: r.calls,
      categories: r.categories,
      slowest: r.slowest,
      at: r.createdAt.toISOString(),
    })),
  );
  return { ...total, recentTurns: total.recentTurns.slice(0, RECENT_TURNS) };
}
