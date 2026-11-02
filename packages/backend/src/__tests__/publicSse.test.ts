import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createSseEventParser, type SseEventFrame } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { mintToken, startPublicApi, type Loose } from './helpers/publicApi.js';
import { apiTokens, repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { broadcastToWorkspace } from '../services/websocket.js';
import { appendEvents } from '../services/workbenches/store.js';
import { MAX_STREAMS_PER_TOKEN, openStreamCountForTests, setSseKeepaliveMsForTests } from '../services/public/sse.js';

/**
 * The `/v1` transcript and session streams: replay from the database, resume
 * from `Last-Event-ID`, live frames from the workspace fan-out, gap repair,
 * keepalive comments, the end frame and the per-token stream cap.
 */

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let api: Awaited<ReturnType<typeof startPublicApi>>;
let token: string;
let tokenId: string;

beforeAll(async () => {
  vi.stubEnv('PUBLIC_API_ENABLED', 'true');
  vi.stubEnv('WORKBENCHES_ENABLED', 'true');
  resetFeatureFlagsForTests();
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: 'owner-a' });
  await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
  await testDb.db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app' });
  token = await mintToken('owner-a', { scopes: ['sessions:read'] });
  tokenId = (await testDb.db.select({ id: apiTokens.id }).from(apiTokens))[0].id;
  api = await startPublicApi();
});

afterAll(async () => {
  await api.close();
  await testDb.cleanup();
  vi.unstubAllEnvs();
  resetFeatureFlagsForTests();
});

let counter = 0;
let sessionId: string;
let chatId: string;

beforeEach(async () => {
  counter += 1;
  sessionId = `wb-${counter}`;
  chatId = `chat-${counter}`;
  await testDb.db.insert(workbenches).values({
    id: sessionId, workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: sessionId,
    branch: sessionId, baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
  });
  await testDb.db.insert(workbenchChats).values({ id: chatId, workbenchId: sessionId, workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
});

afterEach(() => {
  setSseKeepaliveMsForTests(null);
});

interface OpenStream {
  status: number;
  frames: SseEventFrame<Loose>[];
  raw: () => string;
  closed: () => boolean;
  close: () => void;
  body: () => Promise<Loose>;
}

async function openStream(path: string, headers: Record<string, string> = {}): Promise<OpenStream> {
  const controller = new AbortController();
  const resp = await fetch(`${api.base}${path}`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
    signal: controller.signal,
  });
  const frames: SseEventFrame<Loose>[] = [];
  let raw = '';
  let closed = false;
  if (resp.headers.get('content-type')?.startsWith('text/event-stream')) {
    const parser = createSseEventParser<Loose>();
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          raw += text;
          frames.push(...parser.push(text));
        }
      } catch {
        // Aborted by the test.
      }
      closed = true;
    })();
  }
  return {
    status: resp.status,
    frames,
    raw: () => raw,
    closed: () => closed,
    close: () => controller.abort(),
    body: () => resp.json(),
  };
}

const transcriptSeqs = (s: OpenStream) => s.frames.filter((f) => f.event === 'transcript').map((f) => Number(f.id));

async function store(count: number, turn = 1) {
  return appendEvents(chatId, Array.from({ length: count }, (_, i) => ({ turn, event: { type: 'assistant', n: i } })));
}

function emitEvents(events: Awaited<ReturnType<typeof appendEvents>>) {
  broadcastToWorkspace('ws-a', { type: 'workbench:event', payload: { chatId, events }, timestamp: new Date().toISOString() } as never);
}

describe('the transcript stream', () => {
  it('replays the stored events, then follows new ones, each with id = seq', async () => {
    await store(3);
    const stream = await openStream(`/chats/${chatId}/events/stream`);
    expect(stream.status).toBe(200);
    await vi.waitFor(() => expect(transcriptSeqs(stream)).toEqual([1, 2, 3]));
    expect(stream.frames[0].data).toMatchObject({ object: 'event', chat_id: chatId, seq: 1, type: 'assistant' });

    emitEvents(await store(2));
    await vi.waitFor(() => expect(transcriptSeqs(stream)).toEqual([1, 2, 3, 4, 5]));
    stream.close();
  });

  it.each([
    ['Last-Event-ID', `?`, { 'last-event-id': '2' }, [3, 4]],
    ['after', `?after=3`, {}, [4]],
    ['Last-Event-ID over after', `?after=0`, { 'last-event-id': '3' }, [4]],
  ])('resumes from %s', async (_label, qs, headers, expected) => {
    await store(4);
    const stream = await openStream(`/chats/${chatId}/events/stream${qs}`, headers);
    await vi.waitFor(() => expect(transcriptSeqs(stream)).toEqual(expected));
    stream.close();
  });

  it('reads a gap from the database when a live batch skips ahead', async () => {
    await store(1);
    const stream = await openStream(`/chats/${chatId}/events/stream`);
    await vi.waitFor(() => expect(transcriptSeqs(stream)).toEqual([1]));
    await store(1); // seq 2, never broadcast
    emitEvents(await store(1)); // seq 3
    await vi.waitFor(() => expect(transcriptSeqs(stream)).toEqual([1, 2, 3]));
    stream.close();
  });

  it('never sends an event twice when a broadcast repeats one', async () => {
    const stream = await openStream(`/chats/${chatId}/events/stream`);
    const events = await store(2);
    emitEvents(events);
    emitEvents(events);
    await vi.waitFor(() => expect(transcriptSeqs(stream)).toEqual([1, 2]));
    await new Promise((r) => setTimeout(r, 50));
    expect(transcriptSeqs(stream)).toEqual([1, 2]);
    stream.close();
  });

  it('ignores events of another chat', async () => {
    await testDb.db.insert(workbenchChats).values({ id: `${chatId}-other`, workbenchId: sessionId, workspaceId: 'ws-a', title: 'Other', agent: 'claude' });
    const stream = await openStream(`/chats/${chatId}/events/stream`);
    const other = await appendEvents(`${chatId}-other`, [{ turn: 1, event: { type: 'assistant' } }]);
    broadcastToWorkspace('ws-a', { type: 'workbench:event', payload: { chatId: `${chatId}-other`, events: other }, timestamp: '' } as never);
    emitEvents(await store(1));
    await vi.waitFor(() => expect(transcriptSeqs(stream)).toEqual([1]));
    expect(stream.frames.every((f) => f.event !== 'transcript' || f.data.chat_id === chatId)).toBe(true);
    stream.close();
  });

  it('sends a chat frame when the chat changes', async () => {
    const stream = await openStream(`/chats/${chatId}/events/stream`);
    await testDb.db.update(workbenchChats).set({ status: 'running' }).where(eq(workbenchChats.id, chatId));
    broadcastToWorkspace('ws-a', { type: 'workbench:chat', payload: { chat: { id: chatId, workbenchId: sessionId } }, timestamp: '' } as never);
    await vi.waitFor(() => expect(stream.frames.find((f) => f.event === 'chat')?.data).toMatchObject({ object: 'chat', id: chatId, status: 'running' }));
    expect(stream.frames.find((f) => f.event === 'chat')?.id).toBeUndefined();
    stream.close();
  });

  it('sends keepalive comments', async () => {
    setSseKeepaliveMsForTests(30);
    const stream = await openStream(`/chats/${chatId}/events/stream`);
    await vi.waitFor(() => expect(stream.raw()).toContain(': ping\n\n'));
    stream.close();
  });

  it('ends when the session is archived', async () => {
    await store(1);
    const stream = await openStream(`/chats/${chatId}/events/stream`);
    await vi.waitFor(() => expect(transcriptSeqs(stream)).toEqual([1]));
    await testDb.db.update(workbenches).set({ archivedAt: new Date() }).where(eq(workbenches.id, sessionId));
    broadcastToWorkspace('ws-a', { type: 'workbench:updated', payload: { workbench: { id: sessionId } }, timestamp: '' } as never);
    await vi.waitFor(() => expect(stream.frames.at(-1)).toEqual({ event: 'end', data: { reason: 'session_archived' } }));
    await vi.waitFor(() => expect(stream.closed()).toBe(true));
    await vi.waitFor(() => expect(openStreamCountForTests(tokenId)).toBe(0));
  });

  it('replays a closed chat, then ends', async () => {
    await store(2);
    await testDb.db.update(workbenchChats).set({ closedAt: new Date() }).where(eq(workbenchChats.id, chatId));
    const stream = await openStream(`/chats/${chatId}/events/stream`);
    await vi.waitFor(() => expect(stream.closed()).toBe(true));
    expect(transcriptSeqs(stream)).toEqual([1, 2]);
    expect(stream.frames.at(-1)).toEqual({ event: 'end', data: { reason: 'chat_closed' } });
  });

  it('ends when the session is deleted', async () => {
    const stream = await openStream(`/chats/${chatId}/events/stream`);
    await new Promise((r) => setTimeout(r, 20));
    broadcastToWorkspace('ws-a', { type: 'workbench:deleted', payload: { id: sessionId }, timestamp: '' } as never);
    await vi.waitFor(() => expect(stream.frames.at(-1)).toEqual({ event: 'end', data: { reason: 'session_deleted' } }));
  });

  it('refuses a Last-Event-ID that is not a seq', async () => {
    const stream = await openStream(`/chats/${chatId}/events/stream`, { 'last-event-id': 'abc' });
    expect(stream.status).toBe(400);
    expect((await stream.body()).error.param).toBe('Last-Event-ID');
  });

  it(`holds at most ${MAX_STREAMS_PER_TOKEN} streams per token, and frees a slot on disconnect`, async () => {
    const streams: OpenStream[] = [];
    for (let i = 0; i < MAX_STREAMS_PER_TOKEN; i++) streams.push(await openStream(`/chats/${chatId}/events/stream`));
    expect(streams.every((s) => s.status === 200)).toBe(true);
    const refused = await openStream(`/chats/${chatId}/events/stream`);
    expect(refused.status).toBe(429);
    expect((await refused.body()).error.code).toBe('too_many_streams');
    streams[0].close();
    await vi.waitFor(() => expect(openStreamCountForTests(tokenId)).toBe(MAX_STREAMS_PER_TOKEN - 1));
    const again = await openStream(`/chats/${chatId}/events/stream`);
    expect(again.status).toBe(200);
    for (const s of [...streams, again]) s.close();
    await vi.waitFor(() => expect(openStreamCountForTests(tokenId)).toBe(0));
  });
});

describe('the session stream', () => {
  it('starts with the session, then sends session and chat changes', async () => {
    const stream = await openStream(`/sessions/${sessionId}/stream`);
    await vi.waitFor(() => expect(stream.frames[0]).toMatchObject({ event: 'session.updated', data: { object: 'session', id: sessionId, status: 'ready' } }));

    await testDb.db.update(workbenches).set({ status: 'moving' }).where(eq(workbenches.id, sessionId));
    broadcastToWorkspace('ws-a', { type: 'workbench:updated', payload: { workbench: { id: sessionId } }, timestamp: '' } as never);
    await vi.waitFor(() => expect(stream.frames.at(-1)).toMatchObject({ event: 'session.updated', data: { status: 'moving' } }));

    broadcastToWorkspace('ws-a', { type: 'workbench:chat', payload: { chat: { id: chatId, workbenchId: sessionId } }, timestamp: '' } as never);
    await vi.waitFor(() => expect(stream.frames.at(-1)).toMatchObject({ event: 'chat.updated', data: { id: chatId } }));
    // Another session's change is not this stream's.
    broadcastToWorkspace('ws-a', { type: 'workbench:updated', payload: { workbench: { id: 'someone-else' } }, timestamp: '' } as never);
    await new Promise((r) => setTimeout(r, 30));
    expect(stream.frames.every((f) => f.event !== 'session.updated' || f.data.id === sessionId)).toBe(true);
    stream.close();
  });
});
