import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { asc, eq, sql } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { usageInsightsBackfill, workbenchEvents, workbenchSearchText, workspaces } from '../db/schema.js';
import { appendEvents, insertChat, insertWorkbench, storeNumberedEvents, updateWorkbench } from '../services/workbenches/store.js';
import {
  backfillTranscriptSearch,
  backfillTranscriptSearchBatch,
  searchTranscripts,
  TRANSCRIPT_SEARCH_BACKFILL,
  transcriptSearchTerms,
  transcriptSnippet,
} from '../services/workbenches/transcriptSearch.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { workbenchRoutes } from '../routes/workbenches.js';
import { apiErrorHandler } from '../routes/index.js';
import { wrapAsyncRoutes } from '../middleware/asyncHandler.js';

const T0 = new Date('2026-11-01T10:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const userText = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, talyn: { kind: 'user_message' } });
const assistantText = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('transcriptSearchTerms', () => {
  it.each([
    ['pyarrow', ['pyarrow']],
    ['  PyArrow  ', ['pyarrow']],
    ['upgrade pyarrow', ['upgrade', 'pyarrow']],
    ['pyarrow==17.0', ['pyarrow', '17', '0']],
    ["x' | !y & (z):*", ['x', 'y', 'z']],
    ['data_imports', ['data', 'imports']],
    ['posthog-cloud-infra', ['posthog', 'cloud', 'infra']],
    ['café crème', ['café', 'crème']],
    ['dup dup DUP', ['dup']],
    ['ab', []],
    ['   ', []],
    ['!!!', []],
    ['a b c d e f g h i j', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']],
  ])('%j → %j', (query, terms) => {
    expect(transcriptSearchTerms(query)).toEqual(terms);
  });
});

describe('transcriptSnippet', () => {
  it.each([
    ['short text', ['short'], 'short text'],
    ['Please   upgrade\n\npyarrow now', ['pyarrow'], 'Please upgrade pyarrow now'],
    [`${'a'.repeat(100)} pyarrow ${'b'.repeat(300)}`, ['pyarrow'], `…${'a'.repeat(39)} pyarrow ${'b'.repeat(112)}…`],
    ['no match here', ['zzz'], 'no match here'],
    ['first PYARROW then later', ['later', 'pyarrow'], 'first PYARROW then later'],
  ])('%j', (body, terms, snippet) => {
    expect(transcriptSnippet(body, terms)).toBe(snippet);
  });
});

describe('transcript search', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    await seedUser(db, { id: 'owner' });
    await seedUser(db, { id: 'other' });
    await db.insert(workspaces).values([
      { id: 'ws', ownerId: 'owner', name: 'W' },
      { id: 'ws-other', ownerId: 'other', name: 'O' },
    ]);
    const base = { repoFullName: 'o/r', baseBranch: 'main', runtime: 'sandbox' as const, status: 'ready' as const, agent: 'claude' as const };
    await insertWorkbench({ id: 'wb-arrow', workspaceId: 'ws', branch: 'a', name: 'Upgrade dependencies', ...base });
    await insertWorkbench({ id: 'wb-other', workspaceId: 'ws', branch: 'b', name: 'Fix login', ...base });
    await insertWorkbench({ id: 'wb-foreign', workspaceId: 'ws-other', branch: 'c', name: 'Foreign', ...base });
    await insertChat({ id: 'chat-arrow', workbenchId: 'wb-arrow', workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    await insertChat({ id: 'chat-other', workbenchId: 'wb-other', workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    await insertChat({ id: 'chat-foreign', workbenchId: 'wb-foreign', workspaceId: 'ws-other', title: 'Chat', agent: 'claude' });
  });

  afterEach(async () => {
    await cleanup();
  });

  const indexed = () => db.select({
    chatId: workbenchSearchText.chatId, seq: workbenchSearchText.seq, role: workbenchSearchText.role, body: workbenchSearchText.body,
    workbenchId: workbenchSearchText.workbenchId, workspaceId: workbenchSearchText.workspaceId,
  }).from(workbenchSearchText).orderBy(asc(workbenchSearchText.chatId), asc(workbenchSearchText.seq));

  describe('the trigger', () => {
    it('copies the text blocks of user and assistant events, and nothing else', async () => {
      await appendEvents('chat-arrow', [
        { turn: 1, event: userText('Please upgrade pyarrow to 17') },
        { turn: 1, event: { type: 'stream_event', event: { delta: { text: 'pyarrow' } } } },
        { turn: 1, event: { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret pyarrow plan' }] } } },
        { turn: 1, event: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'uv add pyarrow' } }] } } },
        { turn: 1, event: { type: 'user', message: { content: [{ type: 'tool_result', content: 'pyarrow 17 installed' }] } } },
        { turn: 1, event: assistantText('Upgraded pyarrow.') },
        { turn: 1, event: { type: 'assistant', message: { content: [{ type: 'text', text: 'One' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: 'two' }] } } },
        { turn: 1, event: { type: 'result', result: 'Upgraded pyarrow.' } },
        { turn: 1, event: { type: 'system', subtype: 'init' } },
      ]);
      expect(await indexed()).toEqual([
        { chatId: 'chat-arrow', seq: 1, role: 'user', body: 'Please upgrade pyarrow to 17', workbenchId: 'wb-arrow', workspaceId: 'ws' },
        { chatId: 'chat-arrow', seq: 6, role: 'assistant', body: 'Upgraded pyarrow.', workbenchId: 'wb-arrow', workspaceId: 'ws' },
        { chatId: 'chat-arrow', seq: 7, role: 'assistant', body: 'One\ntwo', workbenchId: 'wb-arrow', workspaceId: 'ws' },
      ]);
    });

    it.each([
      ['a string content', { type: 'user', message: { content: 'hi pyarrow' } }, 'hi pyarrow'],
      ['no message', { type: 'user', talyn: { kind: 'user_message' } }, null],
      ['an empty content list', { type: 'assistant', message: { content: [] } }, null],
      ['blank text', { type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } }, null],
      ['scalar blocks', { type: 'assistant', message: { content: ['text', 3, null] } }, null],
      ['a content object', { type: 'assistant', message: { content: { type: 'text', text: 'x' } } }, null],
    ])('handles %s', async (_name, event, body) => {
      await appendEvents('chat-arrow', [{ turn: 1, event }]);
      expect((await indexed()).map((r) => r.body)).toEqual(body === null ? [] : [body]);
    });

    it('caps a long text at 20000 characters', async () => {
      await appendEvents('chat-arrow', [{ turn: 1, event: assistantText('y'.repeat(30_000)) }]);
      expect((await indexed())[0].body).toHaveLength(20_000);
    });

    it('indexes events that a local runtime stores, once', async () => {
      const events = [{ chatId: 'chat-arrow', seq: 4, turn: 1, event: { ...userText('local pyarrow'), seq: 4 } }];
      await storeNumberedEvents('chat-arrow', events as never);
      await storeNumberedEvents('chat-arrow', events as never);
      expect((await indexed()).map((r) => [r.seq, r.body])).toEqual([[4, 'local pyarrow']]);
    });

    it('goes when the chat goes', async () => {
      await appendEvents('chat-arrow', [{ turn: 1, event: userText('pyarrow') }]);
      await db.execute(sql`DELETE FROM workbench_chats WHERE id = 'chat-arrow'`);
      expect(await indexed()).toEqual([]);
    });
  });

  describe('searchTranscripts', () => {
    let seq = 0;
    const event = (chatId: string, s: number, body: Record<string, unknown>) =>
      db.insert(workbenchEvents).values({ chatId, seq: ++seq, turn: 1, event: body, createdAt: at(s) });

    beforeEach(async () => {
      seq = 0;
      await event('chat-arrow', 0, userText('Upgrade the pyarrow package to 17.0'));
      await event('chat-arrow', 10, assistantText('Done: pyarrow is now 17.0 in uv.lock'));
      await event('chat-other', 20, assistantText('The login form uses PyArrow? No, it does not.'));
      await event('chat-other', 30, userText('Fix the login redirect'));
      await event('chat-foreign', 40, userText('pyarrow in another workspace'));
    });

    it('answers each matching session once, newest match first, only in the workspace', async () => {
      const hits = await searchTranscripts('ws', 'pyarrow');
      expect(hits.map((h) => [h.row.id, h.role, h.seq])).toEqual([
        ['wb-other', 'assistant', 3],
        ['wb-arrow', 'user', 1],
      ]);
      expect(hits[1]).toMatchObject({ chatId: 'chat-arrow', snippet: 'Upgrade the pyarrow package to 17.0' });
    });

    it.each([
      ['a prefix', 'pyarr', ['wb-other', 'wb-arrow']],
      ['every word', 'pyarrow lock', ['wb-arrow']],
      ['any case', 'PYARROW', ['wb-other', 'wb-arrow']],
      ['punctuation', 'pyarrow==17', ['wb-arrow']],
      ['words out of order', 'redirect login', ['wb-other']],
      ['a dotted name', 'uv.lock', ['wb-arrow']],
      ['part of a dotted name', 'lock', ['wb-arrow']],
      ['a version', '17.0', ['wb-arrow']],
      ['no match', 'polars', []],
      ['a word inside a word', 'arrow', []],
      ['too short', 'py', []],
      ['only symbols', '&|!():*', []],
    ])('matches %s', async (_name, query, ids) => {
      expect((await searchTranscripts('ws', query)).map((h) => h.row.id)).toEqual(ids);
    });

    it('finds archived sessions and threads', async () => {
      await updateWorkbench('wb-arrow', { archivedAt: new Date() });
      expect((await searchTranscripts('ws', 'uv.lock')).map((h) => h.row.id)).toEqual(['wb-arrow']);
    });

    it('stops at the limit', async () => {
      expect(await searchTranscripts('ws', 'pyarrow', 1)).toHaveLength(1);
    });
  });

  describe('the backfill', () => {
    async function seedWithoutTrigger() {
      await db.execute(sql`ALTER TABLE workbench_events DISABLE TRIGGER workbench_search_index_event`);
      await db.insert(workbenchEvents).values([
        { chatId: 'chat-arrow', seq: 1, turn: 1, event: userText('old pyarrow message'), createdAt: at(0) },
        { chatId: 'chat-arrow', seq: 2, turn: 1, event: { type: 'stream_event', event: {} }, createdAt: at(1) },
        { chatId: 'chat-other', seq: 1, turn: 1, event: assistantText('old login answer'), createdAt: at(2) },
        { chatId: 'chat-foreign', seq: 1, turn: 1, event: userText('old foreign'), createdAt: at(3) },
      ]);
      await db.execute(sql`ALTER TABLE workbench_events ENABLE TRIGGER workbench_search_index_event`);
    }

    const state = async () =>
      (await db.select().from(usageInsightsBackfill).where(eq(usageInsightsBackfill.name, TRANSCRIPT_SEARCH_BACKFILL)))[0];

    it('copies older chats in batches, then stops', async () => {
      await seedWithoutTrigger();
      expect(await indexed()).toEqual([]);

      expect(await backfillTranscriptSearchBatch(2)).toEqual({ chats: 2, rows: 2, completed: false });
      expect((await state()).cursor).toBe('chat-foreign');
      expect(await backfillTranscriptSearchBatch(2)).toEqual({ chats: 1, rows: 1, completed: true });
      expect((await state()).completedAt).not.toBeNull();
      expect(await backfillTranscriptSearchBatch(2)).toEqual({ chats: 0, rows: 0, completed: true });

      expect((await indexed()).map((r) => [r.chatId, r.seq, r.role, r.body, r.workspaceId])).toEqual([
        ['chat-arrow', 1, 'user', 'old pyarrow message', 'ws'],
        ['chat-foreign', 1, 'user', 'old foreign', 'ws-other'],
        ['chat-other', 1, 'assistant', 'old login answer', 'ws'],
      ]);
      expect((await searchTranscripts('ws', 'pyarrow')).map((h) => h.row.id)).toEqual(['wb-arrow']);
    });

    it('keeps the rows the trigger wrote', async () => {
      await appendEvents('chat-arrow', [{ turn: 1, event: userText('live pyarrow') }]);
      expect(await backfillTranscriptSearchBatch(10)).toEqual({ chats: 3, rows: 0, completed: true });
      expect((await indexed()).map((r) => r.body)).toEqual(['live pyarrow']);
    });

    it.each([
      ['00:30', false],
      ['01:00', true],
      ['05:59', true],
      ['06:00', false],
      ['12:00', false],
    ])('runs at %s UTC: %s', async (time, runs) => {
      await seedWithoutTrigger();
      expect(await backfillTranscriptSearch(new Date(`2026-11-02T${time}:00.000Z`))).toBe(runs);
      expect((await indexed()).length > 0).toBe(runs);
    });
  });
});

describe('GET /workbenches/search', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await insertWorkbench({
      id: 'wb-a', workspaceId: 'ws-a', repoFullName: 'o/r', baseBranch: 'main', branch: 'a', name: 'Deps', runtime: 'sandbox', status: 'ready', agent: 'claude',
    });
    await insertChat({ id: 'chat-a', workbenchId: 'wb-a', workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
    await appendEvents('chat-a', [{ turn: 1, event: userText('Upgrade pyarrow please') }]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await testDb.cleanup();
    vi.unstubAllEnvs();
  });

  async function get(path: string, user = 'owner-a') {
    const resp = await fetch(`${base}${path}`, { headers: { 'x-user': user } });
    return {
      status: resp.status,
      body: (await resp.json()) as { success: boolean; data?: Array<{ workbench: { id: string; name: string } } & Record<string, unknown>>; code?: string },
    };
  }

  it('answers the matching sessions with a snippet', async () => {
    const res = await get('/workbenches/search?workspaceId=ws-a&q=pyarrow');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data?.[0]).toMatchObject({ chatId: 'chat-a', seq: 1, role: 'user', snippet: 'Upgrade pyarrow please' });
    expect(res.body.data?.[0].workbench).toMatchObject({ id: 'wb-a', name: 'Deps' });
  });

  it('answers nothing for a short search', async () => {
    const res = await get('/workbenches/search?workspaceId=ws-a&q=py');
    expect(res.body).toMatchObject({ success: true, data: [] });
  });

  it('refuses a workspace the caller cannot read', async () => {
    const res = await get('/workbenches/search?workspaceId=ws-a&q=pyarrow', 'owner-b');
    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });

  it('needs a workspace', async () => {
    expect((await get('/workbenches/search?q=pyarrow')).status).toBe(400);
  });
});
