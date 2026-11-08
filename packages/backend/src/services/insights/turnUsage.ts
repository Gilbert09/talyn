import { and, eq, notInArray, sql, type SQL } from 'drizzle-orm';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { workbenchChats, workbenches, workbenchTurnUsage } from '../../db/schema.js';
import { createConcurrencyLimit } from '../concurrencyLimit.js';
import { debugBus } from '../debugBus.js';
import {
  buildTurnUsageRows,
  parseStoredResult,
  type ChatFacts,
  type StoredResultUsage,
  type TurnFacts,
  type TurnUsageRow,
} from './turnUsageRows.js';

/**
 * The live writer of `workbench_turn_usage`: after a turn's result event is
 * stored, read that turn's small facts out of the transcript ONCE and keep them
 * as a compact row. Insights reads the row and never the transcript.
 *
 * The transcript read returns only scalars and the result events' `usage`
 * objects, never whole events.
 */

const db = () => getPoolDbClient();

/** Each job holds a pooled connection for a few queries. */
const limit = createConcurrencyLimit(2);
const pending = new Set<Promise<unknown>>();

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

const toDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

/** The usage facts of every turn in `chatIds` (optionally one turn), one row per (chat, turn). */
export function turnFactsSql(chatIds: readonly string[], turn?: number): SQL {
  const ids = sql.join(chatIds.map((id) => sql`${id}`), sql`, `);
  const turnFilter = turn === undefined ? sql`` : sql` AND e.turn = ${turn}`;
  return sql`
    WITH ev AS (
      SELECT e.chat_id, e.turn, e.seq, e.created_at,
        e.event ->> 'type' AS type,
        CASE WHEN e.event ->> 'type' = 'user' AND e.event -> 'talyn' ->> 'kind' = 'user_message'
          AND (e.event -> 'talyn' ->> 'origin') IS DISTINCT FROM 'talyn'
          THEN e.event -> 'talyn' ->> 'sentAt' END AS sent_at,
        CASE WHEN e.event ->> 'type' = 'system' AND e.event ->> 'subtype' = 'init'
          THEN e.event ->> 'model' END AS init_model,
        CASE WHEN e.event ->> 'type' = 'system' AND e.event ->> 'subtype' = 'init'
          THEN COALESCE(e.event ->> 'agent', 'claude') END AS init_agent,
        CASE WHEN e.event ->> 'type' = 'user' AND e.event -> 'talyn' ->> 'kind' = 'user_message'
          AND e.event -> 'talyn' -> 'model' IS NOT NULL
          THEN COALESCE(e.event -> 'talyn' ->> 'model', '') END AS turn_model,
        CASE WHEN e.event ->> 'type' = 'result' THEN jsonb_build_object(
          'seq', e.seq, 'at', e.created_at, 'sessionId', e.event -> 'session_id',
          'usage', e.event -> 'usage', 'modelUsage', e.event -> 'modelUsage',
          'cost', e.event -> 'total_cost_usd', 'durationMs', e.event -> 'duration_ms',
          'numTurns', e.event -> 'num_turns', 'isError', e.event -> 'is_error', 'subtype', e.event -> 'subtype'
        ) END AS result
      FROM workbench_events e
      WHERE e.chat_id IN (${ids})${turnFilter}
    ), marked AS (
      SELECT ev.*, min(CASE WHEN sent_at IS NOT NULL THEN seq END) OVER (PARTITION BY chat_id, turn) AS user_seq
      FROM ev
    )
    SELECT chat_id, turn,
      min(created_at) AS started_at,
      max(created_at) AS ended_at,
      (array_agg(init_model ORDER BY seq) FILTER (WHERE init_model IS NOT NULL))[1] AS init_model,
      (array_agg(init_agent ORDER BY seq DESC) FILTER (WHERE init_agent IS NOT NULL))[1] AS init_agent,
      (array_agg(turn_model ORDER BY seq) FILTER (WHERE turn_model IS NOT NULL))[1] AS turn_model,
      (array_agg(sent_at ORDER BY seq) FILTER (WHERE sent_at IS NOT NULL))[1] AS sent_at,
      min(created_at) FILTER (WHERE type = 'assistant' AND seq > user_seq) AS reply_at,
      jsonb_agg(result ORDER BY seq) FILTER (WHERE result IS NOT NULL) AS results
    FROM marked
    GROUP BY chat_id, turn
    HAVING count(result) > 0
    ORDER BY chat_id, turn
  `;
}

interface TurnFactsRow {
  chat_id: string;
  turn: number | string;
  started_at: unknown;
  ended_at: unknown;
  init_model: string | null;
  init_agent?: string | null;
  turn_model?: string | null;
  sent_at: string | null;
  reply_at: unknown;
  results: unknown;
}

export function parseTurnFacts(row: TurnFactsRow): TurnFacts | null {
  const startedAt = toDate(row.started_at);
  const endedAt = toDate(row.ended_at);
  if (!startedAt || !endedAt) return null;
  const raw = typeof row.results === 'string' ? JSON.parse(row.results) : row.results;
  const results = (Array.isArray(raw) ? raw : []).map(parseStoredResult).filter((r): r is StoredResultUsage => r !== null);
  return {
    turn: Number(row.turn),
    startedAt,
    endedAt,
    initModel: row.init_model || null,
    initAgent: row.init_agent === 'codex' || row.init_agent === 'claude' ? row.init_agent : null,
    // '' is a stamped "agent default"; absent is an older turn with no stamp.
    turnModel: row.turn_model === null || row.turn_model === undefined ? undefined : row.turn_model || null,
    sentAt: toDate(row.sent_at),
    replyAt: toDate(row.reply_at),
    results,
  };
}

/** Facts for many chats at once, grouped by chat, turns oldest first. */
export async function loadTurnFacts(chatIds: readonly string[], turn?: number): Promise<Map<string, TurnFacts[]>> {
  const out = new Map<string, TurnFacts[]>();
  if (chatIds.length === 0) return out;
  const rows = rowsOf<TurnFactsRow>(await db().execute(turnFactsSql(chatIds, turn)));
  for (const row of rows) {
    const facts = parseTurnFacts(row);
    if (!facts) continue;
    const list = out.get(row.chat_id) ?? [];
    list.push(facts);
    out.set(row.chat_id, list);
  }
  return out;
}

/** The last result event of a chat before `turn`, for the Codex difference. */
export async function previousResult(chatId: string, turn: number): Promise<StoredResultUsage | null> {
  const [row] = rowsOf<{ seq: number | string; created_at: unknown; usage: unknown; session_id: unknown }>(await db().execute(sql`
    SELECT seq, created_at, event -> 'usage' AS usage, event ->> 'session_id' AS session_id
    FROM workbench_events
    WHERE chat_id = ${chatId} AND turn < ${turn} AND event ->> 'type' = 'result'
    ORDER BY seq DESC LIMIT 1
  `));
  if (!row) return null;
  return parseStoredResult({ seq: row.seq, at: toDate(row.created_at)?.toISOString(), sessionId: row.session_id, usage: typeof row.usage === 'string' ? JSON.parse(row.usage) : row.usage });
}

/** The chat columns the writer needs: the chat's agent and model, and the session's. */
export function chatFactsQuery(chatIds: readonly string[]) {
  return db()
    .select({
      chatId: workbenchChats.id,
      workbenchId: workbenchChats.workbenchId,
      workspaceId: workbenches.workspaceId,
      agent: workbenchChats.agent,
      model: workbenchChats.model,
      sessionAgent: workbenches.agent,
      sessionModel: workbenches.model,
    })
    .from(workbenchChats)
    .innerJoin(workbenches, eq(workbenches.id, workbenchChats.workbenchId))
    .where(sql`${workbenchChats.id} IN (${sql.join(chatIds.map((id) => sql`${id}`), sql`, `)})`);
}

export async function loadChatFacts(chatIds: readonly string[]): Promise<Map<string, ChatFacts>> {
  if (chatIds.length === 0) return new Map();
  const rows = await chatFactsQuery(chatIds);
  return new Map(rows.map((r) => [r.chatId, r]));
}

/** Every row of `chats` from their turn facts, carrying the Codex baseline from turn to turn. */
export function rowsForChat(chat: ChatFacts, turns: readonly TurnFacts[], previous: StoredResultUsage | null = null): TurnUsageRow[] {
  const out: TurnUsageRow[] = [];
  let baseline = previous;
  for (const facts of [...turns].sort((a, b) => a.turn - b.turn)) {
    out.push(...buildTurnUsageRows(chat, facts, baseline));
    const results = [...facts.results].sort((a, b) => a.seq - b.seq);
    if (results.length > 0) baseline = results[results.length - 1];
  }
  return out;
}

const UPDATE_COLUMNS = {
  workspaceId: sql`excluded.workspace_id`,
  workbenchId: sql`excluded.workbench_id`,
  agent: sql`excluded.agent`,
  isPrimary: sql`excluded.is_primary`,
  inputTokens: sql`excluded.input_tokens`,
  outputTokens: sql`excluded.output_tokens`,
  cacheReadTokens: sql`excluded.cache_read_tokens`,
  cacheWriteTokens: sql`excluded.cache_write_tokens`,
  costEstimateMicros: sql`excluded.cost_estimate_micros`,
  durationMs: sql`excluded.duration_ms`,
  agentSteps: sql`excluded.agent_steps`,
  firstReplyMs: sql`excluded.first_reply_ms`,
  isError: sql`excluded.is_error`,
  endedAt: sql`excluded.ended_at`,
};

/**
 * Store rows. `replace` (the live writer) overwrites a turn and drops models it
 * no longer has; otherwise (the backfill) a row already there wins.
 */
export async function storeTurnUsageRows(rows: readonly TurnUsageRow[], mode: 'replace' | 'keep'): Promise<number> {
  if (rows.length === 0) return 0;
  const insert = db().insert(workbenchTurnUsage).values([...rows]);
  const stored = mode === 'replace'
    ? await insert.onConflictDoUpdate({ target: [workbenchTurnUsage.chatId, workbenchTurnUsage.turn, workbenchTurnUsage.model], set: UPDATE_COLUMNS })
      .returning({ chatId: workbenchTurnUsage.chatId })
    : await insert.onConflictDoNothing().returning({ chatId: workbenchTurnUsage.chatId });
  return stored.length;
}

/** Record one ended turn. Returns the rows stored. */
export async function recordTurnUsage(chatId: string, turn: number): Promise<TurnUsageRow[]> {
  const chat = (await loadChatFacts([chatId])).get(chatId);
  if (!chat) return [];
  const facts = (await loadTurnFacts([chatId], turn)).get(chatId)?.[0];
  if (!facts) return [];
  const previous = (facts.initAgent ?? chat.agent) === 'codex' ? await previousResult(chatId, turn) : null;
  const rows = buildTurnUsageRows(chat, facts, previous);
  await storeTurnUsageRows(rows, 'replace');
  await db().delete(workbenchTurnUsage).where(and(
    eq(workbenchTurnUsage.chatId, chatId),
    eq(workbenchTurnUsage.turn, turn),
    notInArray(workbenchTurnUsage.model, rows.map((r) => r.model)),
  ));
  return rows;
}

/** Start {@link recordTurnUsage} in the background. It never throws: failures go to the debug bus. */
export function scheduleTurnUsage(chatId: string, turn: number): void {
  const job = runWithoutScope(() => limit(() => recordTurnUsage(chatId, turn)))
    .catch((error: unknown) => {
      debugBus.recordEvent({
        service: 'insights',
        action: 'turn_usage_failed',
        summary: 'Could not record the token use of a turn.',
        ok: false,
        error,
        meta: { chatId, turn },
      });
    })
    .finally(() => pending.delete(job));
  pending.add(job);
}

/** Tests: wait for the scheduled jobs. */
export async function settleTurnUsageForTests(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
