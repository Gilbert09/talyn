import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import type { Task } from '@talyn/shared';
import { taskRoutes } from '../../routes/tasks.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  tasks as tasksTable,
} from '../../db/schema.js';

/**
 * The task LIST endpoint (`GET /tasks`) must never ship the `transcript` blob —
 * it projects that column away in SQL (it's the cloud-run conversation log,
 * often MBs) so it's never pulled out of Postgres just to be discarded. The
 * single-task GET (`GET /tasks/:id`) is the only endpoint that returns it.
 */

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/tasks', requireAuth, taskRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}

const headers = internalProxyHeaders(TEST_USER_ID);
const TRANSCRIPT = [
  { type: 'message', role: 'assistant', content: 'x'.repeat(1000) },
  { type: 'message', role: 'assistant', content: 'y'.repeat(1000) },
];

describe('GET /tasks — list never returns the transcript', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    await db.insert(tasksTable).values({
      id: 't1',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'completed',
      priority: 'medium',
      title: 'Has a transcript',
      description: 'desc',
      result: { summary: 'done' },
      metadata: { foo: 'bar' },
      transcript: TRANSCRIPT,
    });
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    await close();
    await cleanup();
  });

  it('omits transcript from the list payload but keeps the other fields', async () => {
    const res = await fetch(`${url}/tasks?workspaceId=ws1`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Task[] };

    expect(body.data).toHaveLength(1);
    const [task] = body.data;
    expect(task.id).toBe('t1');
    expect(task.transcript).toBeUndefined();
    // Other fields still serialize — the projection only drops the transcript.
    expect(task.title).toBe('Has a transcript');
    expect(task.result).toEqual({ summary: 'done' });
    expect(task.metadata).toEqual({ foo: 'bar' });
    // Belt-and-braces: the heavy blob isn't anywhere in the serialized list.
    expect(JSON.stringify(body.data)).not.toContain('xxxxxxxxxx');
  });

  it('still returns the transcript from the single-task GET', async () => {
    const res = await fetch(`${url}/tasks/t1`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Task };
    expect(body.data.transcript).toEqual(TRANSCRIPT);
  });
});

/**
 * Pagination for the desktop task list: a comma-separated `status` filter (so
 * the client fetches all active statuses in one call), and `limit` + `before`
 * cursor to lazily page the finished history newest-first.
 */
describe('GET /tasks — status filter + cursor pagination', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;

  const day = (n: number) => new Date(`2026-06-${String(n).padStart(2, '0')}T00:00:00Z`);

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    const mk = (id: string, status: string, d: number) => ({
      id,
      workspaceId: 'ws1',
      type: 'code_writing',
      status,
      priority: 'medium',
      title: id,
      description: '',
      createdAt: day(d),
    });
    // 5 finished (days 1–5) + 2 active (days 6–7).
    await db.insert(tasksTable).values([
      mk('c1', 'completed', 1),
      mk('c2', 'completed', 2),
      mk('c3', 'completed', 3),
      mk('c4', 'failed', 4),
      mk('c5', 'cancelled', 5),
      mk('a1', 'in_progress', 6),
      mk('a2', 'queued', 7),
    ]);
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    await close();
    await cleanup();
  });

  const list = async (qs: string): Promise<Task[]> => {
    const res = await fetch(`${url}/tasks?${qs}`, { headers });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Task[] }).data;
  };
  const HISTORY = 'status=completed,failed,cancelled';

  it('filters by a comma-separated status list', async () => {
    const active = await list('workspaceId=ws1&status=pending,queued,in_progress');
    expect(active.map((t) => t.id).sort()).toEqual(['a1', 'a2']);
  });

  it('returns a createdAt-desc page capped at limit', async () => {
    const page = await list(`workspaceId=ws1&${HISTORY}&limit=2`);
    expect(page.map((t) => t.id)).toEqual(['c5', 'c4']); // newest first
  });

  it('walks older history with the before cursor (strictly older)', async () => {
    const page2 = await list(
      `workspaceId=ws1&${HISTORY}&limit=2&before=${encodeURIComponent(day(4).toISOString())}`,
    );
    expect(page2.map((t) => t.id)).toEqual(['c3', 'c2']);
  });

  it('a full page means more may remain; a short/empty page ends the walk', async () => {
    const first = await list(`workspaceId=ws1&${HISTORY}&limit=5`);
    expect(first).toHaveLength(5); // exactly the history rows
    const beyond = await list(
      `workspaceId=ws1&${HISTORY}&limit=5&before=${encodeURIComponent(day(1).toISOString())}`,
    );
    expect(beyond).toHaveLength(0); // nothing older than the oldest
  });

  it('clamps an oversized limit rather than dumping the table', async () => {
    // limit is capped at 100 — a bogus huge value still returns at most the rows.
    const page = await list(`workspaceId=ws1&${HISTORY}&limit=99999`);
    expect(page).toHaveLength(5);
  });
});
