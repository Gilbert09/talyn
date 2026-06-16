import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { prMonitorService, relationshipFlags, isRepoAccessError } from '../services/prMonitor.js';
import { githubService } from '../services/github.js';
import * as graphqlModule from '../services/githubGraphql.js';
import type { PRSummary } from '../services/githubGraphql.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';

/**
 * Event-driven bucket flags. With webhooks replacing the Search poll,
 * `refreshPr` must derive authored / reviewRequested from the fetched summary +
 * viewer identity (so Mine / Review stay realtime), and must not materialize a
 * row for a PR the viewer has no relationship with.
 */

function summary(over: Partial<PRSummary>): PRSummary {
  return {
    number: 1,
    title: 't',
    author: 'someone',
    owner: 'acme',
    repo: 'widgets',
    state: 'open',
    draft: false,
    url: 'https://github.com/acme/widgets/pull/1',
    headBranch: 'feature/x',
    baseBranch: 'main',
    headSha: 'abc',
    mergeable: 'MERGEABLE',
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
    checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0,
    ...over,
  } as unknown as PRSummary;
}

describe('isRepoAccessError', () => {
  it('flags App-can\'t-reach-repo errors (search 422 / GraphQL 403 / unresolved repo)', () => {
    expect(isRepoAccessError('GitHub GraphQL: Resource not accessible by integration [FORBIDDEN] at repository')).toBe(true);
    expect(isRepoAccessError('GitHub API error 422 Unprocessable Entity: Validation Failed (The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.)')).toBe(true);
    expect(isRepoAccessError('GitHub GraphQL: Could not resolve to a Repository with the name \'PostHog/charts\'.')).toBe(true);
  });
  it('does not flag transient/other errors', () => {
    expect(isRepoAccessError('GitHub GraphQL error: Bad Gateway')).toBe(false);
    expect(isRepoAccessError('Could not resolve to a PullRequest with the number of 3')).toBe(false);
    expect(isRepoAccessError('socket hang up')).toBe(false);
  });
});

describe('relationshipFlags', () => {
  it('marks a PR the viewer authored', () => {
    expect(relationshipFlags(summary({ author: 'octocat' }), 'octocat')).toEqual({
      authored: true,
      reviewRequested: false,
    });
  });

  it('marks a direct review request as reviewRequested', () => {
    const s = summary({ author: 'someone', reviewRequestVia: { direct: true, teams: [] } });
    expect(relationshipFlags(s, 'octocat')).toEqual({ authored: false, reviewRequested: true });
  });

  it('marks a team review request as reviewRequested', () => {
    const s = summary({ author: 'someone', reviewRequestVia: { direct: false, teams: ['acme/fe'] } });
    expect(relationshipFlags(s, 'octocat').reviewRequested).toBe(true);
  });

  it('clears reviewRequested once the viewer has reviewed (team request lingering)', () => {
    const s = summary({
      author: 'someone',
      reviewRequestVia: { direct: false, teams: ['acme/fe'] },
      recentReviews: [{ author: 'octocat', state: 'APPROVED' }] as never,
    });
    expect(relationshipFlags(s, 'octocat').reviewRequested).toBe(false);
  });

  it('never marks the viewer\'s own PR as reviewRequested', () => {
    const s = summary({ author: 'octocat', reviewRequestVia: { direct: true, teams: [] } });
    expect(relationshipFlags(s, 'octocat')).toEqual({ authored: true, reviewRequested: false });
  });

  it('is all-false with no viewer login', () => {
    expect(relationshipFlags(summary({ author: 'octocat' }), null)).toEqual({
      authored: false,
      reviewRequested: false,
    });
  });
});

describe('refreshPr (webhook-driven flags + relevance guard)', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'm', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo1', workspaceId: 'ws1', name: 'acme/widgets',
      url: 'https://github.com/acme/widgets', defaultBranch: 'main', createdAt: new Date(),
    });
    vi.spyOn(githubService, 'getUser').mockResolvedValue({ login: 'octocat' } as never);
    vi.spyOn(githubService, 'getViewerTeamSlugs').mockResolvedValue(new Set());
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function rowFor(number: number) {
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(and(eq(pullRequestsTable.workspaceId, 'ws1'), eq(pullRequestsTable.number, number)));
    return rows[0];
  }

  it('materializes an authored PR with authored=true', async () => {
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 7, pr: summary({ number: 7, author: 'octocat' }) },
    ]);
    await prMonitorService.refreshPr('ws1', 'acme', 'widgets', 7);
    const row = await rowFor(7);
    expect(row?.authored).toBe(true);
    expect(row?.reviewRequested).toBe(false);
  });

  it('does NOT materialize a PR the viewer has no relationship with', async () => {
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 9, pr: summary({ number: 9, author: 'stranger' }) },
    ]);
    await prMonitorService.refreshPr('ws1', 'acme', 'widgets', 9);
    expect(await rowFor(9)).toBeUndefined();
  });

  it('updates an already-tracked PR even when the relationship is now gone', async () => {
    await db.insert(pullRequestsTable).values({
      id: 'pr-x', workspaceId: 'ws1', repositoryId: 'repo1', owner: 'acme', repo: 'widgets',
      number: 5, state: 'open', authored: true, reviewRequested: false,
      lastPolledAt: new Date(), lastSummary: {}, createdAt: new Date(), updatedAt: new Date(),
    });
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 5, pr: summary({ number: 5, author: 'stranger' }) },
    ]);
    await prMonitorService.refreshPr('ws1', 'acme', 'widgets', 5);
    const row = await rowFor(5);
    expect(row).toBeDefined();
    expect(row?.authored).toBe(false); // cleared
  });

  it('openPrNumbersForBase returns only OPEN PRs whose base branch matches', async () => {
    const base = (number: number, state: string, baseBranch: string) => ({
      id: `pr-${number}`, workspaceId: 'ws1', repositoryId: 'repo1', owner: 'acme', repo: 'widgets',
      number, state, authored: false, reviewRequested: false,
      lastPolledAt: new Date(), lastSummary: { baseBranch }, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(pullRequestsTable).values([
      base(1, 'open', 'main'),
      base(2, 'open', 'develop'),
      base(3, 'closed', 'main'),
      base(4, 'open', 'main'),
    ]);
    const nums = await prMonitorService.openPrNumbersForBase('ws1', 'repo1', 'main');
    expect(nums.sort((a, b) => a - b)).toEqual([1, 4]); // #2 wrong base, #3 closed
  });
});
