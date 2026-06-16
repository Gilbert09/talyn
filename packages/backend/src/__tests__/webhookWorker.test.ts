import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isRefreshEvent,
  extractPrNumbers,
  processWebhookDelivery,
  _resetCoalesce,
  type WebhookDelivery,
} from '../services/webhookWorker.js';
import { refreshWebhookIndex, _resetWebhookIndex } from '../services/webhookIndex.js';
import { prMonitorService } from '../services/prMonitor.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';

function delivery(over: Partial<WebhookDelivery>): WebhookDelivery {
  return {
    deliveryId: 'd1',
    eventType: 'pull_request',
    repoFullName: 'acme/widget',
    enqueuedAtMs: 0,
    payload: {},
    ...over,
  };
}

describe('webhook classification helpers', () => {
  it('flags PR-affecting events as refresh events', () => {
    for (const e of [
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'issue_comment',
      'check_run',
      'check_suite',
    ]) {
      expect(isRefreshEvent(e)).toBe(true);
    }
    for (const e of ['installation', 'status', 'push', 'ping']) {
      expect(isRefreshEvent(e)).toBe(false);
    }
  });

  it('extracts PR numbers per event shape', () => {
    expect(extractPrNumbers('pull_request', { pull_request: { number: 7 } })).toEqual([7]);
    expect(extractPrNumbers('pull_request', { number: 9 })).toEqual([9]);
    expect(extractPrNumbers('pull_request_review', { pull_request: { number: 3 } })).toEqual([3]);
    expect(
      extractPrNumbers('pull_request_review_comment', { pull_request: { number: 4 } }),
    ).toEqual([4]);
    expect(
      extractPrNumbers('check_run', { check_run: { pull_requests: [{ number: 1 }, { number: 2 }] } }),
    ).toEqual([1, 2]);
    expect(
      extractPrNumbers('check_suite', { check_suite: { pull_requests: [{ number: 5 }] } }),
    ).toEqual([5]);
  });

  it('only treats issue_comment as a PR when issue.pull_request is present', () => {
    expect(extractPrNumbers('issue_comment', { issue: { number: 8, pull_request: {} } })).toEqual([8]);
    expect(extractPrNumbers('issue_comment', { issue: { number: 8 } })).toEqual([]);
  });

  it('returns no numbers for commit-scoped status events', () => {
    expect(extractPrNumbers('status', { sha: 'abc', state: 'success' })).toEqual([]);
  });

  // A faithful subset of the real `pull_request` / action=closed (merged)
  // delivery for PostHog/posthog#64026 (only the fields our pipeline reads,
  // plus a few documenting ones). Guards against a regression in how a merge
  // delivery is classified.
  it('classifies a real merged-PR (action=closed) delivery as a single-PR refresh', () => {
    const payload = {
      action: 'closed',
      number: 64026,
      pull_request: {
        number: 64026,
        state: 'closed',
        merged: true,
        merged_at: '2026-06-16T20:47:18Z',
        user: { login: 'Gilbert09' },
        base: { ref: 'master' },
        html_url: 'https://github.com/PostHog/posthog/pull/64026',
      },
      repository: { full_name: 'PostHog/posthog', name: 'posthog', owner: { login: 'PostHog' } },
      installation: { id: 140694558 },
    };
    expect(isRefreshEvent('pull_request')).toBe(true);
    expect(extractPrNumbers('pull_request', payload)).toEqual([64026]);
  });
});

describe('processWebhookDelivery (fan-out + coalescing)', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let refreshSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    // Two workspaces watching the SAME repo → one event fans to both.
    await db.insert(workspacesTable).values([
      { id: 'wsA', ownerId: TEST_USER_ID, name: 'A', settings: {} },
      { id: 'wsB', ownerId: TEST_USER_ID, name: 'B', settings: {} },
    ]);
    await db.insert(repositoriesTable).values([
      { id: 'rA', workspaceId: 'wsA', name: 'acme/widget', url: 'https://github.com/acme/widget', defaultBranch: 'main', createdAt: new Date() },
      { id: 'rB', workspaceId: 'wsB', name: 'acme/widget', url: 'https://github.com/acme/widget', defaultBranch: 'main', createdAt: new Date() },
    ]);
    _resetWebhookIndex();
    await refreshWebhookIndex();
    _resetCoalesce();
    // Stub the actual refresh so we assert dispatch without hitting GitHub.
    refreshSpy = vi.spyOn(prMonitorService, 'refreshPr').mockResolvedValue(undefined);
  });

  // A tracked open PR row, so check events for it survive the filterTrackedOpen
  // pre-filter (check events only refresh PRs we already track).
  async function seedTrackedPr(repositoryId: string, workspaceId: string, number: number) {
    await db.insert(pullRequestsTable).values({
      id: `pr-${repositoryId}-${number}`,
      workspaceId,
      repositoryId,
      owner: 'acme',
      repo: 'widget',
      number,
      state: 'open',
    });
  }
  // refreshPr opts the webhook fan-out always passes: the index-resolved repo id
  // (skips getWatchedRepos) + resolveMergeable:false (never block the consumer).
  const opts = (repositoryId: string) => ({ repositoryId, resolveMergeable: false });

  afterEach(async () => {
    _resetWebhookIndex();
    _resetCoalesce();
    await cleanup();
    vi.restoreAllMocks();
  });

  it('fans one PR event out to every workspace watching the repo', async () => {
    const n = await processWebhookDelivery(
      delivery({ payload: { pull_request: { number: 7 } } }),
      1_000,
    );
    expect(n).toBe(2);
    // pull_request is not a check event → not pre-filtered; webhook always passes
    // the index-resolved repositoryId + resolveMergeable:false.
    expect(refreshSpy).toHaveBeenCalledWith('wsA', 'acme', 'widget', 7, opts('rA'));
    expect(refreshSpy).toHaveBeenCalledWith('wsB', 'acme', 'widget', 7, opts('rB'));
  });

  it('refreshes a check event only for PRs the workspace already tracks', async () => {
    // A single check_run lists a tracked PR (7) and an untracked one (8). The
    // filterTrackedOpen pre-filter must drop 8 (no fetch) and dispatch only 7.
    await seedTrackedPr('rA', 'wsA', 7);
    const n = await processWebhookDelivery(
      delivery({
        eventType: 'check_run',
        payload: { check_run: { pull_requests: [{ number: 7 }, { number: 8 }] } },
      }),
      1_000,
    );
    // Only wsA tracks #7; wsB tracks neither.
    expect(n).toBe(1);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).toHaveBeenCalledWith('wsA', 'acme', 'widget', 7, opts('rA'));
    expect(refreshSpy).not.toHaveBeenCalledWith('wsA', 'acme', 'widget', 8, opts('rA'));
  });

  it('dispatches the real PostHog/posthog#64026 merge delivery to refreshPr', async () => {
    // End-to-end on the actual webhook envelope: a watched repo + the real
    // merged-PR payload must fan out to refreshPr(workspace, owner, repo, 64026).
    // Mirrors the prod path that wasn't firing — proves classification + repo
    // resolution + dispatch are correct for this exact delivery.
    await db.insert(workspacesTable).values({
      id: 'wsPH',
      ownerId: TEST_USER_ID,
      name: 'PostHog',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'rPH',
      workspaceId: 'wsPH',
      name: 'PostHog/posthog',
      url: 'https://github.com/PostHog/posthog',
      defaultBranch: 'master',
      createdAt: new Date(),
    });
    _resetWebhookIndex();
    await refreshWebhookIndex();

    const n = await processWebhookDelivery(
      delivery({
        deliveryId: '0a4c1f00-real',
        eventType: 'pull_request',
        repoFullName: 'PostHog/posthog',
        payload: {
          action: 'closed',
          number: 64026,
          pull_request: {
            number: 64026,
            state: 'closed',
            merged: true,
            user: { login: 'Gilbert09' },
            base: { ref: 'master' },
          },
          repository: { full_name: 'PostHog/posthog', name: 'posthog', owner: { login: 'PostHog' } },
          installation: { id: 140694558 },
        },
      }),
      5_000,
    );

    expect(n).toBe(1);
    expect(refreshSpy).toHaveBeenCalledWith('wsPH', 'PostHog', 'posthog', 64026, opts('rPH'));
  });

  it('coalesces a burst for the same (workspace, PR) within the window', async () => {
    // PR 7 is tracked in both workspaces so the follow-up check_run survives the
    // tracked-only filter and actually exercises the coalescing window.
    await seedTrackedPr('rA', 'wsA', 7);
    await seedTrackedPr('rB', 'wsB', 7);
    await processWebhookDelivery(delivery({ payload: { pull_request: { number: 7 } } }), 1_000);
    refreshSpy.mockClear();
    // Same PR, 100ms later — inside the 750ms window → dropped.
    const n = await processWebhookDelivery(
      delivery({ eventType: 'check_run', payload: { check_run: { pull_requests: [{ number: 7 }] } } }),
      1_100,
    );
    expect(n).toBe(0);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('refreshes again once the coalescing window has elapsed', async () => {
    await processWebhookDelivery(delivery({ payload: { pull_request: { number: 7 } } }), 1_000);
    refreshSpy.mockClear();
    const n = await processWebhookDelivery(
      delivery({ payload: { pull_request: { number: 7 } } }),
      2_000, // > 750ms later
    );
    expect(n).toBe(2);
    expect(refreshSpy).toHaveBeenCalledTimes(2);
  });

  it('drops events for a repo nobody watches', async () => {
    const n = await processWebhookDelivery(
      delivery({ repoFullName: 'someone/else', payload: { pull_request: { number: 1 } } }),
      1_000,
    );
    expect(n).toBe(0);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does not refresh on installation events (index maintenance only)', async () => {
    const n = await processWebhookDelivery(
      delivery({ eventType: 'installation', repoFullName: '', payload: { action: 'created' } }),
      1_000,
    );
    expect(n).toBe(0);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('on a push to a branch, refreshes every open PR based on that branch (per workspace)', async () => {
    // wsA has 2 open PRs based on `main`, wsB has 1.
    const baseSpy = vi
      .spyOn(prMonitorService, 'openPrNumbersForBase')
      .mockImplementation(async (workspaceId) => (workspaceId === 'wsA' ? [3, 4] : [9]));

    const n = await processWebhookDelivery(
      delivery({ eventType: 'push', payload: { ref: 'refs/heads/main' } }),
      1_000,
    );

    expect(baseSpy).toHaveBeenCalledWith('wsA', 'rA', 'main');
    expect(baseSpy).toHaveBeenCalledWith('wsB', 'rB', 'main');
    expect(n).toBe(3); // 2 (wsA) + 1 (wsB)
    // push is not a check event → not pre-filtered; passes the index repo id.
    expect(refreshSpy).toHaveBeenCalledWith('wsA', 'acme', 'widget', 3, opts('rA'));
    expect(refreshSpy).toHaveBeenCalledWith('wsA', 'acme', 'widget', 4, opts('rA'));
    expect(refreshSpy).toHaveBeenCalledWith('wsB', 'acme', 'widget', 9, opts('rB'));
  });

  it('ignores a push to a non-branch ref (tags etc.)', async () => {
    const baseSpy = vi.spyOn(prMonitorService, 'openPrNumbersForBase');
    const n = await processWebhookDelivery(
      delivery({ eventType: 'push', payload: { ref: 'refs/tags/v1.0.0' } }),
      1_000,
    );
    expect(n).toBe(0);
    expect(baseSpy).not.toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
