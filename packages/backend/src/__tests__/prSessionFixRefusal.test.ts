import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  pullRequests,
  repositories,
  tasks as tasksTable,
  workbenches,
  workspaces,
} from '../db/schema.js';
import { pullRequestRoutes } from '../routes/pullRequests.js';
import { taskRoutes } from '../routes/tasks.js';
import * as taskCreate from '../services/taskCreate.js';
import { runWorkbenchAction } from '../services/workbenches/actions.js';
import { getWorkbench } from '../services/workbenches/store.js';
import { WorkbenchError } from '../services/workbenches/errors.js';
import { domainEvents } from '../services/events.js';
import { emitPrSession } from '../services/workbenches/prSessions.js';

/**
 * One agent per pull request, whichever side starts it. A manual Fix on a PR a
 * live session works is refused with the session's name (the client sends the
 * fix to that session instead), and the session's own Fix is refused while a
 * cloud task works the PR.
 */

const OWNER = 'owner-a';

describe('fixing a pull request a session works', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    testDb = await createTestDb();
    const { db } = testDb;
    await seedUser(db, { id: OWNER });
    await db.insert(workspaces).values({ id: 'ws-a', ownerId: OWNER, name: 'A' });
    await db.insert(repositories).values({
      id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r', defaultBranch: 'main',
    });
    await db.insert(pullRequests).values({
      id: 'pr-1', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number: 7, state: 'open',
      lastSummary: { title: 'T', url: 'https://github.com/o/r/pull/7' },
    });
    await db.insert(workbenches).values({
      id: 'wb-1', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: 'paris',
      branch: 'feat', baseBranch: 'main', runtime: 'local', agent: 'claude', status: 'ready', pullRequestId: 'pr-1',
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: OWNER, email: 'o@x.dev' } as typeof req.user;
      next();
    });
    app.use('/pull-requests', pullRequestRoutes());
    app.use('/tasks', taskRoutes());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await testDb.cleanup();
    vi.restoreAllMocks();
  });

  const archive = () =>
    testDb.db
      .update(workbenches)
      .set({ archivedAt: new Date(), status: 'archived' })
      .where(eq(workbenches.id, 'wb-1'));

  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('POST /pull-requests/:id/fix', () => {
    it('refuses with 409 pr_has_session, naming the session', async () => {
      const res = await post('/pull-requests/pr-1/fix', {});
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ success: false, code: 'pr_has_session', workbenchId: 'wb-1', name: 'paris' });
      expect(body.error).toContain('"paris"');
    });

    it('goes ahead as before once the session is archived', async () => {
      await archive();
      const res = await post('/pull-requests/pr-1/fix', {});
      // No provider is connected here, which is the refusal past the session check.
      expect(res.status).toBe(400);
    });
  });

  describe('POST /tasks', () => {
    const fix = { workspaceId: 'ws-a', type: 'pr_response', title: 't', description: 'd', prompt: 'p', repositoryId: 'repo-a', pullRequestId: 'pr-1' };

    beforeEach(() => {
      // Anything that gets past the session check stops here, deterministically.
      vi.spyOn(taskCreate, 'createCloudTask').mockRejectedValue(new taskCreate.TaskReferenceError('stop'));
    });

    it('refuses the panel Fix (a pr_response with no skill) with 409 pr_has_session', async () => {
      const res = await post('/tasks', fix);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'pr_has_session', workbenchId: 'wb-1', name: 'paris' });
    });

    it.each([
      ['a skill run', { ...fix, skill: { key: 'platform:1', name: 's', source: 'platform' } }],
      ['another task type', { ...fix, type: 'code_writing' }],
      ['a task with no PR', { ...fix, pullRequestId: undefined }],
    ])('lets %s through', async (_name, body) => {
      const res = await post('/tasks', body);
      expect(res.status).toBe(400);
    });

    it('lets the Fix through once the session is archived', async () => {
      await archive();
      expect((await post('/tasks', fix)).status).toBe(400);
    });
  });

  describe('runWorkbenchAction', () => {
    const insertTask = (status: string) =>
      testDb.db.insert(tasksTable).values({
        id: 'task-1', workspaceId: 'ws-a', type: 'pr_response', status, title: 't', description: 'd',
        repositoryId: 'repo-a', pullRequestId: 'pr-1',
      });

    async function codeOf(action: string): Promise<string> {
      const row = await getWorkbench('wb-1');
      try {
        await runWorkbenchAction(row!, action);
        return 'none';
      } catch (err) {
        if (err instanceof WorkbenchError) return err.code;
        throw err;
      }
    }

    it.each([
      ['in_progress', 'fix_checks', 'task_active'],
      ['queued', 'resolve_conflicts', 'task_active'],
      // Past the guard, a local session is the desktop's to run.
      ['in_progress', 'rename_branch', 'local_runtime'],
      ['completed', 'fix_checks', 'local_runtime'],
      [null, 'fix_checks', 'local_runtime'],
    ])('with a %s task, %s answers %s', async (status, action, code) => {
      if (status) await insertTask(status);
      expect(await codeOf(action)).toBe(code);
    });

    it('says so in words a person can act on', async () => {
      await insertTask('in_progress');
      const row = await getWorkbench('wb-1');
      await expect(runWorkbenchAction(row!, 'fix_checks')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('cloud task'),
      });
    });
  });

  describe('the re-arm signal', () => {
    it('announces a session change on the PR to the background fixers', async () => {
      const seen: unknown[] = [];
      const listener = (evt: unknown) => seen.push(evt);
      domainEvents.on('pr:session', listener);
      try {
        await emitPrSession('ws-a', 'pr-1');
      } finally {
        domainEvents.off('pr:session', listener);
      }
      expect(seen).toEqual([{ workspaceId: 'ws-a', prId: 'pr-1', trigger: 'session:changed' }]);
    });
  });
});
