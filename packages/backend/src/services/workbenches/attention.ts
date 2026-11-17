import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  attentionReason,
  countContextAttention,
  PLAN_BLOCK_FENCE,
  sessionAttentionKey,
  type ContextAttentionCounts,
} from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import {
  pullRequests as prTable,
  workbenchChats as chatsTable,
  workbenchSearchText as searchTextTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';

/**
 * The context rail's badges: for each workspace the caller owns, and for each
 * space their sessions are in, how many live sessions wait on them. A session
 * whose alert the owner already saw (`attention_ack`) does not count.
 *
 * Two narrow reads. Neither ships `settings`, the queued prompts or the PR
 * summary blob: the rail asks every 30 seconds, so the egress rule in
 * CLAUDE.md applies.
 */

/** The caller's live sessions. `workbenchId` narrows it to one session. */
export function attentionSessionsQuery(db: Database, ownerId: string, workbenchId?: string) {
  return db
    .select({
      id: workbenchesTable.id,
      workspaceId: workbenchesTable.workspaceId,
      spaceId: workbenchesTable.spaceId,
      kind: workbenchesTable.kind,
      status: workbenchesTable.status,
      sandboxState: workbenchesTable.sandboxState,
      archivedAt: workbenchesTable.archivedAt,
      attentionAck: workbenchesTable.attentionAck,
      prId: prTable.id,
      prState: prTable.state,
      prMergeable: sql<string | null>`${prTable.lastSummary} ->> 'mergeable'`,
      prHeadSha: sql<string | null>`${prTable.lastSummary} ->> 'headSha'`,
    })
    .from(workbenchesTable)
    .innerJoin(workspacesTable, eq(workspacesTable.id, workbenchesTable.workspaceId))
    .leftJoin(prTable, eq(prTable.id, workbenchesTable.pullRequestId))
    .where(
      and(
        eq(workspacesTable.ownerId, ownerId),
        isNull(workbenchesTable.archivedAt),
        workbenchId ? eq(workbenchesTable.id, workbenchId) : undefined,
      ),
    );
}

/**
 * The opening fence of a plan block, as `parsePlanBlock` reads it: a line of
 * three or more backticks or tildes, then `talyn-plan`. A Postgres regex.
 */
const PLAN_OPENER_SQL = `(^|\n)(\`{3,}|~{3,})[ \t]*${PLAN_BLOCK_FENCE}[ \t]*\r?(\n|$)`;

/**
 * True when an idle chat's agent wrote a plan after the last message from a
 * person, so the plan waits for "Approve and build" or "Keep planning". Both
 * buttons send a message, which ends the wait. It reads
 * `workbench_search_text` (the text of user and assistant events only) on its
 * primary key, never the event stream, and only for an idle chat with no queue.
 */
const planPendingSql = sql<boolean>`CASE WHEN ${chatsTable.status} = 'idle'
    AND COALESCE(jsonb_array_length(${chatsTable.queuedMessages}), 0) = 0
  THEN EXISTS (
    SELECT 1 FROM ${searchTextTable} plan_text
    WHERE plan_text.chat_id = ${chatsTable.id}
      AND plan_text.role = 'assistant'
      AND plan_text.seq > COALESCE((
        SELECT max(asked.seq) FROM ${searchTextTable} asked
        WHERE asked.chat_id = ${chatsTable.id} AND asked.role = 'user'
      ), 0)
      AND plan_text.body ~ ${PLAN_OPENER_SQL}
  )
  ELSE false END`;

export function attentionChatsQuery(db: Database, workbenchIds: string[]) {
  return db
    .select({
      id: chatsTable.id,
      workbenchId: chatsTable.workbenchId,
      status: chatsTable.status,
      queued: sql<number>`COALESCE(jsonb_array_length(${chatsTable.queuedMessages}), 0)::int`,
      turnCount: chatsTable.turnCount,
      planPending: planPendingSql,
    })
    .from(chatsTable)
    .where(and(inArray(chatsTable.workbenchId, workbenchIds), isNull(chatsTable.closedAt)));
}

type AttentionSessionRow = Awaited<ReturnType<typeof attentionSessionsQuery>>[number];

/** Each session with its current `sessionAttentionKey`. */
async function attentionKeys(
  db: Database,
  sessions: AttentionSessionRow[],
): Promise<{ session: AttentionSessionRow; key: string | null }[]> {
  if (sessions.length === 0) return [];
  const chats = new Map<string, { id: string; status: string; queued: number; turnCount: number; planPending: boolean }[]>();
  // The pool, not `db`: the plan check reads `workbench_search_text`, which is
  // backend-pool only (RLS on, no grant), so the owner-scoped handle gets
  // "permission denied". `sessions` came from the owner-filtered query above.
  for (const row of await attentionChatsQuery(getPoolDbClient(), sessions.map((s) => s.id))) {
    const list = chats.get(row.workbenchId) ?? [];
    list.push({
      id: row.id,
      status: row.status,
      queued: Number(row.queued) || 0,
      turnCount: row.turnCount,
      planPending: row.planPending === true,
    });
    chats.set(row.workbenchId, list);
  }
  return sessions.map((s) => ({
    session: s,
    key: sessionAttentionKey({
      kind: s.kind,
      status: s.status,
      sandboxState: s.sandboxState,
      archivedAt: s.archivedAt,
      chats: chats.get(s.id) ?? [],
      pr: s.prState ? { id: s.prId ?? undefined, state: s.prState, mergeable: s.prMergeable, headSha: s.prHeadSha } : null,
    }),
  }));
}

export async function contextAttention(db: Database, ownerId: string): Promise<Required<ContextAttentionCounts>> {
  const keyed = await attentionKeys(db, await attentionSessionsQuery(db, ownerId));
  return countContextAttention(
    keyed.flatMap(({ session, key }) => {
      const reason = attentionReason(key);
      if (reason === null || key === session.attentionAck) return [];
      return [{ id: session.id, workspaceId: session.workspaceId, spaceId: session.spaceId, reason }];
    }),
  );
}

/**
 * The owner opened the session: keep its current alert as seen, so the rail
 * stops counting it. Answers false for a session the caller does not own, or
 * one that is archived. A teammate's view never clears the owner's badge.
 */
export async function acknowledgeAttention(db: Database, ownerId: string, workbenchId: string): Promise<boolean> {
  const [entry] = await attentionKeys(db, await attentionSessionsQuery(db, ownerId, workbenchId));
  if (!entry) return false;
  if (entry.key !== entry.session.attentionAck) {
    await db.update(workbenchesTable).set({ attentionAck: entry.key }).where(eq(workbenchesTable.id, workbenchId));
  }
  return true;
}
