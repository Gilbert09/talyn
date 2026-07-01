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

/**
 * The webhook fan-out dedup: N workspaces on the SAME installation share ONE
 * GitHub fetch (resolveAuth keys the token on the repo owner, so every
 * workspace gets an identical result). This is the fix for the prod rate-limit
 * storm — the old path made N identical GraphQL calls against one shared point
 * budget. The cheap per-workspace post-processing (viewer flags + upsert) still
 * runs once per workspace, independently.
 */
describe('refreshPrAcrossWorkspaces (deduped fan-out)', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const targets = [
    { workspaceId: 'ws1', owner: 'acme', repo: 'widgets', repositoryId: 'repo1' },
    { workspaceId: 'ws2', owner: 'acme', repo: 'widgets', repositoryId: 'repo2' },
  ];

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values([
      { id: 'ws1', ownerId: TEST_USER_ID, name: 'a', settings: {} },
      { id: 'ws2', ownerId: TEST_USER_ID, name: 'b', settings: {} },
    ]);
    await db.insert(repositoriesTable).values([
      { id: 'repo1', workspaceId: 'ws1', name: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranch: 'main', createdAt: new Date() },
      { id: 'repo2', workspaceId: 'ws2', name: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranch: 'main', createdAt: new Date() },
    ]);
    // Both workspaces resolve to the SAME installation account → one group, one fetch.
    vi.spyOn(githubService, 'graphqlAccountKeyForOwner').mockReturnValue('inst:shared');
    vi.spyOn(githubService, 'getViewerTeamSlugs').mockResolvedValue(new Set());
    // Distinct viewer per workspace, so per-workspace relationship derivation is
    // exercised off the ONE shared summary.
    vi.spyOn(githubService, 'getUser').mockImplementation(
      async (ws: string) => ({ login: ws === 'ws1' ? 'octocat' : 'dev2' }) as never,
    );
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  const rowFor = async (workspaceId: string, number: number) => {
    const rows = await db
      .select()
      .from(pullRequestsTable)
      .where(and(eq(pullRequestsTable.workspaceId, workspaceId), eq(pullRequestsTable.number, number)));
    return rows[0];
  };

  it('makes ONE GitHub fetch for all workspaces yet upserts each independently', async () => {
    // author=dev2 (so ws2 is the author); ws1 is review-requested directly.
    const shared = summary({
      number: 7,
      author: 'dev2',
      reviewRequests: { users: ['octocat'], teams: [] },
    } as Partial<PRSummary>);
    fetchSpy = vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 7, pr: shared },
    ]);

    await prMonitorService.refreshPrAcrossWorkspaces(targets, 7);

    // The whole point: a single shared fetch, not one per workspace.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // ws1 (review-requested) and ws2 (author) each get their OWN row with the
    // relationship derived from their own viewer identity.
    const r1 = await rowFor('ws1', 7);
    const r2 = await rowFor('ws2', 7);
    expect(r1).toBeDefined();
    expect(r1?.reviewRequested).toBe(true);
    expect(r1?.authored).toBe(false);
    expect(r2).toBeDefined();
    expect(r2?.authored).toBe(true);
    expect(r2?.reviewRequested).toBe(false);
  });

  it('does not bleed reviewRequestVia across workspaces (clones the shared summary)', async () => {
    const shared = summary({
      number: 8,
      author: 'dev2',
      reviewRequests: { users: ['octocat'], teams: [] },
    } as Partial<PRSummary>);
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([{ number: 8, pr: shared }]);

    await prMonitorService.refreshPrAcrossWorkspaces(targets, 8);

    // The shared fetched object must be left untouched — annotateReviewRequest
    // writes reviewRequestVia onto a per-workspace CLONE, never the original.
    expect((shared as PRSummary).reviewRequestVia).toBeUndefined();
  });

  it('splits into separate fetches when workspaces resolve to different accounts', async () => {
    // No shared installation (user-token fallback) → each workspace is its own
    // group → one fetch each (still correct, just no dedup benefit).
    vi.spyOn(githubService, 'graphqlAccountKeyForOwner').mockImplementation(
      (ws: string) => `user:${ws}`,
    );
    const fetch2 = vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 9, pr: summary({ number: 9, author: 'octocat' }) },
    ]);
    await prMonitorService.refreshPrAcrossWorkspaces(targets, 9);
    expect(fetch2).toHaveBeenCalledTimes(2);
  });
});
