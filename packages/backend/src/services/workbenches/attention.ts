import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { countContextAttention, sessionAttentionKey, type ContextAttentionCounts } from '@talyn/shared';
import type { Database } from '../../db/client.js';
import {
  pullRequests as prTable,
  workbenchChats as chatsTable,
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

export function attentionChatsQuery(db: Database, workbenchIds: string[]) {
  return db
    .select({
      id: chatsTable.id,
      workbenchId: chatsTable.workbenchId,
      status: chatsTable.status,
      queued: sql<number>`COALESCE(jsonb_array_length(${chatsTable.queuedMessages}), 0)::int`,
      turnCount: chatsTable.turnCount,
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
  const chats = new Map<string, { id: string; status: string; queued: number; turnCount: number }[]>();
  for (const row of await attentionChatsQuery(db, sessions.map((s) => s.id))) {
    const list = chats.get(row.workbenchId) ?? [];
    list.push({ id: row.id, status: row.status, queued: Number(row.queued) || 0, turnCount: row.turnCount });
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

export async function contextAttention(db: Database, ownerId: string): Promise<ContextAttentionCounts> {
  const keyed = await attentionKeys(db, await attentionSessionsQuery(db, ownerId));
  return countContextAttention(
    keyed.filter(({ session, key }) => key !== null && key !== session.attentionAck).map(({ session }) => session),
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
