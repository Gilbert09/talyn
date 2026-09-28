/**
 * The numbers the review dashboard is built on, asserted against a real (pglite)
 * database.
 *
 * Two reasons this needs a live database rather than a mock. The aggregate is
 * hand-written SQL — `count(*) filter`, `array_agg(distinct …) filter`, a numeric
 * `sum` that comes back as a string — and every capture in that module swallows
 * its own errors, which is right for a dashboard and means a broken query would
 * report nothing and look fine. So the suite calls the gather directly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  prCodeReviewEvents,
  prCodeReviewRuns,
  prCodeReviews,
  pullRequests,
  repositories,
  workspaces,
} from '../db/schema.js';
import { codeReviewCycleShape } from '../services/codeReview/analytics.js';
import { getReview } from '../services/codeReview/store.js';

const STARTED = new Date('2026-09-28T10:00:00.000Z');
const DISPATCHED = new Date('2026-09-28T10:00:30.000Z');

describe('codeReviewCycleShape', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  const unit = {
    reviewId: 'rev-1',
    workspaceId: 'ws-a',
    cycle: 2,
    kind: 'lens',
    chunkIndex: 0,
    provider: 'selfhosted',
    model: 'claude-sonnet-5',
    dispatchedAt: DISPATCHED,
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
    await testDb.db.insert(prCodeReviews).values({
      id: 'rev-1',
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      pullRequestId: 'pr-a',
      cycle: 2,
      preset: 'standard',
      runsTotal: 4,
      phase: 'ready',
      lensKeys: ['correctness', 'security', 'tests'],
      chunkTotal: 1,
      targetHeadSha: 'a'.repeat(40),
    });
    await testDb.db.insert(prCodeReviewEvents).values({
      reviewId: 'rev-1',
      at: STARTED,
      toPhase: 'queued',
      trigger: 'user:start',
      code: 'cycle_started',
    });
  });

  afterEach(async () => {
    await testDb.pglite.exec('RESET ROLE');
    await testDb.cleanup();
  });

  async function shape() {
    const review = await getReview('rev-1');
    return codeReviewCycleShape(review!);
  }

  it('counts the units by how each one ended', async () => {
    await testDb.db.insert(prCodeReviewRuns).values([
      { ...unit, id: 'r-1', lens: 'correctness', status: 'settled' },
      { ...unit, id: 'r-2', lens: 'security', status: 'settled' },
      { ...unit, id: 'r-3', lens: 'tests', status: 'failed' },
      { ...unit, id: 'r-4', kind: 'sweep', lens: '', status: 'skipped' },
    ]);
    const out = await shape();
    expect(out).toMatchObject({
      units_total: 4,
      units_settled: 2,
      units_failed: 1,
      units_skipped: 1,
      units_planned: 4,
      lenses: 3,
      preset: 'standard',
      cycle: 2,
      is_rereview: true,
    });
  });

  it('ignores the units of another cycle, so a retry is not double-counted', async () => {
    await testDb.db.insert(prCodeReviewRuns).values([
      { ...unit, id: 'r-old', cycle: 1, lens: 'correctness', status: 'failed' },
      { ...unit, id: 'r-new', lens: 'correctness', status: 'settled' },
    ]);
    expect(await shape()).toMatchObject({ units_total: 1, units_settled: 1, units_failed: 0 });
  });

  it('sums a numeric cost rather than concatenating it', async () => {
    // `cost_usd` is numeric, so the driver hands back a string. Adding two of
    // those gives "0.120.34" if nothing converts them.
    await testDb.db.insert(prCodeReviewRuns).values([
      { ...unit, id: 'r-1', lens: 'correctness', status: 'settled', costUsd: '0.12' },
      { ...unit, id: 'r-2', lens: 'security', status: 'settled', costUsd: '0.34' },
    ]);
    expect((await shape()).cost_usd).toBeCloseTo(0.46, 5);
  });

  it('reports no cost rather than a wrong one when no unit recorded any', async () => {
    await testDb.db
      .insert(prCodeReviewRuns)
      .values([{ ...unit, id: 'r-1', lens: 'correctness', status: 'settled' }]);
    expect((await shape()).cost_usd).toBe(0);
  });

  it('counts a parse retry, not a parse attempt', async () => {
    // One attempt is the normal case and must read as zero retries, or the
    // "does the JSON contract hold" number is 100% on a healthy review.
    await testDb.db.insert(prCodeReviewRuns).values([
      { ...unit, id: 'r-1', lens: 'correctness', status: 'settled', parseAttempts: 1 },
      { ...unit, id: 'r-2', lens: 'security', status: 'settled', parseAttempts: 3 },
      { ...unit, id: 'r-3', lens: 'tests', status: 'failed', parseAttempts: 0 },
    ]);
    expect((await shape()).parse_retries).toBe(2);
  });

  it('lists each provider and model once, sorted', async () => {
    await testDb.db.insert(prCodeReviewRuns).values([
      { ...unit, id: 'r-1', lens: 'correctness', status: 'settled' },
      { ...unit, id: 'r-2', lens: 'security', status: 'settled' },
      {
        ...unit,
        id: 'r-3',
        lens: 'tests',
        status: 'settled',
        provider: 'posthog_code',
        model: 'claude-opus-5-5',
      },
    ]);
    const out = await shape();
    expect(out.providers).toEqual(['posthog_code', 'selfhosted']);
    expect(out.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5']);
  });

  it('splits the wait we own from the wait the vendor owns', async () => {
    // The split is the point: `queue_seconds` is scheduler latency, which a start
    // race once put two minutes into, and `agent_seconds` is time no amount of our
    // own work shortens.
    await testDb.db
      .insert(prCodeReviewRuns)
      .values([{ ...unit, id: 'r-1', lens: 'correctness', status: 'settled' }]);
    const out = await shape();
    expect(out.queue_seconds).toBe(30);
    expect(out.agent_seconds as number).toBeGreaterThan(0);
    expect(out.total_seconds as number).toBeGreaterThan(out.queue_seconds as number);
  });

  it('answers with nulls rather than zeroes when nothing was ever dispatched', async () => {
    // A cycle that failed while preparing. Zero would read as "it started
    // instantly", which is the opposite of what happened.
    const out = await shape();
    expect(out.units_total).toBe(0);
    expect(out.agent_seconds).toBeNull();
    expect(out.queue_seconds as number).toBeGreaterThan(0);
  });
});
