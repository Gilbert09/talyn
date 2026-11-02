// A merge-queue fix run that stopped for a human keeps its amber "Needs you"
// until something says the person is no longer needed. These pin the marker
// the queue writes (metadata.needsHumanResolved), the guard that keeps it off a
// reused task row, and the shared reader both front ends use.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskNeedsHumanOpen, type TaskStatus } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  mergeQueueEntries,
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import * as websocketModule from '../../services/websocket.js';
import { resolveNeedsHumanTask } from '../../services/mergeQueue/needsHumanResolve.js';
import { closeActiveEntry, reviewWaitFor } from '../../services/mergeQueue/store.js';
import { mergeQueueEvents } from '../../db/schema.js';

describe('taskNeedsHumanOpen', () => {
  const ended = '2026-11-02T12:00:00.000Z';
  it.each<[string, TaskStatus, Record<string, unknown> | undefined, string | undefined, boolean]>([
    ['an open request', 'needs_human', {}, ended, true],
    ['no metadata at all', 'needs_human', undefined, ended, true],
    ['a resolution after the run ended', 'needs_human', { needsHumanResolved: { at: '2026-11-02T12:05:00.000Z' } }, ended, false],
    // The row was reused and a LATER run asked again: the old resolution must not hide it.
    ['a resolution older than the run', 'needs_human', { needsHumanResolved: { at: '2026-11-02T11:00:00.000Z' } }, ended, true],
    ['a resolution with no end time on the task', 'needs_human', { needsHumanResolved: { at: '2026-11-02T12:05:00.000Z' } }, undefined, false],
    ['a resolution whose time does not parse', 'needs_human', { needsHumanResolved: { at: 'nope' } }, ended, true],
    ['a completed task', 'completed', {}, ended, false],
    ['a failed task', 'failed', {}, ended, false],
    ['a running task', 'in_progress', {}, undefined, false],
  ])('%s', (_label, status, metadata, completedAt, open) => {
    expect(taskNeedsHumanOpen({ status, metadata, completedAt })).toBe(open);
  });
});

describe('resolveNeedsHumanTask + closeActiveEntry', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let taskUpdate: ReturnType<typeof vi.spyOn>;

  async function insertTask(id: string, status: TaskStatus, metadata: Record<string, unknown> = {}) {
    await db.insert(tasksTable).values({
      id,
      workspaceId: 'ws1',
      type: 'pr_response',
      status,
      priority: 'medium',
      title: 't',
      description: 'd',
      metadata,
      completedAt: new Date(Date.now() - 60_000),
    });
  }

  async function metadataOf(id: string): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));
    return (row?.metadata ?? {}) as Record<string, unknown>;
  }

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
    taskUpdate = vi.spyOn(websocketModule, 'emitTaskUpdate').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it('marks a needs_human task resolved, keeps its status and other metadata, and tells clients', async () => {
    await insertTask('t1', 'needs_human', { source: 'merge_queue' });
    await resolveNeedsHumanTask('t1', 'The pull request merged.');

    const [row] = await db.select({ status: tasksTable.status }).from(tasksTable).where(eq(tasksTable.id, 't1'));
    expect(row!.status).toBe('needs_human');
    const metadata = await metadataOf('t1');
    expect(metadata.source).toBe('merge_queue');
    expect(metadata.needsHumanResolved).toMatchObject({ by: 'merge_queue', note: 'The pull request merged.' });
    expect(taskUpdate).toHaveBeenCalledWith('ws1', 't1', { metadata: expect.objectContaining({ needsHumanResolved: expect.any(Object) }) });
  });

  it.each<[TaskStatus]>([['queued'], ['in_progress'], ['completed'], ['failed']])(
    'leaves a %s task (a reused row) alone',
    async (status) => {
      await insertTask('t1', status);
      await resolveNeedsHumanTask('t1', 'x');
      expect((await metadataOf('t1')).needsHumanResolved).toBeUndefined();
      expect(taskUpdate).not.toHaveBeenCalled();
    }
  );

  it('keeps the first resolution', async () => {
    await insertTask('t1', 'needs_human');
    await resolveNeedsHumanTask('t1', 'first');
    await resolveNeedsHumanTask('t1', 'second');
    expect((await metadataOf('t1')).needsHumanResolved).toMatchObject({ note: 'first' });
    expect(taskUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not throw for a missing task', async () => {
    await expect(resolveNeedsHumanTask('missing', 'x')).resolves.toBeUndefined();
  });

  async function insertEntry(fixTaskId: string | null) {
    await db.insert(pullRequestsTable).values({
      id: 'pr1',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'a',
      repo: 'b',
      number: 1,
      state: 'open',
      mergeQueued: true,
      lastPolledAt: new Date(),
      lastSummary: {},
    });
    await db.insert(mergeQueueEntries).values({
      id: 'e1',
      pullRequestId: 'pr1',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      status: 'blocked',
      blockedCode: 'agent_needs_human',
      fixTaskId,
    });
  }

  it('resolves the fix task when the entry closes as merged', async () => {
    await insertTask('t1', 'needs_human');
    await insertEntry('t1');
    await closeActiveEntry('pr1', 'merged', { trigger: 'test', message: 'Merged.' }, db);
    expect((await metadataOf('t1')).needsHumanResolved).toMatchObject({ note: 'The pull request merged.' });
  });

  it('does not resolve it when the person removes the PR from the queue', async () => {
    await insertTask('t1', 'needs_human');
    await insertEntry('t1');
    await closeActiveEntry('pr1', 'removed', { trigger: 'test', message: 'Removed.' }, db);
    expect((await metadataOf('t1')).needsHumanResolved).toBeUndefined();
  });

  describe('reviewWaitFor', () => {
    async function event(at: Date, fromStatus: string | null, toStatus: string, code: string) {
      await db.insert(mergeQueueEvents).values({ entryId: 'e1', at, fromStatus, toStatus, trigger: 't', code });
    }
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

    beforeEach(async () => {
      await insertEntry(null);
    });

    it('is null when the entry never waited for a review', async () => {
      await event(hoursAgo(3), null, 'queued', 'enqueued');
      expect(await reviewWaitFor('e1', db)).toBeNull();
    });

    it('reads the latest start of the wait, not a self-transition inside it', async () => {
      await event(hoursAgo(50), 'queued', 'awaiting_review', 'awaiting_review');
      await event(hoursAgo(40), 'awaiting_review', 'queued', 'status');
      await event(hoursAgo(30), 'queued', 'awaiting_review', 'awaiting_review');
      await event(hoursAgo(5), 'awaiting_review', 'awaiting_review', 'review_wait_reminder');
      const wait = await reviewWaitFor('e1', db);
      expect(Math.round((Date.now() - Date.parse(wait!.since)) / 3_600_000)).toBe(30);
      expect(wait!.reminded).toBe(true);
    });

    it('does not count a reminder from an EARLIER wait', async () => {
      await event(hoursAgo(80), 'queued', 'awaiting_review', 'awaiting_review');
      await event(hoursAgo(55), 'awaiting_review', 'awaiting_review', 'review_wait_reminder');
      await event(hoursAgo(50), 'awaiting_review', 'queued', 'status');
      await event(hoursAgo(30), 'queued', 'awaiting_review', 'awaiting_review');
      const wait = await reviewWaitFor('e1', db);
      expect(Math.round((Date.now() - Date.parse(wait!.since)) / 3_600_000)).toBe(30);
      expect(wait!.reminded).toBe(false);
    });
  });
});
