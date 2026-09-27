import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  prCodeReviewFindings,
  prCodeReviews,
  pullRequests,
  repositories,
  workspaces,
} from '../db/schema.js';

/**
 * Which reviewer is actually worth its cost.
 *
 * Asserted against a real database because the query is raw SQL with a lateral
 * unnest of a jsonb array — the one shape a typecheck says nothing about, and
 * the one that would fail only in production.
 *
 * The claim under test is not just "it counts": it is that a finding counts
 * once PER LENS that raised it. Agreement is the signal the dedupe key exists
 * to preserve, so splitting the credit between two lenses would punish a lens
 * for being corroborated — the exact opposite of what this number is for.
 */
describe('lensEffectiveness', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let lensEffectiveness: typeof import('../services/codeReview/findings.js').lensEffectiveness;

  const finding = (over: Record<string, unknown>) => ({
    id: String(over.id),
    reviewId: 'rev-1',
    workspaceId: 'ws-a',
    pullRequestId: 'pr-a',
    dedupeKey: String(over.id),
    severity: 'major',
    title: 't',
    ...over,
  });

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
      runsTotal: 5,
    });
    ({ lensEffectiveness } = await import('../services/codeReview/findings.js'));
  });

  afterEach(async () => {
    await testDb.pglite.exec('RESET ROLE');
    await testDb.cleanup();
  });

  it('counts raised and kept per lens', async () => {
    await testDb.db.insert(prCodeReviewFindings).values([
      finding({ id: 'f1', lenses: ['correctness'], verdict: 'confirmed' }),
      finding({ id: 'f2', lenses: ['correctness'], verdict: 'rejected' }),
      finding({ id: 'f3', lenses: ['security'], verdict: 'confirmed' }),
    ]);
    const out = await lensEffectiveness('ws-a');
    expect(out).toEqual([
      { lens: 'correctness', raised: 2, kept: 1 },
      { lens: 'security', raised: 1, kept: 1 },
    ]);
  });

  it('credits BOTH lenses when two agreed on one finding', async () => {
    // The point of the number. Splitting the credit would make a corroborated
    // finding look like half a result for each reviewer.
    await testDb.db.insert(prCodeReviewFindings).values([
      finding({ id: 'f1', lenses: ['correctness', 'security'], verdict: 'confirmed' }),
    ]);
    const out = await lensEffectiveness('ws-a');
    expect(out).toEqual([
      { lens: 'correctness', raised: 1, kept: 1 },
      { lens: 'security', raised: 1, kept: 1 },
    ]);
  });

  it('counts an unvalidated finding as raised but not kept', async () => {
    // Mid-review findings have no verdict yet. They were raised; claiming they
    // were kept would flatter every lens on every running review.
    await testDb.db.insert(prCodeReviewFindings).values([
      finding({ id: 'f1', lenses: ['correctness'], verdict: 'unvalidated' }),
    ]);
    expect(await lensEffectiveness('ws-a')).toEqual([
      { lens: 'correctness', raised: 1, kept: 0 },
    ]);
  });

  it('ignores a finding with no lenses rather than inventing one', async () => {
    await testDb.db.insert(prCodeReviewFindings).values([
      finding({ id: 'f1', lenses: [], verdict: 'confirmed' }),
    ]);
    expect(await lensEffectiveness('ws-a')).toEqual([]);
  });

  it('is empty for a workspace with no findings', async () => {
    expect(await lensEffectiveness('ws-a')).toEqual([]);
  });
});
