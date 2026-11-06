import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import {
  spaces,
  teamAdmins,
  teamMembers,
  teamSeats,
  teams,
  users,
} from '../db/schema.js';

/**
 * Migration 0116 backfills `team_members` from the billing tables. The test
 * database runs every migration before any rows exist, so the test seeds the
 * billing tables and runs the backfill statements of 0116 again.
 */

const MIGRATION = path.resolve(__dirname, '../db/migrations/0116_teams_spaces.sql');

function backfillStatements(): string[] {
  return fs
    .readFileSync(MIGRATION, 'utf-8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => /^(--[^\n]*\n)*(INSERT INTO "team_members"|UPDATE "team_members")/.test(s));
}

describe('migration 0116: team_members backfill', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  async function runBackfill(): Promise<void> {
    for (const stmt of backfillStatements()) await testDb.pglite.exec(stmt);
  }

  async function members() {
    const rows = await testDb.db
      .select({
        teamId: teamMembers.teamId,
        githubUserId: teamMembers.githubUserId,
        userId: teamMembers.userId,
        githubLogin: teamMembers.githubLogin,
        role: teamMembers.role,
        source: teamMembers.source,
      })
      .from(teamMembers)
      .orderBy(asc(teamMembers.teamId), asc(teamMembers.githubUserId));
    return rows;
  }

  beforeEach(async () => {
    testDb = await createTestDb();
    await testDb.db.insert(users).values([
      { id: 'u-alice', email: 'a@x.test', githubUserId: 100, githubUsername: 'alice' },
      { id: 'u-bob', email: 'b@x.test', githubUserId: 200, githubUsername: 'bob' },
      { id: 'u-dan', email: 'd@x.test', githubUserId: 400, githubUsername: 'dan' },
      { id: 'u-erin', email: 'e@x.test', githubUserId: 500, githubUsername: 'erin' },
      { id: 'u-fay', email: 'f@x.test', githubUserId: 600, githubUsername: 'fay' },
      // No GitHub id: cannot be keyed, so the backfill skips this admin.
      { id: 'u-nogh', email: 'n@x.test', githubUsername: 'nogh' },
    ]);
    await testDb.db.insert(teams).values([
      { id: 't1', name: 'Paid', createdByUserId: 'u-alice', plan: 'team', seatsPurchased: 5 },
      { id: 't2', name: 'Creator left', createdByUserId: 'u-dan' },
      // A free team: every billing column null or default.
      { id: 't3', name: 'Free', createdByUserId: 'u-nogh' },
    ]);
    await testDb.db.insert(teamAdmins).values([
      { teamId: 't1', userId: 'u-alice' },
      { teamId: 't1', userId: 'u-bob' },
      { teamId: 't2', userId: 'u-erin', createdAt: new Date('2026-01-01') },
      { teamId: 't2', userId: 'u-fay', createdAt: new Date('2026-02-01') },
      { teamId: 't3', userId: 'u-nogh' },
    ]);
    await testDb.db.insert(teamSeats).values([
      { id: 's1', teamId: 't1', githubUserId: 100, githubLogin: 'alice' },
      { id: 's2', teamId: 't1', githubUserId: 200, githubLogin: 'bob' },
      { id: 's3', teamId: 't1', githubUserId: 300, githubLogin: 'carol', avatarUrl: 'https://a/c' },
      { id: 's4', teamId: 't3', githubUserId: 700, githubLogin: 'gus' },
    ]);
    await runBackfill();
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it('finds both backfill statements in the migration', () => {
    expect(backfillStatements()).toHaveLength(2);
  });

  it('maps the creator to owner, admins to admin and seat holders to member', async () => {
    expect((await members()).filter((m) => m.teamId === 't1')).toEqual([
      { teamId: 't1', githubUserId: 100, userId: 'u-alice', githubLogin: 'alice', role: 'owner', source: 'seat' },
      { teamId: 't1', githubUserId: 200, userId: 'u-bob', githubLogin: 'bob', role: 'admin', source: 'seat' },
      { teamId: 't1', githubUserId: 300, userId: null, githubLogin: 'carol', role: 'member', source: 'seat' },
    ]);
  });

  it('makes the oldest admin the owner when the creator is no longer an admin', async () => {
    expect((await members()).filter((m) => m.teamId === 't2')).toEqual([
      { teamId: 't2', githubUserId: 500, userId: 'u-erin', githubLogin: 'erin', role: 'owner', source: 'invite' },
      { teamId: 't2', githubUserId: 600, userId: 'u-fay', githubLogin: 'fay', role: 'admin', source: 'invite' },
    ]);
  });

  it('skips an admin with no GitHub id and keeps a free team working', async () => {
    expect((await members()).filter((m) => m.teamId === 't3')).toEqual([
      { teamId: 't3', githubUserId: 700, userId: null, githubLogin: 'gus', role: 'member', source: 'seat' },
    ]);
    await testDb.db.insert(spaces).values({ id: 'sp', teamId: 't3', name: 'Backend' });
    const [space] = await testDb.db.select({ teamId: spaces.teamId }).from(spaces);
    expect(space?.teamId).toBe('t3');
  });

  it('is safe to run twice', async () => {
    const before = await members();
    await runBackfill();
    expect(await members()).toEqual(before);
  });

  it('enables RLS on the new tables', async () => {
    const result = await testDb.pglite.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('team_members', 'spaces', 'space_repositories') ORDER BY relname`
    );
    expect(result.rows).toEqual([
      { relname: 'space_repositories', relrowsecurity: true },
      { relname: 'spaces', relrowsecurity: true },
      { relname: 'team_members', relrowsecurity: true },
    ]);
  });
});
