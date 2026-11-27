/**
 * How many of Talyn's lenses a review's cycle skipped.
 *
 * Read from the cycle's own plan event. Counting against today's preset made
 * every review from before Standard grew a lens say "1 not needed here".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { prCodeReviewEvents, prCodeReviews, pullRequests, repositories, workspaces } from '../db/schema.js';
import { CYCLE_PLANNED, lensesNotNeededFor } from '../services/codeReview/public.js';

describe('lensesNotNeededFor', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({
      id: 'repo-a',
      workspaceId: 'ws-a',
      name: 'acme/app',
      url: 'https://github.com/acme/app',
    });
    await testDb.db.insert(pullRequests).values(
      ['pr-a', 'pr-b'].map((id, i) => ({
        id,
        workspaceId: 'ws-a',
        repositoryId: 'repo-a',
        owner: 'acme',
        repo: 'app',
        number: i + 1,
        state: 'open',
      }))
    );
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  async function seedReview(id: string, pullRequestId: string, cycle: number, phase: string) {
    await testDb.db.insert(prCodeReviews).values({
      id,
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      pullRequestId,
      cycle,
      preset: 'standard',
      runsTotal: 5,
      phase,
    });
    return { id, cycle, phase };
  }

  async function plan(reviewId: string, at: string, detail: Record<string, unknown>) {
    await testDb.db.insert(prCodeReviewEvents).values({
      reviewId,
      at: new Date(at),
      fromPhase: 'preparing',
      toPhase: 'reviewing',
      trigger: 'executor',
      code: CYCLE_PLANNED,
      detail,
    });
  }

  const skipped = (n: number) => Array.from({ length: n }, (_, i) => ({ lens: `l${i}`, reason: 'r' }));

  it.each([
    ['the latest plan of the current cycle', 'ready', [[1, 1], [2, 2]], 2],
    ['an older plan with no cycle recorded', 'ready', [[undefined, 1]], 1],
    ['a plan that skipped nothing', 'ready', [[2, 0]], 0],
    ['no plan at all', 'ready', [], 0],
    ['a cycle that is not planned yet', 'preparing', [[1, 3]], 0],
    ['a latest plan from an earlier cycle', 'reviewing', [[1, 3]], 0],
  ] as const)('reads %s', async (_label, phase, plans, expected) => {
    const review = await seedReview('rev-1', 'pr-a', 2, phase);
    for (const [i, [cycle, count]] of plans.entries()) {
      await plan('rev-1', `2026-11-27T10:0${i}:00Z`, {
        skippedLenses: skipped(count),
        ...(cycle === undefined ? {} : { cycle }),
      });
    }
    expect((await lensesNotNeededFor([review])).get('rev-1') ?? 0).toBe(expected);
  });

  it('reads many reviews in one call', async () => {
    const a = await seedReview('rev-a', 'pr-a', 1, 'ready');
    const b = await seedReview('rev-b', 'pr-b', 1, 'ready');
    await plan('rev-a', '2026-11-27T10:00:00Z', { cycle: 1, skippedLenses: skipped(2) });
    await plan('rev-b', '2026-11-27T10:00:00Z', { cycle: 1, skippedLenses: [] });
    const counts = await lensesNotNeededFor([a, b]);
    expect(counts.get('rev-a')).toBe(2);
    expect(counts.get('rev-b')).toBe(0);
  });
});
