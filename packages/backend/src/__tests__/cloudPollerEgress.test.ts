import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { tasks as tasksTable, workspaces as workspacesTable } from '../db/schema.js';
import type { Database } from '../db/client.js';

/**
 * The cloud-task poller no longer selects the `transcript` jsonb (a multi-MB
 * blob) every tick — it computes emptiness server-side. This test pins that
 * SQL expression to the exact JS semantics it replaced
 * (`!Array.isArray(t) || t.length === 0`) across every jsonb shape, using real
 * Postgres semantics via pglite.
 */

let db: Database;
let cleanup: () => Promise<void>;

/** The exact emptiness expression used in cloudProviders/poller.ts. */
const transcriptEmptyExpr = sql<boolean>`CASE WHEN jsonb_typeof(${tasksTable.transcript}) = 'array' THEN jsonb_array_length(${tasksTable.transcript}) = 0 ELSE true END`;

async function seedTask(id: string, transcript: unknown): Promise<void> {
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'in_progress',
    priority: 'medium',
    title: 't',
    description: 'd',
    transcript: transcript as object | null,
  });
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db, { id: 'owner1' });
  await db.insert(workspacesTable).values({ id: 'ws1', ownerId: 'owner1', name: 'ws', settings: {} });
});

afterEach(async () => {
  await cleanup();
});

describe('narrowed transcriptEmpty SQL', () => {
  it.each([
    ['null transcript', null, true],
    ['empty array', [], true],
    ['non-empty array', [{ type: 'message' }], false],
    ['multi-element array', [{ a: 1 }, { b: 2 }], false],
    ['non-array object', { foo: 'bar' }, true],
  ])('%s → empty=%s, matching the old JS check', async (label, transcript, expected) => {
    const id = `task-${label.replace(/\s+/g, '-')}`;
    await seedTask(id, transcript);

    const [row] = await db
      .select({ id: tasksTable.id, transcriptEmpty: transcriptEmptyExpr })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));

    // Old behaviour we must preserve, computed the JS way for cross-check.
    const jsEmpty = !Array.isArray(transcript) || transcript.length === 0;

    expect(row.transcriptEmpty).toBe(expected);
    expect(row.transcriptEmpty).toBe(jsEmpty);
  });

  it('only returns in-progress tasks, with emptiness resolved per row', async () => {
    await seedTask('a', [{ type: 'x' }]);
    await seedTask('b', null);
    await db
      .update(tasksTable)
      .set({ status: 'completed' })
      .where(eq(tasksTable.id, 'a'));

    const rows = await db
      .select({ id: tasksTable.id, transcriptEmpty: transcriptEmptyExpr })
      .from(tasksTable)
      .where(eq(tasksTable.status, 'in_progress'));

    expect(rows).toEqual([{ id: 'b', transcriptEmpty: true }]);
  });
});
