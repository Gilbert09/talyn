import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkbenchQueuedMessage } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { pullRequests, repositories, workspaces } from '../db/schema.js';
import {
  appendEvents,
  claimOrEnqueue,
  finishTurn,
  getChat,
  getChatQuery,
  getWorkbenchQuery,
  insertChat,
  insertWorkbench,
  listEvents,
  listEventsQuery,
  listEventRangeQuery,
  listOlderEvents,
  listWorkbenchesQuery,
  openChatsQuery,
  failQueued,
  removeQueuedMessage,
  resetFailedChats,
  storeNumberedEvents,
  updateChat,
  upsertCheckpoint,
  listCheckpoints,
  getWorkbench,
} from '../services/workbenches/store.js';
import { findBranchPrQuery, linkPullRequest, publicWorkbench } from '../services/workbenches/prLink.js';

const msg = (id: string, text = id): WorkbenchQueuedMessage => ({ id, text, queuedAt: new Date(0).toISOString() });

describe('workbench store', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    await insertWorkbench({
      id: 'wb-1', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: 'paris',
      branch: 'paris', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready', sandboxId: 'talyn-wb-wb-1',
    });
    await insertChat({ id: 'chat-1', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  describe('the migration', () => {
    it('creates the four tables with RLS on and the backend role granted', async () => {
      const tables = ['workbenches', 'workbench_chats', 'workbench_events', 'workbench_checkpoints'];
      const rls = await testDb.pglite.query<{ relname: string; relrowsecurity: boolean }>(
        `SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)`,
        [tables],
      );
      expect(rls.rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
      expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
      const policies = await testDb.pglite.query<{ tablename: string }>(
        `SELECT tablename FROM pg_policies WHERE tablename = ANY($1)`,
        [tables],
      );
      expect(new Set(policies.rows.map((r) => r.tablename)).size).toBe(4);
    });

    it('keeps the transcript append-only for the backend role', async () => {
      const r = await testDb.pglite.query<{ upd: boolean; ins: boolean }>(
        `SELECT has_table_privilege('talyn_backend', 'public.workbench_events', 'UPDATE') AS upd,
                has_table_privilege('talyn_backend', 'public.workbench_events', 'INSERT') AS ins`,
      );
      expect(r.rows[0]).toEqual({ upd: false, ins: true });
    });

    it('lets an archived workbench keep its name while a live one reuses it', async () => {
      const second = {
        id: 'wb-2', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: 'paris',
        branch: 'paris-2', baseBranch: 'main', runtime: 'local', agent: 'claude',
      };
      await expect(insertWorkbench(second)).rejects.toThrow();
      await testDb.pglite.exec(`UPDATE workbenches SET archived_at = now() WHERE id = 'wb-1'`);
      await expect(insertWorkbench(second)).resolves.toMatchObject({ id: 'wb-2' });
    });

    it('cascades chats, events and checkpoints with their workbench', async () => {
      await appendEvents('chat-1', [{ turn: 1, event: { type: 'user' } }]);
      await upsertCheckpoint({ chatId: 'chat-1', turn: 1, ref: 'refs/talyn/checkpoints/chat-1/1', sha: 'a'.repeat(40) });
      await testDb.pglite.exec(`DELETE FROM workbenches WHERE id = 'wb-1'`);
      for (const table of ['workbench_chats', 'workbench_events', 'workbench_checkpoints']) {
        const r = await testDb.pglite.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        expect(r.rows[0].n).toBe(0);
      }
    });
  });

  describe('seq allocation', () => {
    it('numbers a batch contiguously, in order, starting at 1', async () => {
      const stored = await appendEvents('chat-1', [
        { turn: 1, event: { type: 'user', n: 0 } },
        { turn: 1, event: { type: 'assistant', n: 1 } },
        { turn: 1, event: { type: 'result', n: 2 } },
      ]);
      expect(stored.map((e) => [e.seq, e.event.type, e.event.n, e.event.seq])).toEqual([
        [1, 'user', 0, 1],
        [2, 'assistant', 1, 2],
        [3, 'result', 2, 3],
      ]);
    });

    it.each([
      [20, 1],
      [10, 7],
      [3, 50],
    ])('gives %i concurrent appends of %i events unique, gap-free seqs', async (appenders, size) => {
      const results = await Promise.all(
        Array.from({ length: appenders }, (_a, a) =>
          appendEvents(
            'chat-1',
            Array.from({ length: size }, (_i, i) => ({ turn: 1, event: { type: 'x', a, i } })),
          ),
        ),
      );
      const all = results.flat().map((e) => e.seq).sort((x, y) => x - y);
      expect(all).toEqual(Array.from({ length: appenders * size }, (_, i) => i + 1));
      // Each batch is one contiguous run, in the order it was given.
      for (const batch of results) {
        expect(batch.map((e) => e.event.i)).toEqual(Array.from({ length: size }, (_, i) => i));
        expect(batch[batch.length - 1].seq - batch[0].seq).toBe(size - 1);
      }
    });

    it('appends nothing for an empty batch and nothing for a missing chat', async () => {
      expect(await appendEvents('chat-1', [])).toEqual([]);
      expect(await appendEvents('no-such-chat', [{ turn: 1, event: { type: 'x' } }])).toEqual([]);
    });

    it.each([
      [0, 2, [1, 2], 2],
      [2, 2, [3, 4], 4],
      [4, 10, [5], 5],
      [5, 10, [], 5],
      [99, 10, [], 99],
    ])('pages after=%i limit=%i', async (after, limit, seqs, cursor) => {
      await appendEvents('chat-1', Array.from({ length: 5 }, (_, i) => ({ turn: 1, event: { type: 'x', i } })));
      const page = await listEvents('chat-1', after, limit);
      expect(page.events.map((e) => e.seq)).toEqual(seqs);
      expect(page.cursor).toBe(cursor);
    });

    describe('paging backwards', () => {
      /** Store events with the given turn per seq, seq 1 first. */
      const seed = (turns: number[]) =>
        storeNumberedEvents(
          'chat-1',
          turns.map((turn, i) => ({ chatId: 'chat-1', seq: i + 1, turn, event: { seq: i + 1, type: 'assistant' } })),
        );
      const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

      it('answers an empty page for a chat with no events', async () => {
        expect(await listOlderEvents('chat-1', null, 10, 100)).toEqual({ events: [], cursor: 0, oldestSeq: null, hasOlder: false });
      });

      // Turn 1 is seq 1-3, turn 2 is seq 4-8, turn 3 is seq 9-10.
      it.each([
        ['the whole chat when the limit covers it', null, 50, range(1, 10), false],
        ['the newest turn, when the window starts on it', null, 2, [9, 10], true],
        ['down to the start of the oldest turn in the window', null, 3, range(4, 10), true],
        ['a window inside one turn, widened to all of it', 9, 1, range(4, 8), true],
        ['the first turn, with nothing older', 4, 2, [1, 2, 3], false],
        ['nothing below the first event', 1, 10, [], false],
      ])('returns %s', async (_name, before, limit, seqs, hasOlder) => {
        await seed([1, 1, 1, 2, 2, 2, 2, 2, 3, 3]);
        const page = await listOlderEvents('chat-1', before, limit, 100);
        expect(page.events.map((e) => e.seq)).toEqual(seqs);
        expect(page.events.every((e) => e.event.seq === e.seq)).toBe(true);
        expect(page).toMatchObject({
          hasOlder,
          oldestSeq: seqs[0] ?? null,
          cursor: seqs[seqs.length - 1] ?? 0,
        });
      });

      it('cuts a turn longer than the ceiling, and pages the rest of it next', async () => {
        await seed([...Array(10).fill(1), 2, 2]);
        const pages: number[][] = [];
        let before: number | null = null;
        for (;;) {
          const page = await listOlderEvents('chat-1', before, 3, 5);
          pages.push(page.events.map((e) => e.seq));
          expect(page.events.length).toBeLessThanOrEqual(5);
          if (!page.hasOlder) break;
          before = page.oldestSeq;
        }
        expect(pages).toEqual([range(8, 12), range(3, 7), [1, 2]]);
      });

      it('does not widen a page when the limit already is the ceiling', async () => {
        await seed([1, 1, 1, 1]);
        const page = await listOlderEvents('chat-1', null, 2, 2);
        expect(page.events.map((e) => e.seq)).toEqual([3, 4]);
        expect(page.hasOlder).toBe(true);
      });

      it('leaves gaps in the seqs alone', async () => {
        await storeNumberedEvents(
          'chat-1',
          [2, 5, 9, 12].map((seq, i) => ({ chatId: 'chat-1', seq, turn: i < 2 ? 1 : 2, event: { seq, type: 'x' } })),
        );
        expect((await listOlderEvents('chat-1', null, 1, 100)).events.map((e) => e.seq)).toEqual([9, 12]);
        expect((await listOlderEvents('chat-1', 9, 1, 100)).events.map((e) => e.seq)).toEqual([2, 5]);
      });

      it('leaves the forward mode as it was', async () => {
        await seed([1, 1, 2, 2]);
        expect(await listEvents('chat-1', 1, 2)).toMatchObject({ cursor: 3 });
        expect(Object.keys(await listEvents('chat-1', 0, 10)).sort()).toEqual(['cursor', 'events']);
      });
    });

    it('stores a local runtime\'s numbered events once, and moves the allocator past them', async () => {
      const events = [3, 4].map((seq) => ({ chatId: 'chat-1', seq, turn: 1, event: { seq, type: 'assistant' } }));
      expect(await storeNumberedEvents('chat-1', events)).toBe(2);
      expect(await storeNumberedEvents('chat-1', events)).toBe(0);
      const next = await appendEvents('chat-1', [{ turn: 1, event: { type: 'result' } }]);
      expect(next[0].seq).toBe(5);
    });
  });

  describe('the turn claim', () => {
    it('starts the first message and queues the ones sent while it runs', async () => {
      const first = await claimOrEnqueue('chat-1', msg('m1'), true);
      expect(first?.started).toEqual({ message: msg('m1'), turn: 1 });
      expect(first?.chat).toMatchObject({ status: 'running', queuedMessages: [], turnCount: 1 });

      const second = await claimOrEnqueue('chat-1', msg('m2'), true);
      const third = await claimOrEnqueue('chat-1', msg('m3'), true);
      expect(second?.started).toBeNull();
      expect(third?.chat.queuedMessages.map((m) => m.id)).toEqual(['m2', 'm3']);
      expect(third?.chat.turnCount).toBe(1);
    });

    it('queues instead of starting while the workbench is not ready', async () => {
      const claim = await claimOrEnqueue('chat-1', msg('m1'), false);
      expect(claim?.started).toBeNull();
      expect(claim?.chat).toMatchObject({ status: 'idle', turnCount: 0 });
      expect(claim?.chat.queuedMessages.map((m) => m.id)).toEqual(['m1']);
    });

    it('runs a queue left by a cancel BEFORE a new message', async () => {
      await updateChat('chat-1', { queuedMessages: [msg('old')] });
      const claim = await claimOrEnqueue('chat-1', msg('new'), true);
      expect(claim?.started?.message.id).toBe('old');
      expect(claim?.chat.queuedMessages.map((m) => m.id)).toEqual(['new']);
    });

    it('starts nothing when there is nothing to start', async () => {
      const claim = await claimOrEnqueue('chat-1', null, true);
      expect(claim?.started).toBeNull();
      expect(claim?.chat.status).toBe('idle');
    });

    it('lets exactly one of many concurrent sends start a turn', async () => {
      const claims = await Promise.all(
        Array.from({ length: 12 }, (_, i) => claimOrEnqueue('chat-1', msg(`m${i}`), true)),
      );
      expect(claims.filter((c) => c?.started).length).toBe(1);
      const chat = await getChat('chat-1');
      expect(chat?.turnCount).toBe(1);
      expect(chat?.queuedMessages.length).toBe(11);
    });

    it('returns null for a chat that does not exist', async () => {
      expect(await claimOrEnqueue('nope', msg('m1'), true)).toBeNull();
      expect(await finishTurn('nope', { finalStatus: 'idle', statusMessage: null, drain: true })).toBeNull();
    });

    it.each([
      ['idle', null, true, ['m2', 'm3'], { status: 'running', turnCount: 2, next: 'm2', left: ['m3'] }],
      ['error', 'boom', true, ['m2'], { status: 'running', turnCount: 2, next: 'm2', left: [] }],
      ['idle', 'Cancelled', false, ['m2', 'm3'], { status: 'idle', turnCount: 1, next: null, left: ['m2', 'm3'] }],
      ['error', 'boom', true, [], { status: 'error', turnCount: 1, next: null, left: [] }],
      ['idle', null, true, [], { status: 'idle', turnCount: 1, next: null, left: [] }],
    ] as const)(
      'ends a turn as %s (message %j, drain %s) with queue %j',
      async (finalStatus, statusMessage, drain, queue, expected) => {
        await claimOrEnqueue('chat-1', msg('m1'), true);
        for (const id of queue) await claimOrEnqueue('chat-1', msg(id), true);
        const fin = await finishTurn('chat-1', { finalStatus, statusMessage, drain });
        expect(fin?.started?.message.id ?? null).toBe(expected.next);
        expect(fin?.chat.status).toBe(expected.status);
        expect(fin?.chat.turnCount).toBe(expected.turnCount);
        expect(fin?.chat.queuedMessages.map((m) => m.id)).toEqual(expected.left);
        expect(fin?.chat.statusMessage).toBe(expected.next ? null : statusMessage);
      },
    );

    it.each([
      ['m2', ['m3']],
      ['m3', ['m2']],
      ['nope', ['m2', 'm3']],
    ])('removes queued message %s', async (id, left) => {
      await updateChat('chat-1', { queuedMessages: [msg('m2'), msg('m3')] });
      const row = await removeQueuedMessage('chat-1', id);
      expect(row?.queuedMessages.map((m) => m.id)).toEqual(left);
      expect(await removeQueuedMessage('no-chat', id)).toBeNull();
    });
  });

  describe('a failed start', () => {
    beforeEach(async () => {
      await insertChat({ id: 'chat-run', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'R', agent: 'claude', status: 'running', queuedMessages: [msg('r1')] });
      await insertChat({ id: 'chat-closed', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'C', agent: 'claude', queuedMessages: [msg('c1')], closedAt: new Date() });
    });

    it.each([
      [[], 'This session failed to start: no fleet'],
      [['m1'], 'This session failed to start: no fleet Your queued message was not sent.'],
      [['m1', 'm2'], 'This session failed to start: no fleet 2 queued messages were not sent.'],
    ])('drops queue %j, marks the chat error, and says why in the transcript', async (queue, text) => {
      await updateChat('chat-1', { queuedMessages: queue.map((id) => msg(id)) });
      const failed = await failQueued('wb-1', 'no fleet');
      expect(failed.map((c) => c.id)).toEqual(['chat-1']);
      expect(await getChat('chat-1')).toMatchObject({ status: 'error', statusMessage: 'no fleet', queuedMessages: [] });
      const { events } = await listEvents('chat-1', 0, 10);
      expect(events).toHaveLength(1);
      expect(events[0].event).toMatchObject({
        type: 'system', subtype: 'workbench_failed', text,
        droppedMessages: queue.map((id) => ({ id, text: id })),
      });
    });

    it('leaves a running chat and a closed chat alone', async () => {
      await failQueued('wb-1', 'no fleet');
      expect(await getChat('chat-run')).toMatchObject({ status: 'running', queuedMessages: [msg('r1')] });
      expect(await getChat('chat-closed')).toMatchObject({ status: 'idle', queuedMessages: [msg('c1')] });
    });

    it('puts failed chats back to idle on a retry, and only those', async () => {
      await failQueued('wb-1', 'no fleet');
      const reset = await resetFailedChats('wb-1');
      expect(reset.map((c) => c.id)).toEqual(['chat-1']);
      expect(await getChat('chat-1')).toMatchObject({ status: 'idle', statusMessage: null });
      expect((await getChat('chat-run'))?.status).toBe('running');
    });
  });

  describe('egress', () => {
    it.each([
      ['list', () => listWorkbenchesQuery('ws-a', false)],
      ['list with archived', () => listWorkbenchesQuery('ws-a', true)],
      ['get', () => getWorkbenchQuery('wb-1')],
      ['get chat', () => getChatQuery('chat-1')],
      ['embedded chats', () => openChatsQuery(['wb-1'])],
    ] as const)('the %s query never reads a transcript', (_name, build) => {
      const sqlText = build().toSQL().sql;
      expect(sqlText).not.toContain('workbench_events');
      expect(sqlText).not.toMatch(/"event"/);
      expect(sqlText).not.toMatch(/select \*/i);
    });

    it('only the transcript pages select the event column', () => {
      expect(listEventsQuery('chat-1', 0, 10).toSQL().sql).toMatch(/"event"/);
      expect(listEventRangeQuery('chat-1', 1, 10, 10).toSQL().sql).toMatch(/order by "workbench_events"."seq" asc limit/i);
    });

    it('finds a branch\'s PR without shipping its summary blob', () => {
      const sqlText = findBranchPrQuery('ws-a', 'repo-a', 'paris').toSQL().sql;
      expect(sqlText).toMatch(/^select "id" from/i);
      expect(sqlText).toContain(`"last_summary" ->> 'headBranch'`);
    });
  });

  describe('the PR link', () => {
    const pr = (id: string, number: number, state: string, headBranch: string, extra: object = {}) => ({
      id, workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number, state,
      lastSummary: { headBranch, mergeable: 'MERGEABLE', ciStatus: 'passing', ...extra },
    });

    it.each([
      ['no PR for the branch', [pr('p1', 1, 'open', 'other')], null],
      ['one PR', [pr('p1', 1, 'open', 'paris')], 'p1'],
      ['an open PR beats a closed one', [pr('p1', 9, 'closed', 'paris'), pr('p2', 2, 'open', 'paris')], 'p2'],
      ['the newest of several closed', [pr('p1', 1, 'closed', 'paris'), pr('p2', 5, 'merged', 'paris')], 'p2'],
    ])('links: %s', async (_name, rows, expected) => {
      await testDb.db.insert(pullRequests).values(rows);
      const row = await linkPullRequest((await getWorkbench('wb-1'))!);
      expect(row.pullRequestId).toBe(expected);
    });

    it('ignores a PR with the same branch name in another workspace or repository', async () => {
      await seedUser(testDb.db, { id: 'owner-b' });
      await testDb.db.insert(workspaces).values({ id: 'ws-b', ownerId: 'owner-b', name: 'B' });
      await testDb.db.insert(repositories).values([
        { id: 'repo-b', workspaceId: 'ws-b', name: 'o/r', url: 'https://github.com/o/r' },
        { id: 'repo-a2', workspaceId: 'ws-a', name: 'o/r2', url: 'https://github.com/o/r2' },
      ]);
      await testDb.db.insert(pullRequests).values([
        { ...pr('p-b', 1, 'open', 'paris'), workspaceId: 'ws-b', repositoryId: 'repo-b' },
        { ...pr('p-a2', 2, 'open', 'paris'), repositoryId: 'repo-a2', repo: 'r2' },
      ]);
      expect((await linkPullRequest((await getWorkbench('wb-1'))!)).pullRequestId).toBeNull();
    });

    it('returns the PR summary, the open chats and no error on a healthy workbench', async () => {
      await testDb.db.insert(pullRequests).values(pr('p1', 12, 'open', 'paris', { mergeable: 'CONFLICTING' }));
      await insertChat({ id: 'chat-closed', workbenchId: 'wb-1', workspaceId: 'ws-a', title: 'Old', agent: 'claude', closedAt: new Date() });
      const data = await publicWorkbench(await linkPullRequest((await getWorkbench('wb-1'))!));
      expect(data.pr).toEqual({
        number: 12, url: 'https://github.com/o/r/pull/12', state: 'open', mergeable: 'conflicting', ciStatus: 'success',
      });
      expect(data.chats?.map((c) => c.id)).toEqual(['chat-1']);
      expect(data.error).toBeNull();
    });
  });

  it('keeps one checkpoint per turn, the latest write winning', async () => {
    await upsertCheckpoint({ chatId: 'chat-1', turn: 2, ref: 'r2', sha: 'b'.repeat(40) });
    await upsertCheckpoint({ chatId: 'chat-1', turn: 1, ref: 'r1', sha: 'a'.repeat(40) });
    await upsertCheckpoint({ chatId: 'chat-1', turn: 1, ref: 'r1', sha: 'c'.repeat(40) });
    expect((await listCheckpoints('chat-1')).map((c) => [c.turn, c.sha[0]])).toEqual([[1, 'c'], [2, 'b']]);
  });
});
