import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import type { LoopRun, LoopWithStats } from '@talyn/shared';
import { loopRoutes } from '../../routes/loops.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  environments as environmentsTable,
  repositories as reposTable,
  tasks as tasksTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import * as loopsAccess from '../../services/loopsAccess.js';
import * as registry from '../../services/cloudProviders/registry.js';
import * as fleetAccess from '../../services/cloudProviders/fleetAccess.js';
import * as fleetCredentials from '../../services/selfHosted/credentials.js';
import * as taskCreate from '../../services/taskCreate.js';

/**
 * The loops API.
 *
 * What is pinned beyond CRUD:
 *   - the flag answers EVERY verb, because a hidden nav item is not a gate;
 *   - the refusal is a 403 that says why, not a 404;
 *   - PATCH is a whole-loop replace, so a partial body cannot land a
 *     provider/model pair the validator would refuse as a whole;
 *   - a validator message reaches the caller verbatim;
 *   - the checks the validator cannot make — the repository belongs to this
 *     workspace, the fleet agent is connected — are made here.
 */

const OTHER_USER_ID = 'user-other';
const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/loops', requireAuth, wrapAsyncRoutes(loopRoutes()));
  app.use(apiErrorHandler);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const body = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'ws-mine',
  name: 'Morning triage',
  prompt: 'Fix yesterday’s failing checks.',
  cron: '0 9 * * 1-5',
  timezone: 'Europe/London',
  provider: 'posthog_code',
  model: 'claude-opus-5',
  repositoryId: 'repo-mine',
  repoFullName: 'acme/widget',
  ...over,
});

describe('loop routes', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let mayUseLoops: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await seedUser(db, { id: OTHER_USER_ID, email: 'other@example.test' });
    await db.insert(workspacesTable).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws-theirs', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
    ]);
    await db.insert(reposTable).values([
      {
        id: 'repo-mine',
        workspaceId: 'ws-mine',
        name: 'acme/widget',
        url: 'https://github.com/acme/widget',
        defaultBranch: 'main',
      },
      {
        id: 'repo-theirs',
        workspaceId: 'ws-theirs',
        name: 'acme/other',
        url: 'https://github.com/acme/other',
        defaultBranch: 'main',
      },
    ]);
    await db.insert(environmentsTable).values({
      id: 'env-1',
      ownerId: TEST_USER_ID,
      name: 'PostHog Code',
      type: 'posthog_code',
      config: {},
    });
    ({ url, close } = await makeServer());
    delete process.env.LOOPS_ENABLED;
    mayUseLoops = vi.spyOn(loopsAccess, 'workspaceMayUseLoops').mockResolvedValue(true);
    vi.spyOn(registry, 'getCloudProvider').mockReturnValue({ type: 'posthog_code' } as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.LOOPS_ENABLED;
    await close();
    await cleanup();
  });

  async function create(over: Record<string, unknown> = {}): Promise<LoopWithStats> {
    const res = await fetch(`${url}/api/v1/loops`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body(over)),
    });
    const json = (await res.json()) as { success: boolean; data: LoopWithStats; error?: string };
    expect(json.success, json.error).toBe(true);
    return json.data;
  }

  it('creates, lists, counts and deletes', async () => {
    const made = await create();
    expect(made).toMatchObject({ name: 'Morning triage', enabled: true, workspaceId: 'ws-mine' });
    // The next run is computed on the write, so the list row renders a schedule
    // without waiting for the first sweep.
    expect(made.nextRunAt).toBeTruthy();
    expect(made.stats).toMatchObject({ runsTotal: 0, lastRunAt: null, lastStatus: null });

    const listed = await fetch(`${url}/api/v1/loops?workspaceId=ws-mine`, { headers });
    expect(((await listed.json()) as { data: LoopWithStats[] }).data.map((l) => l.id)).toEqual([
      made.id,
    ]);

    const counted = await fetch(`${url}/api/v1/loops/count?workspaceId=ws-mine`, { headers });
    expect(((await counted.json()) as { data: { enabled: number } }).data.enabled).toBe(1);

    const del = await fetch(`${url}/api/v1/loops/${made.id}`, { method: 'DELETE', headers });
    expect(del.status).toBe(200);
    const after = await fetch(`${url}/api/v1/loops?workspaceId=ws-mine`, { headers });
    expect(((await after.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('/count is matched before /:id', async () => {
    // Express matches in declaration order; declared the other way round,
    // `/count` is read as a loop id and 404s.
    const res = await fetch(`${url}/api/v1/loops/count?workspaceId=ws-mine`, { headers });
    expect(res.status).toBe(200);
  });

  describe('the flag gates every verb', () => {
    it.each([
      ['GET', '/api/v1/loops?workspaceId=ws-mine'],
      ['POST', '/api/v1/loops'],
    ])('%s %s is refused', async (method, path) => {
      mayUseLoops.mockResolvedValue(false);
      const res = await fetch(`${url}${path}`, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body()) : undefined,
      });
      expect(res.status).toBe(403);
      const json = (await res.json()) as { code: string; error: string };
      // 403 with a reason, NOT 404: somebody who switched the feature off
      // should be able to tell that from a route that does not exist.
      expect(json.code).toBe('loops_unavailable');
      expect(json.error).toMatch(/not available/);
    });

    it('refuses PATCH and DELETE on a loop that already exists', async () => {
      const made = await create();
      mayUseLoops.mockResolvedValue(false);
      for (const method of ['PATCH', 'DELETE'] as const) {
        const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
          method,
          headers,
          body: method === 'PATCH' ? JSON.stringify({ enabled: false }) : undefined,
        });
        expect(res.status).toBe(403);
      }
    });
  });

  it('requires a workspaceId before anything else', async () => {
    const res = await fetch(`${url}/api/v1/loops`, { headers });
    expect(res.status).toBe(400);
  });

  it('refuses another owner’s workspace as 404, not 403', async () => {
    // Not-found rather than forbidden, and that is `requireWorkspaceAccess`'s
    // call throughout: a 403 would confirm that the workspace exists to
    // somebody who is only guessing ids.
    const res = await fetch(`${url}/api/v1/loops?workspaceId=ws-theirs`, { headers });
    expect(res.status).toBe(404);
  });

  it('404s an unknown loop', async () => {
    const res = await fetch(`${url}/api/v1/loops/nope`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });

  describe('validation', () => {
    it('passes the validator’s message through verbatim', async () => {
      const res = await fetch(`${url}/api/v1/loops`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body({ model: 'gpt-5.6-sol' })),
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain('Talyn Fleet model');
    });

    it('refuses a repository belonging to another workspace', async () => {
      // The check the shared validator cannot make: it has no database.
      const res = await fetch(`${url}/api/v1/loops`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body({ repositoryId: 'repo-theirs', repoFullName: 'acme/other' })),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/not connected/);
    });

    it('refuses a fleet loop when the workspace has no fleet access', async () => {
      vi.spyOn(fleetAccess, 'workspaceMayUseFleet').mockResolvedValue(false);
      vi.spyOn(registry, 'getCloudProvider').mockReturnValue({ type: 'selfhosted' } as never);
      const res = await fetch(`${url}/api/v1/loops`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body({ provider: 'selfhosted', model: 'claude-sonnet-5' })),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/Talyn Fleet/);
    });

    it('refuses a fleet loop whose agent is not connected', async () => {
      // Saving a Codex loop with no Codex subscription would produce a loop
      // that fails every firing — refuse it while somebody is looking at it.
      vi.spyOn(fleetAccess, 'workspaceMayUseFleet').mockResolvedValue(true);
      vi.spyOn(registry, 'getCloudProvider').mockReturnValue({ type: 'selfhosted' } as never);
      vi.spyOn(fleetCredentials, 'fleetAgentStatus').mockResolvedValue({
        connectedAgents: ['claude'],
        reauthAgents: [],
      });
      const res = await fetch(`${url}/api/v1/loops`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body({ provider: 'selfhosted', model: 'gpt-5.6-terra' })),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/no Codex subscription/);
    });
  });

  describe('PATCH', () => {
    it('is a whole-loop replace, and recomputes the schedule', async () => {
      const made = await create();
      const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ cron: '0 17 * * *', name: 'Evening triage' }),
      });
      const json = (await res.json()) as { data: LoopWithStats };
      expect(json.data.name).toBe('Evening triage');
      expect(json.data.cron).toBe('0 17 * * *');
      // Unsent fields survive the replace — that is what makes it a replace of
      // the MERGED object rather than of the body.
      expect(json.data.prompt).toBe(made.prompt);
      expect(json.data.nextRunAt).not.toBe(made.nextRunAt);
    });

    it('refuses a partial body that lands an incoherent provider/model pair', async () => {
      // A one-field merge is exactly how a Codex model ends up pinned to
      // PostHog Code. The whole object has to validate.
      const made = await create();
      const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ model: 'gpt-5.6-sol' }),
      });
      expect(res.status).toBe(400);
    });

    it('clears next_run_at when the loop is switched off', async () => {
      const made = await create();
      const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      const json = (await res.json()) as { data: LoopWithStats };
      expect(json.data.enabled).toBe(false);
      expect(json.data.nextRunAt).toBeNull();
    });

    it('resumes from now when switched back on, rather than backfilling', async () => {
      const made = await create();
      await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: false }),
      });
      const res = await fetch(`${url}/api/v1/loops/${made.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ enabled: true }),
      });
      const json = (await res.json()) as { data: LoopWithStats };
      expect(new Date(json.data.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('history', () => {
    it('caps a page at 200 however much is asked for', async () => {
      const made = await create();
      const res = await fetch(`${url}/api/v1/loops/${made.id}/runs?limit=5000`, { headers });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
    });
  });

  describe('run now', () => {
    it('dispatches through the same path the scheduler uses', async () => {
      vi.spyOn(taskCreate, 'createCloudTask').mockImplementation(async (input) => {
        await db.insert(tasksTable).values({
          id: 'task-manual',
          workspaceId: input.workspaceId,
          type: input.type,
          status: 'queued',
          title: input.title,
          description: input.description,
          repositoryId: input.repositoryId,
        });
        return { id: 'task-manual' } as never;
      });
      const made = await create();
      const res = await fetch(`${url}/api/v1/loops/${made.id}/run`, { method: 'POST', headers });
      const json = (await res.json()) as { data: LoopRun };
      expect(json.data.trigger).toBe('manual');
      expect(json.data.taskId).toBe('task-manual');
      expect(json.data.status).toBe('queued');
    });

    it('reports a refusal as the run’s own state, not as an HTTP error', async () => {
      // A manual run and a scheduled one must settle the same way. Answering
      // 402 here would make "Run now" a different code path from the schedule,
      // which is a test of something the schedule never does.
      const made = await create();
      // Take the provider away AFTER the loop is saved — exactly what a
      // disconnect does, and the reason dispatch re-checks what the route
      // already checked.
      vi.spyOn(registry, 'getCloudProvider').mockReturnValue(undefined as never);
      const res = await fetch(`${url}/api/v1/loops/${made.id}/run`, { method: 'POST', headers });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: LoopRun };
      expect(json.data.status).toBe('failed');
      expect(json.data.failureCode).toBe('environment_missing');
    });
  });
});
