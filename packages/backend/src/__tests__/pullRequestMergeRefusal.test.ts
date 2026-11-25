import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { pullRequests, repositories, workspaces } from '../db/schema.js';
import { pullRequestRoutes } from '../routes/pullRequests.js';
import { githubService } from '../services/github.js';
import * as graphqlModule from '../services/githubGraphql.js';
import type { PRSummary } from '../services/githubGraphql.js';
import * as mergeGate from '../services/repoMergeGate.js';

/**
 * A merge GitHub refuses comes back as a code and a message a person can act
 * on, and the PR row shows the new status at once. "Update branch" merges the
 * base into the head on GitHub.
 */

const OWNER = 'owner-a';
const OUT_OF_DATE =
  'GitHub API error 409 Conflict: Head branch is out of date. Review and try the merge again. ' +
  '(GitHub request-id: 8E14:BEB88:AFA78BD:1030E63F:6B070AFE)';

function summary(over: Partial<PRSummary> = {}): PRSummary {
  return {
    owner: 'o',
    repo: 'r',
    number: 344,
    title: 'T',
    body: '',
    changedFiles: 1,
    url: 'https://github.com/o/r/pull/344',
    author: 'me',
    draft: false,
    state: 'open',
    mergedAt: null,
    closedAt: null,
    headBranch: 'feat',
    baseBranch: 'main',
    headSha: 'sha1',
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    effectiveReviewDecision: null,
    blockingReason: 'mergeable',
    checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0,
    checkDigest: 'sha1:',
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
    ...over,
  } as PRSummary;
}

describe('merge refusals and Update branch', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    testDb = await createTestDb();
    const { db } = testDb;
    await seedUser(db, { id: OWNER });
    await db.insert(workspaces).values({ id: 'ws-a', ownerId: OWNER, name: 'A' });
    await db.insert(repositories).values({
      id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r', defaultBranch: 'main',
    });
    await db.insert(pullRequests).values({
      id: 'pr-1', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number: 344, state: 'open',
      lastSummary: summary(),
    });

    vi.spyOn(mergeGate, 'getExternalMergeGate').mockResolvedValue(null);
    vi.spyOn(githubService, 'getPullRequest').mockResolvedValue({ state: 'open', merged: false } as never);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: OWNER, email: 'o@x.dev' } as typeof req.user;
      next();
    });
    app.use('/pull-requests', pullRequestRoutes());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await testDb.cleanup();
    vi.restoreAllMocks();
  });

  const post = (path: string) =>
    fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  const storedSummary = async () => {
    const [row] = await testDb.db
      .select({ lastSummary: pullRequests.lastSummary })
      .from(pullRequests)
      .where(eq(pullRequests.id, 'pr-1'));
    return row.lastSummary as PRSummary;
  };

  describe('POST /pull-requests/:id/merge', () => {
    it.each<[string, PRSummary['blockingReason'], string]>([
      // GitHub has not recomputed its merge state yet: the refusal is the newer fact.
      ['GitHub still says CLEAN', 'mergeable', 'CLEAN'],
      ['GitHub already says BEHIND', 'behind', 'BEHIND'],
    ])('answers branch_behind and marks the row Behind when %s', async (_name, reason, state) => {
      vi.spyOn(githubService, 'mergePullRequest').mockRejectedValue(new Error(OUT_OF_DATE));
      const batch = vi
        .spyOn(graphqlModule, 'batchPullRequests')
        .mockResolvedValue([{ branch: 'feat', pr: summary({ blockingReason: reason, mergeStateStatus: state }) }] as never);

      const res = await post('/pull-requests/pr-1/merge');

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ success: false, code: 'branch_behind' });
      expect(body.error).toBe(
        '#344 is behind main. This repository merges only up-to-date branches. ' +
          'Update the branch, then merge again when its checks pass.',
      );
      expect(batch).toHaveBeenCalledTimes(1);
      const stored = await storedSummary();
      expect(stored.blockingReason).toBe('behind');
      expect(stored.mergeStateStatus).toBe('BEHIND');
    });

    it('does not mark a row Behind for another refusal, but refetches it', async () => {
      vi.spyOn(githubService, 'mergePullRequest').mockRejectedValue(
        new Error('GitHub API error 405 Method Not Allowed: Pull Request is not mergeable'),
      );
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([
        { branch: 'feat', pr: summary({ mergeable: 'CONFLICTING', blockingReason: 'merge_conflicts' }) },
      ] as never);

      const res = await post('/pull-requests/pr-1/merge');

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'not_mergeable' });
      expect((await storedSummary()).blockingReason).toBe('merge_conflicts');
    });

    it('still answers when the refetch fails', async () => {
      vi.spyOn(githubService, 'mergePullRequest').mockRejectedValue(new Error(OUT_OF_DATE));
      vi.spyOn(graphqlModule, 'batchPullRequests').mockRejectedValue(new Error('GraphQL down'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await post('/pull-requests/pr-1/merge');

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'branch_behind' });
    });

    it('answers with a code when GitHub returns merged: false', async () => {
      vi.spyOn(githubService, 'mergePullRequest').mockResolvedValue({
        merged: false,
        message: 'Head branch is out of date.',
      } as never);
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([{ branch: 'feat', pr: summary() }] as never);

      const res = await post('/pull-requests/pr-1/merge');

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'branch_behind' });
      expect((await storedSummary()).blockingReason).toBe('behind');
    });
  });

  describe('POST /pull-requests/:id/update-branch', () => {
    it.each<[string, Awaited<ReturnType<typeof githubService.updatePullRequestBranchOutcome>>, number, Record<string, unknown>]>([
      ['ok', 'ok', 200, { success: true, data: { updated: true } }],
      ['up to date', 'up_to_date', 200, { success: true, data: { updated: false } }],
      ['conflict', 'conflict', 409, { success: false, code: 'update_branch_conflict' }],
      ['error', 'error', 400, { success: false, code: 'update_branch_failed' }],
    ])('%s', async (_name, outcome, status, body) => {
      const update = vi.spyOn(githubService, 'updatePullRequestBranchOutcome').mockResolvedValue(outcome);
      vi.spyOn(graphqlModule, 'batchPullRequests').mockResolvedValue([{ branch: 'feat', pr: summary() }] as never);

      const res = await post('/pull-requests/pr-1/update-branch');

      expect(update).toHaveBeenCalledWith('ws-a', 'o', 'r', 344);
      expect(res.status).toBe(status);
      const json = await res.json();
      expect(json).toMatchObject(body);
      const text = (json.data?.message ?? json.error) as string;
      expect(text).toContain('#344');
    });

    it('refuses a PR that is not open', async () => {
      await testDb.db.update(pullRequests).set({ state: 'merged' }).where(eq(pullRequests.id, 'pr-1'));
      const update = vi.spyOn(githubService, 'updatePullRequestBranchOutcome');

      const res = await post('/pull-requests/pr-1/update-branch');

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'pull_request_not_open' });
      expect(update).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown PR', async () => {
      expect((await post('/pull-requests/nope/update-branch')).status).toBe(404);
    });
  });
});

describe('githubService.updatePullRequestBranch', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each<[string, 'ok' | 'conflict' | 'up_to_date' | 'error', 'ok' | 'conflict' | 'error']>([
    ['ok', 'ok', 'ok'],
    ['conflict', 'conflict', 'conflict'],
    // The merge queue keeps its old reading of every 422.
    ['up to date', 'up_to_date', 'conflict'],
    ['error', 'error', 'error'],
  ])('maps %s for the merge queue', async (_name, outcome, expected) => {
    vi.spyOn(githubService, 'updatePullRequestBranchOutcome').mockResolvedValue(outcome);
    expect(await githubService.updatePullRequestBranch('ws', 'o', 'r', 1)).toBe(expected);
  });
});

describe('githubService.updatePullRequestBranchOutcome', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each<[string, unknown, 'ok' | 'conflict' | 'up_to_date' | 'error']>([
    ['a success', undefined, 'ok'],
    ['no new commits', new Error('GitHub API error 422 Unprocessable Entity: There are no new commits on the base branch.'), 'up_to_date'],
    ['a merge conflict', new Error('GitHub API error 422 Unprocessable Entity: merge conflict between base and head'), 'conflict'],
    ['another error', new Error('GitHub API error 500 Internal Server Error'), 'error'],
  ])('reads %s', async (_name, failure, expected) => {
    const spy = vi.spyOn(githubService as unknown as { apiRequest: () => Promise<unknown> }, 'apiRequest');
    if (failure) spy.mockRejectedValue(failure);
    else spy.mockResolvedValue({});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await githubService.updatePullRequestBranchOutcome('ws', 'o', 'r', 1)).toBe(expected);
  });
});
