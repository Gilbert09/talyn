import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usagePeriodFor } from '@talyn/shared';
import { createTestDb } from './helpers/testDb.js';

/**
 * Migration 0118 moves stored usage period boundaries to 00:00 UTC, to match
 * usagePeriodFor. The test database runs every migration before any rows
 * exist, so the test seeds rows and runs the statements of 0118 again.
 */

const MIGRATION = path.resolve(__dirname, '../db/migrations/0118_usage_period_midnight.sql');
const statements = () =>
  fs.readFileSync(MIGRATION, 'utf-8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);

describe('migration 0118: usage periods start at midnight UTC', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
  });
  afterEach(async () => {
    await testDb.cleanup();
  });

  async function seed(owner: string, start: string, end: string, usedWsec = 0): Promise<void> {
    await testDb.pglite.query(
      `INSERT INTO usage_periods (owner_id, period_start, period_end, tier, included_wsec, used_wsec)
       VALUES ($1, $2, $3, 'pro', 720000, $4)`,
      [owner, start, end, usedWsec],
    );
  }

  async function periods(): Promise<Array<{ owner: string; start: string; end: string; used: number }>> {
    const r = await testDb.pglite.query<{ owner_id: string; period_start: Date; period_end: Date; used_wsec: string | number }>(
      'SELECT owner_id, period_start, period_end, used_wsec FROM usage_periods ORDER BY owner_id, period_start',
    );
    return r.rows.map((row) => ({
      owner: row.owner_id,
      start: new Date(row.period_start).toISOString(),
      end: new Date(row.period_end).toISOString(),
      used: Number(row.used_wsec),
    }));
  }

  it('moves a subscriber period to midnight and keeps its usage, so the meter finds it', async () => {
    await seed('sub', '2026-10-20T09:00:00.000Z', '2026-11-20T09:00:00.000Z', 3600);
    await seed('free', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', 60);
    for (const stmt of statements()) await testDb.pglite.exec(stmt);

    expect(await periods()).toEqual([
      { owner: 'free', start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z', used: 60 },
      { owner: 'sub', start: '2026-10-20T00:00:00.000Z', end: '2026-11-20T00:00:00.000Z', used: 3600 },
    ]);
    const current = usagePeriodFor({ now: new Date('2026-11-15T12:00:00.000Z'), anchor: new Date('2026-11-20T09:00:00.000Z') });
    expect(current.start.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it('leaves a row alone when its owner already has a period starting that midnight', async () => {
    await seed('dup', '2026-10-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z');
    await seed('dup', '2026-10-20T09:00:00.000Z', '2026-11-20T09:00:00.000Z');
    for (const stmt of statements()) await testDb.pglite.exec(stmt);

    expect((await periods()).map((p) => p.start)).toEqual(['2026-10-20T00:00:00.000Z', '2026-10-20T09:00:00.000Z']);
  });
});
