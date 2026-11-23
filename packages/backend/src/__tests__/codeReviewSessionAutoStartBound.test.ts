import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { prCodeReviews, pullRequests, repositories, workspaces } from '../db/schema.js';

/**
 * The auto-start bound counts the cycles that `startReviewCycle` began for the
 * session auto-start, from the review's events, against a real (pglite) database.
 */

vi.mock('../services/analytics.js', () => ({ captureWorkspaceEvent: vi.fn() }));
vi.mock('../services/codeReview/evaluator.js', async (orig) => ({
  ...(await orig<typeof import('../services/codeReview/evaluator.js')>()),
  scheduleReviewEvaluation: vi.fn(),
}));

const { startReviewCycle } = await import('../services/codeReview/cycle.js');
const { appendReviewEvent, countCyclesStartedFor, getReviewForPr } = await import('../services/codeReview/store.js');

type Start = { auto?: boolean; trigger?: 'api' | 'auto' | 'workflow' | 'session_complete' };

const SESSION: Start = { auto: true, trigger: 'session_complete' };
const MANUAL: Start = {};
const API: Start = { trigger: 'api' };
const AUTO_REVIEW: Start = { auto: true };
const WORKFLOW: Start = { trigger: 'workflow' };

describe('countCyclesStartedFor', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'a/a', url: 'https://github.com/a/a' });
    await testDb.db.insert(pullRequests).values({
      id: 'pr-a', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'a', repo: 'a', number: 1, state: 'open',
      lastSummary: { headSha: 'a'.repeat(40) },
    });
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  /** Start cycles one after another, each settled before the next, and count the session starts. */
  async function run(starts: Start[]): Promise<number> {
    for (const start of starts) {
      const outcome = await startReviewCycle({ pullRequestId: 'pr-a', ...start });
      expect(outcome).toMatchObject({ ok: true, started: true });
      await testDb.db.update(prCodeReviews).set({ phase: 'ready' }).where(eq(prCodeReviews.pullRequestId, 'pr-a'));
    }
    const review = await getReviewForPr('pr-a');
    return countCyclesStartedFor(review!.id, 'session_complete');
  }

  it.each<[string, Start[], number]>([
    ['one session start', [SESSION], 1],
    ['session starts under the bound', [SESSION, SESSION], 2],
    ['session starts at the bound', [SESSION, SESSION, SESSION], 3],
    ['manual starts only', [MANUAL, MANUAL, MANUAL], 0],
    ['manual starts between session starts', [SESSION, MANUAL, SESSION, MANUAL], 2],
    ['API, per-push auto-review and workflow starts', [API, AUTO_REVIEW, WORKFLOW, SESSION], 1],
  ])('%s', async (_name, starts, expected) => {
    expect(await run(starts)).toBe(expected);
  });

  it('ignores other events and cycle starts from before the field existed', async () => {
    await run([SESSION]);
    const review = (await getReviewForPr('pr-a'))!;
    await appendReviewEvent(review.id, { toPhase: 'queued', trigger: 'auto', code: 'cycle_started', detail: { cycle: 9 } });
    await appendReviewEvent(review.id, { toPhase: 'queued', trigger: 'auto', code: 'cycle_deferred', detail: { startedFor: 'session_complete' } });
    expect(await countCyclesStartedFor(review.id, 'session_complete')).toBe(1);
    expect(await countCyclesStartedFor('no-such-review', 'session_complete')).toBe(0);
  });
});
