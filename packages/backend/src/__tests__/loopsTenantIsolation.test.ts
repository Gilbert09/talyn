import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyDataApiRevocations, createTestDb, seedUser } from './helpers/testDb.js';
import { loopRuns, loops, pullRequests, repositories, tasks, workspaces } from '../db/schema.js';
import { getLoopRun, listLoopRuns } from '../services/loops/store.js';
import { activeRunsWithTaskStatus } from '../services/loops/runs.js';
import { loopScheduler } from '../services/loops/scheduler.js';
import { domainEvents } from '../services/events.js';
import { emitLoopRun } from '../services/websocket.js';

vi.mock('../services/websocket.js', () => ({ emitLoopRun: vi.fn() }));

describe('loop run tenant isolation', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  const loop = {
    id: 'loop-a', workspaceId: 'ws-a', name: 'A', prompt: 'Test', enabled: false,
    cron: '0 9 * * *', timezone: 'UTC', provider: 'posthog_code',
    model: 'claude-opus-5', repoFullName: 'a/a', consecutiveFailures: 2,
  };
  const run = {
    id: 'run-a', loopId: 'loop-a', workspaceId: 'ws-a', scheduledFor: new Date(0),
    repoFullName: 'a/a', provider: 'posthog_code', model: 'claude-opus-5', status: 'queued',
    dispatchedAt: new Date(0),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('LOOPS_ENABLED', 'true');
    testDb = await createTestDb();
    await applyDataApiRevocations(testDb.pglite);
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
      { id: 'ws-c', ownerId: 'owner-a', name: 'Same owner, different workspace' },
    ]);
    for (const suffix of ['a', 'b', 'c']) {
      await testDb.db.insert(repositories).values({
        id: `repo-${suffix}`, workspaceId: `ws-${suffix}`, name: `${suffix}/${suffix}`,
        url: `https://github.com/${suffix}/${suffix}`,
      });
      await testDb.db.insert(pullRequests).values({
        id: `pr-${suffix}`, workspaceId: `ws-${suffix}`, repositoryId: `repo-${suffix}`,
        owner: suffix, repo: suffix, number: 123, state: 'open',
      });
      await testDb.db.insert(tasks).values({
        id: `task-${suffix}`, workspaceId: `ws-${suffix}`, repositoryId: `repo-${suffix}`,
        pullRequestId: `pr-${suffix}`, type: 'code_writing', title: suffix, description: '',
        status: 'completed', completedAt: new Date(0),
      });
    }
    await testDb.db.insert(loops).values(loop);
  });

  afterEach(async () => {
    loopScheduler.stop();
    await testDb.pglite.exec('RESET ROLE');
    await testDb.cleanup();
    vi.unstubAllEnvs();
  });

  it.each(['insert', 'update'] as const)(
    'denies authenticated Data API %s of a foreign task reference', async (operation) => {
      await testDb.db.insert(loopRuns).values({ ...run, taskId: 'task-a' });
      await testDb.pglite.query('SELECT set_config($1, $2, false)', [
        'request.jwt.claim.sub', 'owner-a',
      ]);
      await testDb.pglite.exec('SET ROLE authenticated');
      const query = operation === 'insert'
        ? `INSERT INTO loop_runs
            (id, loop_id, workspace_id, scheduled_for, repo_full_name, provider, model, status, task_id)
           VALUES ('run-foreign', 'loop-a', 'ws-a', now(), 'a/a', 'posthog_code', 'claude-opus-5', 'queued', 'task-b')`
        : `UPDATE loop_runs SET task_id = 'task-b' WHERE id = 'run-a'`;
      await expect(testDb.pglite.query(query)).rejects.toMatchObject({
        code: '42501', message: expect.stringContaining('permission denied'),
      });
    },
  );

  it.each(['a', 'b', 'c'])('filters historical task details by workspace: %s', async (suffix) => {
    await testDb.db.insert(loopRuns).values({ ...run, taskId: `task-${suffix}` });
    const single = await getLoopRun(run.id);
    expect(await listLoopRuns(loop.id, { limit: 50 })).toEqual([single]);
    if (suffix === 'a') {
      expect(single).toMatchObject({
        taskId: 'task-a', task: {
          id: 'task-a', status: 'completed', completedAt: new Date(0).toISOString(),
          prUrl: 'https://github.com/a/a/pull/123', prNumber: 123,
        },
      });
    } else {
      expect(single).toMatchObject({ taskId: null, task: null });
    }
  });

  it.each(['b', 'c'])('hides historical PR details from workspace %s on an owned task', async (suffix) => {
    await testDb.db.update(tasks).set({ pullRequestId: `pr-${suffix}` }).where(eq(tasks.id, 'task-a'));
    await testDb.db.insert(loopRuns).values({ ...run, taskId: 'task-a' });
    const single = await getLoopRun(run.id);
    expect(single).toMatchObject({ taskId: 'task-a', task: { status: 'completed', prUrl: null, prNumber: null } });
    expect(await listLoopRuns(loop.id, { limit: 50 })).toEqual([single]);
  });

  it.each(['b', 'c'])('rejects a run whose workspace %s differs from its loop', async (suffix) => {
    await testDb.db.insert(loopRuns).values({ ...run, workspaceId: `ws-${suffix}`, taskId: `task-${suffix}` });
    expect(await getLoopRun(run.id)).toBeNull();
    expect(await listLoopRuns(loop.id, { limit: 50 })).toEqual([]);
    expect(await activeRunsWithTaskStatus(50)).toEqual([]);
    await loopScheduler.tick();
    expect(emitLoopRun).not.toHaveBeenCalled();
    expect(await testDb.db.select({ status: loopRuns.status }).from(loopRuns)).toEqual([{ status: 'queued' }]);
  });

  it.each(['a', 'b', 'c'].flatMap((suffix) =>
    (['event', 'sweep'] as const).flatMap((path) =>
      (['completed', 'failed', 'in_progress'] as const).map((status) => ({ suffix, path, status })),
    ),
  ))('settles only valid links: workspace=$suffix path=$path status=$status', async ({ suffix, path, status }) => {
    const { db } = testDb;
    await db.update(tasks).set({ status }).where(eq(tasks.id, `task-${suffix}`));
    await db.insert(loopRuns).values({ ...run, taskId: `task-${suffix}` });
    const valid = suffix === 'a';
    if (!valid) {
      // A valid run after the malformed row must still receive the task event.
      await db.insert(loops).values({ ...loop, id: 'loop-valid', workspaceId: `ws-${suffix}` });
      await db.insert(loopRuns).values({
        ...run, id: 'run-valid', loopId: 'loop-valid', workspaceId: `ws-${suffix}`, taskId: `task-${suffix}`,
      });
    }
    const tasksBefore = await db.select().from(tasks);
    if (path === 'event') {
      loopScheduler.init();
      domainEvents.emit('task:status', { workspaceId: `ws-${suffix}`, taskId: `task-${suffix}`, status });
      await vi.waitFor(() => expect(emitLoopRun).toHaveBeenCalledOnce());
    } else {
      await loopScheduler.tick();
    }
    const expectedStatus = status === 'completed' ? 'succeeded' : status === 'in_progress' ? 'running' : 'failed';
    expect(emitLoopRun).toHaveBeenCalledOnce();
    expect(emitLoopRun).toHaveBeenCalledWith(`ws-${suffix}`, expect.objectContaining({
      id: valid ? run.id : 'run-valid', status: expectedStatus, taskId: `task-${suffix}`,
    }));
    const [stored] = await db.select().from(loopRuns).where(eq(loopRuns.id, run.id));
    expect(stored.status).toBe(valid ? expectedStatus : 'queued');
    if (!valid) {
      expect(stored.settledAt).toBeNull();
      const [definition] = await db.select().from(loops).where(eq(loops.id, loop.id));
      expect(definition.consecutiveFailures).toBe(2);
    }
    expect(await db.select().from(tasks)).toEqual(tasksBefore);
  });
});
