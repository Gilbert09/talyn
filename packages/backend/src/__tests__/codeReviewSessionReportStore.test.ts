/**
 * The two reads and writes behind code review report-back, against a real
 * database: which findings the session is told about, and the once-per-cycle
 * record that stops a second message for the same cycle.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  prCodeReviewEvents,
  prCodeReviewFindings,
  prCodeReviews,
  pullRequests,
  repositories,
  workspaces,
} from '../db/schema.js';
import { confirmedOpenFindings } from '../services/codeReview/findings.js';
import { appendReviewEventOnce, getReview } from '../services/codeReview/store.js';

const EVENT = {
  fromPhase: 'ready' as const,
  toPhase: 'ready' as const,
  trigger: 'executor',
  code: 'session_report_sent',
  message: 'Sent.',
  detail: { workbenchId: 'wb-1' },
};

describe('code review report-back store', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

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
      targetHeadSha: 'a'.repeat(40),
    });
  });

  afterEach(async () => {
    await testDb.pglite.exec('RESET ROLE');
    await testDb.cleanup();
  });

  async function reportEvents() {
    return testDb.db
      .select({ code: prCodeReviewEvents.code, detail: prCodeReviewEvents.detail })
      .from(prCodeReviewEvents)
      .where(eq(prCodeReviewEvents.code, 'session_report_sent'));
  }

  describe('appendReviewEventOnce', () => {
    it('writes the event once per cycle, with the cycle in its detail', async () => {
      expect(await appendReviewEventOnce('rev-1', 2, EVENT)).toBe(true);
      expect(await appendReviewEventOnce('rev-1', 2, EVENT)).toBe(false);
      expect(await reportEvents()).toEqual([
        { code: 'session_report_sent', detail: { workbenchId: 'wb-1', cycle: 2 } },
      ]);
    });

    it('writes again for the next cycle and for another code', async () => {
      expect(await appendReviewEventOnce('rev-1', 2, EVENT)).toBe(true);
      expect(await appendReviewEventOnce('rev-1', 3, EVENT)).toBe(true);
      expect(await appendReviewEventOnce('rev-1', 2, { ...EVENT, code: 'other_code' })).toBe(true);
      expect(await reportEvents()).toHaveLength(2);
    });

    it('lets one of two callers at the same time win', async () => {
      const results = await Promise.all([
        appendReviewEventOnce('rev-1', 2, EVENT),
        appendReviewEventOnce('rev-1', 2, EVENT),
        appendReviewEventOnce('rev-1', 2, EVENT),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await reportEvents()).toHaveLength(1);
    });

    it('does not move the review version', async () => {
      const before = await getReview('rev-1');
      await appendReviewEventOnce('rev-1', 2, EVENT);
      expect((await getReview('rev-1'))?.version).toBe(before?.version);
    });
  });

  describe('confirmedOpenFindings', () => {
    it.each([
      { id: 'kept-blocker', verdict: 'confirmed', disposition: 'open', severity: 'blocker', kept: true },
      { id: 'kept-minor', verdict: 'confirmed', disposition: 'open', severity: 'minor', kept: true },
      { id: 'unvalidated', verdict: 'unvalidated', disposition: 'open', severity: 'blocker', kept: false },
      { id: 'rejected', verdict: 'rejected', disposition: 'open', severity: 'blocker', kept: false },
      { id: 'uncertain', verdict: 'uncertain', disposition: 'open', severity: 'blocker', kept: false },
      { id: 'dismissed', verdict: 'confirmed', disposition: 'dismissed', severity: 'blocker', kept: false },
      { id: 'selected', verdict: 'confirmed', disposition: 'selected', severity: 'blocker', kept: false },
      { id: 'stale', verdict: 'confirmed', disposition: 'stale', severity: 'blocker', kept: false },
      { id: 'fixed', verdict: 'confirmed', disposition: 'fixed', severity: 'blocker', kept: false },
    ])('$id is kept: $kept', async ({ id, verdict, disposition, severity, kept }) => {
      await testDb.db.insert(prCodeReviewFindings).values({
        id,
        reviewId: 'rev-1',
        workspaceId: 'ws-a',
        pullRequestId: 'pr-a',
        dedupeKey: id,
        severity,
        title: id,
        body: 'why',
        verdict,
        disposition,
      });
      expect((await confirmedOpenFindings('rev-1')).map((f) => f.id)).toEqual(kept ? [id] : []);
    });

    it('lists the most severe first, with the body', async () => {
      for (const [id, severity] of [
        ['n', 'nit'],
        ['b', 'blocker'],
        ['m', 'minor'],
      ] as const) {
        await testDb.db.insert(prCodeReviewFindings).values({
          id,
          reviewId: 'rev-1',
          workspaceId: 'ws-a',
          pullRequestId: 'pr-a',
          dedupeKey: id,
          severity,
          title: id,
          body: `body ${id}`,
          verdict: 'confirmed',
          disposition: 'open',
          filePath: 'src/x.ts',
          lineStart: 3,
        });
      }
      const rows = await confirmedOpenFindings('rev-1');
      expect(rows.map((f) => f.id)).toEqual(['b', 'm', 'n']);
      expect(rows[0]).toMatchObject({ body: 'body b', filePath: 'src/x.ts', lineStart: 3 });
    });
  });
});
