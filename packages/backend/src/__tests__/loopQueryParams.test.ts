import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createTestDb } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  activeRunsWithTaskStatus,
  dueLoops,
  isSuperseded,
  orphanedClaims,
} from '../services/loops/runs.js';

/**
 * Every date a loop query compares against must reach the driver ENCODED.
 *
 * The scheduler sweep died in production on a line that reads as equivalent to
 * the one next to it:
 *
 *   sql`${runsTable.createdAt} < ${olderThan}`   // dead
 *   lt(runsTable.createdAt, olderThan)           // fine
 *
 * A value interpolated into a raw `sql` fragment carries no column type, so
 * drizzle passes it through unencoded and postgres-js throws `The "string"
 * argument must be of type string … Received an instance of Date` before
 * Postgres is ever asked. Every 30s tick failed; settlement and orphan reaping
 * stopped for as long as it was deployed.
 *
 * Running the query is not the test — pglite's drizzle session encodes the Date
 * itself, so the broken version passes against it. What distinguishes them is
 * what lands in the driver's parameter list, so that is what this asserts. It
 * catches the mistake in the one place it is invisible.
 */
describe('loop queries — no unencoded Date reaches the driver', () => {
  let db: Database;
  let pglite: PGlite;
  let cleanup: () => Promise<void>;
  let params: unknown[][];

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    pglite = testDb.pglite;
    cleanup = testDb.cleanup;
    params = [];
    const original = pglite.query.bind(pglite) as (
      query: string,
      p?: unknown[],
      o?: unknown
    ) => Promise<unknown>;
    // drizzle's pglite session funnels every statement through `client.query`.
    (pglite as unknown as { query: typeof original }).query = (query, p, o) => {
      if (p) params.push(p);
      return original(query, p, o);
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  const dates = () => params.flat().filter((p) => p instanceof Date);

  it.each([
    ['orphanedClaims', () => orphanedClaims(new Date(Date.now() - 300_000), 10)],
    ['isSuperseded', () => isSuperseded('loop-1', new Date())],
    ['dueLoops', () => dueLoops(10)],
    ['activeRunsWithTaskStatus', () => activeRunsWithTaskStatus(10)],
  ])('%s encodes every date parameter', async (_name, run) => {
    await run();
    expect(params.length).toBeGreaterThan(0);
    expect(dates()).toEqual([]);
  });

  it('proves the assertion can fail', async () => {
    // Guards the guard: if drizzle ever started encoding raw `sql` params, or
    // the interception stopped seeing them, every case above would pass for the
    // wrong reason and say nothing.
    const { sql } = await import('drizzle-orm');
    const { loopRuns } = await import('../db/schema.js');
    await db
      .select({ id: loopRuns.id })
      .from(loopRuns)
      .where(sql`${loopRuns.createdAt} < ${new Date()}`);
    expect(dates()).not.toEqual([]);
  });
});
