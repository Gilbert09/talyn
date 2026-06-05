import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { tasks as tasksTable } from '../db/schema.js';
import { taskColumnsNoTranscript } from '../services/taskSerialize.js';
import type { Database } from '../db/client.js';

/**
 * Egress regression guards: the list/loop reads must never emit the heavy
 * `transcript` jsonb in their generated SQL. `.toSQL()` renders the query
 * without executing it, so we can assert the projected column set directly.
 */

let db: Database;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterEach(async () => {
  await cleanup();
});

describe('task projection egress', () => {
  it('taskColumnsNoTranscript select never references the transcript column', () => {
    const { sql } = db.select(taskColumnsNoTranscript).from(tasksTable).toSQL();
    expect(sql).not.toContain('transcript');
    // sanity: it still selects the columns the list needs
    expect(sql).toContain('"id"');
    expect(sql).toContain('"status"');
    expect(sql).toContain('"metadata"');
  });

  it('a bare select(), by contrast, DOES reference transcript (guards the test itself)', () => {
    const { sql } = db.select().from(tasksTable).toSQL();
    expect(sql).toContain('transcript');
  });
});
