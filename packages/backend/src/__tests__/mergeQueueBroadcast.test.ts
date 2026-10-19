// The merge-queue position broadcast: coalesced per workspace, and it sends
// only the rows whose queue payload changed since this process last sent it.
// A 100-PR queue used to emit every row (with its summary blob) on every
// enqueue, merge and close.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  mergeQueueEntries,
} from '../db/schema.js';
import * as websocketModule from '../services/websocket.js';
import * as storeModule from '../services/mergeQueue/store.js';
import { closeActiveEntry, ensureActiveEntry } from '../services/mergeQueue/store.js';
import {
  _resetMergeQueueBroadcasts,
  broadcastMergeQueuePositions,
  noteMergeQueueEmitted,
  QUEUE_RESET_COLUMNS,
} from '../services/mergeQueueBroadcast.js';

const OWNER = 'user-mq-broadcast';

type Emitted = Parameters<typeof websocketModule.emitPullRequestUpdated>[1];

describe('broadcastMergeQueuePositions', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let emitted: Emitted[];
  let loadSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    _resetMergeQueueBroadcasts();
    await seedUser(db, { id: OWNER });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: OWNER, name: 'ws', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'a/b',
      url: 'https://github.com/a/b',
      defaultBranch: 'main',
    });
    emitted = [];
    vi.spyOn(websocketModule, 'emitPullRequestUpdated').mockImplementation((_ws, payload) => {
      emitted.push(payload);
    });
    loadSpy = vi.spyOn(storeModule, 'loadActiveEntriesForWorkspace');
  });

  afterEach(async () => {
    _resetMergeQueueBroadcasts();
    vi.restoreAllMocks();
    await cleanup();
  });

  /** Queue `count` PRs, pr-1 at the head. */
  async function queue(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let n = 1; n <= count; n++) {
      const id = `pr-${n}`;
      await db.insert(pullRequestsTable).values({
        id,
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        owner: 'a',
        repo: 'b',
        number: n,
        state: 'open',
        mergeQueued: true,
        mergeQueuedAt: new Date(Date.UTC(2026, 0, 1, 0, n)),
        mergeMethod: 'squash',
        lastPolledAt: new Date(),
        lastSummary: { baseBranch: 'main', headSha: `sha${n}`, title: 'a big summary' },
      });
      const entryId = await ensureActiveEntry(
        {
          pullRequestId: id,
          workspaceId: 'ws1',
          repositoryId: 'repo1',
          baseBranch: 'main',
          mergeMethod: 'squash',
          headSha: `sha${n}`,
          trigger: 'test:seed',
        },
        db
      );
      await db
        .update(mergeQueueEntries)
        .set({ enqueuedAt: new Date(Date.UTC(2026, 0, 1, 0, n)) })
        .where(eq(mergeQueueEntries.id, entryId));
      ids.push(id);
    }
    return ids;
  }

  async function dequeue(id: string): Promise<void> {
    await closeActiveEntry(id, 'removed', { trigger: 'test', message: 'removed' }, db);
    await db
      .update(pullRequestsTable)
      .set({ mergeQueued: false, mergeQueuedAt: null })
      .where(eq(pullRequestsTable.id, id));
  }

  /** Run one broadcast and return what it emitted. */
  async function run(): Promise<Emitted[]> {
    emitted = [];
    await broadcastMergeQueuePositions('ws1');
    return emitted;
  }

  const ids = (rows: Emitted[]) => rows.map((r) => r.id).sort();
  const position = (row: Emitted | undefined) =>
    (row?.mergeQueue as { position?: number } | null | undefined)?.position;

  it('first run emits every queued row, with positions and no summary', async () => {
    await queue(3);
    const out = await run();

    expect(ids(out)).toEqual(['pr-1', 'pr-2', 'pr-3']);
    for (const row of out) {
      expect(row.lastSummary).toEqual({});
      expect(row.mergeQueued).toBe(true);
    }
    expect(out.map((r) => [r.id, position(r)]).sort()).toEqual([
      ['pr-1', 1],
      ['pr-2', 2],
      ['pr-3', 3],
    ]);
  });

  it.each([
    ['nothing changed', async () => {}, []],
    ['the tail left', (d: typeof dequeue) => d('pr-3'), ['pr-3']],
    ['the head left', (d: typeof dequeue) => d('pr-1'), ['pr-1', 'pr-2', 'pr-3']],
    ['a middle row left', (d: typeof dequeue) => d('pr-2'), ['pr-2', 'pr-3']],
  ])('after %s, emits only the changed rows', async (_label, change, expected) => {
    await queue(3);
    await run();
    await change(dequeue);

    expect(ids(await run())).toEqual(expected);
  });

  it('emits a row whose status changed and leaves its siblings alone', async () => {
    await queue(3);
    await run();
    await db
      .update(mergeQueueEntries)
      .set({ status: 'fixing' })
      .where(eq(mergeQueueEntries.pullRequestId, 'pr-2'));

    const out = await run();
    expect(ids(out)).toEqual(['pr-2']);
    expect((out[0]!.mergeQueue as { status: string }).status).toBe('fixing');
  });

  it.each([
    ['dequeued', 'open', async () => dequeue('pr-2')],
    [
      'merged',
      'merged',
      // The monitor's close-out: the row goes terminal and the entry stays
      // active until the next evaluation ends it.
      async (database: Database) =>
        database
          .update(pullRequestsTable)
          .set({ state: 'merged', ...QUEUE_RESET_COLUMNS })
          .where(eq(pullRequestsTable.id, 'pr-2')),
    ],
  ])('sends a clearing emit for a row that was %s', async (_label, state, leave) => {
    await queue(2);
    await run();
    await leave(db);

    const out = await run();
    const cleared = out.find((r) => r.id === 'pr-2');
    expect(cleared).toMatchObject({ state, mergeQueued: false, mergeQueue: null, lastSummary: {} });
    // The clear is sent once, not on every later run.
    expect(ids(await run())).toEqual([]);
  });

  it('a row that rejoins after its queue emptied is sent again', async () => {
    await queue(1);
    await run();
    await dequeue('pr-1');
    expect(ids(await run())).toEqual(['pr-1']);

    await db
      .update(pullRequestsTable)
      .set({ mergeQueued: true, mergeQueuedAt: new Date() })
      .where(eq(pullRequestsTable.id, 'pr-1'));
    await ensureActiveEntry(
      {
        pullRequestId: 'pr-1',
        workspaceId: 'ws1',
        repositoryId: 'repo1',
        baseBranch: 'main',
        mergeMethod: 'squash',
        headSha: 'sha1',
        trigger: 'test',
      },
      db
    );
    const out = await run();
    expect(ids(out)).toEqual(['pr-1']);
    expect(out[0]!.mergeQueued).toBe(true);
  });

  it.each([2, 5])('coalesces %i rapid calls into one read and one emit per row', async (calls) => {
    await queue(3);
    loadSpy.mockClear();
    emitted = [];

    await Promise.all(Array.from({ length: calls }, () => broadcastMergeQueuePositions('ws1')));

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(ids(emitted)).toEqual(['pr-1', 'pr-2', 'pr-3']);
  });

  it('a call made after a run started gets a run of its own', async () => {
    await queue(1);
    loadSpy.mockClear();
    const first = broadcastMergeQueuePositions('ws1');
    await vi.waitFor(() => expect(loadSpy).toHaveBeenCalledTimes(1));
    await first;
    await broadcastMergeQueuePositions('ws1');
    expect(loadSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps workspaces apart', async () => {
    await queue(1);
    loadSpy.mockClear();
    await Promise.all([
      broadcastMergeQueuePositions('ws1'),
      broadcastMergeQueuePositions('ws-other'),
    ]);
    expect(loadSpy).toHaveBeenCalledTimes(2);
  });

  it('re-sends a row another emitter changed on the client', async () => {
    await queue(2);
    await run();
    // The executor's mirror sent a stale position for pr-2.
    noteMergeQueueEmitted('ws1', 'pr-2', { status: 'queued', position: 7 });

    expect(ids(await run())).toEqual(['pr-2']);
  });

  it('a note that a row left does not make the next run clear it again', async () => {
    await queue(2);
    await run();
    await dequeue('pr-2');
    noteMergeQueueEmitted('ws1', 'pr-2', null);

    expect(ids(await run())).toEqual([]);
  });

  it('sends every row again once the memo is too old to trust', async () => {
    await queue(2);
    await run();
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 6 * 60_000);

    expect(ids(await run())).toEqual(['pr-1', 'pr-2']);
  });

  it('never rejects, so request paths can fire and forget it', async () => {
    await queue(1);
    loadSpy.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(broadcastMergeQueuePositions('ws1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
