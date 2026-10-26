import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import type {
  AgentEvent,
  Workbench,
  WorkbenchAgent,
  WorkbenchChat,
  WorkbenchChatStatus,
  WorkbenchCheckpoint,
  WorkbenchEffort,
  WorkbenchEvent,
  WorkbenchQueuedMessage,
  WorkbenchRuntimeKind,
  WorkbenchSandboxState,
  WorkbenchStatus,
} from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import {
  workbenchChats as chatsTable,
  workbenchCheckpoints as checkpointsTable,
  workbenchEvents as eventsTable,
  workbenches as workbenchesTable,
} from '../../db/schema.js';
import { emitWorkbenchChat, emitWorkbenchEvents } from './emit.js';

/**
 * Reads and writes for the four workbench tables.
 *
 * # Every query runs on the POOL
 *
 * Routes authorise first (`requireWorkspaceAccess`), then call here. The pool
 * rather than the request's owner-scoped transaction, for one reason that
 * matters: almost every write here is followed by background work (a
 * provision, a turn) that reads the row back on the pool. A row written inside
 * the request transaction is invisible to that work until the response has
 * gone and the transaction committed — a race the background job loses on a
 * fast path. Writing on the pool commits before the job starts.
 *
 * # Egress
 *
 * Explicit projections throughout. `workbench_events.event` is selected by
 * exactly one query, the transcript page; nothing that lists workbenches or
 * chats touches that table at all.
 */

const db = (): Database => getPoolDbClient();

/** Every workbench column. Explicit, so a column added later is opted in on purpose. */
export const WORKBENCH_COLUMNS = {
  id: workbenchesTable.id,
  workspaceId: workbenchesTable.workspaceId,
  repositoryId: workbenchesTable.repositoryId,
  repoFullName: workbenchesTable.repoFullName,
  name: workbenchesTable.name,
  title: workbenchesTable.title,
  branch: workbenchesTable.branch,
  baseBranch: workbenchesTable.baseBranch,
  runtime: workbenchesTable.runtime,
  agent: workbenchesTable.agent,
  model: workbenchesTable.model,
  deviceId: workbenchesTable.deviceId,
  localPath: workbenchesTable.localPath,
  sandboxId: workbenchesTable.sandboxId,
  sandboxState: workbenchesTable.sandboxState,
  fleetHost: workbenchesTable.fleetHost,
  status: workbenchesTable.status,
  statusMessage: workbenchesTable.statusMessage,
  pullRequestId: workbenchesTable.pullRequestId,
  settings: workbenchesTable.settings,
  diffStat: workbenchesTable.diffStat,
  archivedAt: workbenchesTable.archivedAt,
  createdAt: workbenchesTable.createdAt,
  updatedAt: workbenchesTable.updatedAt,
} as const;

export type WorkbenchRow = Pick<typeof workbenchesTable.$inferSelect, keyof typeof WORKBENCH_COLUMNS>;

/** Every chat column. `queued_messages` is bounded by what a person typed during one turn. */
export const CHAT_COLUMNS = {
  id: chatsTable.id,
  workbenchId: chatsTable.workbenchId,
  workspaceId: chatsTable.workspaceId,
  title: chatsTable.title,
  agent: chatsTable.agent,
  model: chatsTable.model,
  effort: chatsTable.effort,
  planMode: chatsTable.planMode,
  agentSessionId: chatsTable.agentSessionId,
  status: chatsTable.status,
  statusMessage: chatsTable.statusMessage,
  queuedMessages: chatsTable.queuedMessages,
  turnCount: chatsTable.turnCount,
  closedAt: chatsTable.closedAt,
  createdAt: chatsTable.createdAt,
  updatedAt: chatsTable.updatedAt,
} as const;

export type ChatRow = Pick<typeof chatsTable.$inferSelect, keyof typeof CHAT_COLUMNS>;

export function rowToWorkbench(row: WorkbenchRow): Workbench {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    repositoryId: row.repositoryId,
    repoFullName: row.repoFullName,
    name: row.name,
    title: row.title ?? null,
    branch: row.branch,
    baseBranch: row.baseBranch,
    runtime: row.runtime as WorkbenchRuntimeKind,
    agent: row.agent as WorkbenchAgent,
    deviceId: row.deviceId,
    localPath: row.localPath,
    sandboxId: row.sandboxId,
    sandboxState: row.sandboxState as WorkbenchSandboxState,
    status: row.status as WorkbenchStatus,
    statusMessage: row.statusMessage,
    pullRequestId: row.pullRequestId,
    settings: row.settings ?? {},
    diffStat: row.diffStat ?? null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function rowToChat(row: ChatRow): WorkbenchChat {
  return {
    id: row.id,
    workbenchId: row.workbenchId,
    title: row.title,
    agent: row.agent as WorkbenchAgent,
    model: row.model,
    effort: (row.effort as WorkbenchEffort | null) ?? null,
    planMode: row.planMode,
    agentSessionId: row.agentSessionId,
    status: row.status as WorkbenchChatStatus,
    queuedMessages: row.queuedMessages ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ============================================================================
// Workbenches
// ============================================================================

export type NewWorkbench = typeof workbenchesTable.$inferInsert;

export async function insertWorkbench(values: NewWorkbench): Promise<WorkbenchRow> {
  const [row] = await db().insert(workbenchesTable).values(values).returning(WORKBENCH_COLUMNS);
  return row;
}

/** The list query, exposed so a test can prove it never reads a transcript. */
export function listWorkbenchesQuery(workspaceId: string, includeArchived: boolean) {
  const where = includeArchived
    ? eq(workbenchesTable.workspaceId, workspaceId)
    : and(eq(workbenchesTable.workspaceId, workspaceId), isNull(workbenchesTable.archivedAt));
  return db()
    .select(WORKBENCH_COLUMNS)
    .from(workbenchesTable)
    .where(where)
    .orderBy(desc(workbenchesTable.createdAt));
}

export async function listWorkbenches(workspaceId: string, includeArchived = false): Promise<WorkbenchRow[]> {
  return listWorkbenchesQuery(workspaceId, includeArchived);
}

export function getWorkbenchQuery(id: string) {
  return db().select(WORKBENCH_COLUMNS).from(workbenchesTable).where(eq(workbenchesTable.id, id)).limit(1);
}

export async function getWorkbench(id: string): Promise<WorkbenchRow | null> {
  return (await getWorkbenchQuery(id))[0] ?? null;
}

export async function updateWorkbench(
  id: string,
  patch: Partial<Omit<NewWorkbench, 'id' | 'workspaceId' | 'createdAt'>>,
): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(workbenchesTable.id, id))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/** Claim a lost box once. The old sandbox id keeps late calls from replacing its new box. */
export async function claimLostWorkbench(id: string, sandboxId: string, replacementId: string, message: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({
      status: 'provisioning',
      statusMessage: message,
      sandboxState: 'lost',
      sandboxId: replacementId,
      fleetHost: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(workbenchesTable.id, id),
      eq(workbenchesTable.sandboxId, sandboxId),
      eq(workbenchesTable.status, 'ready'),
      isNull(workbenchesTable.archivedAt),
    ))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/** Stop an automatic loop when a second box is lost inside the retry window. */
export async function failLostWorkbench(id: string, sandboxId: string, message: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ status: 'error', statusMessage: message, sandboxState: 'error', updatedAt: new Date() })
    .where(and(
      eq(workbenchesTable.id, id),
      eq(workbenchesTable.sandboxId, sandboxId),
      eq(workbenchesTable.status, 'ready'),
      isNull(workbenchesTable.archivedAt),
    ))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

/**
 * Set a generated title, but only while the workbench has none. One
 * statement, so a title a person sets at the same moment always wins.
 * Null when nothing changed.
 */
export async function setGeneratedTitle(id: string, title: string): Promise<WorkbenchRow | null> {
  const [row] = await db()
    .update(workbenchesTable)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(workbenchesTable.id, id), isNull(workbenchesTable.title), isNull(workbenchesTable.archivedAt)))
    .returning(WORKBENCH_COLUMNS);
  return row ?? null;
}

export async function deleteWorkbenchRow(id: string): Promise<void> {
  await db().delete(workbenchesTable).where(eq(workbenchesTable.id, id));
}

/** Names in use by LIVE workbenches of this workspace — the city picker's input. */
export async function liveWorkbenchNames(workspaceId: string): Promise<string[]> {
  const rows = await db()
    .select({ name: workbenchesTable.name })
    .from(workbenchesTable)
    .where(and(eq(workbenchesTable.workspaceId, workspaceId), isNull(workbenchesTable.archivedAt)));
  return rows.map((r) => r.name);
}

/** Live sandbox workbenches a dead process left mid-provision. */
export async function provisioningWorkbenchIds(): Promise<string[]> {
  const rows = await db()
    .select({ id: workbenchesTable.id })
    .from(workbenchesTable)
    .where(
      and(
        eq(workbenchesTable.status, 'provisioning'),
        eq(workbenchesTable.runtime, 'sandbox'),
        isNull(workbenchesTable.archivedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/** Forget every chat's CLI session — after a restore onto a new box, where the session files are gone. */
export async function clearAgentSessions(workbenchId: string): Promise<ChatRow[]> {
  return db()
    .update(chatsTable)
    .set({ agentSessionId: null, updatedAt: new Date() })
    .where(and(eq(chatsTable.workbenchId, workbenchId), sql`${chatsTable.agentSessionId} IS NOT NULL`))
    .returning(CHAT_COLUMNS);
}

/** A fleet sandbox id back to its workbench — the credential pull's lookup. */
export async function workbenchBySandboxId(sandboxId: string): Promise<WorkbenchRow | null> {
  const rows = await db()
    .select(WORKBENCH_COLUMNS)
    .from(workbenchesTable)
    .where(eq(workbenchesTable.sandboxId, sandboxId))
    .limit(1);
  return rows[0] ?? null;
}

// ============================================================================
// Chats
// ============================================================================

export type NewChat = typeof chatsTable.$inferInsert;

export async function insertChat(values: NewChat): Promise<ChatRow> {
  const [row] = await db().insert(chatsTable).values(values).returning(CHAT_COLUMNS);
  return row;
}

export function getChatQuery(id: string) {
  return db().select(CHAT_COLUMNS).from(chatsTable).where(eq(chatsTable.id, id)).limit(1);
}

export async function getChat(id: string): Promise<ChatRow | null> {
  return (await getChatQuery(id))[0] ?? null;
}

/** Every chat of a workbench, closed ones included, oldest first. */
export async function listChats(workbenchId: string): Promise<ChatRow[]> {
  return db()
    .select(CHAT_COLUMNS)
    .from(chatsTable)
    .where(eq(chatsTable.workbenchId, workbenchId))
    .orderBy(asc(chatsTable.createdAt));
}

/** The open chats of several workbenches, oldest first — embedded in the list response in one query. */
export function openChatsQuery(workbenchIds: string[]) {
  return db()
    .select(CHAT_COLUMNS)
    .from(chatsTable)
    .where(and(inArray(chatsTable.workbenchId, workbenchIds), isNull(chatsTable.closedAt)))
    .orderBy(asc(chatsTable.createdAt));
}

export async function openChatsByWorkbench(workbenchIds: string[]): Promise<Map<string, ChatRow[]>> {
  const out = new Map<string, ChatRow[]>();
  if (workbenchIds.length === 0) return out;
  for (const row of await openChatsQuery(workbenchIds)) {
    const list = out.get(row.workbenchId) ?? [];
    list.push(row);
    out.set(row.workbenchId, list);
  }
  return out;
}

/**
 * Drop one queued message by its id, in one statement so a turn ending at the
 * same moment cannot pop it after we decided it was still there. Null when
 * the chat does not exist.
 */
export async function removeQueuedMessage(chatId: string, messageId: string): Promise<ChatRow | null> {
  const result = await db().execute(sql`
    UPDATE workbench_chats c SET
      queued_messages = COALESCE((
        SELECT jsonb_agg(e.value ORDER BY e.ord)
        FROM jsonb_array_elements(c.queued_messages) WITH ORDINALITY AS e(value, ord)
        WHERE e.value ->> 'id' IS DISTINCT FROM ${messageId}
      ), '[]'::jsonb),
      updated_at = now()
    WHERE c.id = ${chatId}
    RETURNING ${RETURNING_CHAT}
  `);
  const row = rowsOf<RawChatRow>(result)[0];
  return row ? rawToChatRow(row) : null;
}

/** The chat most recently used — where an action lands when none is named. */
export async function latestChat(workbenchId: string): Promise<ChatRow | null> {
  const rows = await db()
    .select(CHAT_COLUMNS)
    .from(chatsTable)
    .where(eq(chatsTable.workbenchId, workbenchId))
    .orderBy(desc(chatsTable.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateChat(
  id: string,
  patch: Partial<Omit<NewChat, 'id' | 'workbenchId' | 'workspaceId' | 'createdAt'>>,
): Promise<ChatRow | null> {
  const [row] = await db()
    .update(chatsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(chatsTable.id, id))
    .returning(CHAT_COLUMNS);
  return row ?? null;
}

/** Every chat a dead process left `running`. Reads the partial index only. */
export async function runningChats(): Promise<Array<{ id: string; workbenchId: string; workspaceId: string }>> {
  return db()
    .select({ id: chatsTable.id, workbenchId: chatsTable.workbenchId, workspaceId: chatsTable.workspaceId })
    .from(chatsTable)
    .where(eq(chatsTable.status, 'running'));
}

/**
 * Raw-row reads from a `sql` statement come back snake_case. One mapper for
 * the statements below, so a column rename has one place to update.
 */
interface RawChatRow {
  id: string;
  workbench_id: string;
  workspace_id: string;
  title: string;
  agent: string;
  model: string | null;
  effort: string | null;
  plan_mode: boolean;
  agent_session_id: string | null;
  status: string;
  status_message: string | null;
  queued_messages: WorkbenchQueuedMessage[] | string;
  turn_count: number;
  closed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function rawToChatRow(r: RawChatRow): ChatRow {
  const date = (v: Date | string) => (v instanceof Date ? v : new Date(v));
  const queue = typeof r.queued_messages === 'string' ? JSON.parse(r.queued_messages) : r.queued_messages;
  return {
    id: r.id,
    workbenchId: r.workbench_id,
    workspaceId: r.workspace_id,
    title: r.title,
    agent: r.agent,
    model: r.model,
    effort: r.effort,
    planMode: r.plan_mode,
    agentSessionId: r.agent_session_id,
    status: r.status,
    statusMessage: r.status_message,
    queuedMessages: queue ?? [],
    turnCount: Number(r.turn_count),
    closedAt: r.closed_at ? date(r.closed_at) : null,
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
  };
}

function rowsOf<T>(result: unknown): T[] {
  // postgres-js returns the rows array itself; pglite wraps them in `{ rows }`.
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

const RETURNING_CHAT = sql.raw(
  `c.id, c.workbench_id, c.workspace_id, c.title, c.agent, c.model, c.effort, c.plan_mode,
   c.agent_session_id, c.status, c.status_message, c.queued_messages, c.turn_count,
   c.closed_at, c.created_at, c.updated_at`,
);

export interface ClaimResult {
  chat: ChatRow;
  /** The message that starts a turn now, with that turn's number; null when it queued. */
  started: { message: WorkbenchQueuedMessage; turn: number } | null;
}

/**
 * Add `message` to the chat's queue and, when no turn is running and
 * `canStart` (the workbench is ready), take the HEAD of the queue as the next
 * turn — in ONE statement.
 *
 * One statement is the concurrency design. The row lock the CTE takes orders
 * every send against every other send and against the end of a turn, so a
 * message can neither start a second concurrent turn nor be queued in the gap
 * after a turn has already looked at an empty queue. No advisory lock.
 *
 * Enqueue-then-pop rather than "start this one": a queue left behind by a
 * cancel drains in the order it was typed, before the new message.
 */
export async function claimOrEnqueue(
  chatId: string,
  message: WorkbenchQueuedMessage | null,
  canStart: boolean,
): Promise<ClaimResult | null> {
  const add = JSON.stringify(message ? [message] : []);
  const result = await db().execute(sql`
    WITH old AS (
      SELECT status, queued_messages FROM workbench_chats WHERE id = ${chatId} FOR UPDATE
    ), merged AS (
      SELECT status AS prev_status, queued_messages || ${add}::jsonb AS mq,
        (status <> 'running' AND ${canStart} AND jsonb_array_length(queued_messages || ${add}::jsonb) > 0) AS go
      FROM old
    )
    UPDATE workbench_chats c SET
      queued_messages = CASE WHEN merged.go THEN merged.mq - 0 ELSE merged.mq END,
      status = CASE WHEN merged.go THEN 'running' ELSE c.status END,
      status_message = CASE WHEN merged.go THEN NULL ELSE c.status_message END,
      turn_count = CASE WHEN merged.go THEN c.turn_count + 1 ELSE c.turn_count END,
      updated_at = now()
    FROM merged
    WHERE c.id = ${chatId}
    RETURNING ${RETURNING_CHAT}, merged.go AS started, CASE WHEN merged.go THEN merged.mq -> 0 END AS started_message
  `);
  const row = rowsOf<RawChatRow & { started: boolean; started_message: unknown }>(result)[0];
  if (!row) return null;
  const chat = rawToChatRow(row);
  if (!row.started) return { chat, started: null };
  const startedMessage =
    typeof row.started_message === 'string' ? JSON.parse(row.started_message) : row.started_message;
  return { chat, started: { message: startedMessage as WorkbenchQueuedMessage, turn: chat.turnCount } };
}

/**
 * End the running turn: take the next queued message as the next turn when
 * `drain` allows it, else settle on `finalStatus`. One statement, for the
 * reason `claimOrEnqueue` is one.
 */
export async function finishTurn(
  chatId: string,
  opts: { finalStatus: WorkbenchChatStatus; statusMessage: string | null; drain: boolean },
): Promise<ClaimResult | null> {
  const result = await db().execute(sql`
    WITH old AS (
      SELECT queued_messages FROM workbench_chats WHERE id = ${chatId} FOR UPDATE
    ), merged AS (
      SELECT queued_messages AS mq, (${opts.drain} AND jsonb_array_length(queued_messages) > 0) AS go FROM old
    )
    UPDATE workbench_chats c SET
      queued_messages = CASE WHEN merged.go THEN merged.mq - 0 ELSE merged.mq END,
      status = CASE WHEN merged.go THEN 'running' ELSE ${opts.finalStatus} END,
      status_message = CASE WHEN merged.go THEN NULL ELSE ${opts.statusMessage} END,
      turn_count = CASE WHEN merged.go THEN c.turn_count + 1 ELSE c.turn_count END,
      updated_at = now()
    FROM merged
    WHERE c.id = ${chatId}
    RETURNING ${RETURNING_CHAT}, merged.go AS started, CASE WHEN merged.go THEN merged.mq -> 0 END AS started_message
  `);
  const row = rowsOf<RawChatRow & { started: boolean; started_message: unknown }>(result)[0];
  if (!row) return null;
  const chat = rawToChatRow(row);
  if (!row.started) return { chat, started: null };
  const startedMessage =
    typeof row.started_message === 'string' ? JSON.parse(row.started_message) : row.started_message;
  return { chat, started: { message: startedMessage as WorkbenchQueuedMessage, turn: chat.turnCount } };
}

/**
 * A workbench failed to start: every open chat that is not running drops its
 * queue and goes to `error`, and its transcript says why. The queued messages
 * cannot run on a box that does not exist, and leaving them would make them
 * look sent. One statement for the queues, so a send at the same moment either
 * lands before the clear or sees the chat in `error`.
 */
export async function failQueued(workbenchId: string, reason: string): Promise<ChatRow[]> {
  const result = await db().execute(sql`
    WITH old AS (
      SELECT id, queued_messages AS dropped FROM workbench_chats
      WHERE workbench_id = ${workbenchId} AND closed_at IS NULL AND status <> 'running'
      FOR UPDATE
    )
    UPDATE workbench_chats c SET
      queued_messages = '[]'::jsonb,
      status = 'error',
      status_message = ${reason},
      updated_at = now()
    FROM old
    WHERE c.id = old.id
    RETURNING ${RETURNING_CHAT}, old.dropped AS dropped
  `);
  const out: ChatRow[] = [];
  for (const raw of rowsOf<RawChatRow & { dropped: WorkbenchQueuedMessage[] | string | null }>(result)) {
    const chat = rawToChatRow(raw);
    const dropped = (typeof raw.dropped === 'string' ? JSON.parse(raw.dropped) : raw.dropped) ?? [];
    const notSent =
      dropped.length === 0
        ? ''
        : ` ${dropped.length === 1 ? 'Your queued message was' : `${dropped.length} queued messages were`} not sent.`;
    const stored = await appendEvents(chat.id, [
      {
        turn: chat.turnCount,
        event: {
          type: 'system',
          subtype: 'workbench_failed',
          text: `This session failed to start: ${reason}${notSent}`,
          droppedMessages: dropped.map((m: WorkbenchQueuedMessage) => ({ id: m.id, text: m.text })),
        },
      },
    ]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
    emitWorkbenchChat(chat.workspaceId, rowToChat(chat));
    out.push(chat);
  }
  return out;
}

/** After a retry: chats a failed start left in `error` go back to `idle`. */
export async function resetFailedChats(workbenchId: string): Promise<ChatRow[]> {
  const rows = await db()
    .update(chatsTable)
    .set({ status: 'idle', statusMessage: null, updatedAt: new Date() })
    .where(and(eq(chatsTable.workbenchId, workbenchId), eq(chatsTable.status, 'error'), isNull(chatsTable.closedAt)))
    .returning(CHAT_COLUMNS);
  for (const row of rows) emitWorkbenchChat(row.workspaceId, rowToChat(row));
  return rows;
}

// ============================================================================
// Events
// ============================================================================

export interface EventDraftInput {
  turn: number;
  event: Record<string, unknown>;
}

/**
 * Append events to a chat's transcript, assigning their `seq`.
 *
 * ONE statement: the chat's `next_seq` is bumped by the batch size and the rows
 * are inserted from the bumped value. The bump's row lock serialises
 * concurrent appenders until commit, so seqs are gap-free per statement and a
 * reader paging by `seq` never sees a later one before an earlier one. No
 * advisory lock and no read-then-write.
 */
export async function appendEvents(chatId: string, items: EventDraftInput[]): Promise<WorkbenchEvent[]> {
  if (items.length === 0) return [];
  const payload = JSON.stringify(items.map((i) => ({ turn: i.turn, event: i.event })));
  const result = await db().execute(sql`
    WITH alloc AS (
      UPDATE workbench_chats SET next_seq = next_seq + ${items.length}, updated_at = now()
      WHERE id = ${chatId}
      RETURNING next_seq - ${items.length} AS base
    )
    INSERT INTO workbench_events (chat_id, seq, turn, event)
    SELECT ${chatId}, alloc.base + e.ord, (e.value ->> 'turn')::int, e.value -> 'event'
    FROM alloc, jsonb_array_elements(${payload}::jsonb) WITH ORDINALITY AS e(value, ord)
    RETURNING seq, turn, event
  `);
  const rows = rowsOf<{ seq: number | string; turn: number; event: unknown }>(result);
  return rows
    .map((r) => {
      const seq = Number(r.seq);
      const event = (typeof r.event === 'string' ? JSON.parse(r.event) : r.event) as Record<string, unknown>;
      return { chatId, seq, turn: Number(r.turn), event: { ...event, seq } as AgentEvent };
    })
    .sort((a, b) => a.seq - b.seq);
}

/**
 * Store events a LOCAL runtime already numbered. Idempotent on `(chat, seq)`,
 * so a desktop that retries an upload stores nothing twice, and the allocator
 * is moved past the highest seq so a later server-side append cannot collide.
 */
export async function storeNumberedEvents(chatId: string, events: WorkbenchEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const inserted = await db()
    .insert(eventsTable)
    .values(events.map((e) => ({ chatId, seq: e.seq, turn: e.turn, event: e.event as Record<string, unknown> })))
    .onConflictDoNothing()
    .returning({ seq: eventsTable.seq });
  const maxSeq = Math.max(...events.map((e) => e.seq));
  await db()
    .update(chatsTable)
    .set({ nextSeq: sql`GREATEST(${chatsTable.nextSeq}, ${maxSeq})`, updatedAt: new Date() })
    .where(eq(chatsTable.id, chatId));
  return inserted.length;
}

/** The forward transcript page. With `listEventRangeQuery`, the only queries that select `event`. */
export function listEventsQuery(chatId: string, after: number, limit: number) {
  return db()
    .select({ seq: eventsTable.seq, turn: eventsTable.turn, event: eventsTable.event })
    .from(eventsTable)
    .where(and(eq(eventsTable.chatId, chatId), gt(eventsTable.seq, after)))
    .orderBy(asc(eventsTable.seq))
    .limit(limit);
}

export async function listEvents(
  chatId: string,
  after: number,
  limit: number,
): Promise<{ events: WorkbenchEvent[]; cursor: number }> {
  const rows = await listEventsQuery(chatId, after, limit);
  const events = rows.map((r) => ({
    chatId,
    seq: r.seq,
    turn: r.turn,
    event: { ...r.event, seq: r.seq } as AgentEvent,
  }));
  return { events, cursor: events.length > 0 ? events[events.length - 1].seq : after };
}

/** The backward mode's page body: `seq` in `[from, to]`, oldest first. With `listEventsQuery`, the only reads of `event`. */
export function listEventRangeQuery(chatId: string, from: number, to: number, limit: number) {
  return db()
    .select({ seq: eventsTable.seq, turn: eventsTable.turn, event: eventsTable.event })
    .from(eventsTable)
    .where(and(eq(eventsTable.chatId, chatId), gte(eventsTable.seq, from), lte(eventsTable.seq, to)))
    .orderBy(asc(eventsTable.seq))
    .limit(limit);
}

export interface OlderEventsPage {
  events: WorkbenchEvent[];
  /** The newest seq returned, as in the forward mode; 0 for an empty page. */
  cursor: number;
  /** The oldest seq returned. Pass it back as `before` for the next older page. */
  oldestSeq: number | null;
  hasOlder: boolean;
}

/**
 * The newest page of events with `seq < before` (`null` = from the newest),
 * returned oldest first and aligned to whole turns: the window of the newest
 * `limit` events is extended down to the first event of its oldest turn, so a
 * tool_result never arrives without its tool_use.
 *
 * `ceiling` bounds that extension. A single turn with more events than that
 * is cut at the ceiling instead, and its first events arrive with the next
 * older page. One response never holds more than `ceiling` events.
 *
 * Every step but the page body reads `seq` and `turn` only, walking the
 * `(chat_id, seq)` primary key backwards.
 */
export async function listOlderEvents(
  chatId: string,
  before: number | null,
  limit: number,
  ceiling: number,
): Promise<OlderEventsPage> {
  const below =
    before === null ? eq(eventsTable.chatId, chatId) : and(eq(eventsTable.chatId, chatId), lt(eventsTable.seq, before));
  const [newest] = await db()
    .select({ seq: eventsTable.seq })
    .from(eventsTable)
    .where(below)
    .orderBy(desc(eventsTable.seq))
    .limit(1);
  if (!newest) return { events: [], cursor: 0, oldestSeq: null, hasOlder: false };

  // The oldest event of the plain window. None means the window reaches the start of the chat.
  const [edge] = await db()
    .select({ seq: eventsTable.seq, turn: eventsTable.turn })
    .from(eventsTable)
    .where(below)
    .orderBy(desc(eventsTable.seq))
    .offset(limit - 1)
    .limit(1);

  let from = 0;
  if (edge) {
    // Seqs are unique, so [edge - budget, edge) holds at most `budget` events.
    const floor = edge.seq - Math.max(0, ceiling - limit);
    const [prevTurn] = await db()
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(
        and(eq(eventsTable.chatId, chatId), lt(eventsTable.seq, edge.seq), gte(eventsTable.seq, floor), ne(eventsTable.turn, edge.turn)),
      )
      .orderBy(desc(eventsTable.seq))
      .limit(1);
    // No other turn inside the budget: either the chat starts there, or the turn is cut at the floor.
    from = prevTurn ? prevTurn.seq + 1 : floor;
  }

  const rows = await listEventRangeQuery(chatId, from, newest.seq, ceiling);
  const events = rows.map((r) => ({
    chatId,
    seq: r.seq,
    turn: r.turn,
    event: { ...r.event, seq: r.seq } as AgentEvent,
  }));
  const oldestSeq = events.length ? events[0].seq : null;
  let hasOlder = false;
  if (oldestSeq !== null) {
    const [older] = await db()
      .select({ seq: eventsTable.seq })
      .from(eventsTable)
      .where(and(eq(eventsTable.chatId, chatId), lt(eventsTable.seq, oldestSeq)))
      .limit(1);
    hasOlder = Boolean(older);
  }
  return { events, cursor: events.length ? events[events.length - 1].seq : 0, oldestSeq, hasOlder };
}

// ============================================================================
// Checkpoints
// ============================================================================

export async function upsertCheckpoint(input: { chatId: string; turn: number; ref: string; sha: string }): Promise<void> {
  await db()
    .insert(checkpointsTable)
    .values(input)
    .onConflictDoUpdate({
      target: [checkpointsTable.chatId, checkpointsTable.turn],
      set: { ref: input.ref, sha: input.sha, createdAt: new Date() },
    });
}

export async function listCheckpoints(chatId: string): Promise<WorkbenchCheckpoint[]> {
  const rows = await db()
    .select({
      chatId: checkpointsTable.chatId,
      turn: checkpointsTable.turn,
      ref: checkpointsTable.ref,
      sha: checkpointsTable.sha,
      createdAt: checkpointsTable.createdAt,
    })
    .from(checkpointsTable)
    .where(eq(checkpointsTable.chatId, chatId))
    .orderBy(asc(checkpointsTable.turn));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function getCheckpoint(chatId: string, turn: number): Promise<WorkbenchCheckpoint | null> {
  const rows = await db()
    .select({
      chatId: checkpointsTable.chatId,
      turn: checkpointsTable.turn,
      ref: checkpointsTable.ref,
      sha: checkpointsTable.sha,
      createdAt: checkpointsTable.createdAt,
    })
    .from(checkpointsTable)
    .where(and(eq(checkpointsTable.chatId, chatId), eq(checkpointsTable.turn, turn)))
    .limit(1);
  const r = rows[0];
  return r ? { ...r, createdAt: r.createdAt.toISOString() } : null;
}

/** Chat ids of a workbench — for clearing sessions after a restore. */
export async function chatIdsOf(workbenchIds: string[]): Promise<string[]> {
  if (workbenchIds.length === 0) return [];
  const rows = await db()
    .select({ id: chatsTable.id })
    .from(chatsTable)
    .where(inArray(chatsTable.workbenchId, workbenchIds));
  return rows.map((r) => r.id);
}
