import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { callPublic, mintToken, startPublicApi } from './helpers/publicApi.js';
import {
  mergeQueueEntries,
  mergeQueueEvents,
  prCodeReviews,
  pullRequests,
  repositories,
  workbenches,
  workspaces,
} from '../db/schema.js';

/**
 * `/v1` pull requests and the merge queue: the public shape, the filters and
 * the cursor, the merge-queue writes through `setQueueMembership`, the plan
 * gate, refresh through `refreshPullRequest`, and the reach rules.
 */

const forceFetchAndUpsert = vi.fn();
vi.mock('../services/prCache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/prCache.js')>()),
  forceFetchAndUpsert: (...args: unknown[]) => forceFetchAndUpsert(...args),
}));

// The queue's evaluation walk reads GitHub. These tests stop at the queue write.
vi.mock('../services/mergeQueue/triggers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mergeQueue/triggers.js')>()),
  onQueueMembershipChanged: vi.fn(async () => undefined),
}));

const { settleQueueFollowUps } = await import('../services/mergeQueue/membership.js');
const { githubService } = await import('../services/github.js');
const { GitHubRateLimitError } = await import('../services/githubRateGate.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { listPullRequestsQuery, activeQueueEntriesQuery, getPullRequestQuery } = await import('../services/public/pullRequests.js');

const SUMMARY = {
  title: 'Make the tests faster',
  url: 'https://github.com/acme/app/pull/1',
  author: 'octocat',
  prAuthorIsBot: false,
  draft: false,
  headBranch: 'feat/fast',
  baseBranch: 'main',
  headSha: 'a'.repeat(40),
  createdAt: '2026-10-01T10:00:00Z',
  additions: 12,
  deletions: 3,
  changedFiles: 2,
  ciStatus: 'failing_required',
  blockingReason: 'checks_failed',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: null,
  effectiveReviewDecision: 'APPROVED',
  unresolvedReviewThreads: 1,
  checks: { total: 5, passed: 3, failed: 1, inProgress: 1, skipped: 0 },
  humanGates: [{ id: 'visual_review', label: 'Visual review', name: 'Visual review', url: 'https://x' }],
  recentComments: [{ id: 'c', bodyText: 'secret comment text' }],
};

describe('/v1 pull requests and merge queue', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let api: Awaited<ReturnType<typeof startPublicApi>>;
  let token: string;

  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>, as = token) =>
    callPublic(api.base, method, path, { token: as, body, headers });

  async function addPr(id: string, over: Partial<typeof pullRequests.$inferInsert> = {}) {
    await testDb.db.insert(pullRequests).values({
      id,
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      owner: 'acme',
      repo: 'app',
      number: Number(id.replace(/\D/g, '')) || 1,
      state: 'open',
      authored: true,
      lastSummary: SUMMARY as never,
      body: 'The description',
      ...over,
    });
  }

  beforeEach(async () => {
    vi.stubEnv('PUBLIC_API_ENABLED', 'true');
    resetFeatureFlagsForTests();
    forceFetchAndUpsert.mockReset();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-a2', ownerId: 'owner-a', name: 'A2' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main' },
      { id: 'repo-a3', workspaceId: 'ws-a', name: 'acme/web', url: 'https://github.com/acme/web', defaultBranch: 'main' },
      { id: 'repo-a2', workspaceId: 'ws-a2', name: 'acme/two', url: 'https://github.com/acme/two', defaultBranch: 'main' },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'other/app', url: 'https://github.com/other/app', defaultBranch: 'main' },
    ]);
    // The disarm path and draft publish call GitHub; nothing here arms or drafts.
    vi.spyOn(githubService, 'getPullRequest').mockRejectedValue(new Error('offline'));
    token = await mintToken('owner-a');
    api = await startPublicApi();
  });

  afterEach(async () => {
    await settleQueueFollowUps();
    await api.close();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  describe('reading', () => {
    it('lists open pull requests in the public shape, with no summary blob or body', async () => {
      await addPr('pr-1');
      const res = await call('GET', '/pull-requests?workspace_id=ws-a');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ object: 'list', has_more: false, next_cursor: null });
      expect(res.body.data).toHaveLength(1);
      const pr = res.body.data[0];
      expect(pr).toMatchObject({
        object: 'pull_request',
        id: 'pr-1',
        workspace_id: 'ws-a',
        repository_id: 'repo-a',
        repository_full_name: 'acme/app',
        number: 1,
        title: 'Make the tests faster',
        author: 'octocat',
        author_is_bot: false,
        state: 'open',
        draft: false,
        head_branch: 'feat/fast',
        base_branch: 'main',
        additions: 12,
        changed_files: 2,
        authored: true,
        review_requested: false,
        ci_status: 'failing_required',
        checks: { total: 5, passed: 3, failed: 1, in_progress: 1, skipped: 0 },
        human_gates: [{ id: 'visual_review', label: 'Visual review', name: 'Visual review', url: 'https://x' }],
        blocking_reason: 'checks_failed',
        mergeable: 'mergeable',
        merge_state_status: 'blocked',
        review_decision: 'approved',
        unresolved_review_threads: 1,
        auto_keep_mergeable: false,
        merge_queue: null,
        opened_at: '2026-10-01T10:00:00.000Z',
      });
      for (const key of ['summary', 'lastSummary', 'last_summary', 'body', 'taskId', 'task_id', 'recentComments']) {
        expect(pr).not.toHaveProperty(key);
      }
      expect(JSON.stringify(res.body)).not.toContain('secret comment text');
      // Single-response fields stay off the list.
      expect(pr).not.toHaveProperty('session_ids');
      expect(pr).not.toHaveProperty('code_review');
    });

    it('answers nulls for a pull request Talyn has not read from GitHub yet', async () => {
      await addPr('pr-1', { lastSummary: {} as never });
      const res = await call('GET', '/pull-requests/pr-1');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ title: null, ci_status: null, checks: null, human_gates: [], head_branch: null, opened_at: null });
    });

    it.each([
      ['the default (open)', '', ['pr-1', 'pr-3']],
      ['merged', '&state=merged', ['pr-2']],
      ['all', '&state=all', ['pr-1', 'pr-2', 'pr-3']],
      ['authored (Mine)', '&relationship=authored', ['pr-1']],
      ['review requested', '&relationship=review_requested', ['pr-3']],
      ['a repository', '&repository_id=repo-a3', ['pr-3']],
      ['merge queued', '&merge_queued=true', ['pr-3']],
      ['not merge queued', '&merge_queued=false', ['pr-1']],
    ])('filters by %s', async (_label, qs, ids) => {
      await addPr('pr-1');
      await addPr('pr-2', { state: 'merged', mergedAt: new Date() });
      await addPr('pr-3', { authored: false, reviewRequested: true, repositoryId: 'repo-a3', repo: 'web', mergeQueued: true });
      const res = await call('GET', `/pull-requests?workspace_id=ws-a${qs}`);
      expect(res.status).toBe(200);
      expect(res.body.data.map((p: { id: string }) => p.id).sort()).toEqual(ids);
    });

    it('pages newest tracked first with a cursor, with no repeats or gaps', async () => {
      const base = Date.UTC(2026, 9, 1);
      for (let n = 1; n <= 5; n++) await addPr(`pr-${n}`, { createdAt: new Date(base + n * 1000) });
      const first = await call('GET', '/pull-requests?workspace_id=ws-a&limit=2');
      expect(first.body.data.map((p: { id: string }) => p.id)).toEqual(['pr-5', 'pr-4']);
      expect(first.body.has_more).toBe(true);
      const second = await call('GET', `/pull-requests?workspace_id=ws-a&limit=2&cursor=${first.body.next_cursor}`);
      const third = await call('GET', `/pull-requests?workspace_id=ws-a&limit=2&cursor=${second.body.next_cursor}`);
      expect(second.body.data.map((p: { id: string }) => p.id)).toEqual(['pr-3', 'pr-2']);
      expect(third.body.data.map((p: { id: string }) => p.id)).toEqual(['pr-1']);
      expect(third.body).toMatchObject({ has_more: false, next_cursor: null });
    });

    it.each([
      ['an unknown state', '?workspace_id=ws-a&state=draft', 'state'],
      ['an unknown relationship', '?workspace_id=ws-a&relationship=mine', 'relationship'],
      ['a camelCase filter', '?workspaceId=ws-a', 'workspaceId'],
      ['a bad cursor', '?workspace_id=ws-a&cursor=nope', 'cursor'],
      ['no workspace', '', 'workspace_id'],
    ])('refuses %s', async (_label, qs, param) => {
      const res = await call('GET', `/pull-requests${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe(param);
    });

    it('gets one pull request with its queue place, live sessions and latest code review', async () => {
      await addPr('pr-1');
      await testDb.db.insert(workbenches).values([
        { id: 'wb-live', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: 'live', branch: 'feat/fast', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready', pullRequestId: 'pr-1' },
        { id: 'wb-old', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: 'old', branch: 'feat/fast', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready', pullRequestId: 'pr-1', archivedAt: new Date() },
      ]);
      await testDb.db.insert(prCodeReviews).values({
        id: 'rev-1', workspaceId: 'ws-a', repositoryId: 'repo-a', pullRequestId: 'pr-1', cycle: 1, phase: 'ready',
        targetHeadSha: SUMMARY.headSha, reviewedHeadSha: SUMMARY.headSha,
      });
      expect((await call('POST', '/pull-requests/pr-1/merge-queue', { method: 'rebase' })).status).toBe(200);

      const res = await call('GET', '/pull-requests/pr-1');
      expect(res.status).toBe(200);
      expect(res.body.session_ids).toEqual(['wb-live']);
      expect(res.body.code_review).toMatchObject({ id: 'rev-1', phase: 'ready', open_count: 0, stale_for_head: false });
      expect(res.body.merge_queue).toMatchObject({ status: 'queued', position: 1, method: 'rebase', base_branch: 'main', auto_merge_armed: false });
      expect(res.body.merge_queue).not.toHaveProperty('seen_signatures');
    });

    it('serves the cached description', async () => {
      await addPr('pr-1');
      const res = await call('GET', '/pull-requests/pr-1/description');
      expect(res.body).toEqual({ object: 'pull_request_description', pull_request_id: 'pr-1', body: 'The description' });
    });
  });

  describe('reach', () => {
    beforeEach(async () => {
      await addPr('pr-1');
      await testDb.db.insert(pullRequests).values({
        id: 'pr-b', workspaceId: 'ws-b', repositoryId: 'repo-b', owner: 'other', repo: 'app', number: 9, state: 'open',
      });
      await testDb.db.insert(pullRequests).values({
        id: 'pr-a2', workspaceId: 'ws-a2', repositoryId: 'repo-a2', owner: 'acme', repo: 'two', number: 2, state: 'open',
      });
    });

    it.each([
      ['GET', '/pull-requests/pr-b'],
      ['GET', '/pull-requests/pr-b/description'],
      ['PATCH', '/pull-requests/pr-b'],
      ['POST', '/pull-requests/pr-b/refresh'],
      ['POST', '/pull-requests/pr-b/merge-queue'],
      ['DELETE', '/pull-requests/pr-b/merge-queue'],
      ['POST', '/pull-requests/pr-b/merge-queue/resubmit'],
      ['GET', '/pull-requests/pr-b/merge-queue/events'],
      ['GET', '/pull-requests/nope'],
    ])('answers 404 for %s %s of another owner', async (method, path) => {
      const res = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('pull_request_not_found');
      expect(forceFetchAndUpsert).not.toHaveBeenCalled();
    });

    it('refuses another owner’s workspace list and queue as not found', async () => {
      expect((await call('GET', '/pull-requests?workspace_id=ws-b')).status).toBe(404);
      expect((await call('GET', '/merge-queue?workspace_id=ws-b')).status).toBe(404);
    });

    it('keeps a workspace-bound token inside its workspace, and lets it leave workspace_id out', async () => {
      const bound = await mintToken('owner-a', { workspaceIds: ['ws-a'] });
      const list = await call('GET', '/pull-requests', undefined, undefined, bound);
      expect(list.status).toBe(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).toEqual(['pr-1']);
      expect((await call('GET', '/pull-requests/pr-a2', undefined, undefined, bound)).status).toBe(404);
      expect((await call('POST', '/pull-requests/pr-a2/merge-queue', {}, undefined, bound)).status).toBe(404);
      expect((await call('GET', '/merge-queue', undefined, undefined, bound)).status).toBe(200);
    });

    it.each([
      ['GET', '/pull-requests?workspace_id=ws-a', ['sessions:read'], 'pull_requests:read'],
      ['GET', '/merge-queue?workspace_id=ws-a', ['code_reviews:read'], 'pull_requests:read'],
      ['PATCH', '/pull-requests/pr-1', ['pull_requests:read'], 'pull_requests:write'],
      ['POST', '/pull-requests/pr-1/merge-queue', ['pull_requests:read'], 'pull_requests:write'],
      ['POST', '/pull-requests/pr-1/refresh', ['pull_requests:read'], 'pull_requests:write'],
    ])('answers 403 for %s %s without the scope', async (method, path, scopes, needed) => {
      const weak = await mintToken('owner-a', { scopes: scopes as never });
      const res = await call(method, path, method === 'GET' ? undefined : {}, undefined, weak);
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain(needed);
    });

    it('lets pull_requests:write read', async () => {
      const writer = await mintToken('owner-a', { scopes: ['pull_requests:write'] });
      expect((await call('GET', '/pull-requests/pr-1', undefined, undefined, writer)).status).toBe(200);
    });
  });

  describe('auto-keep', () => {
    it('turns the watcher on and off', async () => {
      await addPr('pr-1');
      const on = await call('PATCH', '/pull-requests/pr-1', { auto_keep_mergeable: true });
      expect(on.status).toBe(200);
      expect(on.body.auto_keep_mergeable).toBe(true);
      const [row] = await testDb.db
        .select({ autoKeepMergeable: pullRequests.autoKeepMergeable, autoMergeState: pullRequests.autoMergeState })
        .from(pullRequests)
        .where(eq(pullRequests.id, 'pr-1'));
      expect(row).toEqual({ autoKeepMergeable: true, autoMergeState: { attempts: 0, accounted: true } });
      const off = await call('PATCH', '/pull-requests/pr-1', { auto_keep_mergeable: false });
      expect(off.body.auto_keep_mergeable).toBe(false);
    });

    it.each([
      ['a camelCase field', { autoKeepMergeable: true }, 'autoKeepMergeable'],
      ['a string', { auto_keep_mergeable: 'yes' }, 'auto_keep_mergeable'],
    ])('refuses %s', async (_label, body, param) => {
      await addPr('pr-1');
      const res = await call('PATCH', '/pull-requests/pr-1', body);
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe(param);
    });
  });

  describe('refresh', () => {
    beforeEach(async () => {
      await addPr('pr-1');
    });

    it('fetches again through the service and answers the stored row', async () => {
      forceFetchAndUpsert.mockImplementation(async () => {
        await testDb.db
          .update(pullRequests)
          .set({ lastSummary: { ...SUMMARY, title: 'Renamed on GitHub' } as never })
          .where(eq(pullRequests.id, 'pr-1'));
        return { rowId: 'pr-1' };
      });
      const res = await call('POST', '/pull-requests/pr-1/refresh');
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Renamed on GitHub');
      expect(forceFetchAndUpsert).toHaveBeenCalledWith(expect.objectContaining({ owner: 'acme', repo: 'app', number: 1 }));
    });

    it('records a merge GitHub reports when the pull request is no longer open', async () => {
      forceFetchAndUpsert.mockResolvedValue(null);
      vi.spyOn(githubService, 'getPullRequest').mockResolvedValue({ merged: true, merged_at: '2026-11-01T00:00:00Z', state: 'closed' } as never);
      const res = await call('POST', '/pull-requests/pr-1/refresh');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ state: 'merged', merged_at: '2026-11-01T00:00:00.000Z' });
    });

    it('answers 409 cannot_refresh when GitHub has nothing', async () => {
      forceFetchAndUpsert.mockResolvedValue(null);
      const res = await call('POST', '/pull-requests/pr-1/refresh');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('cannot_refresh');
    });

    it('answers 503 with Retry-After when GitHub rate limits the account', async () => {
      forceFetchAndUpsert.mockRejectedValue(new GitHubRateLimitError('slow down', 42_000));
      const res = await call('POST', '/pull-requests/pr-1/refresh');
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ type: 'unavailable_error', code: 'github_rate_limited' });
      expect(res.headers.get('retry-after')).toBe('42');
    });

    it('counts against the GitHub tier: the 31st refresh in a minute is refused', async () => {
      forceFetchAndUpsert.mockResolvedValue({ rowId: 'pr-1' });
      for (let i = 0; i < 30; i++) expect((await call('POST', '/pull-requests/pr-1/refresh')).status).toBe(200);
      const refused = await call('POST', '/pull-requests/pr-1/refresh');
      expect(refused.status).toBe(429);
      expect(refused.body.error.message).toContain('GitHub');
      // Reads do not count against it.
      expect((await call('GET', '/pull-requests/pr-1')).status).toBe(200);
    });
  });

  describe('merge queue', () => {
    it('adds, lists and removes a pull request', async () => {
      await addPr('pr-1');
      await addPr('pr-2', { createdAt: new Date(Date.now() + 1000) });
      const added = await call('POST', '/pull-requests/pr-1/merge-queue', {});
      expect(added.status).toBe(200);
      expect(added.body.merge_queue).toMatchObject({ status: 'queued', position: 1, method: 'squash' });
      await call('POST', '/pull-requests/pr-2/merge-queue', { method: 'merge' });

      const queue = await call('GET', '/merge-queue?workspace_id=ws-a');
      expect(queue.status).toBe(200);
      expect(queue.body).toMatchObject({ object: 'list', has_more: false, next_cursor: null });
      expect(queue.body.data).toEqual([
        expect.objectContaining({ object: 'merge_queue_entry', pull_request_id: 'pr-1', number: 1, title: 'Make the tests faster', position: 1, repository_full_name: 'acme/app' }),
        expect.objectContaining({ pull_request_id: 'pr-2', position: 2, method: 'merge' }),
      ]);

      const removed = await call('DELETE', '/pull-requests/pr-1/merge-queue');
      expect(removed.status).toBe(200);
      expect(removed.body.merge_queue).toBeNull();
      const after = await call('GET', '/merge-queue?workspace_id=ws-a');
      expect(after.body.data.map((e: { pull_request_id: string; position: number }) => [e.pull_request_id, e.position])).toEqual([['pr-2', 1]]);
      // Removing again answers the same.
      expect((await call('DELETE', '/pull-requests/pr-1/merge-queue')).status).toBe(200);
    });

    it('records the queue history and serves it without the internal detail', async () => {
      await addPr('pr-1');
      await call('POST', '/pull-requests/pr-1/merge-queue', {});
      const res = await call('GET', '/pull-requests/pr-1/merge-queue/events');
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('list');
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toMatchObject({ object: 'merge_queue_event', to_status: 'queued', trigger: 'user:api_enqueue' });
      expect(res.body.data[0]).not.toHaveProperty('detail');
      const empty = await call('GET', '/pull-requests/pr-1/merge-queue/events');
      expect(empty.status).toBe(200);
    });

    it('refuses a pull request that is not open', async () => {
      await addPr('pr-1', { state: 'closed' });
      const res = await call('POST', '/pull-requests/pr-1/merge-queue', {});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('pull_request_not_open');
      expect(await testDb.db.select({ id: mergeQueueEntries.id }).from(mergeQueueEntries)).toEqual([]);
    });

    it('refuses an unknown method', async () => {
      await addPr('pr-1');
      const res = await call('POST', '/pull-requests/pr-1/merge-queue', { method: 'fast-forward' });
      expect(res.status).toBe(400);
      expect(res.body.error.param).toBe('method');
    });


    it('replays an add sent again with the same Idempotency-Key', async () => {
      await addPr('pr-1');
      const first = await call('POST', '/pull-requests/pr-1/merge-queue', {}, { 'Idempotency-Key': 'mq-1' });
      const again = await call('POST', '/pull-requests/pr-1/merge-queue', {}, { 'Idempotency-Key': 'mq-1' });
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body).toEqual(first.body);
      const reused = await call('POST', '/pull-requests/pr-1/merge-queue', { method: 'merge' }, { 'Idempotency-Key': 'mq-1' });
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('idempotency_key_reused');
    });

    it.each([
      ['not queued', null, 'not_queued'],
      ['still being worked', 'awaiting_ci', 'not_parked'],
      ['parked, but never near an external queue', 'blocked', 'no_external_queue'],
    ])('refuses to re-submit a pull request %s', async (_label, status, code) => {
      await addPr('pr-1');
      if (status) {
        await call('POST', '/pull-requests/pr-1/merge-queue', {});
        await testDb.db.update(mergeQueueEntries).set({ status, blockedCode: status === 'blocked' ? 'no_progress' : null });
      }
      const res = await call('POST', '/pull-requests/pr-1/merge-queue/resubmit');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(code);
    });

    it('re-submits a parked entry an external queue gave back', async () => {
      await addPr('pr-1');
      await call('POST', '/pull-requests/pr-1/merge-queue', {});
      await testDb.db.update(mergeQueueEntries).set({ status: 'blocked', blockedCode: 'external_queue_rejected' });
      const res = await call('POST', '/pull-requests/pr-1/merge-queue/resubmit');
      expect(res.status).toBe(200);
      const codes = await testDb.db.select({ code: mergeQueueEvents.code }).from(mergeQueueEvents);
      expect(codes.map((c) => c.code)).toContain('user_resubmit');
    });
  });

  describe('egress', () => {
    /** Every `last_summary` in the SQL is read through a JSON accessor, never selected whole. */
    function expectNoWholeSummary(sqlText: string) {
      const uses = sqlText.match(/"last_summary"(\s*(->>|#>>|->))?/g) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      for (const use of uses) expect(use, sqlText).toMatch(/(->>|#>>|->)$/);
    }

    it('the list reads summary fields in SQL and never the body', () => {
      const q = listPullRequestsQuery('ws-a', { state: 'all', relationship: 'authored', mergeQueued: true }, null, 50).toSQL().sql;
      expectNoWholeSummary(q);
      expect(q).not.toContain('"body"');
      expect(q).not.toContain('"task_id"');
      expect(q).not.toContain('"auto_merge_state"');
    });

    it('the single read does the same', () => {
      const q = getPullRequestQuery('pr-1').toSQL().sql;
      expectNoWholeSummary(q);
      expect(q).not.toContain('"body"');
    });

    it('the queue read leaves the engine bookkeeping in the database', () => {
      const q = activeQueueEntriesQuery('ws-a').toSQL().sql;
      for (const col of ['seen_signatures', 'fix_task_id', 'last_error', 'version']) expect(q).not.toContain(`"${col}"`);
      expectNoWholeSummary(q);
    });
  });
});
