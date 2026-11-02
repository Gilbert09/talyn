import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { callPublic, mintToken, startPublicApi } from './helpers/publicApi.js';
import {
  prCodeReviewEvents,
  prCodeReviewFindings,
  prCodeReviews,
  pullRequests,
  repositories,
  workspaces,
} from '../db/schema.js';

/**
 * `/v1` code reviews: listing and reading a review with its findings, starting
 * a cycle (plan gate, `no_reviewers`, a closed PR), cancelling, dismissing and
 * undoing it, and Post to PR against a mocked GitHub.
 */

const { scheduleReviewEvaluation } = vi.hoisted(() => ({ scheduleReviewEvaluation: vi.fn() }));
vi.mock('../services/codeReview/evaluator.js', () => ({ scheduleReviewEvaluation }));

const onQueueMembershipChanged = vi.fn(async () => undefined);
vi.mock('../services/mergeQueue/triggers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mergeQueue/triggers.js')>()),
  onQueueMembershipChanged: (...args: unknown[]) => onQueueMembershipChanged(...(args as [])),
}));

const { githubService, GitHubApiError } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

const HEAD = 'a'.repeat(40);
const PATCH = ['@@ -10,3 +10,6 @@', ' ctx', '+new', '+new', '+new', ' ctx', ' ctx'].join('\n');

describe('/v1 code reviews', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let api: Awaited<ReturnType<typeof startPublicApi>>;
  let token: string;
  let createReview: ReturnType<typeof vi.spyOn>;

  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>, as = token) =>
    callPublic(api.base, method, path, { token: as, body, headers });

  async function addFinding(id: string, over: Partial<typeof prCodeReviewFindings.$inferInsert> = {}) {
    await testDb.db.insert(prCodeReviewFindings).values({
      id,
      reviewId: 'rev-1',
      workspaceId: 'ws-a',
      pullRequestId: 'pr-1',
      dedupeKey: `key-${id}`,
      severity: 'major',
      title: `Finding ${id}`,
      body: `Body of ${id}`,
      suggestion: `Suggestion for ${id}`,
      anchor: 'const x = 1;',
      filePath: 'src/a.ts',
      lineStart: 11,
      lineEnd: 11,
      anchorVerified: true,
      verdict: 'confirmed',
      verdictReason: 'Real bug.',
      lenses: ['security', 'correctness'],
      fixTaskId: null,
      ...over,
    });
  }

  beforeEach(async () => {
    vi.stubEnv('PUBLIC_API_ENABLED', 'true');
    resetFeatureFlagsForTests();
    scheduleReviewEvaluation.mockReset();
    onQueueMembershipChanged.mockClear();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main' },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'other/app', url: 'https://github.com/other/app', defaultBranch: 'main' },
    ]);
    const pr = (id: string, number: number, over: Partial<typeof pullRequests.$inferInsert> = {}) => ({
      id, workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'acme', repo: 'app', number, state: 'open',
      lastSummary: { headSha: HEAD, baseBranch: 'main', headBranch: `b-${number}` } as never, ...over,
    });
    await testDb.db.insert(pullRequests).values([
      pr('pr-1', 1),
      pr('pr-2', 2),
      pr('pr-closed', 3, { state: 'closed' }),
      pr('pr-b', 9, { workspaceId: 'ws-b', repositoryId: 'repo-b', owner: 'other' }),
    ]);
    await testDb.db.insert(prCodeReviews).values([
      {
        id: 'rev-1', workspaceId: 'ws-a', repositoryId: 'repo-a', pullRequestId: 'pr-1', cycle: 2, preset: 'standard',
        lensKeys: ['security', 'correctness'], runsTotal: 4, phase: 'ready', targetHeadSha: HEAD, reviewedHeadSha: HEAD,
      },
      {
        id: 'rev-b', workspaceId: 'ws-b', repositoryId: 'repo-b', pullRequestId: 'pr-b', cycle: 1, phase: 'ready',
        targetHeadSha: HEAD, reviewedHeadSha: HEAD,
      },
    ]);
    await addFinding('f-blocker', { severity: 'blocker', firstSeenCycle: 1, lastSeenCycle: 2, seenCount: 2 });
    await addFinding('f-major');
    await addFinding('f-dismissed', { disposition: 'dismissed', dismissedReason: 'not_a_problem' });
    await addFinding('f-discarded', { disposition: 'discarded' });
    await testDb.db.insert(prCodeReviewFindings).values({
      id: 'f-other', reviewId: 'rev-b', workspaceId: 'ws-b', pullRequestId: 'pr-b', dedupeKey: 'k', severity: 'nit', title: 'Other',
    });
    await testDb.db.insert(prCodeReviewEvents).values({
      reviewId: 'rev-1', fromPhase: 'validating', toPhase: 'ready', trigger: 'poller:unit_settled', code: 'findings_ingested',
      message: 'Findings ready.', detail: { secret: 'internal' },
    });

    let nextId = 900;
    createReview = vi.spyOn(githubService, 'createPRReview').mockImplementation(async () => {
      nextId += 1;
      return { id: nextId, html_url: `https://github.com/acme/app/pull/1#pullrequestreview-${nextId}` } as never;
    });
    vi.spyOn(githubService, 'getAllPRFiles').mockResolvedValue([{ filename: 'src/a.ts', status: 'modified', patch: PATCH }] as never);

    token = await mintToken('owner-a');
    api = await startPublicApi();
  });

  afterEach(async () => {
    await api.close();
    await testDb.pglite.exec('RESET ROLE');
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  describe('reading', () => {
    it('lists the review of a pull request without findings, and nothing for an unreviewed one', async () => {
      const res = await call('GET', '/pull-requests/pr-1/code-reviews');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ object: 'list', has_more: false, next_cursor: null });
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        object: 'code_review',
        id: 'rev-1',
        pull_request_id: 'pr-1',
        cycle: 2,
        preset: 'standard',
        phase: 'ready',
        counts: { blocker: 1, major: 1, minor: 0, nit: 0 },
        dismissed_count: 1,
        stale_for_head: false,
      });
      expect(res.body.data[0]).not.toHaveProperty('findings');
      expect((await call('GET', '/pull-requests/pr-2/code-reviews')).body.data).toEqual([]);
    });

    it('gets a review with its findings, labelled, with no task ids and nothing discarded', async () => {
      const res = await call('GET', '/code-reviews/rev-1');
      expect(res.status).toBe(200);
      expect(res.body.lenses_run).toEqual([
        { key: 'security', name: 'Security' },
        { key: 'correctness', name: 'Logic' },
      ]);
      const ids = res.body.findings.map((f: { id: string }) => f.id);
      expect(ids[0]).toBe('f-blocker');
      expect(ids).toEqual(expect.arrayContaining(['f-blocker', 'f-major', 'f-dismissed']));
      expect(ids).not.toContain('f-discarded');
      expect(res.body.findings[0]).toMatchObject({
        object: 'code_review_finding',
        severity: 'blocker',
        file_path: 'src/a.ts',
        line_start: 11,
        anchor_verified: true,
        status: 'open',
        verdict: 'confirmed',
        verdict_reason: 'Real bug.',
        carried_over: true,
        seen_count: 2,
        lenses: [{ key: 'security', name: 'Security' }, { key: 'correctness', name: 'Logic' }],
      });
      const text = JSON.stringify(res.body);
      for (const key of ['fix_task_id', 'fixTaskId', 'dedupe_key', 'Body of f-blocker', 'Suggestion for']) expect(text).not.toContain(key);
      expect(res.body.findings.find((f: { id: string }) => f.id === 'f-dismissed')).toMatchObject({
        status: 'dismissed',
        dismissed_reason: 'not_a_problem',
      });
    });

    it('gets one finding with its body, suggestion and anchor', async () => {
      const res = await call('GET', '/code-reviews/rev-1/findings/f-major');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: 'f-major', body: 'Body of f-major', suggestion: 'Suggestion for f-major', anchor: 'const x = 1;' });
    });

    it.each([
      ['another review’s finding', '/code-reviews/rev-1/findings/f-other', 'finding_not_found'],
      ['a discarded finding', '/code-reviews/rev-1/findings/f-discarded', 'finding_not_found'],
      ['another owner’s review', '/code-reviews/rev-b', 'code_review_not_found'],
      ['another owner’s finding through its review', '/code-reviews/rev-b/findings/f-other', 'code_review_not_found'],
      ['another owner’s pull request', '/pull-requests/pr-b/code-reviews', 'pull_request_not_found'],
      ['no such review', '/code-reviews/nope', 'code_review_not_found'],
    ])('answers 404 for %s', async (_label, path, code) => {
      const res = await call('GET', path);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(code);
    });

    it('serves the history without the internal detail', async () => {
      const res = await call('GET', '/code-reviews/rev-1/events');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        expect.objectContaining({ object: 'code_review_event', from_phase: 'validating', to_phase: 'ready', code: 'findings_ingested' }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain('internal');
    });
  });

  describe('starting and stopping', () => {
    it('starts a cycle with 201, then answers the running one with 200', async () => {
      const res = await call('POST', '/pull-requests/pr-2/code-reviews', { preset: 'quick' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ object: 'code_review', pull_request_id: 'pr-2', cycle: 1, preset: 'quick', phase: 'queued' });
      expect(scheduleReviewEvaluation).toHaveBeenCalledWith(res.body.id, 'user:start');
      const again = await call('POST', '/pull-requests/pr-2/code-reviews', {});
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(res.body.id);
    });

    it('starts the next cycle of an existing review', async () => {
      const res = await call('POST', '/pull-requests/pr-1/code-reviews', {});
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: 'rev-1', cycle: 3, phase: 'queued' });
    });

    it('refuses a closed pull request with 409 pr_closed', async () => {
      const res = await call('POST', '/pull-requests/pr-closed/code-reviews', {});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('pr_closed');
    });

    it('refuses with 409 no_reviewers when the workspace has no reviewer', async () => {
      await testDb.db.update(workspaces).set({ settings: { codeReview: { builtInReviewers: false } } }).where(eq(workspaces.id, 'ws-a'));
      const res = await call('POST', '/pull-requests/pr-2/code-reviews', {});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('no_reviewers');
    });

    it('answers 402 code_review_limit_reached on a free plan with a cycle running', async () => {
      vi.stubEnv('POLAR_ACCESS_TOKEN', 'polar-test');
      await testDb.db.update(prCodeReviews).set({ phase: 'reviewing' }).where(eq(prCodeReviews.id, 'rev-1'));
      const res = await call('POST', '/pull-requests/pr-2/code-reviews', {});
      expect(res.status).toBe(402);
      expect(res.body.error).toMatchObject({ type: 'plan_limit_error', code: 'code_review_limit_reached', limit: 1 });
    });

    it.each([
      ['an unknown preset', { preset: 'huge' }, 'preset'],
      ['a camelCase field', { Reset: true }, 'Reset'],
    ])('refuses %s', async (_label, body, param) => {
      const res = await call('POST', '/pull-requests/pr-2/code-reviews', body);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.param).toBe(param);
    });

    it('replays a start sent again with the same Idempotency-Key', async () => {
      const first = await call('POST', '/pull-requests/pr-2/code-reviews', {}, { 'Idempotency-Key': 'cr-1' });
      const again = await call('POST', '/pull-requests/pr-2/code-reviews', {}, { 'Idempotency-Key': 'cr-1' });
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(scheduleReviewEvaluation).toHaveBeenCalledTimes(1);
    });

    it('cancels a running cycle, and answers a review at rest as it is', async () => {
      await testDb.db.update(prCodeReviews).set({ phase: 'reviewing' }).where(eq(prCodeReviews.id, 'rev-1'));
      const res = await call('POST', '/code-reviews/rev-1/cancel');
      expect(res.status).toBe(200);
      expect(res.body.phase).toBe('cancelled');
      const again = await call('POST', '/code-reviews/rev-1/cancel');
      expect(again.body.phase).toBe('cancelled');
    });
  });

  describe('dismissing', () => {
    it('dismisses with a reason, tells the merge queue, and undoes it', async () => {
      const res = await call('POST', '/code-reviews/rev-1/findings/f-major/dismiss', { reason: 'wont_fix_here' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: 'f-major', status: 'dismissed', dismissed_reason: 'wont_fix_here' });
      expect(onQueueMembershipChanged).toHaveBeenCalledWith('pr-1', 'code_review:dismissed');
      const [row] = await testDb.db
        .select({ by: prCodeReviewFindings.dispositionBy })
        .from(prCodeReviewFindings)
        .where(eq(prCodeReviewFindings.id, 'f-major'));
      expect(row.by).toBe('owner-a');

      const undo = await call('DELETE', '/code-reviews/rev-1/findings/f-major/dismiss');
      expect(undo.status).toBe(200);
      expect(undo.body).toMatchObject({ status: 'open', dismissed_reason: null });
      expect(onQueueMembershipChanged).toHaveBeenCalledWith('pr-1', 'code_review:undismissed');
    });

    it('dismisses with no reason', async () => {
      const res = await call('POST', '/code-reviews/rev-1/findings/f-major/dismiss', {});
      expect(res.body).toMatchObject({ status: 'dismissed', dismissed_reason: null });
    });

    it('refuses an unknown reason', async () => {
      const res = await call('POST', '/code-reviews/rev-1/findings/f-major/dismiss', { reason: 'meh' });
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe('reason');
    });

    it('does not reopen a finding that is not dismissed', async () => {
      await testDb.db.update(prCodeReviewFindings).set({ disposition: 'fixed' }).where(eq(prCodeReviewFindings.id, 'f-major'));
      const res = await call('DELETE', '/code-reviews/rev-1/findings/f-major/dismiss');
      expect(res.body.status).toBe('fixed');
    });

    it.each([
      ['POST', '/code-reviews/rev-1/findings/f-major/dismiss', ['code_reviews:read'], 'code_reviews:write'],
      ['POST', '/pull-requests/pr-2/code-reviews', ['pull_requests:write'], 'code_reviews:write'],
      ['POST', '/code-reviews/rev-1/post', ['code_reviews:read'], 'code_reviews:write'],
      ['GET', '/code-reviews/rev-1', ['pull_requests:read'], 'code_reviews:read'],
    ])('answers 403 for %s %s without the scope', async (method, path, scopes, needed) => {
      const weak = await mintToken('owner-a', { scopes: scopes as never });
      const res = await call(method, path, method === 'GET' ? undefined : {}, undefined, weak);
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain(needed);
    });

    it('keeps a workspace-bound token out of another workspace', async () => {
      await testDb.db.insert(workspaces).values({ id: 'ws-a2', ownerId: 'owner-a', name: 'A2' });
      const bound = await mintToken('owner-a', { workspaceIds: ['ws-a2'] });
      expect((await call('GET', '/code-reviews/rev-1', undefined, undefined, bound)).status).toBe(404);
      expect((await call('POST', '/code-reviews/rev-1/findings/f-major/dismiss', {}, undefined, bound)).status).toBe(404);
    });
  });

  describe('post to PR', () => {
    it('posts the open findings as one COMMENT review and never twice', async () => {
      const res = await call('POST', '/code-reviews/rev-1/post', {});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ object: 'code_review_post', review_id: 'rev-1', posted: 2 });
      expect(res.body.review_url).toContain('pullrequestreview');
      expect(createReview).toHaveBeenCalledTimes(1);
      expect((createReview.mock.calls[0]![4] as { event: string }).event).toBe('COMMENT');

      const again = await call('POST', '/code-reviews/rev-1/post', {});
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('code_review_post_nothing_to_post');
      expect(createReview).toHaveBeenCalledTimes(1);
    });

    it('posts only the chosen findings', async () => {
      const res = await call('POST', '/code-reviews/rev-1/post', { finding_ids: ['f-major'] });
      expect(res.body.posted).toBe(1);
    });

    it('answers 502 when GitHub refuses', async () => {
      createReview.mockRejectedValue(new GitHubApiError('GitHub is down', 500) as never);
      const res = await call('POST', '/code-reviews/rev-1/post', {});
      expect(res.status).toBe(502);
      expect(res.body.error).toMatchObject({ type: 'api_error', code: 'code_review_post_github_failed' });
    });

    it('refuses a review that is still running', async () => {
      await testDb.db.update(prCodeReviews).set({ phase: 'reviewing' }).where(eq(prCodeReviews.id, 'rev-1'));
      const res = await call('POST', '/code-reviews/rev-1/post', {});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('code_review_post_not_ready');
    });
  });
});
