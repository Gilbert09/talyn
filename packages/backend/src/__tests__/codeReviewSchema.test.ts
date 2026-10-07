/**
 * The code-review schema's load-bearing constraints, asserted against a real
 * (pglite) database rather than trusted.
 *
 * Every test here covers something whose failure mode is silent. A claim index
 * that does not dedupe boots a second microVM per evaluation pass and nothing
 * reports an error. A dedupe index that does not merge produces a second finding
 * saying the same thing, and the user's dismissal simply stops working. Neither
 * shows up in a typecheck, and neither is visible in the code that depends on it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  prCodeReviewFindings,
  prCodeReviewRuns,
  prCodeReviews,
  pullRequests,
  repositories,
  workspaces,
} from '../db/schema.js';

/**
 * The Postgres error code for a rejected write, found by walking the cause
 * chain rather than read off the top-level error.
 *
 * Drizzle reports `Failed query: insert into …` and puts the reason in `cause`,
 * so asserting `{ code }` on what it throws passes for the wrong reason — it
 * matches nothing and reports "24 matching properties omitted". The same trap
 * the debug bus documents for `describeError`.
 */
async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    return undefined;
  }
  throw new Error('expected the write to be rejected, and it was accepted');
}

const UNIQUE_VIOLATION = '23505';
const NOT_NULL_VIOLATION = '23502';

describe('code review schema', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  const review = {
    id: 'rev-1',
    workspaceId: 'ws-a',
    repositoryId: 'repo-a',
    pullRequestId: 'pr-a',
    cycle: 0,
    preset: 'standard',
    runsTotal: 4,
  };

  const unit = {
    id: 'run-1',
    reviewId: 'rev-1',
    workspaceId: 'ws-a',
    cycle: 0,
    kind: 'lens',
    lens: 'correctness',
    chunkIndex: 0,
  };

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({
      id: 'repo-a',
      workspaceId: 'ws-a',
      name: 'a/a',
      url: 'https://github.com/a/a',
    });
    await testDb.db.insert(pullRequests).values({
      id: 'pr-a',
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      owner: 'a',
      repo: 'a',
      number: 1,
      state: 'open',
    });
    await testDb.db.insert(prCodeReviews).values(review);
  });

  afterEach(async () => {
    await testDb.pglite.exec('RESET ROLE');
    await testDb.cleanup();
  });

  it('allows only one review per pull request, so a re-review reuses the row', async () => {
    expect(
      await rejectionCode(testDb.db.insert(prCodeReviews).values({ ...review, id: 'rev-2' }))
    ).toBe(UNIQUE_VIOLATION);
  });

  describe('the unit claim key', () => {
    it('refuses a second claim on the same unit of the same cycle', async () => {
      await testDb.db.insert(prCodeReviewRuns).values(unit);
      // The insert IS the claim, so this rejection is what stops two
      // evaluation passes both booting a sandbox for one lens.
      expect(
        await rejectionCode(testDb.db.insert(prCodeReviewRuns).values({ ...unit, id: 'run-2' }))
      ).toBe(UNIQUE_VIOLATION);
    });

    it('lets the next cycle claim the same unit, so a failed review can be retried', async () => {
      await testDb.db.insert(prCodeReviewRuns).values(unit);
      await testDb.db.insert(prCodeReviewRuns).values({ ...unit, id: 'run-2', cycle: 1 });
      const rows = await testDb.db.select({ id: prCodeReviewRuns.id }).from(prCodeReviewRuns);
      expect(rows).toHaveLength(2);
    });

    it('separates a lens from the sweep and from another chunk', async () => {
      await testDb.db.insert(prCodeReviewRuns).values(unit);
      await testDb.db.insert(prCodeReviewRuns).values({
        ...unit,
        id: 'run-sweep',
        kind: 'sweep',
        lens: '',
      });
      await testDb.db.insert(prCodeReviewRuns).values({ ...unit, id: 'run-c1', chunkIndex: 1 });
      const rows = await testDb.db.select({ id: prCodeReviewRuns.id }).from(prCodeReviewRuns);
      expect(rows).toHaveLength(3);
    });

    /**
     * The reason `lens` and `chunk_index` are NOT NULL with empty/zero
     * sentinels. Postgres treats NULLs as DISTINCT in a unique index, so a
     * nullable column anywhere in the claim key would make the key stop
     * deduping — every pass would claim the sweep again and boot another
     * microVM. This proves the columns actually reject a NULL, rather than
     * relying on nobody ever writing one.
     */
    it('refuses a NULL in the claim key, which would silently stop it deduping', async () => {
      for (const column of ['lens', 'chunk_index']) {
        expect(
          await rejectionCode(
            testDb.pglite.query(
              `INSERT INTO pr_code_review_runs (id, review_id, workspace_id, cycle, kind, ${column})
               VALUES ('run-null', 'rev-1', 'ws-a', 0, 'sweep', NULL)`
            )
          ),
          column
        ).toBe(NOT_NULL_VIOLATION);
      }
    });

    it('proves the assertion can fail: two NULLs in one unique index do NOT collide', async () => {
      // Guards the test above. If this ever starts rejecting, Postgres has
      // changed its NULL semantics and the sentinels are no longer needed —
      // which is worth knowing rather than assuming.
      await testDb.pglite.exec(`
        CREATE TABLE null_probe (a text, b text);
        CREATE UNIQUE INDEX null_probe_uq ON null_probe (a, b);
      `);
      await testDb.pglite.query(`INSERT INTO null_probe (a, b) VALUES ('x', NULL)`);
      await testDb.pglite.query(`INSERT INTO null_probe (a, b) VALUES ('x', NULL)`);
      const rows = await testDb.pglite.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM null_probe'
      );
      expect(rows.rows[0]?.n).toBe(2);
    });
  });

  describe('the finding dedupe key', () => {
    const finding = {
      id: 'f-1',
      reviewId: 'rev-1',
      workspaceId: 'ws-a',
      pullRequestId: 'pr-a',
      dedupeKey: 'abc123',
      severity: 'blocker',
      title: 'Null deref',
    };

    it('refuses a second finding with the same key, so a re-review merges', async () => {
      await testDb.db.insert(prCodeReviewFindings).values(finding);
      expect(
        await rejectionCode(
          testDb.db.insert(prCodeReviewFindings).values({ ...finding, id: 'f-2' })
        )
      ).toBe(UNIQUE_VIOLATION);
    });

    it('scopes the key to its review, so two PRs can carry the same finding', async () => {
      await testDb.db.insert(prCodeReviewFindings).values(finding);
      await testDb.db.insert(pullRequests).values({
        id: 'pr-b',
        workspaceId: 'ws-a',
        repositoryId: 'repo-a',
        owner: 'a',
        repo: 'a',
        number: 2,
        state: 'open',
      });
      await testDb.db
        .insert(prCodeReviews)
        .values({ ...review, id: 'rev-b', pullRequestId: 'pr-b' });
      await testDb.db
        .insert(prCodeReviewFindings)
        .values({ ...finding, id: 'f-3', reviewId: 'rev-b', pullRequestId: 'pr-b' });
      const rows = await testDb.db.select({ id: prCodeReviewFindings.id }).from(prCodeReviewFindings);
      expect(rows).toHaveLength(2);
    });
  });

  it('keeps the partial indexes the pacing and staleness reads depend on', async () => {
    const idx = await testDb.pglite.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename LIKE 'pr_code_review%'
    `);
    const byName = new Map(idx.rows.map((r) => [r.indexname, r.indexdef]));

    // Each of these carries a WHERE clause, and the clause is the point: an
    // index without it scans terminal rows forever as history accumulates.
    for (const name of [
      'idx_pr_code_reviews_active',
      'idx_pr_code_reviews_stale',
      'idx_pr_code_review_runs_active',
      'idx_pr_code_review_runs_ws_inflight',
      'idx_pr_code_review_runs_inflight',
      'idx_pr_code_review_findings_open',
    ]) {
      expect(byName.get(name), name).toMatch(/WHERE/);
    }

    // `ready` must be OUTSIDE the active set, or a review resting with findings
    // on screen would hold a free-plan slot for ever.
    expect(byName.get('idx_pr_code_reviews_active')).toMatch(/ready/);
    expect(byName.get('uq_pr_code_review_runs_claim')).toMatch(/UNIQUE/);
    expect(byName.get('uq_pr_code_review_findings_dedupe')).toMatch(/UNIQUE/);
  });

  /**
   * Migration 0074. Both columns must accept NULL, because every unit that ran
   * normally has neither, and both must exist under the names the Drizzle
   * schema reads.
   */
  it('stores why a unit failed and which agent it moved from, both optional', async () => {
    await testDb.db.insert(prCodeReviewRuns).values(unit);
    await testDb.db.insert(prCodeReviewRuns).values({
      ...unit,
      id: 'run-2',
      lens: 'security',
      failureDetail: 'You have hit your ChatGPT usage limit.',
      failedOverFrom: 'codex',
    });
    const rows = await testDb.pglite.query<{
      id: string;
      failure_detail: string | null;
      failed_over_from: string | null;
    }>(`SELECT id, failure_detail, failed_over_from FROM pr_code_review_runs ORDER BY id`);
    expect(rows.rows).toEqual([
      { id: 'run-1', failure_detail: null, failed_over_from: null },
      {
        id: 'run-2',
        failure_detail: 'You have hit your ChatGPT usage limit.',
        failed_over_from: 'codex',
      },
    ]);
  });

  it('cascades a deleted review to its units and findings, and a deleted PR to the review', async () => {
    await testDb.db.insert(prCodeReviewRuns).values(unit);
    await testDb.db.insert(prCodeReviewFindings).values({
      id: 'f-1',
      reviewId: 'rev-1',
      workspaceId: 'ws-a',
      pullRequestId: 'pr-a',
      dedupeKey: 'abc123',
      severity: 'minor',
      title: 'Style',
    });

    // Un-watching a PR deletes its row, and nothing should be left pointing at
    // a review that no longer has a pull request.
    await testDb.pglite.query(`DELETE FROM pull_requests WHERE id = 'pr-a'`);
    for (const table of ['pr_code_reviews', 'pr_code_review_runs', 'pr_code_review_findings']) {
      const rows = await testDb.pglite.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table}`
      );
      expect(rows.rows[0]?.n, table).toBe(0);
    }
  });
});
