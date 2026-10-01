/**
 * Settling a code-review fix when its task reaches a terminal status.
 *
 * The review keeps `fixTaskId` after it settles, and task rows are reused per PR.
 * So the next "Fix with agent" press or merge-queue fix ends on the same task id.
 * That run's failure used to put every finding the review fix had landed back on
 * the list, while the review still said "Fix pushed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/codeReview/evaluator.js', () => ({ scheduleReviewEvaluation: vi.fn() }));
vi.mock('../services/codeReview/analytics.js', () => ({ captureFixSettled: vi.fn(async () => {}) }));
vi.mock('../services/mergeQueue/triggers.js', () => ({ onQueueMembershipChanged: vi.fn() }));

import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  prCodeReviewFindings,
  prCodeReviews,
  pullRequests,
  repositories,
  tasks,
  workspaces,
} from '../db/schema.js';
import { settleFixRun } from '../services/codeReview/fix.js';
import { reviewsByFixTask } from '../services/codeReview/store.js';

describe('settleFixRun', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  async function seed(phase: 'fixing' | 'fixed', disposition: 'selected' | 'fixed') {
    await testDb.db.insert(prCodeReviews).values({
      id: 'rev-1',
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      pullRequestId: 'pr-a',
      cycle: 1,
      preset: 'standard',
      runsTotal: 4,
      targetHeadSha: 'a'.repeat(40),
      phase,
      fixTaskId: 'task-1',
      version: 7,
    });
    await testDb.db.insert(prCodeReviewFindings).values(
      ['f-1', 'f-2'].map((id) => ({
        id,
        reviewId: 'rev-1',
        workspaceId: 'ws-a',
        pullRequestId: 'pr-a',
        dedupeKey: `key-${id}`,
        severity: 'should_fix' as const,
        title: id,
        body: 'why',
        disposition,
        fixTaskId: 'task-1',
      }))
    );
  }

  async function review() {
    const [row] = await reviewsByFixTask('task-1');
    return row!;
  }

  async function dispositions() {
    const rows = await testDb.db
      .select({ disposition: prCodeReviewFindings.disposition })
      .from(prCodeReviewFindings)
      .where(eq(prCodeReviewFindings.reviewId, 'rev-1'));
    return rows.map((r) => r.disposition);
  }

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
    await testDb.db.insert(tasks).values({
      id: 'task-1',
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      type: 'pr_response',
      status: 'failed',
      title: 'fix',
      description: '',
      metadata: { codeReview: { reviewId: 'rev-1', cycle: 1, findingIds: ['f-1', 'f-2'] } },
    });
  });

  afterEach(async () => {
    await testDb.pglite.exec('RESET ROLE');
    await testDb.cleanup();
  });

  it.each(['failed', 'cancelled', 'needs_human', 'completed'])(
    'ignores a %s run on the reused task row once the review has settled',
    async (status) => {
      await seed('fixed', 'fixed');
      await settleFixRun(await review(), 'task-1', status);
      expect(await dispositions()).toEqual(['fixed', 'fixed']);
      const after = await review();
      expect(after.phase).toBe('fixed');
      expect(after.version).toBe(7);
    }
  );

  it.each(['failed', 'cancelled', 'needs_human'])(
    'puts the findings back and returns to ready when the fix run itself ends %s',
    async (status) => {
      // The rollback used to expect `version + 1` on a freshly loaded row, so it
      // never matched and the review stayed `fixing` for ever.
      await seed('fixing', 'selected');
      await settleFixRun(await review(), 'task-1', status);
      expect(await dispositions()).toEqual(['open', 'open']);
      const [row] = await testDb.db
        .select({ phase: prCodeReviews.phase, fixTaskId: prCodeReviews.fixTaskId })
        .from(prCodeReviews)
        .where(eq(prCodeReviews.id, 'rev-1'));
      expect(row).toEqual({ phase: 'ready', fixTaskId: null });
    }
  );

  it('ignores a terminal status for a task the review is not waiting on', async () => {
    await seed('fixing', 'selected');
    await settleFixRun(await review(), 'task-other', 'failed');
    expect(await dispositions()).toEqual(['selected', 'selected']);
    expect((await review()).phase).toBe('fixing');
  });
});
