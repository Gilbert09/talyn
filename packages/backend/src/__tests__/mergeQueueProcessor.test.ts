import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mergeQueueProcessor } from '../services/mergeQueueProcessor.js';
import { githubService } from '../services/github.js';
import { prMonitorService } from '../services/prMonitor.js';
import * as websocketModule from '../services/websocket.js';
import {
  broadcastMergeQueuePositions,
  computeQueuePositions,
} from '../services/mergeQueueBroadcast.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  tasks as tasksTable,
} from '../db/schema.js';

/**
 * Exercises the merge-queue processor against a real (pglite) DB: it merges a
 * group's head when it's clean, fires the shared "get mergeable" cloud run on
 * conflict / behind / blocked, serializes same-base PRs one-at-a-time, and
 * drops merged PRs off the queue.
 */

const OWNER = 'user-mq';
const OWNER2 = 'user-mq-noenv';

/** Conflicting summary — trips prNeedsFollowup. */
function conflictSummary(base = 'main') {
  return {
    title: 'PR title',
    author: 'me',
    draft: false,
    headBranch: 'feat',
    baseBranch: base,
    headSha: 'abc',
    url: 'https://github.com/a/b/pull/1',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    reviewDecision: null,
    blockingReason: 'merge_conflicts',
    checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    unresolvedReviewThreads: 0,
  };
}

/** Clean, mergeable, up-to-date. */
function cleanSummary(base = 'main') {
  return {
    ...conflictSummary(base),
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    blockingReason: 'mergeable',
  };
}

/**
 * Mergeable but behind the base — the post-merge race state. Passes
 * prNeedsFollowup (nothing to "fix") but must still funnel into the fix path
 * via `needsUpdate`.
 */
function behindSummary(base = 'main') {
  return {
    ...cleanSummary(base),
    mergeStateStatus: 'BEHIND',
  };
}

async function seedBase(db: Database): Promise<void> {
  await seedUser(db, { id: OWNER });
  await db.insert(workspacesTable).values({ id: 'ws1', ownerId: OWNER, name: 'ws', settings: {} });
  await db.insert(environmentsTable).values({
    id: 'cloud1',
    ownerId: OWNER,
    name: 'PostHog Code',
    type: 'posthog_code',
    status: 'connected',
    config: { type: 'posthog_code' },
  });
  await db.insert(repositoriesTable).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: 'a/b',
    url: 'https://github.com/a/b',
    defaultBranch: 'main',
  });
}

let prCounter = 0;
async function insertPr(
  db: Database,
  overrides: {
    summary?: Record<string, unknown>;
    mergeQueued?: boolean;
    mergeQueuedAt?: Date;
    mergeQueueState?: unknown;
    mergeMethod?: string;
    taskId?: string | null;
    state?: string;
    workspaceId?: string;
    repositoryId?: string;
  } = {}
): Promise<string> {
  const id = `pr-${++prCounter}`;
  await db.insert(pullRequestsTable).values({
    id,
    workspaceId: overrides.workspaceId ?? 'ws1',
    repositoryId: overrides.repositoryId ?? 'repo1',
    taskId: overrides.taskId ?? null,
    owner: 'a',
    repo: 'b',
    number: prCounter,
    state: overrides.state ?? 'open',
    mergeQueued: overrides.mergeQueued ?? true,
    mergeQueuedAt: overrides.mergeQueuedAt ?? new Date(),
    mergeMethod: overrides.mergeMethod ?? 'squash',
    mergeQueueState: overrides.mergeQueueState ?? { status: 'waiting', attempts: 0, accounted: true },
    // Recent so the processor's freshness refresh (a live GitHub poll) is skipped.
    lastPolledAt: new Date(),
    lastSummary: overrides.summary ?? cleanSummary(),
  });
  return id;
}

async function insertTask(db: Database, id: string, status: string, prId: string): Promise<void> {
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'pr_response',
    status,
    priority: 'medium',
    title: 't',
    description: 'd',
    repositoryId: 'repo1',
    assignedEnvironmentId: 'cloud1',
    metadata: { pullRequest: { id: prId, number: 1, url: '', createdAt: '' } },
  });
}

async function countTasks(db: Database): Promise<number> {
  const rows = await db.select({ id: tasksTable.id }).from(tasksTable);
  return rows.length;
}

async function getPr(db: Database, id: string) {
  const rows = await db
    .select()
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, id))
    .limit(1);
  return rows[0];
}

type QueueState = {
  status: string;
  attempts: number;
  lastFixTaskId?: string;
  accounted?: boolean;
  lastError?: string;
};

describe('mergeQueueProcessor', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let mergeSpy: ReturnType<typeof vi.spyOn>;
  let refreshSpy: ReturnType<typeof vi.spyOn>;
  let blockedSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    prCounter = 0;
    await seedBase(db);
    mergeSpy = vi
      .spyOn(githubService, 'mergePullRequest')
      .mockResolvedValue({ sha: 'merged-sha', merged: true, message: 'ok' });
    // Stub the post-failure refetch so it doesn't hit GitHub; tests assert it
    // fires. The top-of-tick freshness refresh is skipped (fresh lastPolledAt).
    refreshSpy = vi.spyOn(prMonitorService, 'refreshPr').mockResolvedValue(undefined);
    // The one-time "PR blocked" broadcast — tests assert it fires once on the
    // transition and never on a re-tick while already blocked.
    blockedSpy = vi.spyOn(websocketModule, 'emitMergeQueueBlocked').mockImplementation(() => {});
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it('merges a clean queued PR and drops it off the queue', async () => {
    const prId = await insertPr(db, { summary: cleanSummary() });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(await countTasks(db)).toBe(0); // no cloud fix run needed
    const pr = await getPr(db, prId);
    expect(pr.state).toBe('merged');
    expect(pr.mergeQueued).toBe(false);
    expect(pr.mergeQueueState).toBeNull();
    expect(pr.mergedAt).toBeTruthy();
  });

  it('merges with the configured merge method', async () => {
    await insertPr(db, { summary: cleanSummary(), mergeMethod: 'merge' });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledWith('ws1', 'a', 'b', expect.any(Number), {
      merge_method: 'merge',
    });
  });

  it('fires a cloud fix run for a conflicting PR instead of merging', async () => {
    const prId = await insertPr(db, { summary: conflictSummary() });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).not.toHaveBeenCalled();
    const tasks = await db.select().from(tasksTable);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('pr_response');
    const pr = await getPr(db, prId);
    const state = pr.mergeQueueState as QueueState;
    expect(state.status).toBe('fixing');
    expect(state.lastFixTaskId).toBe(tasks[0].id);
    expect(state.accounted).toBe(false);
    expect(pr.taskId).toBe(tasks[0].id); // reverse-linked
  });

  it('funnels a BEHIND PR into the same fix path (the post-merge race)', async () => {
    await insertPr(db, { summary: behindSummary() });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).not.toHaveBeenCalled(); // would bounce with merged:false
    expect(await countTasks(db)).toBe(1);
  });

  it('does not fire or merge while a fix run is in flight', async () => {
    const prId = await insertPr(db, { summary: conflictSummary() });
    await insertTask(db, 'running', 'in_progress', prId);
    await db.update(pullRequestsTable).set({ taskId: 'running' }).where(eq(pullRequestsTable.id, prId));

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).not.toHaveBeenCalled();
    expect(await countTasks(db)).toBe(1); // only the pre-existing run
    const pr = await getPr(db, prId);
    expect((pr.mergeQueueState as QueueState).status).toBe('fixing');
  });

  it('serializes two same-base PRs — only the head merges per tick', async () => {
    const first = await insertPr(db, {
      summary: cleanSummary('main'),
      mergeQueuedAt: new Date('2026-06-01T00:00:00Z'),
    });
    const second = await insertPr(db, {
      summary: cleanSummary('main'),
      mergeQueuedAt: new Date('2026-06-01T00:01:00Z'),
    });

    await mergeQueueProcessor.runOnce();

    // Exactly one merge — the earlier-queued head.
    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect((await getPr(db, first)).state).toBe('merged');
    const secondRow = await getPr(db, second);
    expect(secondRow.state).toBe('open');
    expect(secondRow.mergeQueued).toBe(true);

    // Next tick: the second is now the head and merges.
    await mergeQueueProcessor.runOnce();
    expect(mergeSpy).toHaveBeenCalledTimes(2);
    expect((await getPr(db, second)).state).toBe('merged');
  });

  it('merges different-base PRs in parallel within one tick', async () => {
    const a = await insertPr(db, { summary: cleanSummary('main') });
    const b = await insertPr(db, { summary: cleanSummary('develop') });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledTimes(2);
    expect((await getPr(db, a)).state).toBe('merged');
    expect((await getPr(db, b)).state).toBe('merged');
  });

  it('blocks after MAX_ATTEMPTS consecutive failed fix runs and notifies once with the reason', async () => {
    const prId = await insertPr(db, {
      summary: conflictSummary(),
      mergeQueueState: { status: 'fixing', attempts: 2, lastFixTaskId: 'prev', accounted: false },
    });
    await insertTask(db, 'prev', 'completed', prId);
    await db.update(pullRequestsTable).set({ taskId: 'prev' }).where(eq(pullRequestsTable.id, prId));

    await mergeQueueProcessor.runOnce();

    const pr = await getPr(db, prId);
    const state = pr.mergeQueueState as QueueState;
    expect(state.attempts).toBe(3);
    expect(state.status).toBe('blocked');
    expect(mergeSpy).not.toHaveBeenCalled();
    expect(await countTasks(db)).toBe(1); // only 'prev' — no new run

    // Fired the one-time blocked notification with the human reason.
    expect(blockedSpy).toHaveBeenCalledTimes(1);
    expect(blockedSpy).toHaveBeenCalledWith(
      'ws1',
      expect.objectContaining({
        pullRequestId: prId,
        number: expect.any(Number),
        reason: 'merge conflicts with the base branch',
        attempts: 3,
      })
    );
  });

  it('does not re-notify on a re-tick while already blocked', async () => {
    // Already blocked (the transition happened on a prior tick), still conflicting.
    const prId = await insertPr(db, {
      summary: conflictSummary(),
      mergeQueueState: {
        status: 'blocked',
        attempts: 3,
        accounted: true,
        blockReason: 'merge conflicts with the base branch',
      },
    });

    await mergeQueueProcessor.runOnce();

    expect((await getPr(db, prId)).mergeQueueState).toMatchObject({ status: 'blocked' });
    expect(blockedSpy).not.toHaveBeenCalled(); // no fresh transition → no ping
  });

  it('surfaces the blocked reason on the persisted state (for the badge tooltip)', async () => {
    const prId = await insertPr(db, {
      summary: conflictSummary(),
      mergeQueueState: { status: 'fixing', attempts: 2, lastFixTaskId: 'prev', accounted: false },
    });
    await insertTask(db, 'prev', 'completed', prId);
    await db.update(pullRequestsTable).set({ taskId: 'prev' }).where(eq(pullRequestsTable.id, prId));

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState & { blockReason?: string };
    expect(state.blockReason).toBe('merge conflicts with the base branch');
  });

  it('does not reset the attempt counter on a transient clean reading (cap-evasion)', async () => {
    // Mid-loop: 2 runs already spent, the last one terminal. The cached summary
    // momentarily reads CLEAN (the post-push UNKNOWN window) but the merge then
    // bounces — the PR isn't really fixed. The counter must NOT reset to 0, or
    // the 3-attempt cap would never trip and the queue fires fix runs forever.
    mergeSpy.mockResolvedValueOnce({ sha: '', merged: false, message: 'still conflicting' });
    const prId = await insertPr(db, {
      summary: cleanSummary(),
      mergeQueueState: { status: 'fixing', attempts: 2, lastFixTaskId: 'prev', accounted: false },
    });
    await insertTask(db, 'prev', 'completed', prId);

    await mergeQueueProcessor.runOnce();

    const state = (await getPr(db, prId)).mergeQueueState as QueueState;
    expect(state.attempts).toBe(2); // held — NOT reset to 0
  });

  it('never fires past the retry budget, even after a failed-merge flap downgraded the status', async () => {
    // Budget already spent (attempts == MAX) but status was knocked back to
    // 'waiting' by an earlier failed merge on a transient clean reading. The
    // hard cap must re-settle it to 'blocked' and fire nothing.
    const prId = await insertPr(db, {
      summary: conflictSummary(),
      mergeQueueState: { status: 'waiting', attempts: 3, accounted: true },
    });

    await mergeQueueProcessor.runOnce();

    expect(await countTasks(db)).toBe(0); // no 4th run
    expect(mergeSpy).not.toHaveBeenCalled();
    expect((await getPr(db, prId)).mergeQueueState).toMatchObject({ status: 'blocked' });
  });

  it('does not fire a duplicate while its own run is active, even if row.taskId was reassigned', async () => {
    // The queue fired 'qfix' (still in flight). Another flow then reassigned the
    // PR's row.taskId to a now-completed task 'other'. The guard must recognise
    // the queue's OWN run (qfix) as active and back off — keying only on
    // row.taskId would miss it and fire a concurrent duplicate.
    const prId = await insertPr(db, {
      summary: conflictSummary(),
      mergeQueueState: { status: 'fixing', attempts: 1, lastFixTaskId: 'qfix', accounted: false },
    });
    await insertTask(db, 'qfix', 'in_progress', prId);
    await insertTask(db, 'other', 'completed', prId);
    await db.update(pullRequestsTable).set({ taskId: 'other' }).where(eq(pullRequestsTable.id, prId));

    await mergeQueueProcessor.runOnce();

    expect(await countTasks(db)).toBe(2); // qfix + other — no duplicate fired
    expect(mergeSpy).not.toHaveBeenCalled();
    expect((await getPr(db, prId)).mergeQueueState).toMatchObject({ status: 'fixing' });
  });

  it('re-arms a blocked PR once it is observed clean, then merges it', async () => {
    await insertPr(db, {
      summary: cleanSummary(),
      mergeQueueState: { status: 'blocked', attempts: 3, accounted: true },
    });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps a PR queued when GitHub returns merged:false', async () => {
    mergeSpy.mockResolvedValueOnce({ sha: '', merged: false, message: 'Base branch was modified' });
    const prId = await insertPr(db, { summary: cleanSummary() });

    await mergeQueueProcessor.runOnce();

    const pr = await getPr(db, prId);
    expect(pr.state).toBe('open');
    expect(pr.mergeQueued).toBe(true);
    const state = pr.mergeQueueState as QueueState;
    expect(state.status).toBe('waiting');
    expect(state.lastError).toContain('Base branch was modified');
    // Reacted to the failed merge by refetching so the BEHIND/conflict state
    // surfaces now instead of after FRESHNESS_MS.
    expect(refreshSpy).toHaveBeenCalledWith('ws1', 'a', 'b', expect.any(Number));
  });

  it('keeps a PR queued and refetches when the merge throws (e.g. 405 conflicts)', async () => {
    mergeSpy.mockRejectedValueOnce(
      new Error('GitHub API error 405 Method Not Allowed: Pull Request has merge conflicts')
    );
    const prId = await insertPr(db, { summary: cleanSummary() });

    await expect(mergeQueueProcessor.runOnce()).resolves.toBeUndefined();

    const pr = await getPr(db, prId);
    expect(pr.state).toBe('open');
    expect(pr.mergeQueued).toBe(true);
    expect((pr.mergeQueueState as QueueState).lastError).toContain('merge conflicts');
    // The 405 means our cached mergeability was stale — refetch immediately so
    // the conflict hits the cache + UI and the next tick fires the fix run.
    expect(refreshSpy).toHaveBeenCalledWith('ws1', 'a', 'b', expect.any(Number));
  });

  it('does not refetch after a successful merge', async () => {
    await insertPr(db, { summary: cleanSummary() });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).toHaveBeenCalledTimes(1);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('does not fire a fix run when the workspace has no connected cloud env', async () => {
    await seedUser(db, { id: OWNER2 });
    await db.insert(workspacesTable).values({ id: 'ws2', ownerId: OWNER2, name: 'ws2', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo2',
      workspaceId: 'ws2',
      name: 'c/d',
      url: 'https://github.com/c/d',
      defaultBranch: 'main',
    });
    await insertPr(db, { summary: conflictSummary(), workspaceId: 'ws2', repositoryId: 'repo2' });

    await mergeQueueProcessor.runOnce();

    expect(await countTasks(db)).toBe(0);
    expect(mergeSpy).not.toHaveBeenCalled();
  });

  it('ignores PRs that are not open or not queued', async () => {
    await insertPr(db, { summary: cleanSummary(), state: 'merged' });
    await insertPr(db, { summary: cleanSummary(), mergeQueued: false });

    await mergeQueueProcessor.runOnce();

    expect(mergeSpy).not.toHaveBeenCalled();
  });

  // The "#N" badge counts only stay correct live if sibling positions are
  // rebroadcast when the group's membership changes.
  describe('live position broadcasts', () => {
    /** Latest position broadcast for a PR id across all emit calls. */
    function lastPositionFor(
      spy: ReturnType<typeof vi.spyOn>,
      prId: string
    ): { mergeQueued?: boolean; position?: number } | undefined {
      const calls = spy.mock.calls.filter(
        (c) => (c[1] as { id: string }).id === prId
      );
      if (calls.length === 0) return undefined;
      const p = calls[calls.length - 1][1] as {
        mergeQueued?: boolean;
        mergeQueueState?: { position: number } | null;
      };
      return { mergeQueued: p.mergeQueued, position: p.mergeQueueState?.position };
    }

    it('reshuffles survivors after the head merges (#2 → #1)', async () => {
      // Three same-base PRs, FIFO by queued-at → positions 1, 2, 3.
      await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(1000) });
      const pr2 = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(2000) });
      const pr3 = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(3000) });
      const emitSpy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');

      await mergeQueueProcessor.runOnce();

      // Head merged; the two survivors are rebroadcast as #1 and #2.
      expect(mergeSpy).toHaveBeenCalledTimes(1);
      expect(lastPositionFor(emitSpy, pr2)).toEqual({ mergeQueued: true, position: 1 });
      expect(lastPositionFor(emitSpy, pr3)).toEqual({ mergeQueued: true, position: 2 });
    });

    it('broadcasts a contiguous 1-based order for the whole queue', async () => {
      const a = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(3000) });
      const b = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(1000) });
      const c = await insertPr(db, { summary: cleanSummary(), mergeQueuedAt: new Date(2000) });
      const emitSpy = vi.spyOn(websocketModule, 'emitPullRequestUpdated');

      await broadcastMergeQueuePositions('ws1');

      // Ordered by queued-at, not insert order.
      expect(lastPositionFor(emitSpy, b)).toEqual({ mergeQueued: true, position: 1 });
      expect(lastPositionFor(emitSpy, c)).toEqual({ mergeQueued: true, position: 2 });
      expect(lastPositionFor(emitSpy, a)).toEqual({ mergeQueued: true, position: 3 });
    });
  });
});

describe('computeQueuePositions', () => {
  type Row = {
    id: string;
    mergeQueued: boolean;
    mergeQueuedAt: Date | null;
    repositoryId: string;
    lastSummary: unknown;
  };
  function row(id: string, ms: number, opts: Partial<Row> = {}): Row {
    return {
      id,
      mergeQueued: true,
      mergeQueuedAt: new Date(ms),
      repositoryId: 'repo1',
      lastSummary: { baseBranch: 'main' },
      ...opts,
    };
  }

  it('numbers a single group 1-based in FIFO order', () => {
    const positions = computeQueuePositions([row('a', 3000), row('b', 1000), row('c', 2000)]);
    expect(positions.get('b')).toBe(1);
    expect(positions.get('c')).toBe(2);
    expect(positions.get('a')).toBe(3);
  });

  it('numbers each (repo, base) group independently', () => {
    const positions = computeQueuePositions([
      row('a', 1000, { repositoryId: 'r1', lastSummary: { baseBranch: 'main' } }),
      row('b', 2000, { repositoryId: 'r1', lastSummary: { baseBranch: 'main' } }),
      row('c', 1500, { repositoryId: 'r1', lastSummary: { baseBranch: 'dev' } }),
      row('d', 1200, { repositoryId: 'r2', lastSummary: { baseBranch: 'main' } }),
    ]);
    expect(positions.get('a')).toBe(1);
    expect(positions.get('b')).toBe(2);
    expect(positions.get('c')).toBe(1); // different base → its own group
    expect(positions.get('d')).toBe(1); // different repo → its own group
  });

  it('excludes PRs that are not queued', () => {
    const positions = computeQueuePositions([
      row('a', 1000),
      row('b', 2000, { mergeQueued: false }),
      row('c', 3000),
    ]);
    expect(positions.has('b')).toBe(false);
    expect(positions.get('a')).toBe(1);
    expect(positions.get('c')).toBe(2); // 'b' doesn't consume a slot
  });
});
