import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { PublicApiError } from './errors.js';

/**
 * Opaque list cursors: base64url JSON of the last row's `created_at` and `id`.
 * Lists are ordered `created_at DESC, id DESC`, so a page boundary is the
 * pair, and two rows created in the same microsecond still page correctly.
 *
 * The timestamp is the database's own text, at microsecond precision. A JS
 * Date keeps milliseconds only, and a cursor rounded to the millisecond
 * would repeat or skip rows created in the same millisecond.
 */
export interface ListCursor {
  /** `created_at` as UTC text with microseconds, e.g. `2026-11-02T09:30:00.123456Z`. */
  t: string;
  id: string;
}

const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(raw: string | undefined): ListCursor | null {
  if (raw === undefined || raw === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<ListCursor>;
    if (typeof parsed?.t === 'string' && TIME_PATTERN.test(parsed.t) && typeof parsed.id === 'string' && parsed.id) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // Fall through to the refusal.
  }
  throw new PublicApiError(400, 'invalid_cursor', 'The cursor is not valid. Pass the next_cursor of a previous page.', {
    param: 'cursor',
  });
}

/** `created_at` as cursor text, selected beside each row. */
export function cursorTimeColumn(createdAt: AnyColumn): SQL<string> {
  return sql<string>`to_char(${createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Rows after the cursor in `created_at DESC, id DESC` order. The values are
 * passed as text and cast in SQL: a JS Date in a raw `sql` fragment is not
 * encoded by postgres-js (see CLAUDE.md, "Compare a date with lt/gt").
 */
export function afterCursor(createdAt: AnyColumn, id: AnyColumn, cursor: ListCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${createdAt}, ${id}) < (${cursor.t}::timestamptz, ${cursor.id})`;
}

/** Split a `limit + 1` fetch into a page and its `has_more` / `next_cursor`. */
export function pageOf<R extends { cursorTime: string; id: string }>(
  rows: R[],
  limit: number,
): { rows: R[]; hasMore: boolean; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { rows: page, hasMore, nextCursor: hasMore && last ? encodeCursor({ t: last.cursorTime, id: last.id }) : null };
}
