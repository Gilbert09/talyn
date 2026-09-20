import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { tasks as tasksTable, pullRequests as pullRequestsTable } from '../db/schema.js';
import { DETAIL_COLUMNS, LIST_COLUMNS } from '../routes/pullRequests.js';
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

describe('pull request projection egress', () => {
  // `pull_requests.body` is the PR description — a TOASTed text column that
  // only `GET /:id/description` serializes. It must not ride along on the list
  // (one open panel would cost every tracked PR's description on every load)
  // nor on the whole-row detail reads, which drop it on the floor.
  it.each([
    ['LIST_COLUMNS', LIST_COLUMNS],
    ['DETAIL_COLUMNS', DETAIL_COLUMNS],
  ])('%s never references the body column', (_label, projection) => {
    const { sql } = db.select(projection).from(pullRequestsTable).toSQL();
    expect(sql).not.toContain('"body"');
    // sanity: the projections still carry what their callers read
    expect(sql).toContain('"last_summary"');
    expect(sql).toContain('"id"');
  });

  it('a bare select(), by contrast, DOES reference body (guards the test itself)', () => {
    const { sql } = db.select().from(pullRequestsTable).toSQL();
    expect(sql).toContain('"body"');
  });
});
