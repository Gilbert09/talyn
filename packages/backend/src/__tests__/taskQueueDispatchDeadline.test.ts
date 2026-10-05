import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskQueueService, MAX_DISPATCH_MS } from '../services/taskQueue.js';
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
 * One task must not break the queue for the others.
 *
 * `dispatchQueuedTasks` walks its due tasks serially inside one advisory lock.
 * It had a per-task try/catch, so a dispatch that THREW was already isolated —
 * but nothing at all bounded a dispatch that simply never came back, and that
 * starves the queue just as completely and for much longer.
 *
 * On 2026-10-05 a fleet host spent eight minutes refusing every boot. One
 * dispatch hung on it; the tick's 300s lock budget ran out; the watchdog
 * abandoned the tick; the next tick started from the same head task and did it
 * again. Twenty-one tasks behind that one task were never even attempted,
 * across three consecutive ticks. Tom's words for it: "one task broke the queue
 * for all the others".
 *
 * Pinned here as the property, not the incident: a task that hangs is bounded,
 * counted as a failed attempt so the existing exponential backoff takes it out
 * of the next few ticks, and the tasks behind it still get dispatched.
 */
function fakeProvider(dispatch: CloudTaskProvider['dispatch']): CloudTaskProvider {
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
  await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
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

async function insertQueuedTask(db: Database, id: string, createdAt: Date): Promise<void> {
  await db.insert(tasksTable).values({
    id,
    workspaceId: 'ws1',
    type: 'code_writing',
    status: 'queued',
    priority: 'medium',
    title: id,
    description: 'd',
    prompt: 'do',
    repositoryId: 'repo1',
    assignedEnvironmentId: 'cloud1',
    createdAt,
    updatedAt: createdAt,
  });
}

async function readTask(db: Database, id: string) {
  const rows = await db
    .select({ status: tasksTable.status, metadata: tasksTable.metadata })
    .from(tasksTable)
    .where(eq(tasksTable.id, id));
  return { status: rows[0]!.status, metadata: (rows[0]!.metadata as Record<string, unknown>) ?? {} };
}

describe('taskQueueService — a hung dispatch must not starve the queue', () => {
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
    vi.useRealTimers();
    taskQueueService.shutdown();
    taskQueueService.resetForTests();
    if (originalProvider) registerCloudProvider(originalProvider);
    await cleanup();
    vi.restoreAllMocks();
  });

  it('bounds the hung task and still dispatches the ones behind it', async () => {
    const base = Date.now();
    await insertQueuedTask(db, 'hangs', new Date(base - 3000));
    await insertQueuedTask(db, 'behind-1', new Date(base - 2000));
    await insertQueuedTask(db, 'behind-2', new Date(base - 1000));

    const seen: string[] = [];
    registerCloudProvider(
      fakeProvider(async (task) => {
        seen.push(task.id);
        // The hung host: a promise that never settles, exactly like a create
        // sitting on a socket that no longer answers.
        if (task.id === 'hangs') return new Promise(() => {});
        return { ok: true as const };
      })
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    const tick = taskQueueService.processQueue();
    await vi.advanceTimersByTimeAsync(MAX_DISPATCH_MS + 1_000);
    await tick;

    // The whole point: the two tasks behind the hung one were attempted.
    expect(seen).toContain('behind-1');
    expect(seen).toContain('behind-2');

    // And the hung one is counted as a failed attempt, so the existing
    // exponential backoff keeps it out of the next few ticks rather than
    // letting it re-hang the queue every five seconds.
    const hung = await readTask(db, 'hangs');
    expect(hung.status).toBe('queued');
    expect(hung.metadata.dispatchAttempts).toBe(1);
    expect(typeof hung.metadata.nextDispatchAttemptAt).toBe('string');
    const err = hung.metadata.lastScheduleError as { reason: string } | undefined;
    expect(err?.reason).toMatch(/exceeded .*ms and was abandoned/);
  });

  // The deadline must not fire on a dispatch that is merely working. A bound
  // that trips on healthy traffic would turn a slow provider into a queue that
  // never dispatches anything at all.
  it('leaves a dispatch that finishes inside the deadline alone', async () => {
    await insertQueuedTask(db, 'slow-but-fine', new Date(Date.now() - 1000));
    registerCloudProvider(
      fakeProvider(async () => {
        await new Promise((r) => setTimeout(r, 25));
        return { ok: true as const };
      })
    );

    await taskQueueService.processQueue();

    const t = await readTask(db, 'slow-but-fine');
    expect(t.metadata.dispatchAttempts).toBeUndefined();
    expect(t.metadata.lastScheduleError).toBeUndefined();
  });
});
