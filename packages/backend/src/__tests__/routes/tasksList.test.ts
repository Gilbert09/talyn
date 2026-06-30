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
