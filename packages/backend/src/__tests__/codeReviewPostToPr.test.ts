/**
 * "Post to PR", against a real (pglite) database and a mocked GitHub.
 *
 * What is pinned here is what a mistake would make public: a finding written
 * on somebody's pull request twice, a dismissed finding posted anyway, or a
 * finding marked as posted when GitHub refused it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { GitHubApiError, githubService } from '../services/github.js';
import { FINDING_LIST_COLUMNS, listFindings } from '../services/codeReview/findings.js';
import { postFindingsToPr } from '../services/codeReview/postToPr.js';
import { getDbClient } from '../db/client.js';

const HEAD = 'a'.repeat(40);
const PATCH = ['@@ -10,3 +10,6 @@', ' ctx', '+new', '+new', '+new', ' ctx', ' ctx'].join('\n');

type ReviewCall = Parameters<typeof githubService.createPRReview>[4];

describe('postFindingsToPr', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let createReview: ReturnType<typeof vi.spyOn>;
  let listFiles: ReturnType<typeof vi.spyOn>;

  async function addFinding(id: string, over: Partial<typeof prCodeReviewFindings.$inferInsert> = {}) {
    await testDb.db.insert(prCodeReviewFindings).values({
      id,
      reviewId: 'rev-1',
      workspaceId: 'ws-a',
      pullRequestId: 'pr-a',
      dedupeKey: `key-${id}`,
      severity: 'major',
      title: `Finding ${id}`,
      body: `Body of ${id}`,
      filePath: 'src/a.ts',
      lineStart: 11,
      lineEnd: 11,
      anchorVerified: true,
      verdict: 'confirmed',
      ...over,
    });
  }

  async function row(id: string) {
    const rows = await testDb.db
      .select()
      .from(prCodeReviewFindings)
      .where(eq(prCodeReviewFindings.id, id));
    return rows[0]!;
  }

  function sent(call = 0): ReviewCall {
    return createReview.mock.calls[call]![4] as ReviewCall;
  }

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
    await testDb.db.insert(pullRequests).values([
      {
        id: 'pr-a',
        workspaceId: 'ws-a',
        repositoryId: 'repo-a',
        owner: 'acme',
        repo: 'app',
        number: 7,
        state: 'open',
        lastSummary: { headSha: HEAD } as never,
      },
      {
        id: 'pr-b',
        workspaceId: 'ws-a',
        repositoryId: 'repo-a',
        owner: 'acme',
        repo: 'app',
        number: 8,
        state: 'open',
      },
    ]);
    await testDb.db.insert(prCodeReviews).values([
      {
        id: 'rev-1',
        workspaceId: 'ws-a',
        repositoryId: 'repo-a',
        pullRequestId: 'pr-a',
        cycle: 2,
        preset: 'standard',
        runsTotal: 4,
        phase: 'ready',
        targetHeadSha: HEAD,
        reviewedHeadSha: HEAD,
      },
      {
        id: 'rev-2',
        workspaceId: 'ws-a',
        repositoryId: 'repo-a',
        pullRequestId: 'pr-b',
        cycle: 1,
        preset: 'standard',
        runsTotal: 4,
        phase: 'ready',
        targetHeadSha: HEAD,
        reviewedHeadSha: HEAD,
      },
    ]);

    let nextId = 900;
    createReview = vi.spyOn(githubService, 'createPRReview').mockImplementation(async () => {
      nextId += 1;
      return { id: nextId, html_url: `https://github.com/acme/app/pull/7#pullrequestreview-${nextId}` } as never;
    });
    listFiles = vi
      .spyOn(githubService, 'getAllPRFiles')
      .mockResolvedValue([{ filename: 'src/a.ts', status: 'modified', patch: PATCH }]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await testDb.pglite.exec('RESET ROLE');
    await testDb.cleanup();
  });

  it('posts one COMMENT review with inline comments and marks the findings', async () => {
    await addFinding('f-1', { severity: 'blocker', suggestion: 'Do this.' });
    await addFinding('f-2', { lineStart: 12, lineEnd: 14 });

    const out = await postFindingsToPr('rev-1', [], 'owner-a');

    expect(out).toEqual({
      ok: true,
      posted: 2,
      inline: 2,
      inSummary: 0,
      reviewUrl: 'https://github.com/acme/app/pull/7#pullrequestreview-901',
    });
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(createReview.mock.calls[0]!.slice(0, 4)).toEqual(['ws-a', 'acme', 'app', 7]);
    const review = sent();
    expect(review.event).toBe('COMMENT');
    expect(review.commit_id).toBe(HEAD);
    expect(review.body).toContain('Findings from a Talyn code review of aaaaaaa.');
    expect(review.comments).toEqual([
      {
        path: 'src/a.ts',
        line: 11,
        side: 'RIGHT',
        body: '**Must fix: Finding f-1**\n\nBody of f-1\n\n**Suggested fix**\n\nDo this.',
      },
      {
        path: 'src/a.ts',
        line: 14,
        side: 'RIGHT',
        start_line: 12,
        start_side: 'RIGHT',
        body: '**Should fix: Finding f-2**\n\nBody of f-2',
      },
    ]);

    for (const id of ['f-1', 'f-2']) {
      const saved = await row(id);
      expect(saved.postedAt).toBeInstanceOf(Date);
      expect(saved.postedReviewId).toBe('901');
      // Posting is not a disposition: the finding is still open in the app.
      expect(saved.disposition).toBe('open');
    }
  });

  it('records the post on the review timeline without moving the phase', async () => {
    await addFinding('f-1');
    await postFindingsToPr('rev-1', [], 'owner-a');
    const events = await testDb.db
      .select()
      .from(prCodeReviewEvents)
      .where(eq(prCodeReviewEvents.reviewId, 'rev-1'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromPhase: 'ready',
      toPhase: 'ready',
      trigger: 'user:post',
      code: 'posted_to_pr',
    });
    expect(events[0]!.detail).toMatchObject({ findingIds: ['f-1'], inline: 1, inSummary: 0, userId: 'owner-a' });
  });

  it('posts only what is new the second time, and refuses when nothing is left', async () => {
    await addFinding('f-1');
    await postFindingsToPr('rev-1', [], 'owner-a');
    const first = (await row('f-1')).postedAt;

    await addFinding('f-2', { lineStart: 13, lineEnd: 13 });
    const second = await postFindingsToPr('rev-1', [], 'owner-a');
    expect(second).toMatchObject({ ok: true, posted: 1, inline: 1 });
    expect(sent(1).comments!.map((c) => c.line)).toEqual([13]);
    // The first finding keeps the review that carried it.
    expect((await row('f-1')).postedAt).toEqual(first);
    expect((await row('f-1')).postedReviewId).toBe('901');
    expect((await row('f-2')).postedReviewId).toBe('902');

    const third = await postFindingsToPr('rev-1', [], 'owner-a');
    expect(third).toMatchObject({ ok: false, code: 'nothing_to_post' });
    // Naming a posted finding by id does not post it again either.
    expect(await postFindingsToPr('rev-1', ['f-1'], 'owner-a')).toMatchObject({
      ok: false,
      code: 'nothing_to_post',
    });
    expect(createReview).toHaveBeenCalledTimes(2);
  });

  it('posts once when the button is pressed twice at the same moment', async () => {
    await addFinding('f-1');
    const [a, b] = await Promise.all([
      postFindingsToPr('rev-1', [], 'owner-a'),
      postFindingsToPr('rev-1', [], 'owner-a'),
    ]);
    expect(createReview).toHaveBeenCalledTimes(1);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((o) => !o.ok)).toMatchObject({ code: 'nothing_to_post' });
  });

  it('lets the next press through after one that failed', async () => {
    await addFinding('f-1');
    createReview.mockRejectedValueOnce(new GitHubApiError('Server Error', 500));
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({ ok: false });
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({ ok: true, posted: 1 });
  });

  it('posts exactly the ticked findings', async () => {
    await addFinding('f-1');
    await addFinding('f-2', { lineStart: 12, lineEnd: 12 });
    await addFinding('f-3', { lineStart: 13, lineEnd: 13 });

    const out = await postFindingsToPr('rev-1', ['f-1', 'f-3'], 'owner-a');
    expect(out).toMatchObject({ ok: true, posted: 2 });
    expect(sent().comments!.map((c) => c.line)).toEqual([11, 13]);
    expect((await row('f-2')).postedAt).toBeNull();
  });

  it.each<[string, Partial<typeof prCodeReviewFindings.$inferInsert>]>([
    ['dismissed', { disposition: 'dismissed' }],
    ['fixed', { disposition: 'fixed' }],
    ['stale', { disposition: 'stale' }],
    ['discarded', { disposition: 'discarded' }],
    ['rejected by the checker', { verdict: 'rejected' }],
    ['rejected and stale', { verdict: 'rejected', disposition: 'stale' }],
  ])('never posts a finding that is %s', async (_label, over) => {
    await addFinding('f-out', over);
    // By default, and when it is named by id.
    for (const ids of [[], ['f-out']]) {
      expect(await postFindingsToPr('rev-1', ids, 'owner-a')).toMatchObject({
        ok: false,
        code: 'nothing_to_post',
      });
    }
    await addFinding('f-in', { lineStart: 12, lineEnd: 12 });
    expect(await postFindingsToPr('rev-1', ['f-out', 'f-in'], 'owner-a')).toMatchObject({
      ok: true,
      posted: 1,
    });
    expect((await row('f-out')).postedAt).toBeNull();
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<typeof prCodeReviewFindings.$inferInsert>]>([
    ['selected for a fix', { disposition: 'selected' }],
    ['not checked', { verdict: 'unvalidated' }],
    ['uncertain', { verdict: 'uncertain' }],
  ])('posts a finding that is %s', async (_label, over) => {
    await addFinding('f-1', over);
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({ ok: true, posted: 1 });
  });

  it.each<[string, Partial<typeof prCodeReviewFindings.$inferInsert>, string]>([
    ['an unverified anchor', { anchorVerified: false }, '(`src/a.ts:11`)'],
    ['a line outside the diff', { lineStart: 200, lineEnd: 200 }, '(`src/a.ts:200`)'],
    ['a file that is not in the diff', { filePath: 'src/other.ts' }, '(`src/other.ts:11`)'],
    ['no line', { lineStart: null, lineEnd: null }, '(`src/a.ts`)'],
  ])('puts a finding with %s in the review body', async (_label, over, location) => {
    await addFinding('f-1', over);
    await addFinding('f-2', { lineStart: 12, lineEnd: 12 });

    const out = await postFindingsToPr('rev-1', [], 'owner-a');
    expect(out).toMatchObject({ ok: true, posted: 2, inline: 1, inSummary: 1 });
    const review = sent();
    expect(review.comments).toHaveLength(1);
    expect(review.comments![0]!.line).toBe(12);
    expect(review.body).toContain('2 findings: 1 as inline comment, 1 below.');
    expect(review.body).toContain(`**Should fix: Finding f-1** ${location}\n\nBody of f-1`);
    expect((await row('f-1')).postedAt).toBeInstanceOf(Date);
  });

  it('does not read the diff when no finding could go inline', async () => {
    await addFinding('f-1', { anchorVerified: false });
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({
      ok: true,
      inline: 0,
      inSummary: 1,
    });
    expect(listFiles).not.toHaveBeenCalled();
    expect(sent().comments).toBeUndefined();
  });

  it('posts everything in the body when the pull request moved past the reviewed commit', async () => {
    // The file listing describes the newest commit. Its lines prove nothing
    // about the commit the review read.
    await testDb.db
      .update(pullRequests)
      .set({ lastSummary: { headSha: 'b'.repeat(40) } as never })
      .where(eq(pullRequests.id, 'pr-a'));
    await addFinding('f-1');
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({
      ok: true,
      inline: 0,
      inSummary: 1,
    });
    expect(listFiles).not.toHaveBeenCalled();
    expect(sent().commit_id).toBe(HEAD);
  });

  it('sends the review again with no inline comments when GitHub answers 422', async () => {
    await addFinding('f-1');
    await addFinding('f-2', { lineStart: 12, lineEnd: 12 });
    createReview.mockRejectedValueOnce(new GitHubApiError('Unprocessable Entity', 422));

    const out = await postFindingsToPr('rev-1', [], 'owner-a');
    expect(out).toMatchObject({ ok: true, posted: 2, inline: 0, inSummary: 2 });
    expect(createReview).toHaveBeenCalledTimes(2);
    expect(sent(0).comments).toHaveLength(2);
    expect(sent(1).comments).toBeUndefined();
    expect(sent(1).event).toBe('COMMENT');
    expect(sent(1).body).toContain('Finding f-1');
    expect(sent(1).body).toContain('Finding f-2');
    expect((await row('f-1')).postedReviewId).toBe('901');
  });

  it('retries a 422 once only', async () => {
    await addFinding('f-1');
    createReview.mockRejectedValue(new GitHubApiError('Unprocessable Entity', 422));
    const out = await postFindingsToPr('rev-1', [], 'owner-a');
    expect(out).toMatchObject({ ok: false, code: 'github_failed', message: 'Unprocessable Entity' });
    expect(createReview).toHaveBeenCalledTimes(2);
    expect((await row('f-1')).postedAt).toBeNull();
  });

  it('does not retry a 422 for a review that had no inline comments', async () => {
    await addFinding('f-1', { anchorVerified: false });
    createReview.mockRejectedValue(new GitHubApiError('Unprocessable Entity', 422));
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({
      ok: false,
      code: 'github_failed',
    });
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => void]>([
    ['the review answers 500', () => createReview.mockRejectedValue(new GitHubApiError('Server Error', 500))],
    ['the review answers 403', () => createReview.mockRejectedValue(new GitHubApiError('Resource not accessible', 403))],
    ['the review request times out', () => createReview.mockRejectedValue(new Error('GitHub request timed out'))],
    ['the file listing fails', () => listFiles.mockRejectedValue(new GitHubApiError('Server Error', 500))],
  ])('marks nothing when %s', async (_label, arrange) => {
    await addFinding('f-1');
    arrange();
    const out = await postFindingsToPr('rev-1', [], 'owner-a');
    expect(out).toMatchObject({ ok: false, code: 'github_failed' });
    expect((await row('f-1')).postedAt).toBeNull();
    expect((await row('f-1')).postedReviewId).toBeNull();
    expect(await testDb.db.select().from(prCodeReviewEvents)).toHaveLength(0);
  });

  it.each(['queued', 'preparing', 'reviewing', 'sweeping', 'validating', 'fixing'])(
    'refuses while the review is %s',
    async (phase) => {
      await addFinding('f-1');
      await testDb.db.update(prCodeReviews).set({ phase }).where(eq(prCodeReviews.id, 'rev-1'));
      expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({
        ok: false,
        code: 'not_ready',
      });
      expect(createReview).not.toHaveBeenCalled();
    }
  );

  it.each(['ready', 'fixed', 'failed', 'cancelled'])('posts when the review is %s', async (phase) => {
    await addFinding('f-1');
    await testDb.db.update(prCodeReviews).set({ phase }).where(eq(prCodeReviews.id, 'rev-1'));
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({ ok: true });
  });

  it('refuses a review that has not finished on a commit', async () => {
    // The column is NOT NULL and starts empty, so empty is the only "none".
    await addFinding('f-1');
    await testDb.db
      .update(prCodeReviews)
      .set({ reviewedHeadSha: '' })
      .where(eq(prCodeReviews.id, 'rev-1'));
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({
      ok: false,
      code: 'not_ready',
    });
    expect(createReview).not.toHaveBeenCalled();
  });

  it('refuses a review that does not exist', async () => {
    expect(await postFindingsToPr('rev-none', [], 'owner-a')).toMatchObject({
      ok: false,
      code: 'not_ready',
    });
  });

  it('ignores a finding id that belongs to another review', async () => {
    await addFinding('f-1');
    await addFinding('f-other', { reviewId: 'rev-2', pullRequestId: 'pr-b' });

    expect(await postFindingsToPr('rev-1', ['f-other'], 'owner-a')).toMatchObject({
      ok: false,
      code: 'nothing_to_post',
    });
    expect(await postFindingsToPr('rev-1', ['f-other', 'f-1'], 'owner-a')).toMatchObject({
      ok: true,
      posted: 1,
    });
    expect((await row('f-other')).postedAt).toBeNull();
  });

  it('leaves a finding that does not fit unposted, and says so on the pull request', async () => {
    const big = 'x'.repeat(30_000);
    for (const [id, severity] of [['f-a', 'blocker'], ['f-b', 'major'], ['f-c', 'minor']] as const) {
      await addFinding(id, { severity, body: big, anchorVerified: false });
    }
    const out = await postFindingsToPr('rev-1', [], 'owner-a');
    expect(out).toMatchObject({ ok: true, posted: 2, inSummary: 2 });
    expect(sent().body!.length).toBeLessThanOrEqual(65536);
    expect(sent().body).toContain('1 finding did not fit in this comment');
    expect((await row('f-a')).postedAt).toBeInstanceOf(Date);
    expect((await row('f-b')).postedAt).toBeInstanceOf(Date);
    expect((await row('f-c')).postedAt).toBeNull();

    // The one left out is still eligible, and goes in the next review.
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({ ok: true, posted: 1 });
    expect((await row('f-c')).postedReviewId).toBe('902');
  });

  it('posts nothing when every finding is too long for a comment', async () => {
    await addFinding('f-1', { body: 'x'.repeat(70_000) });
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({
      ok: false,
      code: 'nothing_to_post',
    });
    expect(createReview).not.toHaveBeenCalled();
    expect((await row('f-1')).postedAt).toBeNull();
  });

  it('keeps posted_at when a later cycle re-opens the finding', async () => {
    await addFinding('f-1');
    await postFindingsToPr('rev-1', [], 'owner-a');
    // What `upsertFindings` does to a key that reappears.
    await testDb.db
      .update(prCodeReviewFindings)
      .set({ disposition: 'open', verdict: 'unvalidated', lastSeenCycle: 3 })
      .where(eq(prCodeReviewFindings.id, 'f-1'));
    expect(await postFindingsToPr('rev-1', [], 'owner-a')).toMatchObject({
      ok: false,
      code: 'nothing_to_post',
    });
    expect((await row('f-1')).postedAt).toBeInstanceOf(Date);
  });

  it('carries posted_at on the list projection, and not the GitHub review id', async () => {
    await addFinding('f-1');
    await postFindingsToPr('rev-1', [], 'owner-a');
    const [listed] = await listFindings('rev-1', { includeInactive: true });
    expect(listed!.postedAt).toBeInstanceOf(Date);

    const sql = getDbClient().select(FINDING_LIST_COLUMNS).from(prCodeReviewFindings).toSQL().sql;
    expect(sql).toContain('"posted_at"');
    expect(sql).not.toContain('"posted_review_id"');
    // The big columns stay off the list.
    expect(sql).not.toContain('"body"');
    expect(sql).not.toContain('"suggestion"');
  });
});
