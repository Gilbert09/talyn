import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { taskRoutes } from '../../routes/tasks.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { internalProxyHeaders, requireAuth } from '../../middleware/auth.js';
import { createCloudTask, TaskReferenceError } from '../../services/taskCreate.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { repositories, pullRequests, tasks, workspaces } from '../../db/schema.js';

const serverMetadata = {
  cloudTask: { provider: 'selfhosted', remoteTaskId: 'own-sandbox', extra: { host: 'host1', llm: 'anthropic' } },
  posthogTaskId: 'own-posthog-task',
  posthogRunId: 'own-posthog-run',
  pullRequest: { id: 'pr1' },
  runAttempt: 2,
  model: 'old-model',
};
const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };

describe('task tenant isolation', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let close: () => Promise<void>;
  let url: string;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    await seedUser(db, { id: 'other-user' });
    await db.insert(workspaces).values([
      { id: 'ws1', ownerId: TEST_USER_ID, name: 'mine' },
      { id: 'ws2', ownerId: 'other-user', name: 'theirs' },
    ]);
    await db.insert(repositories).values([
      { id: 'repo1', workspaceId: 'ws1', name: 'acme/one', url: 'https://github.com/acme/one' },
      { id: 'repo2', workspaceId: 'ws2', name: 'private/two', url: 'https://github.com/private/two' },
      { id: 'repo3', workspaceId: 'ws1', name: 'acme/three', url: 'https://github.com/acme/three' },
    ]);
    await db.insert(pullRequests).values([
      { id: 'pr1', workspaceId: 'ws1', repositoryId: 'repo1', owner: 'acme', repo: 'one', number: 1, state: 'open' },
      { id: 'pr2', workspaceId: 'ws2', repositoryId: 'repo2', owner: 'private', repo: 'two', number: 2, state: 'open' },
      { id: 'pr3', workspaceId: 'ws1', repositoryId: 'repo3', owner: 'acme', repo: 'three', number: 3, state: 'open' },
    ]);
    await db.insert(tasks).values([
      { id: 'task1', workspaceId: 'ws1', repositoryId: 'repo1', pullRequestId: 'pr1', type: 'pr_response', status: 'completed', title: 'mine', description: '', metadata: serverMetadata },
      { id: 'task2', workspaceId: 'ws2', repositoryId: 'repo2', pullRequestId: 'pr2', type: 'pr_response', status: 'completed', title: 'theirs', description: '', metadata: { secret: 'other-tenant' } },
    ]);
    const app = express();
    app.use(express.json());
    app.use('/tasks', requireAuth, wrapAsyncRoutes(taskRoutes()));
    app.use(apiErrorHandler);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tasks`;
    close = () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });

  afterEach(async () => {
    await close();
    await cleanup();
  });

  it.each([
    { cloudTask: { provider: 'selfhosted', remoteTaskId: 'other-sandbox' } },
    { cloudTask: { provider: 'posthog_code', remoteTaskId: 'other-task', remoteRunId: 'other-run' } },
    { posthogTaskId: 'other-task' },
    { posthogRunId: 'other-run' },
    { posthogProjectId: 999 },
    { posthogHost: 'https://other.invalid' },
    { pullRequest: { id: 'pr2' } },
    { runAttempt: 100 },
    { workflow: { workflowId: 'foreign-workflow' } },
    { unknown: true },
    { model: 'new-model', posthogTaskId: 'other-task' },
    { model: { remoteTaskId: 'other-task' } },
    { runtimeAdapter: 'unsupported' },
    null,
    [],
    'invalid',
  ].map((metadata) => ({ metadata })))('rejects unsafe metadata $metadata without changing either tenant', async ({ metadata }) => {
    const before = await db.select().from(tasks);
    const res = await fetch(`${url}/task1`, {
      method: 'PATCH', headers, body: JSON.stringify({ metadata, title: 'must not change' }),
    });
    expect(res.status).toBe(400);
    expect(await db.select().from(tasks)).toEqual(before);
  });

  it('merges supported settings without removing server metadata', async () => {
    const res = await fetch(`${url}/task1`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ metadata: { model: 'new-model', runtimeAdapter: 'codex' } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.metadata).toEqual({ ...serverMetadata, model: 'new-model', runtimeAdapter: 'codex' });
    const empty = await fetch(`${url}/task1`, { method: 'PATCH', headers, body: JSON.stringify({ metadata: {} }) });
    expect((await empty.json()).data.metadata.cloudTask).toEqual(serverMetadata.cloudTask);
  });

  it('denies edits to another tenant task', async () => {
    const res = await fetch(`${url}/task2`, {
      method: 'PATCH', headers, body: JSON.stringify({ metadata: { model: 'new-model' } }),
    });
    expect(res.status).toBe(404);
  });

  it.each([
    { repositoryId: 'repo2' },
    { repositoryId: 'missing' },
    { repositoryId: 'repo1', pullRequestId: 'pr2' },
    { repositoryId: 'repo1', pullRequestId: 'pr3' },
    { repositoryId: 'repo1', pullRequestId: 'missing' },
    { repositoryId: 'repo2', pullRequestId: 'pr1' },
  ])('rejects foreign or mismatched references %j before insert or reuse', async (references) => {
    const input = {
      workspaceId: 'ws1', type: 'pr_response' as const, title: 'must not change', description: '', ...references,
    };
    const before = await db.select().from(tasks);
    const prsBefore = await db.select().from(pullRequests);
    await expect(createCloudTask(input)).rejects.toBeInstanceOf(TaskReferenceError);
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(res.status).toBe(400);
    expect(await db.select().from(tasks)).toEqual(before);
    expect(await db.select().from(pullRequests)).toEqual(prsBefore);
  });

  it('validates before reusing a previously malformed task', async () => {
    await db.update(tasks).set({ pullRequestId: 'pr2' }).where(eq(tasks.id, 'task1'));
    await expect(createCloudTask({
      workspaceId: 'ws1', repositoryId: 'repo1', pullRequestId: 'pr2',
      type: 'pr_response', title: 'must not change', description: '',
    })).rejects.toBeInstanceOf(TaskReferenceError);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, 'task1'));
    expect(row.status).toBe('completed');
    expect(row.metadata).toEqual(serverMetadata);
  });
});
