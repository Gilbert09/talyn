import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  ingestCheckRun,
  pruneChecksForSha,
  parseCheckRunPayload,
  type CheckEventInput,
} from '../services/checkCounts.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  prCheckStates,
} from '../db/schema.js';

describe('checkCounts', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'A', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'r1',
      workspaceId: 'ws1',
      name: 'acme/widget',
      url: 'https://github.com/acme/widget',
      defaultBranch: 'main',
      createdAt: new Date(),
    });
  });
  afterEach(async () => {
    await cleanup();
  });

  const ZERO = { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 };

  async function seedPr(number: number, headSha: string) {
    await db.insert(pullRequestsTable).values({
      id: `pr-${number}`,
      workspaceId: 'ws1',
      repositoryId: 'r1',
      owner: 'acme',
      repo: 'widget',
      number,
      state: 'open',
      lastSummary: { headSha, checks: { ...ZERO } },
    });
  }
  const targets = [{ workspaceId: 'ws1', repositoryId: 'r1' }];
  const tracked = (nums: number[]) => new Map([['r1', new Set(nums)]]);
  const ev = (over: Partial<CheckEventInput> = {}): CheckEventInput => ({
    repoFullName: 'acme/widget',
    owner: 'acme',
    repo: 'widget',
    headSha: 'sha-A',
    name: 'lint',
    source: 'check_run',
    externalId: '1',
    state: 'success',
    ts: new Date('2026-06-16T10:00:00Z'),
    ...over,
  });
  async function checksOf(number: number) {
    const rows = await db
      .select({ ls: pullRequestsTable.lastSummary })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, `pr-${number}`));
    return (rows[0].ls as { checks: Record<string, number> }).checks;
  }

  describe('parseCheckRunPayload', () => {
    it('extracts + normalizes a completed check_run', () => {
      const parsed = parseCheckRunPayload(
        {
          check_run: {
            id: 42,
            name: 'Build',
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc',
            completed_at: '2026-06-16T10:00:00Z',
          },
          repository: { owner: { login: 'Acme' }, name: 'Widget' },
        },
        'Acme/Widget',
      );
      expect(parsed).toMatchObject({
        repoFullName: 'acme/widget',
        name: 'Build',
        headSha: 'abc',
        state: 'success',
        externalId: '42',
      });
    });

    it('returns null without a name or head sha', () => {
      expect(parseCheckRunPayload({ check_run: { status: 'queued' } }, 'a/b')).toBeNull();
    });

    it.each([
      [{ status: 'in_progress' }, 'in_progress'],
      [{ status: 'queued' }, 'pending'],
      [{ status: 'completed', conclusion: 'failure' }, 'failure'],
      [{ status: 'completed', conclusion: 'skipped' }, 'skipped'],
      [{ status: 'completed', conclusion: 'success' }, 'success'],
    ])('maps %o → %s', (cr, want) => {
      const parsed = parseCheckRunPayload(
        { check_run: { name: 'x', head_sha: 's', ...cr } },
        'a/b',
      );
      expect(parsed?.state).toBe(want);
    });
  });

  describe('ingestCheckRun', () => {
    it('builds counts from check_run events for a tracked PR on the head commit', async () => {
      await seedPr(7, 'sha-A');
      const n = await ingestCheckRun(ev({ name: 'lint', state: 'success' }), targets, [7], tracked([7]));
      expect(n).toBe(1);
      expect(await checksOf(7)).toEqual({ total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 });
      await ingestCheckRun(ev({ name: 'test', state: 'success' }), targets, [7], tracked([7]));
      expect(await checksOf(7)).toEqual({ total: 2, passed: 2, failed: 0, inProgress: 0, skipped: 0 });
      await ingestCheckRun(ev({ name: 'e2e', state: 'in_progress' }), targets, [7], tracked([7]));
      expect(await checksOf(7)).toEqual({ total: 3, passed: 2, failed: 0, inProgress: 1, skipped: 0 });
    });

    it('dedupes a re-run by name (latest state wins, total unchanged)', async () => {
      await seedPr(7, 'sha-A');
      await ingestCheckRun(
        ev({ name: 'lint', state: 'success', ts: new Date('2026-06-16T10:00:00Z') }),
        targets,
        [7],
        tracked([7]),
      );
      await ingestCheckRun(
        ev({ name: 'lint', state: 'failure', ts: new Date('2026-06-16T10:05:00Z') }),
        targets,
        [7],
        tracked([7]),
      );
      expect(await checksOf(7)).toEqual({ total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 });
      expect(await db.select().from(prCheckStates)).toHaveLength(1); // one row per name
    });

    it('ignores an out-of-order older event (does not regress a check)', async () => {
      await seedPr(7, 'sha-A');
      await ingestCheckRun(
        ev({ name: 'lint', state: 'failure', ts: new Date('2026-06-16T10:05:00Z') }),
        targets,
        [7],
        tracked([7]),
      );
      // A stale 'queued' event for the same check arrives late — must not overwrite.
      await ingestCheckRun(
        ev({ name: 'lint', state: 'pending', ts: new Date('2026-06-16T10:00:00Z') }),
        targets,
        [7],
        tracked([7]),
      );
      expect(await checksOf(7)).toEqual({ total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 });
    });

    it('does not count — or store — checks on a superseded commit', async () => {
      await seedPr(7, 'sha-A'); // PR head is sha-A
      const n = await ingestCheckRun(ev({ headSha: 'sha-OLD' }), targets, [7], tracked([7]));
      expect(n).toBe(0);
      expect(await checksOf(7)).toEqual(ZERO); // unchanged
      expect(await db.select().from(prCheckStates)).toHaveLength(0); // not stored
    });

    it('ignores — and does not store — a check for an untracked PR', async () => {
      const n = await ingestCheckRun(ev(), targets, [8], tracked([])); // nothing tracked
      expect(n).toBe(0);
      expect(await db.select().from(prCheckStates)).toHaveLength(0);
    });

    it('counts only cancelled checks toward total, not the sub-buckets', async () => {
      await seedPr(7, 'sha-A');
      await ingestCheckRun(ev({ name: 'a', state: 'success' }), targets, [7], tracked([7]));
      await ingestCheckRun(ev({ name: 'b', state: 'cancelled' }), targets, [7], tracked([7]));
      expect(await checksOf(7)).toEqual({ total: 2, passed: 1, failed: 0, inProgress: 0, skipped: 0 });
    });
  });

  describe('pruneChecksForSha', () => {
    it('deletes all check state for a commit', async () => {
      await seedPr(7, 'sha-A');
      await ingestCheckRun(ev({ name: 'lint' }), targets, [7], tracked([7]));
      await ingestCheckRun(ev({ name: 'test' }), targets, [7], tracked([7]));
      expect(await db.select().from(prCheckStates)).toHaveLength(2);
      await pruneChecksForSha('acme/widget', 'sha-A');
      expect(await db.select().from(prCheckStates)).toHaveLength(0);
    });
  });
});
