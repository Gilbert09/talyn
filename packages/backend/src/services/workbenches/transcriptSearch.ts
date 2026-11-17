import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { usageInsightsBackfill, workbenchChats, workbenches as workbenchesTable } from '../../db/schema.js';
import { TRANSCRIPT_SEARCH_MIN_LENGTH } from '@talyn/shared';
import { inBackfillWindow } from '../insights/backfill.js';
import { withMaintenanceClaim } from './maintenanceClaim.js';
import { WORKBENCH_COLUMNS, type WorkbenchRow } from './store.js';

/**
 * Search in transcripts (⌘K). The trigger of migration 0142 copies the text of
 * each user and assistant event into `workbench_search_text`; this file reads
 * it, and backfills the chats from before the trigger.
 */

const db = () => getPoolDbClient();

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** At most this many sessions in one answer. */
export const TRANSCRIPT_SEARCH_LIMIT = 20;
const MAX_TERMS = 8;
const MAX_QUERY_LENGTH = 200;
const SEARCH_TIMEOUT_MS = 5000;
const SNIPPET_BEFORE = 40;
const SNIPPET_LENGTH = 160;

/**
 * The words of a search, lowercase, letters and digits only. They place the
 * snippet. Postgres tokenizes the query itself, with the parser of the text.
 */
export function transcriptSearchTerms(query: string): string[] {
  if (query.trim().length < TRANSCRIPT_SEARCH_MIN_LENGTH) return [];
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  return [...new Set(words)].slice(0, MAX_TERMS);
}

/** The text around the first match of a term, on one line. */
export function transcriptSnippet(body: string, terms: readonly string[]): string {
  const text = body.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t)).filter((at) => at >= 0);
  const at = hits.length > 0 ? Math.min(...hits) : 0;
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

export interface TranscriptSearchHit {
  row: WorkbenchRow;
  chatId: string;
  seq: number;
  role: 'user' | 'assistant';
  snippet: string;
}

/**
 * The sessions and threads of a workspace whose transcripts hold every word
 * of the search (each as a word prefix), archived ones too. One hit for each
 * session: its newest matching message from a person, else its newest
 * matching agent text. Sessions whose match is newest come first.
 */
export async function searchTranscripts(
  workspaceId: string,
  query: string,
  limit = TRANSCRIPT_SEARCH_LIMIT,
): Promise<TranscriptSearchHit[]> {
  const terms = transcriptSearchTerms(query);
  if (terms.length === 0) return [];
  const matches = await db().transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${SEARCH_TIMEOUT_MS}`));
    return rowsOf<{ workbench_id: string; chat_id: string; seq: number | string; role: string; body: string }>(await tx.execute(sql`
      SELECT workbench_id, chat_id, seq, role, body FROM (
        SELECT DISTINCT ON (workbench_id) workbench_id, chat_id, seq, role, body, created_at
        FROM workbench_search_text
        WHERE workspace_id = ${workspaceId} AND tsv @@ (
          -- Tokenized like the text (uv.lock stays one word), then each word as a prefix.
          SELECT regexp_replace(plainto_tsquery('simple', ${query.slice(0, MAX_QUERY_LENGTH)})::text, '''(\\s|$)', ''':*\\1', 'g')::tsquery
        )
        ORDER BY workbench_id, (role = 'user') DESC, created_at DESC, seq DESC
      ) m
      ORDER BY created_at DESC
      LIMIT ${limit}
    `));
  });
  if (matches.length === 0) return [];
  const rows = await db()
    .select(WORKBENCH_COLUMNS)
    .from(workbenchesTable)
    .where(and(eq(workbenchesTable.workspaceId, workspaceId), inArray(workbenchesTable.id, matches.map((m) => m.workbench_id))));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return matches.flatMap((m) => {
    const row = byId.get(m.workbench_id);
    if (!row) return [];
    return [{
      row,
      chatId: m.chat_id,
      seq: Number(m.seq),
      role: m.role === 'user' ? 'user' as const : 'assistant' as const,
      snippet: transcriptSnippet(m.body, terms),
    }];
  });
}

// ============================================================================
// Backfill
// ============================================================================

/** The backfill's cursor row in `usage_insights_backfill`. */
export const TRANSCRIPT_SEARCH_BACKFILL = 'transcript-search-backfill';

/** Chats per tick. Like the Insights backfill, a tick reads every event of these chats once. */
export const TRANSCRIPT_SEARCH_BACKFILL_BATCH = 40;

export interface TranscriptSearchBackfillTick {
  chats: number;
  rows: number;
  completed: boolean;
}

/**
 * One batch of chats in id order, every chat however old. The rows that the
 * trigger already wrote win (`ON CONFLICT DO NOTHING`), so an overlap or a
 * second replica costs a repeated read only. Exported for tests.
 */
export async function backfillTranscriptSearchBatch(
  batchSize = TRANSCRIPT_SEARCH_BACKFILL_BATCH,
  now = new Date(),
): Promise<TranscriptSearchBackfillTick> {
  const [state] = await db()
    .select({ cursor: usageInsightsBackfill.cursor, completedAt: usageInsightsBackfill.completedAt })
    .from(usageInsightsBackfill)
    .where(eq(usageInsightsBackfill.name, TRANSCRIPT_SEARCH_BACKFILL))
    .limit(1);
  if (state?.completedAt) return { chats: 0, rows: 0, completed: true };

  const batch = await db()
    .select({ id: workbenchChats.id })
    .from(workbenchChats)
    .where(state?.cursor ? gt(workbenchChats.id, state.cursor) : undefined)
    .orderBy(asc(workbenchChats.id))
    .limit(batchSize);
  const ids = batch.map((c) => c.id);

  let rows = 0;
  if (ids.length > 0) {
    const inserted = await db().execute(sql`
      INSERT INTO workbench_search_text (chat_id, seq, workbench_id, workspace_id, role, body, created_at)
      SELECT e.chat_id, e.seq, c.workbench_id, c.workspace_id, e.event ->> 'type', b.body, e.created_at
      FROM workbench_events e
      JOIN workbench_chats c ON c.id = e.chat_id
      CROSS JOIN LATERAL (SELECT workbench_search_body(e.event) AS body) b
      WHERE e.chat_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        AND e.event ->> 'type' IN ('user', 'assistant')
        AND b.body IS NOT NULL
      ON CONFLICT (chat_id, seq) DO NOTHING
      RETURNING seq
    `);
    rows = rowsOf(inserted).length;
  }

  const completed = ids.length < batchSize;
  const cursor = ids.length > 0 ? ids[ids.length - 1] : state?.cursor ?? null;
  await db()
    .insert(usageInsightsBackfill)
    .values({ name: TRANSCRIPT_SEARCH_BACKFILL, cursor, chatsDone: ids.length, completedAt: completed ? now : null })
    .onConflictDoUpdate({
      target: usageInsightsBackfill.name,
      set: {
        cursor,
        chatsDone: sql`${usageInsightsBackfill.chatsDone} + ${ids.length}`,
        completedAt: completed ? now : null,
        updatedAt: now,
      },
    });
  return { chats: ids.length, rows, completed };
}

/** The maintenance tick: one batch, in the Insights backfill's night window only. */
export async function backfillTranscriptSearch(now = new Date()): Promise<boolean> {
  if (!inBackfillWindow(now)) return false;
  return withMaintenanceClaim(TRANSCRIPT_SEARCH_BACKFILL, async (renew) => {
    await renew();
    await backfillTranscriptSearchBatch(TRANSCRIPT_SEARCH_BACKFILL_BATCH, now);
  });
}
