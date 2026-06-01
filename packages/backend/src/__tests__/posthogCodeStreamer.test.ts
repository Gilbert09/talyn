import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The streamer resolves its PostHog client via the credentials module;
// mock it so we can feed a scripted SSE body / session-log backfill.
const mockClient = {
  openRunStream: vi.fn(),
  getSessionLogs: vi.fn(),
};
vi.mock('../services/posthogCode/credentials.js', () => ({
  getPostHogCodeClient: vi.fn(async () => mockClient),
}));

import { eq } from 'drizzle-orm';
import { postHogCodeStreamer } from '../services/posthogCode/streamer.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import * as schema from '../db/schema.js';
import type { Database } from '../db/client.js';
import type { AgentEvent } from '@fastowl/shared';

const WS = 'ws-1';
const TASK = 'task-1';

/** Build a ReadableStream that emits the given SSE frames then closes. */
function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

/**
 * A stream that emits the given frames then stays open (never closes), so
 * the streamer tails it without hitting its periodic-persist threshold —
 * lets us exercise flushNow() on a live, mid-run stream.
 */
function openSseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      // intentionally no close()
    },
  });
}

/** A minimal `fetch` Response stand-in carrying the scripted SSE body. */
function sseResponse(frames: string[]): Partial<Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: sseStream(frames),
  };
}

function acpFrame(update: Record<string, unknown>, id: string): string {
  const entry = { type: 'notification', notification: { method: 'session/update', params: { update } } };
  return `id: ${id}\ndata: ${JSON.stringify(entry)}\n\n`;
}

async function seedTask(db: Database): Promise<void> {
  await seedUser(db);
  await db.insert(schema.workspaces).values({ id: WS, ownerId: 'user-test', name: 'WS' });
  await db.insert(schema.tasks).values({
    id: TASK,
    workspaceId: WS,
    type: 'code_writing',
    status: 'in_progress',
    title: 'T',
    description: 'D',
  });
}

async function getTranscript(db: Database): Promise<AgentEvent[]> {
  const rows = await db.select({ transcript: schema.tasks.transcript }).from(schema.tasks).where(eq(schema.tasks.id, TASK));
  return (rows[0]?.transcript as AgentEvent[]) ?? [];
}

/** Poll the DB until the persisted transcript is non-empty (or timeout). */
async function waitForTranscript(db: Database, timeoutMs = 2000): Promise<AgentEvent[]> {
  const start = Date.now();
  for (;;) {
    const t = await getTranscript(db);
    if (t.length > 0) return t;
    if (Date.now() - start > timeoutMs) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('postHogCodeStreamer', () => {
  let cleanup: () => Promise<void>;
  let db: Database;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    cleanup = ctx.cleanup;
    mockClient.openRunStream.mockReset();
    mockClient.getSessionLogs.mockReset();
    await seedTask(db);
  });

  afterEach(async () => {
    postHogCodeStreamer.shutdownAll();
    await cleanup();
  });

  it('consumes the SSE stream, persists a transcript, and stamps ordered seqs', async () => {
    mockClient.openRunStream.mockResolvedValue(
      sseResponse([
        acpFrame({ sessionUpdate: 'agent_message', content: { text: 'Hello' } }, '1-0'),
        acpFrame({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', rawInput: { command: 'ls' } }, '2-0'),
        acpFrame({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: 'a.txt' }, '3-0'),
        'event: keepalive\ndata: {"type":"keepalive"}\n\n',
      ]),
    );

    postHogCodeStreamer.ensure({ taskId: TASK, workspaceId: WS, posthogTaskId: 'pt', posthogRunId: 'pr' });
    const transcript = await waitForTranscript(db);

    // assistant(text) → assistant(tool_use) → user(tool_result), plus the
    // converter's flush of any trailing text (none here).
    const types = transcript.map((e) => e.type);
    expect(types).toEqual(['assistant', 'assistant', 'user']);
    expect(transcript.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(mockClient.openRunStream).toHaveBeenCalledOnce();

    // tool_use / tool_result pair on the same id so the renderer can collapse them.
    const toolUse = (transcript[1].message as { content: Array<{ id: string }> }).content[0];
    const toolResult = (transcript[2].message as { content: Array<{ tool_use_id: string }> }).content[0];
    expect(toolResult.tool_use_id).toBe(toolUse.id);
  });

  it('is idempotent — a concurrent second ensure does not reopen the stream', async () => {
    mockClient.openRunStream.mockResolvedValue(
      sseResponse([acpFrame({ sessionUpdate: 'agent_message', content: { text: 'hi' } }, '1-0')]),
    );

    // The second ensure runs while the first is still active (the stream
    // is registered synchronously), so it must be a no-op.
    postHogCodeStreamer.ensure({ taskId: TASK, workspaceId: WS, posthogTaskId: 'pt', posthogRunId: 'pr' });
    postHogCodeStreamer.ensure({ taskId: TASK, workspaceId: WS, posthogTaskId: 'pt', posthogRunId: 'pr' });
    await waitForTranscript(db);

    expect(mockClient.openRunStream).toHaveBeenCalledOnce();
  });

  it('falls back to the durable session-log backfill when the live stream is unavailable', async () => {
    mockClient.openRunStream.mockRejectedValue(new Error('PostHog Code stream open failed (404): Stream not available'));
    mockClient.getSessionLogs.mockResolvedValue([
      { type: 'notification', notification: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message', content: { text: 'from S3' } } } } },
    ]);

    postHogCodeStreamer.ensure({ taskId: TASK, workspaceId: WS, posthogTaskId: 'pt', posthogRunId: 'pr' });
    const transcript = await waitForTranscript(db);

    expect(mockClient.getSessionLogs).toHaveBeenCalledOnce();
    expect(transcript).toHaveLength(1);
    const text = (transcript[0].message as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe('from S3');
  });

  it('flushNow() persists the in-memory transcript of a live stream mid-run', async () => {
    // Two events — below PERSIST_EVERY (25), so the stream would not persist
    // on its own. The body stays open (in-progress run still tailing).
    mockClient.openRunStream.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: openSseStream([
        acpFrame({ sessionUpdate: 'agent_message', content: { text: 'one' } }, '1-0'),
        acpFrame({ sessionUpdate: 'agent_message', content: { text: 'two' } }, '2-0'),
      ]),
    });

    postHogCodeStreamer.ensure({ taskId: TASK, workspaceId: WS, posthogTaskId: 'pt', posthogRunId: 'pr' });

    // The stream never closes, so it won't auto-persist; poll flushNow until
    // the processed events land in the DB (or time out).
    const start = Date.now();
    let transcript = await getTranscript(db);
    while (transcript.length < 2 && Date.now() - start < 2000) {
      await postHogCodeStreamer.flushNow(TASK);
      transcript = await getTranscript(db);
      if (transcript.length < 2) await new Promise((r) => setTimeout(r, 25));
    }

    expect(transcript.map((e) => (e.message as { content: Array<{ text: string }> }).content[0].text)).toEqual([
      'one',
      'two',
    ]);
  });

  it('flushNow() is a harmless no-op when no stream is active', async () => {
    await expect(postHogCodeStreamer.flushNow('no-such-task')).resolves.toBeUndefined();
  });

  it('pages through session_logs with `after` until a short page drains the run', async () => {
    mockClient.openRunStream.mockRejectedValue(new Error('(404): Stream not available'));
    // A full 5000-entry first page (forces a second fetch), then a short
    // page that ends pagination. Only two entries carry visible text.
    const PAGE = 5000;
    const firstPage = Array.from({ length: PAGE }, (_, i) => ({
      type: 'notification',
      timestamp: `2026-01-01T00:00:${String(i).padStart(4, '0')}Z`,
      notification: { method: 'session/update', params: { update: { sessionUpdate: 'usage_update' } } },
    }));
    firstPage[0].notification.params.update = { sessionUpdate: 'agent_message', content: { text: 'p1' } };
    const lastTs = firstPage[PAGE - 1].timestamp;
    const secondPage = [
      {
        type: 'notification',
        timestamp: '2026-01-02T00:00:00Z',
        notification: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message', content: { text: 'p2' } } } },
      },
    ];
    mockClient.getSessionLogs.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);

    postHogCodeStreamer.ensure({ taskId: TASK, workspaceId: WS, posthogTaskId: 'pt', posthogRunId: 'pr' });
    const transcript = await waitForTranscript(db);

    expect(mockClient.getSessionLogs).toHaveBeenCalledTimes(2);
    // Second fetch resumes after the last timestamp of the first page.
    expect(mockClient.getSessionLogs.mock.calls[1][2]).toMatchObject({ after: lastTs });
    expect(transcript.map((e) => (e.message as { content: Array<{ text: string }> }).content[0].text)).toEqual(['p1', 'p2']);
  });
});
