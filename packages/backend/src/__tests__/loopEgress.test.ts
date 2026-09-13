import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { getDbClient } from '../db/client.js';
import {
  loopRuns as runsTable,
  loops as loopsTable,
  pullRequests as prTable,
  tasks as tasksTable,
} from '../db/schema.js';
import { countLoopsQuery } from '../services/loops/store.js';
import { DUE_LOOP_COLUMNS } from '../services/loops/runs.js';

/**
 * Egress regression guards for the loop reads.
 *
 * `.toSQL()` renders a query without running it, so these assert the projected
 * column set directly. The column that matters is `tasks.transcript` —
 * routinely megabytes of conversation log, and the loops history joins `tasks`
 * on every page. A `SELECT *` there would ship fifty transcripts to render
 * fifty status pills.
 */

describe('loop egress', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('the history join never selects the transcript', () => {
    // The same shape `listLoopRuns` builds.
    const query = db
      .select({
        run: runsTable,
        taskStatus: tasksTable.status,
        taskCompletedAt: tasksTable.completedAt,
        taskPrOwner: prTable.owner,
        taskPrRepo: prTable.repo,
        taskPrNumber: prTable.number,
      })
      .from(runsTable)
      .leftJoin(tasksTable, eq(tasksTable.id, runsTable.taskId))
      .leftJoin(prTable, eq(prTable.id, tasksTable.pullRequestId))
      .where(and(eq(runsTable.loopId, 'x'), lt(runsTable.createdAt, new Date())))
      .orderBy(desc(runsTable.createdAt))
      .limit(50);

    const { sql: text } = query.toSQL();
    expect(text).not.toContain('transcript');
    // `pull_requests.last_summary` is the other expensive jsonb in this schema,
    // and a link needs only owner/repo/number.
    expect(text).not.toContain('last_summary');
    expect(text).toContain('"loop_runs"');
  });

  it('the nav-badge count fetches no rows at all', () => {
    // It runs on every client boot whether or not anybody opens the page, so it
    // must not be `list().length` — that read is a SELECT * plus an aggregate
    // over the entire run history.
    const { sql: text } = countLoopsQuery('ws-1').toSQL();
    expect(text).toContain('count(*)');
    expect(text).not.toContain('"prompt"');
  });

  it('the due-loops read takes only what a firing needs', () => {
    // Typed with `Pick` in runs.ts, so a consumer that later reads a column
    // this drops fails tsc rather than silently re-bloating the query.
    const query = getDbClient()
      .select(DUE_LOOP_COLUMNS)
      .from(loopsTable)
      .where(and(eq(loopsTable.enabled, true), sql`${loopsTable.nextRunAt} <= now()`));
    const { sql: text } = query.toSQL();
    expect(text).toContain('"cron"');
    // Neither is needed to fire a loop, and both would ship on every tick.
    expect(text).not.toContain('disabled_reason');
    expect(text).not.toContain('updated_at');
  });

  it('the settlement backstop reads the task status, not the task', () => {
    const query = db
      .select({
        runId: runsTable.id,
        status: runsTable.status,
        taskId: runsTable.taskId,
        dispatchedAt: runsTable.dispatchedAt,
        taskStatus: tasksTable.status,
      })
      .from(runsTable)
      .leftJoin(tasksTable, eq(tasksTable.id, runsTable.taskId));
    expect(query.toSQL().sql).not.toContain('transcript');
  });
});
