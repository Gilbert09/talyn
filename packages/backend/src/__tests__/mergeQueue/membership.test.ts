import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  mergeQueueEntries,
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { ensureActiveEntry } from '../../services/mergeQueue/store.js';
import {
  applyQueueMembership,
  settleQueueFollowUps,
  type QueueMembershipRow,
} from '../../services/mergeQueue/membership.js';
import { createConcurrencyLimit } from '../../services/concurrencyLimit.js';

const { mockDisableAutoMerge } = vi.hoisted(() => ({ mockDisableAutoMerge: vi.fn() }));
vi.mock('../../services/githubAutoMerge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/githubAutoMerge.js')>()),
  disableAutoMerge: mockDisableAutoMerge,
}));

/**
 * Leaving the queue disarms a Talyn-armed auto-merge on GitHub. That call must
 * not run while the caller's transaction holds the PR row: on 2026-10-12 GitHub
 * calls made inside a request transaction kept PR rows locked, the writers
 * waiting on them filled the pool, and the DB watchdog restarted production.
 */
describe('applyQueueMembership — dequeue disarm', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let row: QueueMembershipRow;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws1', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    const lastSummary = { baseBranch: 'main', headSha: 'sha1', nodeId: 'PR_node' };
    await db.insert(pullRequestsTable).values({
      id: 'pr1',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      taskId: null,
      owner: 'a',
      repo: 'b',
      number: 1,
      state: 'open',
      mergeQueued: true,
      mergeMethod: 'squash',
      lastPolledAt: new Date(),
      lastSummary,
    });
    const entryId = await ensureActiveEntry({
      pullRequestId: 'pr1',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      baseBranch: 'main',
      mergeMethod: 'squash',
      headSha: 'sha1',
      trigger: 'test',
    });
    await db
      .update(mergeQueueEntries)
      .set({ automergeArmedBy: 'talyn', automergeArmedAt: new Date() })
      .where(eq(mergeQueueEntries.id, entryId));
    row = {
      id: 'pr1',
      workspaceId: 'ws1',
      taskId: null,
      repositoryId: 'repo1',
      owner: 'a',
      repo: 'b',
      number: 1,
      state: 'open',
      lastSummary,
      mergeQueuedAt: new Date(),
    };
    mockDisableAutoMerge.mockReset();
  });

  afterEach(async () => {
    await settleQueueFollowUps();
    await cleanup();
  });

  async function entryFlags() {
    const [entry] = await db
      .select({ pendingDisarm: mergeQueueEntries.pendingDisarm, armedBy: mergeQueueEntries.automergeArmedBy })
      .from(mergeQueueEntries)
      .where(eq(mergeQueueEntries.pullRequestId, 'pr1'));
    return entry;
  }

  it('returns before GitHub answers, with the disarm flagged for the reconciler', async () => {
    let answer!: (ok: boolean) => void;
    mockDisableAutoMerge.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

    await applyQueueMembership(row, { enabled: false, method: 'squash', trigger: 'test' });

    expect(mockDisableAutoMerge).toHaveBeenCalledTimes(1);
    expect(await entryFlags()).toEqual({ pendingDisarm: true, armedBy: 'talyn' });
    answer(true);
  });

  it('clears the flag once GitHub confirms the disarm', async () => {
    mockDisableAutoMerge.mockResolvedValue(true);

    await applyQueueMembership(row, { enabled: false, method: 'squash', trigger: 'test' });
    await settleQueueFollowUps();

    expect(await entryFlags()).toEqual({ pendingDisarm: false, armedBy: null });
  });

  it('leaves the flag set when GitHub refuses, so the reconciler retries', async () => {
    mockDisableAutoMerge.mockResolvedValue(false);

    await applyQueueMembership(row, { enabled: false, method: 'squash', trigger: 'test' });
    await settleQueueFollowUps();

    expect(await entryFlags()).toEqual({ pendingDisarm: true, armedBy: 'talyn' });
  });

  it('leaves the flag set when the GitHub call throws', async () => {
    mockDisableAutoMerge.mockRejectedValue(new Error('network'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await applyQueueMembership(row, { enabled: false, method: 'squash', trigger: 'test' });
    await settleQueueFollowUps();

    expect(await entryFlags()).toEqual({ pendingDisarm: true, armedBy: 'talyn' });
    warn.mockRestore();
  });
});

describe('createConcurrencyLimit', () => {
  it.each([1, 2, 4])('never runs more than %i at once, and runs them all', async (max) => {
    const limit = createConcurrencyLimit(max);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(i);
          active--;
          return i * 2;
        })
      )
    );
    expect(peak).toBe(max);
    expect(results).toEqual(Array.from({ length: 10 }, (_, i) => i * 2));
    expect(order).toHaveLength(10);
  });

  it('frees the slot when a task rejects', async () => {
    const limit = createConcurrencyLimit(1);
    await expect(limit(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limit(async () => 'next')).resolves.toBe('next');
  });
});
