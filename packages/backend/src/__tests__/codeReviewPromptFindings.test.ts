/**
 * Which review findings an ordinary "fix this pull request" run is told about.
 *
 * Every gate here is a way an agent could be sent to change working code. The
 * head-sha gate is the sharpest: a finding names a file and a line, so one read
 * at a commit that has since moved does not merely go stale — it points the agent
 * at whatever now occupies those lines. Asserted against a real (pglite) database
 * because the gates are a WHERE clause, and a WHERE clause that quietly matches
 * more than it should is exactly the failure a mocked read cannot show.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  prCodeReviewFindings,
  prCodeReviews,
  pullRequests,
  repositories,
  workspaces,
} from '../db/schema.js';
import { findingsForMergeableRun } from '../services/codeReview/promptFindings.js';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

describe('findingsForMergeableRun', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  const finding = {
    id: 'f-1',
    reviewId: 'rev-1',
    workspaceId: 'ws-a',
    pullRequestId: 'pr-a',
    dedupeKey: 'key-1',
    severity: 'blocker',
    category: 'correctness',
    filePath: 'src/a.ts',
    lineStart: 41,
    lineEnd: 44,
    anchor: 'const user = await getUser(id)',
    title: 'getUser can return undefined',
    body: 'The next line dereferences it.',
    suggestion: 'Guard the undefined case.',
    verdict: 'confirmed',
    disposition: 'open',
    firstSeenSha: HEAD,
    lastSeenSha: HEAD,
    sourceRunId: null,
  };

  async function setReview(patch: Record<string, unknown>) {
    await testDb.db.update(prCodeReviews).set(patch);
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
    await testDb.db.insert(prCodeReviews).values({
      id: 'rev-1',
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      pullRequestId: 'pr-a',
      cycle: 1,
      preset: 'standard',
      runsTotal: 4,
      phase: 'ready',
      targetHeadSha: HEAD,
      reviewedHeadSha: HEAD,
    });
    await testDb.db.insert(prCodeReviewFindings).values(finding);
  });

  afterEach(async () => {
    await testDb.pglite.exec('RESET ROLE');
    await testDb.cleanup();
  });

  it('hands over an open, confirmed finding read at the commit the run starts from', async () => {
    const out = await findingsForMergeableRun('pr-a', HEAD);
    expect(out?.findings).toHaveLength(1);
    expect(out?.findings[0]?.title).toBe('getUser can return undefined');
    expect(out?.findings[0]?.body).toBe('The next line dereferences it.');
    expect(out?.headShaShort).toBe(HEAD.slice(0, 7));
  });

  it('says nothing when the review read an earlier commit', async () => {
    // The whole point. The findings are real and were real; they describe code
    // that has moved, and an agent sent after them edits whatever is there now.
    await setReview({ reviewedHeadSha: OLD_HEAD });
    expect(await findingsForMergeableRun('pr-a', HEAD)).toBeUndefined();
  });

  it('says nothing while the review is still running', async () => {
    // Nothing has judged these yet, so they are candidates rather than findings.
    await setReview({ phase: 'reviewing' });
    expect(await findingsForMergeableRun('pr-a', HEAD)).toBeUndefined();
  });

  it('says nothing while a fix run of its own is in flight', async () => {
    await setReview({ phase: 'fixing' });
    expect(await findingsForMergeableRun('pr-a', HEAD)).toBeUndefined();
  });

  it('carries a finding forward into the next fix after one landed', async () => {
    // `fixed` is at rest, and a finding still open after a fix that did not
    // address it is exactly what the next run should be told about.
    await setReview({ phase: 'fixed' });
    expect((await findingsForMergeableRun('pr-a', HEAD))?.findings).toHaveLength(1);
  });

  it.each([
    ['rejected by the judge', { verdict: 'rejected' }],
    ['not judged yet', { verdict: 'unvalidated' }],
    ['dismissed by the user', { disposition: 'dismissed' }],
    ['already marked fixed', { disposition: 'fixed' }],
    ['gone stale', { disposition: 'stale' }],
    ['discarded', { disposition: 'discarded' }],
    ['claimed by another fix task', { disposition: 'selected' }],
  ])('leaves out a finding that is %s', async (_label, patch) => {
    await testDb.db.update(prCodeReviewFindings).set(patch);
    expect(await findingsForMergeableRun('pr-a', HEAD)).toBeUndefined();
  });

  it('respects the workspace reporting bar the user is actually shown', async () => {
    // A nitpick the list hides must not become a commit. The bar is the one the
    // workspace chose, not the shipped default.
    await testDb.db.update(prCodeReviewFindings).set({ severity: 'nit' });
    await testDb.db
      .update(workspaces)
      .set({ settings: { codeReview: { reportingBar: 'major' } } });
    expect(await findingsForMergeableRun('pr-a', HEAD)).toBeUndefined();

    await testDb.db
      .update(workspaces)
      .set({ settings: { codeReview: { reportingBar: 'nit' } } });
    expect((await findingsForMergeableRun('pr-a', HEAD))?.findings).toHaveLength(1);
  });

  it('orders the findings by severity, so the agent reads the blockers first', async () => {
    await testDb.db.insert(prCodeReviewFindings).values([
      { ...finding, id: 'f-2', dedupeKey: 'key-2', severity: 'minor', title: 'minor one' },
      { ...finding, id: 'f-3', dedupeKey: 'key-3', severity: 'major', title: 'major one' },
    ]);
    const out = await findingsForMergeableRun('pr-a', HEAD);
    expect(out?.findings.map((f) => f.severity)).toEqual(['blocker', 'major', 'minor']);
  });

  it('says nothing when the pull request has no review, and when the head is unknown', async () => {
    expect(await findingsForMergeableRun('pr-a', null)).toBeUndefined();
    expect(await findingsForMergeableRun('pr-missing', HEAD)).toBeUndefined();
  });
});
