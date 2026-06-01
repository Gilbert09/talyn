import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';

// Mock the PostHog client + streamer the message route depends on.
// vi.hoisted so the mock factories (also hoisted) can reference them.
const { fakeClient, streamer } = vi.hoisted(() => ({
  fakeClient: { getTask: vi.fn(), resumeRun: vi.fn(), sendRunCommand: vi.fn() },
  streamer: { ensure: vi.fn(), stop: vi.fn(), flushNow: vi.fn(async () => {}) },
}));
vi.mock('../../services/posthogCode/credentials.js', () => ({
  getPostHogCodeClient: vi.fn(async () => fakeClient),
}));
vi.mock('../../services/posthogCode/streamer.js', () => ({
  postHogCodeStreamer: streamer,
}));

import { taskRoutes } from '../../routes/tasks.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../../db/schema.js';

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

const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };

async function seedCloudTask(
  db: Database,
  over: { status?: string; metadata?: Record<string, unknown>; transcript?: unknown } = {}
): Promise<string> {
  const now = new Date();
  const id = 't-cloud';
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'pr_response',
    status: over.status ?? 'completed',
    priority: 'medium',
    title: 'Cloud task',
    description: 'desc',
    repositoryId: 'repo1',
    metadata: over.metadata ?? { posthogTaskId: 'pt1', posthogRunId: 'run1' },
    transcript: (over.transcript as object) ?? null,
    completedAt: over.status === 'completed' ? now : null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('POST /tasks/:id/message — PostHog Code follow-ups', () => {
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
    await db.insert(repositoriesTable).values({
      id: 'repo1', workspaceId: 'ws1', name: 'acme/widgets',
      url: 'https://github.com/acme/widgets', defaultBranch: 'main',
    });
    fakeClient.getTask.mockReset();
    fakeClient.resumeRun.mockReset();
    fakeClient.sendRunCommand.mockReset();
    streamer.ensure.mockReset();
    streamer.stop.mockReset();
    const s = await makeServer();
    url = s.url;
    close = s.close;
  });

  afterEach(async () => {
    await close();
    await cleanup();
  });

  const post = (id: string, body: unknown) =>
    fetch(`${url}/tasks/${id}/message`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('resumes a finished run with the message + model/effort and flips to in_progress', async () => {
    fakeClient.getTask.mockResolvedValue({ id: 'pt1', latest_run: { id: 'run1', status: 'completed' } });
    fakeClient.resumeRun.mockResolvedValue({ id: 'pt1', latest_run: { id: 'run2', status: 'queued' } });
    const taskId = await seedCloudTask(db, { status: 'completed' });

    const res = await post(taskId, { message: '  please also add a test  ', model: 'claude-opus-4-8', reasoningEffort: 'max' });
    expect(res.status).toBe(200);

    expect(fakeClient.resumeRun).toHaveBeenCalledWith('pt1', expect.objectContaining({
      resumeFromRunId: 'run1',
      message: 'please also add a test',
      model: 'claude-opus-4-8',
      reasoningEffort: 'max',
    }));
    expect(fakeClient.sendRunCommand).not.toHaveBeenCalled();

    const [row] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    expect(row.status).toBe('in_progress');
    expect(row.completedAt).toBeNull();
    expect((row.metadata as { posthogRunId: string }).posthogRunId).toBe('run2');
    // User message echoed into the transcript.
    const t = row.transcript as Array<{ type: string; message: { content: Array<{ text: string }> } }>;
    expect(t[t.length - 1].message.content[0].text).toBe('please also add a test');

    // Streamer re-armed for the new run, seeded with prior history.
    expect(streamer.stop).toHaveBeenCalledWith(taskId);
    expect(streamer.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ posthogRunId: 'run2', seedTranscript: expect.any(Array) })
    );
  });

  it('injects a user_message into a live run without resuming', async () => {
    fakeClient.getTask.mockResolvedValue({ id: 'pt1', latest_run: { id: 'run1', status: 'in_progress' } });
    const taskId = await seedCloudTask(db, { status: 'in_progress' });

    const res = await post(taskId, { message: 'tweak the copy' });
    expect(res.status).toBe(200);

    expect(fakeClient.sendRunCommand).toHaveBeenCalledWith('pt1', 'run1', {
      method: 'user_message',
      params: { content: 'tweak the copy' },
    });
    expect(fakeClient.resumeRun).not.toHaveBeenCalled();
    expect(streamer.ensure).not.toHaveBeenCalled();
  });

  it('rejects an empty message', async () => {
    const taskId = await seedCloudTask(db);
    const res = await post(taskId, { message: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-cloud task', async () => {
    const now = new Date();
    await db.insert(tasksTable).values({
      id: 't-local', workspaceId: 'ws1', type: 'code_writing', status: 'completed',
      priority: 'medium', title: 'local', description: 'd', repositoryId: 'repo1',
      metadata: {}, createdAt: now, updatedAt: now,
    });
    const res = await post('t-local', { message: 'hi' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not a posthog code task/i);
  });
});
