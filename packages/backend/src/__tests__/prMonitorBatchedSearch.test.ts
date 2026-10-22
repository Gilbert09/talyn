import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  prMonitorService,
  chunkReposForSearch,
  needsDirectRequestSearch,
  relationshipSearch,
  describeForcedPoll,
  describeRefreshFailure,
  refreshOutcome,
  BATCH_SEARCH_MAX_QUERY_BYTES,
} from '../services/prMonitor.js';
import { GitHubRateLimitError } from '../services/githubRateGate.js';
import { githubService, repoKeyFromApiUrl } from '../services/github.js';
import * as graphqlModule from '../services/githubGraphql.js';
import { _resetPrFocus } from '../services/prFocus.js';
import type { PRSummary } from '../services/githubGraphql.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';

/**
 * The poll searches once per WORKSPACE (many `repo:` qualifiers) instead of 3-4
 * times per repo, against GitHub's 30-a-minute search budget. These pin the
 * batched path and every case where it must hand back to the per-repo searches.
 */

function fakeSummary(owner: string, repo: string, number: number, author = 'me'): PRSummary {
  return {
    owner,
    repo,
    number,
    title: `PR ${number}`,
    body: '',
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    author,
    draft: false,
    state: 'open',
    mergedAt: null,
    closedAt: null,
    headBranch: `branch-${number}`,
    baseBranch: 'main',
    headSha: `sha${number}`,
    updatedAt: '2026-01-01T00:00:00Z',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    blockingReason: 'mergeable',
    checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0,
    checkDigest: `sha${number}:`,
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
  };
}

type ByRepo = Record<string, number[]>;

/** Answers each batched search by its qualifier, keyed by lower-cased repo. */
function mockBatchedSearch(
  answers: { authored?: ByRepo; requested?: ByRepo; reviewed?: ByRepo; direct?: ByRepo },
  complete = true
) {
  return vi
    .spyOn(githubService, 'searchPullRequestNumbersByRepo')
    .mockImplementation(async (_ws: string, q: string) => {
      const pick = q.includes('user-review-requested:')
        ? answers.direct
        : q.includes('reviewed-by:')
          ? answers.reviewed
          : q.includes('review-requested:')
            ? answers.requested
            : answers.authored;
      // Only the repos the query names, as GitHub would.
      const named = new Set([...q.matchAll(/repo:(\S+)/g)].map((m) => m[1].toLowerCase()));
      const byRepo = new Map(Object.entries(pick ?? {}).filter(([k]) => named.has(k)));
      return { byRepo, complete };
    });
}

/** PR numbers of 100 and up are someone else's; the rest are mine. */
function mockGraphql(over: (pr: PRSummary) => Partial<PRSummary> = () => ({})) {
  return vi
    .spyOn(graphqlModule, 'batchPullRequestsByNumber')
    .mockImplementation(async ({ owner, repo, numbers, onChunk }) => {
      const results = numbers.map((n) => {
        const pr = fakeSummary(owner, repo, n, n >= 100 ? 'someone-else' : 'me');
        return { number: n, pr: { ...pr, ...over(pr) } };
      });
      // The real fetch hands each chunk over as it lands; one chunk is enough here.
      if (onChunk) await onChunk(results);
      return results;
    });
}

async function seed(db: Database, repos: Array<{ id: string; fullName: string }>): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
  for (const r of repos) {
    await db.insert(repositoriesTable).values({
      id: r.id,
      workspaceId: 'ws1',
      name: r.fullName,
      url: `https://github.com/${r.fullName}`,
      defaultBranch: 'main',
    });
  }
}

const TWO_REPOS = [
  { id: 'repo1', fullName: 'acme/widgets' },
  { id: 'repo2', fullName: 'acme/gadgets' },
];

describe('prMonitor — batched relationship search', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  async function setup(repos = TWO_REPOS) {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db, repos);
  }

  beforeEach(() => {
    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue(['ws1']);
    vi.spyOn(githubService, 'getUser').mockResolvedValue({
      id: 1,
      login: 'me',
      name: 'Me',
      avatar_url: 'x',
      email: null,
    });
    prMonitorService.invalidateUserLogin('ws1');
    _resetPrFocus();
  });

  afterEach(async () => {
    await cleanup?.();
    vi.restoreAllMocks();
  });

  it('answers every repo from one set of searches and never searches per repo', async () => {
    await setup();
    const batched = mockBatchedSearch({
      authored: { 'acme/widgets': [1], 'acme/gadgets': [2] },
      requested: { 'acme/gadgets': [100] },
    });
    const perRepo = vi.spyOn(githubService, 'searchPullRequestNumbers').mockResolvedValue([]);
    mockGraphql();

    await prMonitorService.forcePoll();

    expect(perRepo).not.toHaveBeenCalled();
    // authored + requested + reviewed; the direct search is not needed here.
    expect(batched).toHaveBeenCalledTimes(3);
    for (const [, q] of batched.mock.calls) {
      expect(q).toContain('repo:acme/widgets');
      expect(q).toContain('repo:acme/gadgets');
    }
    const rows = await db.select().from(pullRequestsTable);
    const byKey = Object.fromEntries(rows.map((r) => [`${r.repositoryId}#${r.number}`, r]));
    expect(Object.keys(byKey).sort()).toEqual(['repo1#1', 'repo2#100', 'repo2#2']);
    expect(byKey['repo1#1'].authored).toBe(true);
    expect(byKey['repo2#2'].authored).toBe(true);
    expect(byKey['repo2#100'].reviewRequested).toBe(true);
    expect(byKey['repo2#100'].authored).toBe(false);
  });

  it('matches a repo whatever casing GitHub reports it in', async () => {
    await setup([
      { id: 'repo1', fullName: 'Acme/Widgets' },
      { id: 'repo2', fullName: 'acme/gadgets' },
    ]);
    mockBatchedSearch({ authored: { 'acme/widgets': [7] } });
    vi.spyOn(githubService, 'searchPullRequestNumbers').mockResolvedValue([]);
    mockGraphql();

    await prMonitorService.forcePoll();

    const rows = await db.select().from(pullRequestsTable);
    expect(rows.map((r) => [r.repositoryId, r.number, r.authored])).toEqual([['repo1', 7, true]]);
  });

  it('runs the direct-request search only for the repos that need it', async () => {
    await setup();
    // #100 in widgets is requested AND already reviewed; gadgets has no overlap.
    const batched = mockBatchedSearch({
      requested: { 'acme/widgets': [100], 'acme/gadgets': [101] },
      reviewed: { 'acme/widgets': [100] },
      direct: { 'acme/widgets': [100] },
    });
    vi.spyOn(githubService, 'searchPullRequestNumbers').mockResolvedValue([]);
    mockGraphql();

    await prMonitorService.forcePoll();

    const directCalls = batched.mock.calls.filter(([, q]) => q.includes('user-review-requested:'));
    expect(directCalls).toHaveLength(1);
    expect(directCalls[0][1]).toContain('repo:acme/widgets');
    expect(directCalls[0][1]).not.toContain('repo:acme/gadgets');
    const rows = await db.select().from(pullRequestsTable);
    const pending = Object.fromEntries(rows.map((r) => [r.number, r.reviewRequested]));
    // Re-requested directly after a review: still owed.
    expect(pending[100]).toBe(true);
    expect(pending[101]).toBe(true);
  });

  it.each([
    ['comes back partial', 'partial'],
    ['throws', 'throws'],
  ])('falls back to per-repo searches when the batched search %s', async (_label, mode) => {
    await setup();
    if (mode === 'partial') {
      mockBatchedSearch({ authored: { 'acme/widgets': [1] } }, false);
    } else {
      vi.spyOn(githubService, 'searchPullRequestNumbersByRepo').mockRejectedValue(new Error('HTTP 414'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    }
    const perRepo = vi
      .spyOn(githubService, 'searchPullRequestNumbers')
      .mockImplementation(async (_ws: string, q: string) =>
        q.includes('author:') && q.includes('repo:acme/widgets') ? [1] : []
      );
    mockGraphql();

    await prMonitorService.forcePoll();

    const searchedRepos = new Set(perRepo.mock.calls.map(([, q]) => /repo:(\S+)/.exec(q)?.[1]));
    expect(searchedRepos).toEqual(new Set(['acme/widgets', 'acme/gadgets']));
    const rows = await db.select().from(pullRequestsTable);
    expect(rows.map((r) => [r.repositoryId, r.number, r.authored])).toEqual([['repo1', 1, true]]);
  });

  it.each([
    // A repo with no results but tracked open rows may be one the App can no
    // longer see: the batched search leaves it out silently. Ask per repo.
    ['has tracked open rows', true, ['acme/gadgets']],
    // Nothing tracked, so nothing a wrong answer could change: no extra search.
    ['has no tracked rows', false, []],
  ])('a repo with no batched results that %s', async (_label, tracked, expected) => {
    await setup();
    if (tracked) {
      await db.insert(pullRequestsTable).values({
        id: 'pr-tracked',
        workspaceId: 'ws1',
        repositoryId: 'repo2',
        owner: 'acme',
        repo: 'gadgets',
        number: 9,
        state: 'open',
        authored: true,
        reviewRequested: false,
        lastPolledAt: new Date(),
        lastSummary: {},
      });
    }
    mockBatchedSearch({ authored: { 'acme/widgets': [1] } });
    const perRepo = vi
      .spyOn(githubService, 'searchPullRequestNumbers')
      .mockImplementation(async (_ws: string, q: string) => (q.includes('author:') ? [9] : []));
    mockGraphql();

    await prMonitorService.forcePoll();

    const searchedRepos = [...new Set(perRepo.mock.calls.map(([, q]) => /repo:(\S+)/.exec(q)?.[1]))];
    expect(searchedRepos).toEqual(expected);
    if (tracked) {
      // The per-repo answer kept the row on Mine instead of clearing the flag.
      const rows = await db.select().from(pullRequestsTable);
      expect(rows.find((r) => r.number === 9)?.authored).toBe(true);
    }
  });

  it('keeps the per-repo searches for a workspace that watches one repo', async () => {
    await setup([{ id: 'repo1', fullName: 'acme/widgets' }]);
    const batched = vi.spyOn(githubService, 'searchPullRequestNumbersByRepo');
    const perRepo = vi.spyOn(githubService, 'searchPullRequestNumbers').mockResolvedValue([]);
    mockGraphql();

    await prMonitorService.forcePoll();

    expect(batched).not.toHaveBeenCalled();
    expect(perRepo).toHaveBeenCalledTimes(3);
  });

  it('logs one timing line per forced poll of a user', async () => {
    await setup();
    mockBatchedSearch({ authored: { 'acme/widgets': [1] } });
    vi.spyOn(githubService, 'searchPullRequestNumbers').mockResolvedValue([]);
    mockGraphql();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await prMonitorService.forcePollForOwner(TEST_USER_ID);

    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('forced poll of workspace'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /: list ready in \d+\.\ds \(1 new PRs\), then refresh took \d+\.\ds \(2 repos, searches \d+\.\ds, slowest: /
    );
  });
});

describe('prMonitor — Refresh puts new PRs on the list first', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db, TWO_REPOS);
    vi.spyOn(githubService, 'getConnectedWorkspaces').mockReturnValue(['ws1']);
    vi.spyOn(githubService, 'getUser').mockResolvedValue({
      id: 1,
      login: 'me',
      name: 'Me',
      avatar_url: 'x',
      email: null,
    });
    vi.spyOn(githubService, 'searchPullRequestNumbers').mockResolvedValue([]);
    prMonitorService.invalidateUserLogin('ws1');
    _resetPrFocus();
  });

  afterEach(async () => {
    await cleanup?.();
    vi.restoreAllMocks();
  });

  async function trackOpen(id: string, repositoryId: string, repo: string, number: number, polledAgoMs: number) {
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: 'ws1',
      repositoryId,
      owner: 'acme',
      repo,
      number,
      state: 'open',
      authored: true,
      reviewRequested: false,
      lastPolledAt: new Date(Date.now() - polledAgoMs),
      lastSummary: {},
    });
  }

  it('answers once the new PRs are written, before the existing ones are refreshed', async () => {
    // #5 is already tracked and stale; #1 and #2 are new.
    await trackOpen('pr-old', 'repo1', 'widgets', 5, 3_600_000);
    mockBatchedSearch({ authored: { 'acme/widgets': [1, 5], 'acme/gadgets': [2] } });
    let releasePass2: () => void = () => {};
    const pass2Gate = new Promise<void>((r) => (releasePass2 = r));
    const fetched: number[][] = [];
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockImplementation(async ({ owner, repo, numbers, onChunk }) => {
      fetched.push([...numbers]);
      // Pass 2 refetches the tracked #5; hold it so the test can look in between.
      if (numbers.includes(5)) await pass2Gate;
      const results = numbers.map((n) => ({ number: n, pr: fakeSummary(owner, repo, n) }));
      if (onChunk) await onChunk(results);
      return results;
    });

    await prMonitorService.forcePollForOwner(TEST_USER_ID, { untilListReady: true });

    const rows = await db.select().from(pullRequestsTable);
    expect(rows.map((r) => r.number).sort()).toEqual([1, 2, 5]);
    // Pass 1 fetched only the new numbers, one repo at a time.
    expect(fetched.slice(0, 2)).toEqual([[1], [2]]);

    releasePass2();
    await vi.waitFor(() => expect(fetched.some((n) => n.includes(5))).toBe(true));
    await prMonitorService.forcePollForOwner(TEST_USER_ID); // waits for the guard, so pass 2 is done
  });

  it('does not hold a Refresh on mergeability GitHub has not computed', async () => {
    mockBatchedSearch({ authored: { 'acme/widgets': [1], 'acme/gadgets': [2] } });
    const graphql = mockGraphql(() => ({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', blockingReason: 'unknown' }));

    await prMonitorService.forcePollForOwner(TEST_USER_ID);

    // One fetch per new PR and no inline retries (the inline loop would re-ask
    // each one 3 times). The deferred settler asks again later.
    expect(graphql.mock.calls.map(([o]) => o.numbers)).toEqual([[1], [2]]);
    const rows = await db.select().from(pullRequestsTable);
    expect(rows.map((r) => r.number).sort()).toEqual([1, 2]);
  });

  it('reports a refresh that reached GitHub for no repo', async () => {
    vi.spyOn(githubService, 'searchPullRequestNumbersByRepo').mockRejectedValue(
      new GitHubRateLimitError('GitHub rate-limited; retry in 240s', 240_000)
    );
    vi.spyOn(githubService, 'searchPullRequestNumbers').mockRejectedValue(
      new GitHubRateLimitError('GitHub rate-limited; retry in 240s', 240_000)
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGraphql();

    const outcome = await prMonitorService.forcePollForOwner(TEST_USER_ID, { untilListReady: true });

    expect(outcome).toEqual({
      repos: 2,
      failedRepos: 2,
      failure: 'GitHub is rate-limiting your account. Try again in about 4 min.',
    });
    await prMonitorService.forcePollForOwner(TEST_USER_ID); // let pass 2 finish
  });

  it('reports a clean refresh', async () => {
    mockBatchedSearch({ authored: { 'acme/widgets': [1] } });
    mockGraphql();

    const outcome = await prMonitorService.forcePollForOwner(TEST_USER_ID, { untilListReady: true });

    expect(outcome).toEqual({ repos: 2, failedRepos: 0, failure: null });
    await prMonitorService.forcePollForOwner(TEST_USER_ID);
  });

  it('still answers when pass 1 fails for a repo, and pass 2 searches it again', async () => {
    mockBatchedSearch({ authored: { 'acme/widgets': [1], 'acme/gadgets': [2] } });
    let failGadgetsOnce = true;
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockImplementation(async ({ owner, repo, numbers, onChunk }) => {
      if (repo === 'gadgets' && failGadgetsOnce) {
        failGadgetsOnce = false;
        throw new Error('HTTP 502');
      }
      const results = numbers.map((n) => ({ number: n, pr: fakeSummary(owner, repo, n) }));
      if (onChunk) await onChunk(results);
      return results;
    });
    const perRepo = vi.spyOn(githubService, 'searchPullRequestNumbers').mockImplementation(
      async (_ws: string, q: string) => (q.includes('author:') && q.includes('repo:acme/gadgets') ? [2] : [])
    );

    await prMonitorService.forcePollForOwner(TEST_USER_ID);

    expect(new Set(perRepo.mock.calls.map(([, q]) => /repo:(\S+)/.exec(q)?.[1]))).toEqual(new Set(['acme/gadgets']));
    const rows = await db.select().from(pullRequestsTable);
    expect(rows.map((r) => r.number).sort()).toEqual([1, 2]);
  });
});

describe('chunkReposForSearch', () => {
  const repo = (i: number) => ({ fullName: `org/repo-${i}` });
  const base = 'is:pr is:open user-review-requested:me';
  const encodedLength = (chunk: Array<{ fullName: string }>) =>
    encodeURIComponent(`${base}${chunk.map((r) => ` repo:${r.fullName}`).join('')}`).length;

  it.each([
    ['no repos', 0, 1_000, 0],
    ['one repo', 1, 1_000, 1],
    ['a handful under the budget', 5, 1_000, 1],
    ['more than one chunk holds', 100, 1_000, 3],
    ['the production budget, 300 repos', 300, BATCH_SEARCH_MAX_QUERY_BYTES, 2],
  ])('%s', (_label, count, maxBytes, expectedChunks) => {
    const repos = Array.from({ length: count }, (_, i) => repo(i));
    const chunks = chunkReposForSearch(base, repos, maxBytes);
    expect(chunks).toHaveLength(expectedChunks);
    // Every repo exactly once, in order.
    expect(chunks.flat()).toEqual(repos);
    for (const chunk of chunks) expect(encodedLength(chunk)).toBeLessThanOrEqual(maxBytes);
  });

  it('still sends a repo too long for the budget, alone', () => {
    const long = { fullName: `org/${'x'.repeat(200)}` };
    const chunks = chunkReposForSearch(base, [repo(1), long, repo(2)], 100);
    expect(chunks).toEqual([[repo(1)], [long], [repo(2)]]);
  });
});

describe('relationship search sets', () => {
  it.each([
    ['nothing', [], [], [], false],
    ['requested, not reviewed', [], [1], [], false],
    ['requested and reviewed', [], [1], [1], true],
    ['my own PR, requested and reviewed', [1], [1], [1], false],
    ['reviewed, not requested', [], [], [1], false],
  ])('needsDirectRequestSearch: %s', (_label, authored, requested, reviewed, expected) => {
    expect(needsDirectRequestSearch(authored, requested, reviewed)).toBe(expected);
  });

  it.each([
    ['a team request with no review is pending', [], [1], [], [], [1]],
    ['a review clears a lingering team request', [], [1], [1], [], []],
    ['a direct re-request after a review is pending', [], [1], [1], [1], [1]],
    ['my own PR is never pending', [1], [1], [], [], []],
    ['a direct request alone is pending', [], [], [], [2], [2]],
  ])('relationshipSearch: %s', (_label, authored, requested, reviewed, direct, pending) => {
    const result = relationshipSearch(authored, requested, reviewed, direct);
    expect([...result.pendingSet].sort()).toEqual(pending);
    expect([...result.authoredSet]).toEqual(authored);
  });
});

describe('repoKeyFromApiUrl', () => {
  it.each([
    ['https://api.github.com/repos/PostHog/posthog', 'posthog/posthog'],
    ['https://api.github.com/repos/acme/widgets/', 'acme/widgets'],
    ['https://github.example.com/api/v3/repos/Org/Repo', 'org/repo'],
    ['https://api.github.com/users/acme', null],
    ['', null],
    [undefined, null],
  ])('%s → %s', (url, expected) => {
    expect(repoKeyFromApiUrl(url)).toBe(expected);
  });
});

describe('searchPullRequestNumbersByRepo', () => {
  afterEach(() => vi.restoreAllMocks());

  type Page = { total_count: number; incomplete_results?: boolean; items: Array<{ number: number; repository_url?: string }> };
  const item = (n: number, repo: string) => ({ number: n, repository_url: `https://api.github.com/repos/${repo}` });
  const stubPages = (pages: Page[]) => {
    const api = githubService as unknown as { apiRequest: (ws: string, path: string) => Promise<Page> };
    return vi.spyOn(api, 'apiRequest').mockImplementation(async (_ws, path) => {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
      return pages[page - 1] ?? { total_count: 0, items: [] };
    });
  };

  it('groups the numbers by lower-cased repo across pages', async () => {
    const full = Array.from({ length: 100 }, (_, i) => item(i + 1, i % 2 ? 'Acme/Widgets' : 'acme/gadgets'));
    const spy = stubPages([{ total_count: 101, items: full }, { total_count: 101, items: [item(500, 'acme/widgets')] }]);

    const { byRepo, complete } = await githubService.searchPullRequestNumbersByRepo('ws-search', 'q');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(complete).toBe(true);
    expect(byRepo.get('acme/widgets')).toHaveLength(51);
    expect(byRepo.get('acme/widgets')).toContain(500);
    expect(byRepo.get('acme/gadgets')).toHaveLength(50);
  });

  it.each<[string, Page]>([
    ['GitHub timed out', { total_count: 1, incomplete_results: true, items: [item(1, 'a/b')] }],
    ['more matches than GitHub returns', { total_count: 1_001, items: [item(1, 'a/b')] }],
    ['an item names no repo', { total_count: 1, items: [{ number: 1 }] }],
  ])('reports incomplete when %s', async (_label, page) => {
    stubPages([page]);
    const { complete } = await githubService.searchPullRequestNumbersByRepo('ws-search', 'q');
    expect(complete).toBe(false);
  });
});

describe('describeForcedPoll', () => {
  it.each([
    [
      'names the three slowest repos',
      { failedRepos: 0, searchMs: 1_200, totalMs: 9_000, repoTimings: [
        { repo: 'a/1', ms: 100 }, { repo: 'a/2', ms: 4_000 }, { repo: 'a/3', ms: 2_500 }, { repo: 'a/4', ms: 900 },
      ] },
      'PR monitor: forced poll of workspace abcdefgh: refresh took 9.0s (4 repos, searches 1.2s, slowest: a/2 4.0s, a/3 2.5s, a/4 0.9s)',
    ],
    [
      'says how many failed',
      { failedRepos: 1, searchMs: 0, totalMs: 500, repoTimings: [{ repo: 'a/1', ms: 500 }] },
      'PR monitor: forced poll of workspace abcdefgh: refresh took 0.5s (1 repos, searches 0.0s, slowest: a/1 0.5s, 1 failed)',
    ],
    [
      'has no repos',
      { failedRepos: 0, searchMs: 0, totalMs: 10, repoTimings: [] },
      'PR monitor: forced poll of workspace abcdefgh: refresh took 0.0s (0 repos, searches 0.0s)',
    ],
  ])('%s', (_label, result, expected) => {
    expect(describeForcedPoll('abcdefgh-1234', result)).toBe(expected);
  });

  it('leads with when the list was ready', () => {
    expect(
      describeForcedPoll(
        'abcdefgh-1234',
        { failedRepos: 0, searchMs: 0, totalMs: 40_000, repoTimings: [{ repo: 'a/1', ms: 40_000 }] },
        { newPrs: 3, ms: 6_500 }
      )
    ).toBe(
      'PR monitor: forced poll of workspace abcdefgh: list ready in 6.5s (3 new PRs), then refresh took 40.0s (1 repos, searches 0.0s, slowest: a/1 40.0s)'
    );
  });
});

describe('describeRefreshFailure', () => {
  it.each<[string, unknown, string]>([
    ['a short rate limit rounds up to a minute', new GitHubRateLimitError('x', 5_000), 'GitHub is rate-limiting your account. Try again in about 1 min.'],
    ['a long rate limit', new GitHubRateLimitError('x', 16 * 60_000 + 1), 'GitHub is rate-limiting your account. Try again in about 17 min.'],
    ['any other error names the repo', new Error('HTTP 502'), 'acme/widgets: HTTP 502'],
    ['a thrown string', 'boom', 'acme/widgets: boom'],
  ])('%s', (_label, error, expected) => {
    expect(describeRefreshFailure({ repo: 'acme/widgets', error })).toBe(expected);
  });
});

describe('refreshOutcome', () => {
  it.each<[string, Array<{ repos: unknown[]; failures: Array<{ repo: string; error: unknown }> }>, ReturnType<typeof refreshOutcome>]>([
    ['no workspaces', [], { repos: 0, failedRepos: 0, failure: null }],
    ['clean', [{ repos: [1, 2], failures: [] }], { repos: 2, failedRepos: 0, failure: null }],
    [
      'failures across workspaces, first one described',
      [
        { repos: [1, 2], failures: [{ repo: 'a/b', error: new Error('HTTP 502') }] },
        { repos: [3], failures: [{ repo: 'c/d', error: new Error('HTTP 504') }] },
      ],
      { repos: 3, failedRepos: 2, failure: 'a/b: HTTP 502' },
    ],
  ])('%s', (_label, discoveries, expected) => {
    expect(refreshOutcome(discoveries)).toEqual(expected);
  });
});
