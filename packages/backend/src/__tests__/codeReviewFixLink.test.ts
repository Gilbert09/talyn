/**
 * What a fixed finding remembers about the commit that fixed it.
 *
 * The column exists because a fixed finding used to simply leave the list, so
 * "an agent fixed this" was indistinguishable from "it went stale" and from
 * "somebody dismissed it" — the row was gone either way. The sha is what lets the
 * app say which of the three happened, and link to the proof.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  prCodeReviewFindings,
  prCodeReviews,
  pullRequests,
  repositories,
  tasks,
  workspaces,
} from '../db/schema.js';
import { listFindings, markFixed, unmarkFixed } from '../services/codeReview/findings.js';

const PUSHED = 'c'.repeat(40);

describe('markFixed / unmarkFixed — the commit link', () => {
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
    // A real row: `fix_task_id` is a foreign key, which is what stops a finding
    // claiming a task that never existed.
    await testDb.db.insert(tasks).values({
      id: 'task-1',
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      type: 'pr_response',
      status: 'completed',
      title: 'fix',
      description: '',
    });
    await testDb.db.insert(prCodeReviews).values({
      id: 'rev-1',
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      pullRequestId: 'pr-a',
      cycle: 1,
      preset: 'standard',
      runsTotal: 4,
      targetHeadSha: 'a'.repeat(40),
    });
    await testDb.db.insert(prCodeReviewFindings).values({
      id: 'f-1',
      reviewId: 'rev-1',
      workspaceId: 'ws-a',
      pullRequestId: 'pr-a',
      dedupeKey: 'key-1',
      severity: 'blocker',
      title: 'a finding',
      body: 'why',
      disposition: 'selected',
    });
  });

  afterEach(async () => {
    await testDb.pglite.exec('RESET ROLE');
    await testDb.cleanup();
  });

  async function only() {
    const rows = await listFindings('rev-1', { includeInactive: true });
    return rows[0]!;
  }

  it('records the commit a fix pushed', async () => {
    expect(await markFixed('rev-1', ['f-1'], 'task-1', PUSHED)).toBe(1);
    const row = await only();
    expect(row.disposition).toBe('fixed');
    expect(row.fixedHeadSha).toBe(PUSHED);
    expect(row.fixTaskId).toBe('task-1');
  });

  it('records no commit when the run pushed none, rather than a wrong one', async () => {
    // A run can complete having changed nothing. Naming the head it started from
    // would present somebody else's commit as the fix for this finding.
    await markFixed('rev-1', ['f-1'], 'task-1', null);
    const row = await only();
    expect(row.disposition).toBe('fixed');
    expect(row.fixedHeadSha).toBeNull();
  });

  it('leaves a finding an earlier run fixed alone', async () => {
    // Task rows are reused per PR, so a later failed run can carry this task id.
    // Its failure says nothing about a fix that already landed.
    await markFixed('rev-1', ['f-1'], 'task-1', PUSHED);
    expect(await unmarkFixed('rev-1', 'task-1')).toBe(0);
    const row = await only();
    expect(row.disposition).toBe('fixed');
    expect(row.fixedHeadSha).toBe(PUSHED);
  });

  it('unwinds a run that never got as far as marking anything fixed', async () => {
    // `selected` is the in-flight state, set when the fix claims the finding. A
    // run that died there must release it.
    await testDb.db.update(prCodeReviewFindings).set({ fixTaskId: 'task-1' });
    expect(await unmarkFixed('rev-1', 'task-1')).toBe(1);
    const row = await only();
    expect(row.disposition).toBe('open');
    expect(row.fixTaskId).toBeNull();
  });

  it('leaves a fixed finding readable, so the app can say what happened to it', async () => {
    // The default list drops inactive dispositions; the findings endpoint asks
    // for them precisely so a fixed one can still be shown.
    await markFixed('rev-1', ['f-1'], 'task-1', PUSHED);
    expect(await listFindings('rev-1')).toHaveLength(0);
    expect(await listFindings('rev-1', { includeInactive: true })).toHaveLength(1);
  });
});
