import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import {
  repositories as reposTable,
  workbenchChats as chatsTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { afterCursor, type ListCursor } from './cursor.js';
import {
  PUBLIC_CHAT_COLUMNS,
  PUBLIC_REPOSITORY_COLUMNS,
  PUBLIC_SESSION_COLUMNS,
  PUBLIC_WORKSPACE_COLUMNS,
  type PublicSessionStatus,
} from './projections.js';

/**
 * The reads behind `/v1`. Each list fetches `limit + 1` rows so the route can
 * say `has_more` without a COUNT. Every query is on the pool: `/v1` requests
 * have no owner-scoped transaction, and each route authorises before it reads.
 * The query builders are exported so the egress tests can call `.toSQL()`.
 */

const db = () => getPoolDbClient();

export function listWorkspacesQuery(ownerId: string, workspaceIds: string[] | null, cursor: ListCursor | null, limit: number) {
  return db()
    .select(PUBLIC_WORKSPACE_COLUMNS)
    .from(workspacesTable)
    .where(
      and(
        eq(workspacesTable.ownerId, ownerId),
        workspaceIds ? inArray(workspacesTable.id, workspaceIds) : undefined,
        afterCursor(workspacesTable.createdAt, workspacesTable.id, cursor),
      ),
    )
    .orderBy(desc(workspacesTable.createdAt), desc(workspacesTable.id))
    .limit(limit + 1);
}

export function getWorkspaceQuery(id: string) {
  return db().select(PUBLIC_WORKSPACE_COLUMNS).from(workspacesTable).where(eq(workspacesTable.id, id)).limit(1);
}

/** The owner of a workspace, or null when it does not exist. */
export async function workspaceOwner(id: string): Promise<string | null> {
  const [row] = await db()
    .select({ ownerId: workspacesTable.ownerId })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, id))
    .limit(1);
  return row?.ownerId ?? null;
}

export function listRepositoriesQuery(workspaceId: string, cursor: ListCursor | null, limit: number) {
  return db()
    .select(PUBLIC_REPOSITORY_COLUMNS)
    .from(reposTable)
    .where(and(eq(reposTable.workspaceId, workspaceId), afterCursor(reposTable.createdAt, reposTable.id, cursor)))
    .orderBy(desc(reposTable.createdAt), desc(reposTable.id))
    .limit(limit + 1);
}

export interface SessionListFilter {
  statuses?: PublicSessionStatus[];
  kinds?: Array<'session' | 'thread'>;
  includeArchived?: boolean;
}

/** The SQL for the public statuses, which `publicSessionStatus` derives from two columns. */
function statusWhere(statuses: PublicSessionStatus[]): SQL | undefined {
  const parts = statuses.map((s): SQL | undefined => {
    if (s === 'archive_error') return eq(workbenchesTable.status, 'archiveError');
    if (s === 'archived') return and(isNotNull(workbenchesTable.archivedAt), ne(workbenchesTable.status, 'archiveError'));
    return and(eq(workbenchesTable.status, s), isNull(workbenchesTable.archivedAt));
  });
  return or(...parts);
}

export function listSessionsQuery(workspaceId: string, filter: SessionListFilter, cursor: ListCursor | null, limit: number) {
  const kinds = filter.kinds && filter.kinds.length > 0 ? filter.kinds : ['session'];
  const status =
    filter.statuses && filter.statuses.length > 0
      ? statusWhere(filter.statuses)
      : filter.includeArchived
        ? undefined
        : isNull(workbenchesTable.archivedAt);
  return db()
    .select(PUBLIC_SESSION_COLUMNS)
    .from(workbenchesTable)
    .where(
      and(
        eq(workbenchesTable.workspaceId, workspaceId),
        inArray(workbenchesTable.kind, kinds),
        status,
        afterCursor(workbenchesTable.createdAt, workbenchesTable.id, cursor),
      ),
    )
    .orderBy(desc(workbenchesTable.createdAt), desc(workbenchesTable.id))
    .limit(limit + 1);
}

export function getSessionQuery(id: string) {
  return db().select(PUBLIC_SESSION_COLUMNS).from(workbenchesTable).where(eq(workbenchesTable.id, id)).limit(1);
}

export function openChatsQuery(sessionId: string) {
  return db()
    .select(PUBLIC_CHAT_COLUMNS)
    .from(chatsTable)
    .where(and(eq(chatsTable.workbenchId, sessionId), isNull(chatsTable.closedAt)))
    .orderBy(asc(chatsTable.createdAt));
}

export function getChatQuery(id: string) {
  return db().select(PUBLIC_CHAT_COLUMNS).from(chatsTable).where(eq(chatsTable.id, id)).limit(1);
}
