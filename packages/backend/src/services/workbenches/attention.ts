import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { countContextAttention, sessionNeedsAttention, type ContextAttentionCounts } from '@talyn/shared';
import type { Database } from '../../db/client.js';
import {
  pullRequests as prTable,
  workbenchChats as chatsTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';

/**
 * The context rail's badges: for each workspace the caller owns, and for each
 * space their sessions are in, how many live sessions wait on them.
 *
 * Two narrow reads. Neither ships `settings`, the queued prompts or the PR
 * summary blob: the rail asks every 30 seconds, so the egress rule in
 * CLAUDE.md applies.
 */

export function attentionSessionsQuery(db: Database, ownerId: string) {
  return db
    .select({
      id: workbenchesTable.id,
      workspaceId: workbenchesTable.workspaceId,
      spaceId: workbenchesTable.spaceId,
      kind: workbenchesTable.kind,
      status: workbenchesTable.status,
      sandboxState: workbenchesTable.sandboxState,
      archivedAt: workbenchesTable.archivedAt,
      prState: prTable.state,
      prMergeable: sql<string | null>`${prTable.lastSummary} ->> 'mergeable'`,
    })
    .from(workbenchesTable)
    .innerJoin(workspacesTable, eq(workspacesTable.id, workbenchesTable.workspaceId))
    .leftJoin(prTable, eq(prTable.id, workbenchesTable.pullRequestId))
    .where(and(eq(workspacesTable.ownerId, ownerId), isNull(workbenchesTable.archivedAt)));
}

export function attentionChatsQuery(db: Database, workbenchIds: string[]) {
  return db
    .select({
      workbenchId: chatsTable.workbenchId,
      status: chatsTable.status,
      queued: sql<number>`COALESCE(jsonb_array_length(${chatsTable.queuedMessages}), 0)::int`,
    })
    .from(chatsTable)
    .where(and(inArray(chatsTable.workbenchId, workbenchIds), isNull(chatsTable.closedAt)));
}

export async function contextAttention(db: Database, ownerId: string): Promise<ContextAttentionCounts> {
  const sessions = await attentionSessionsQuery(db, ownerId);
  if (sessions.length === 0) return { workspaces: {}, spaces: {} };
  const chats = new Map<string, { status: string; queued: number }[]>();
  for (const row of await attentionChatsQuery(db, sessions.map((s) => s.id))) {
    const list = chats.get(row.workbenchId) ?? [];
    list.push({ status: row.status, queued: Number(row.queued) || 0 });
    chats.set(row.workbenchId, list);
  }
  return countContextAttention(
    sessions.filter((s) =>
      sessionNeedsAttention({
        kind: s.kind,
        status: s.status,
        sandboxState: s.sandboxState,
        archivedAt: s.archivedAt,
        chats: chats.get(s.id) ?? [],
        pr: s.prState ? { state: s.prState, mergeable: s.prMergeable } : null,
      }),
    ),
  );
}
