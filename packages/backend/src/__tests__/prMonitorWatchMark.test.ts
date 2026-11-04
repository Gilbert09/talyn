import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prMonitorService } from '../services/prMonitor.js';
import * as graphqlModule from '../services/githubGraphql.js';
import type { PRSummary } from '../services/githubGraphql.js';
import * as websocketModule from '../services/websocket.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces, repositories, pullRequests } from '../db/schema.js';

const repo = {
  id: 'repo1',
  workspaceId: 'ws1',
  owner: 'acme',
  repo: 'widgets',
  fullName: 'acme/widgets',
  defaultBranch: 'main',
};

function summary(): PRSummary {
  return {
    owner: 'acme', repo: 'widgets', number: 42, title: 't', body: '', changedFiles: 1,
    url: 'https://github.com/acme/widgets/pull/42', author: 'me', draft: false, state: 'open',
    mergedAt: null, closedAt: null, headBranch: 'f', baseBranch: 'main', headSha: 's1',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN', reviewDecision: null, blockingReason: 'mergeable',
    checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 }, unresolvedReviewThreads: 0,
    checkDigest: 's1:', recentReviews: [], recentReviewComments: [], recentComments: [],
  } as PRSummary;
}

describe('watchPullRequest markWatching', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let emitted: Array<Record<string, unknown>>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspaces).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await db.insert(repositories).values({
      id: 'repo1', workspaceId: 'ws1', name: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranch: 'main',
    });
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 42, pr: summary() },
    ] as never);
    vi.spyOn(prMonitorService as never, 'annotateReviewRequest').mockResolvedValue(undefined as never);
    vi.spyOn(prMonitorService as never, 'resolveCurrentUser').mockResolvedValue('me' as never);
    emitted = [];
    vi.spyOn(websocketModule, 'emitPullRequestUpdated').mockImplementation(((_ws: string, p: Record<string, unknown>) => {
      emitted.push(p);
    }) as never);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  const watchedFlag = async () => (await db.select().from(pullRequests))[0]?.watching;

  it('marks the row watched by default', async () => {
    const res = await prMonitorService.watchPullRequest({ workspaceId: 'ws1', repo, number: 42 });
    expect(res.ok).toBe(true);
    expect(await watchedFlag()).toBe(true);
    expect(emitted.some((e) => e.watching === true)).toBe(true);
  });

  it('holds the row without the mark when markWatching is false', async () => {
    const res = await prMonitorService.watchPullRequest({ workspaceId: 'ws1', repo, number: 42, markWatching: false });
    expect(res.ok).toBe(true);
    expect(await watchedFlag()).toBe(false);
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.some((e) => e.watching !== undefined)).toBe(false);
  });

  it('keeps a mark a person already set', async () => {
    await prMonitorService.watchPullRequest({ workspaceId: 'ws1', repo, number: 42 });
    const res = await prMonitorService.watchPullRequest({ workspaceId: 'ws1', repo, number: 42, markWatching: false });
    expect(res).toMatchObject({ ok: true, alreadyTracked: true });
    expect(await watchedFlag()).toBe(true);
  });
});
