import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mocked at the module boundary rather than spied on the namespace: prMonitor
// imports `captureWorkspaceEvent` as a direct binding, which `vi.spyOn` cannot
// rebind under ESM.
vi.mock('../services/analytics.js', () => ({
  captureWorkspaceEvent: vi.fn(),
  captureServerEvent: vi.fn(),
  captureSignup: vi.fn(),
  isServerAnalyticsConfigured: () => false,
}));
import { prMonitorService } from '../services/prMonitor.js';
import { githubService } from '../services/github.js';
import * as graphqlModule from '../services/githubGraphql.js';
import * as websocketModule from '../services/websocket.js';
import { _resetPrFocus } from '../services/prFocus.js';
import type { PRSummary } from '../services/githubGraphql.js';
import { reviewRequestedStamps } from '../services/prCache.js';
import { captureWorkspaceEvent } from '../services/analytics.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';

/**
 * `review_requested_first_seen_at` — the honest basis for "how long have I
 * been sitting on this".
 *
 * The whole value of the column is that it is stamped on the TRANSITION and
 * never again. Writing it alongside the flags on every reconcile would compile,
 * pass every other test, and silently make every PR look brand new on every
 * poll — at which point the age signal is identically zero for the entire
 * cohort and the Reviews ordering quietly stops meaning anything. Nothing would
 * fail loudly, which is exactly why it is tested here.
 */

function fakeSummary(over: Partial<PRSummary> = {}): PRSummary {
  return {
    owner: 'acme',
    repo: 'widgets',
    number: 42,
    title: 'Add feature',
    body: '',
    url: 'https://github.com/acme/widgets/pull/42',
    author: 'someone-else',
    draft: false,
    state: 'open',
    mergedAt: null,
    closedAt: null,
    headBranch: 'feature/x',
    baseBranch: 'main',
    headSha: 'sha1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    blockingReason: 'mergeable',
    checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0,
    checkDigest: 'sha1:',
    recentReviews: [],
    recentReviewComments: [],
    recentComments: [],
    checkContexts: [],
    ...over,
  } as PRSummary;
}

function mockSearch(authored: number[], reviewRequested: number[] = [], reviewedBy: number[] = []) {
  return vi
    .spyOn(githubService, 'searchPullRequestNumbers')
    .mockImplementation(async (_ws: string, q: string) => {
      if (q.includes('reviewed-by:')) return reviewedBy;
      if (q.includes('review-requested:')) return reviewRequested;
      if (q.includes('author:')) return authored;
      return [];
    });
}

describe('review_requested_first_seen_at', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'ws',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'acme/widgets',
      url: 'https://github.com/acme/widgets',
      defaultBranch: 'main',
    });

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
    vi.mocked(captureWorkspaceEvent).mockClear();
    vi.spyOn(graphqlModule, 'batchPullRequestsByNumber').mockResolvedValue([
      { number: 9, pr: fakeSummary({ number: 9 }) },
    ]);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  async function seedRow(over: Record<string, unknown> = {}) {
    await db.insert(pullRequestsTable).values({
      id: 'pr-9',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'acme',
      repo: 'widgets',
      number: 9,
      state: 'open',
      authored: false,
      reviewRequested: false,
      lastPolledAt: new Date(Date.now() - 6 * 60_000),
      lastSummary: { headBranch: 'feature/x' },
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });
  }

  const readRow = async () =>
    (await db.select().from(pullRequestsTable)).find((r) => r.number === 9);

  it('stamps the instant a PR ENTERS the review-requested cohort', async () => {
    await seedRow();
    mockSearch([], [9]);

    await prMonitorService.forcePoll();

    const row = await readRow();
    expect(row?.reviewRequested).toBe(true);
    expect(row?.reviewRequestedFirstSeenAt).toBeInstanceOf(Date);
    expect(row?.reviewRequestedClearedAt).toBeNull();
  });

  it('does NOT bump the stamp on a true → true tick', async () => {
    // The bug this file exists for. Two polls, both finding the PR still
    // requested: the second must leave the first's answer alone, or "waited
    // three days" resets to zero every thirty seconds.
    const stamped = new Date(Date.now() - 72 * 3_600_000);
    await seedRow({ reviewRequested: true, reviewRequestedFirstSeenAt: stamped });
    mockSearch([], [9]);

    await prMonitorService.forcePoll();
    await prMonitorService.forcePoll();

    const row = await readRow();
    expect(row?.reviewRequested).toBe(true);
    expect(row?.reviewRequestedFirstSeenAt?.getTime()).toBe(stamped.getTime());
  });

  it('does not bump the stamp when only the AUTHORED flag changes', async () => {
    // A different reconcile path through the same UPDATE. The `authored` flip
    // is a real change, so the row IS written — and the timestamp must still
    // survive it untouched.
    const stamped = new Date(Date.now() - 48 * 3_600_000);
    await seedRow({ reviewRequested: true, authored: false, reviewRequestedFirstSeenAt: stamped });
    mockSearch([9], [9]);

    await prMonitorService.forcePoll();

    const row = await readRow();
    expect(row?.authored).toBe(true);
    expect(row?.reviewRequestedFirstSeenAt?.getTime()).toBe(stamped.getTime());
  });

  it('stamps cleared_at when the viewer reviews it and the PR leaves the cohort', async () => {
    // The only record that the review happened at all: most reviews are
    // submitted on github.com, so nothing else in the app observes one.
    await seedRow({
      reviewRequested: true,
      reviewRequestedFirstSeenAt: new Date(Date.now() - 5 * 3_600_000),
    });
    // Requested AND reviewed-by → the monitor subtracts it out of the cohort.
    mockSearch([], [9], [9]);

    await prMonitorService.forcePoll();

    const row = await readRow();
    expect(row?.reviewRequested).toBe(false);
    expect(row?.reviewRequestedClearedAt).toBeInstanceOf(Date);
  });

  it('clears a stale cleared_at when the PR is requested again', async () => {
    // A re-request is a live question. Leaving the previous answer attached
    // would read as "already reviewed" on a review that is outstanding.
    await seedRow({
      reviewRequested: false,
      reviewRequestedFirstSeenAt: new Date(Date.now() - 100 * 3_600_000),
      reviewRequestedClearedAt: new Date(Date.now() - 90 * 3_600_000),
    });
    mockSearch([], [9]);

    await prMonitorService.forcePoll();

    const row = await readRow();
    expect(row?.reviewRequested).toBe(true);
    expect(row?.reviewRequestedClearedAt).toBeNull();
    // And the stamp is refreshed — this is a NEW wait, not a resumption of the
    // old one.
    expect(row!.reviewRequestedFirstSeenAt!.getTime()).toBeGreaterThan(
      Date.now() - 60_000
    );
  });

  it('broadcasts the stamp with the transition, so the age is right immediately', async () => {
    // A freshly-requested PR is precisely the case the age term exists to get
    // right, so it must not wait for the next full list refresh to learn when
    // it arrived.
    const emit = vi.spyOn(websocketModule, 'emitPullRequestUpdated');
    await seedRow();
    mockSearch([], [9]);

    await prMonitorService.forcePoll();

    const call = emit.mock.calls
      .map((c) => c[1])
      .find((p) => p.number === 9 && p.reviewRequested === true);
    expect(call?.reviewRequestedFirstSeenAt).toEqual(expect.any(String));
  });

  it('reports how long a review was owed when the PR leaves the cohort', async () => {
    // Nothing else in the app sees a review happen: almost all of them are
    // submitted on github.com. This transition is the only sighting, and
    // without it "did the ordering help" has no answer at all.
    await seedRow({
      reviewRequested: true,
      reviewRequestedFirstSeenAt: new Date(Date.now() - 30 * 3_600_000),
    });
    mockSearch([], [9], [9]);

    await prMonitorService.forcePoll();

    const call = vi
      .mocked(captureWorkspaceEvent)
      .mock.calls.find((c) => c[1] === 'pr_review_submitted');
    expect(call?.[2]).toMatchObject({ repo: 'acme/widgets', pr_number: 9 });
    expect(call?.[2]?.hours_in_cohort as number).toBeCloseTo(30, 0);
  });

  it('says nothing when the PR was never recorded as entering the cohort', async () => {
    // No entry stamp means no elapsed time to report, and inventing one from
    // the PR's open date would claim a wait that never happened.
    await seedRow({ reviewRequested: true, reviewRequestedFirstSeenAt: null });
    mockSearch([], [9], [9]);

    await prMonitorService.forcePoll();

    expect(
      vi.mocked(captureWorkspaceEvent).mock.calls.find((c) => c[1] === 'pr_review_submitted'),
    ).toBeUndefined();
  });

  it('says nothing when the PR merely stays in the cohort', async () => {
    await seedRow({
      reviewRequested: true,
      reviewRequestedFirstSeenAt: new Date(Date.now() - 5 * 3_600_000),
    });
    mockSearch([], [9]);

    await prMonitorService.forcePoll();

    expect(
      vi.mocked(captureWorkspaceEvent).mock.calls.find((c) => c[1] === 'pr_review_submitted'),
    ).toBeUndefined();
  });

  it('omits the stamp from an emit that did not touch it', async () => {
    // `??`-preserved on the client, so restating it would be harmless — but an
    // emit claiming a field it did not write is how the next emitter learns the
    // wrong habit.
    const emit = vi.spyOn(websocketModule, 'emitPullRequestUpdated');
    await seedRow({
      reviewRequested: true,
      reviewRequestedFirstSeenAt: new Date(Date.now() - 10 * 3_600_000),
    });
    mockSearch([9], [9]);

    await prMonitorService.forcePoll();

    const call = emit.mock.calls
      .map((c) => c[1])
      .find((p) => p.number === 9 && p.authored === true);
    expect(call?.reviewRequestedFirstSeenAt).toBeUndefined();
  });
});

describe('reviewRequestedStamps — the shared rule', () => {
  const now = new Date('2026-09-20T12:00:00Z');

  it('stamps nothing when the flag did not move', () => {
    expect(reviewRequestedStamps(true, true, now)).toEqual({});
    expect(reviewRequestedStamps(false, false, now)).toEqual({});
  });

  it('stamps nothing when either side is unknown', () => {
    // An absent flag means "this caller does not know the relationship" — the
    // detail refresh and the merge path both leave it alone — and guessing a
    // transition from "unknown" would stamp a PR on every manual refresh.
    expect(reviewRequestedStamps(undefined, true, now)).toEqual({});
    expect(reviewRequestedStamps(true, undefined, now)).toEqual({});
  });

  it('stamps entry, and clears any superseded answer with it', () => {
    expect(reviewRequestedStamps(false, true, now)).toEqual({
      reviewRequestedFirstSeenAt: now,
      reviewRequestedClearedAt: null,
    });
  });

  it('stamps exit without touching the entry instant', () => {
    expect(reviewRequestedStamps(true, false, now)).toEqual({
      reviewRequestedClearedAt: now,
    });
  });
});
