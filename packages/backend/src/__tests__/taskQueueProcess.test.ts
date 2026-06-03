import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskQueueService } from '../services/taskQueue.js';
import {
  registerCloudProvider,
  getCloudProvider,
} from '../services/cloudProviders/registry.js';
import type { CloudTaskProvider } from '../services/cloudProviders/types.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  environments as environmentsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
} from '../db/schema.js';

/**
 * Build a fake PostHog Code provider whose `dispatch` is a spy, so the
 * scheduler can be tested without touching the real cloud client. We
 * register it under the real `posthog_code` type and restore the original
 * provider afterwards.
 */
function fakeProvider(
  dispatch: CloudTaskProvider['dispatch']
): CloudTaskProvider {
  return {
    type: 'posthog_code',
    displayName: 'Fake PostHog Code',
    validateCredentials: vi.fn(async () => ({ ok: true })),
    hasCredentials: vi.fn(async () => true),
    removeCredentials: vi.fn(async () => {}),
    dispatch,
    reconcile: vi.fn(async () => {}),
    stopStreaming: vi.fn(() => {}),
  };
}

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({
    id: 'ws1',
    ownerId: TEST_USER_ID,
    name: 'ws',
    settings: {},
  });
  await db.insert(environmentsTable).values({
    id: 'cloud1',
    ownerId: TEST_USER_ID,
    name: 'PostHog Code',
    type: 'posthog_code',
    status: 'connected',
    config: { type: 'posthog_code' },
  });
  await db.insert(repositoriesTable).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: 'a/b',
    url: 'https://github.com/a/b',
    defaultBranch: 'main',
  });
}

async function insertQueuedTask(
  db: Database,
  overrides: Partial<{
    id: string;
    status: string;
    repositoryId: string | null;
    assignedEnvironmentId: string | null;
  }> = {}
): Promise<string> {
  const id = overrides.id ?? `t-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date();
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'code_writing',
    status: overrides.status ?? 'queued',
    priority: 'medium',
    title: `task-${id}`,
    description: 'd',
    prompt: 'do',
    repositoryId:
      overrides.repositoryId === undefined ? 'repo1' : overrides.repositoryId,
    assignedEnvironmentId:
      overrides.assignedEnvironmentId === undefined
        ? 'cloud1'
        : overrides.assignedEnvironmentId,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe('taskQueueService.processQueue (cloud dispatch)', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let originalProvider: CloudTaskProvider | null;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);
    originalProvider = getCloudProvider('posthog_code');
  });

  afterEach(async () => {
    taskQueueService.shutdown();
    taskQueueService.resetForTests();
    if (originalProvider) registerCloudProvider(originalProvider);
    await cleanup();
    vi.restoreAllMocks();
  });

  it('no-ops when the queue is empty', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeProvider(dispatch));
    await taskQueueService.processQueue();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches a queued task to its cloud provider', async () => {
    const id = await insertQueuedTask(db);
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeProvider(dispatch));

    await taskQueueService.processQueue();

    expect(dispatch).toHaveBeenCalledTimes(1);
    const [task, env] = dispatch.mock.calls[0];
    expect(task.id).toBe(id);
    expect(env.id).toBe('cloud1');
    expect(env.type).toBe('posthog_code');
  });

  it('rolls the task back to queued + writes lastScheduleError when dispatch fails', async () => {
    const id = await insertQueuedTask(db);
    registerCloudProvider(
      fakeProvider(vi.fn(async () => ({ ok: false as const, error: 'no api key' })))
    );

    await taskQueueService.processQueue();

    const rows = await db
      .select({ status: tasksTable.status, metadata: tasksTable.metadata })
      .from(tasksTable)
      .where(eq(tasksTable.id, id));
    expect(rows[0].status).toBe('queued');
    const meta = rows[0].metadata as { lastScheduleError?: { reason?: string } };
    expect(meta.lastScheduleError?.reason).toMatch(/no api key/);
  });

  it('skips a task with no assigned cloud env', async () => {
    await insertQueuedTask(db, { assignedEnvironmentId: null });
    const dispatch = vi.fn(async () => ({ ok: true as const }));
    registerCloudProvider(fakeProvider(dispatch));

    await taskQueueService.processQueue();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
