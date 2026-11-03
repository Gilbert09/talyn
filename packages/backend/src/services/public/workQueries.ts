import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import {
  repositories as reposTable,
  workbenchChats as chatsTable,
  workbenchPreviewHosts as previewHostsTable,
  workbenchScriptRuns as scriptRunsTable,
  workbenches as workbenchesTable,
  workspaceMemories as memoriesTable,
} from '../../db/schema.js';
import type { ApiTokenPrincipal } from '../apiTokens.js';
import { memoryListWhere, type ListMemoryOptions } from '../workbenches/memory.js';
import { getWorkbench, type WorkbenchRow } from '../workbenches/store.js';
import { authorizedSession, authorizeWorkspace } from './authorize.js';
import { afterCursor, type ListCursor } from './cursor.js';
import { notFound } from './errors.js';
import { PUBLIC_REPOSITORY_COLUMNS, PUBLIC_SESSION_COLUMNS, type PublicSessionRow } from './projections.js';
import { PUBLIC_MEMORY_COLUMNS, type QueuedMessageRow } from './workProjections.js';

/**
 * The reads and the access checks of phase 2 part 1. On the pool, like
 * `queries.ts`; each route authorises before it reads. The builders are
 * exported so the egress tests can call `.toSQL()`.
 */

const db = () => getPoolDbClient();

/**
 * A session the token can reach, as the full row the services take. The
 * public row comes first, so a session out of reach is 404 before anything
 * else is read.
 */
export async function authorizedWorkbench(
  token: ApiTokenPrincipal,
  id: string,
): Promise<{ session: PublicSessionRow; row: WorkbenchRow }> {
  const session = await authorizedSession(token, id);
  const row = await getWorkbench(session.id);
  if (!row) throw notFound('session');
  return { session, row };
}

export function getRepositoryQuery(id: string) {
  return db().select(PUBLIC_REPOSITORY_COLUMNS).from(reposTable).where(eq(reposTable.id, id)).limit(1);
}

/** A repository the token can reach. */
export async function authorizedRepository(token: ApiTokenPrincipal, id: string) {
  const [row] = await getRepositoryQuery(id);
  if (!row) throw notFound('repository');
  try {
    await authorizeWorkspace(token, row.workspaceId);
  } catch {
    throw notFound('repository');
  }
  return row;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export function listThreadSessionsQuery(threadId: string, cursor: ListCursor | null, limit: number) {
  return db()
    .select(PUBLIC_SESSION_COLUMNS)
    .from(workbenchesTable)
    .where(and(eq(workbenchesTable.threadId, threadId), afterCursor(workbenchesTable.createdAt, workbenchesTable.id, cursor)))
    .orderBy(desc(workbenchesTable.createdAt), desc(workbenchesTable.id))
    .limit(limit + 1);
}

// ---------------------------------------------------------------------------
// Scripts and previews
// ---------------------------------------------------------------------------

/** The state of each script that has run. Never the stored output. */
export function listScriptRunsQuery(sessionId: string) {
  return db()
    .select({ name: scriptRunsTable.name, running: scriptRunsTable.running, exitCode: scriptRunsTable.exitCode })
    .from(scriptRunsTable)
    .where(eq(scriptRunsTable.workbenchId, sessionId))
    .orderBy(asc(scriptRunsTable.name));
}

/** One script's state and its stored output (the last 64 KiB). */
export function getScriptRunQuery(sessionId: string, name: string) {
  return db()
    .select({
      name: scriptRunsTable.name,
      running: scriptRunsTable.running,
      exitCode: scriptRunsTable.exitCode,
      output: scriptRunsTable.output,
    })
    .from(scriptRunsTable)
    .where(and(eq(scriptRunsTable.workbenchId, sessionId), eq(scriptRunsTable.name, name)))
    .limit(1);
}

/** The ports that have a hosted preview host. */
export function listPreviewHostsQuery(sessionId: string) {
  return db()
    .select({ id: previewHostsTable.id, port: previewHostsTable.port })
    .from(previewHostsTable)
    .where(eq(previewHostsTable.workbenchId, sessionId))
    .orderBy(asc(previewHostsTable.port));
}

/** The repository's settings column, for the preview ports a session shows. */
export async function repositorySettingsOf(repositoryId: string | null) {
  if (!repositoryId) return null;
  const [row] = await db()
    .select({ settings: reposTable.settings })
    .from(reposTable)
    .where(eq(reposTable.id, repositoryId))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Chat queue
// ---------------------------------------------------------------------------

/**
 * A chat's queued messages, built in SQL: each message's attachments are
 * counted and never shipped, because they are base64 images.
 */
export function queuedMessagesQuery(chatId: string) {
  return db()
    .select({
      messages: sql<QueuedMessageRow[]>`coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', e.value ->> 'id',
          'text', e.value ->> 'text',
          'model', e.value ->> 'model',
          'effort', e.value ->> 'effort',
          'planMode', e.value -> 'planMode',
          'origin', e.value ->> 'origin',
          'queuedAt', e.value ->> 'queuedAt',
          'attachmentCount', coalesce(jsonb_array_length(e.value -> 'attachments'), 0)
        ) ORDER BY e.ord)
        FROM jsonb_array_elements(${chatsTable.queuedMessages}) WITH ORDINALITY AS e(value, ord)
      ), '[]'::jsonb)`,
    })
    .from(chatsTable)
    .where(eq(chatsTable.id, chatId))
    .limit(1);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function listMemoriesPageQuery(
  workspaceId: string,
  opts: Omit<ListMemoryOptions, 'includeBody'> & { includeBody: boolean },
  cursor: ListCursor | null,
  limit: number,
) {
  const { includeBody, ...filter } = opts;
  return db()
    .select({ ...PUBLIC_MEMORY_COLUMNS, body: includeBody ? memoriesTable.body : sql<string | null>`null` })
    .from(memoriesTable)
    .where(and(memoryListWhere(workspaceId, filter), afterCursor(memoriesTable.createdAt, memoriesTable.id, cursor)))
    .orderBy(desc(memoriesTable.createdAt), desc(memoriesTable.id))
    .limit(limit + 1);
}

export function getMemoryQuery(id: string) {
  return db()
    .select({ ...PUBLIC_MEMORY_COLUMNS, body: memoriesTable.body })
    .from(memoriesTable)
    .where(eq(memoriesTable.id, id))
    .limit(1);
}

/** A memory entry the token can reach, with its body. */
export async function authorizedMemory(token: ApiTokenPrincipal, id: string) {
  const [row] = await getMemoryQuery(id);
  if (!row) throw notFound('memory');
  try {
    await authorizeWorkspace(token, row.workspaceId);
  } catch {
    throw notFound('memory');
  }
  return row;
}
