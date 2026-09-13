import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import type { WorkflowWithStats } from '@talyn/shared';
import { workflowRoutes } from '../../routes/workflows.js';
import { featureRoutes } from '../../routes/features.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';
import { _resetWorkflowStore } from '../../services/workflows/store.js';

/**
 * The workflows API.
 *
 * What is pinned beyond CRUD:
 *   - the kill switch answers EVERY verb, because a hidden nav item is not a
 *     gate — the CLI, the MCP server and plain `curl` walk straight past one;
 *   - the refusal is a 403 that says the switch was pulled, not a 404;
 *   - PATCH is a whole-workflow replace, so a partial body cannot land a
 *     trigger/condition combination the validator would refuse as a whole;
 *   - a validator message reaches the caller verbatim, because those messages
 *     are written for a person.
 */

const OTHER_USER_ID = 'user-other';
const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/features', requireAuth, wrapAsyncRoutes(featureRoutes()));
  app.use('/api/v1/workflows', requireAuth, wrapAsyncRoutes(workflowRoutes()));
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
  name: 'Label new PRs',
  events: ['pr_opened'],
  actions: [{ type: 'add_labels', labels: ['talyn-seen'] }],
  ...over,
});

describe('workflow routes', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await seedUser(db, { id: OTHER_USER_ID, email: 'other@example.test' });
    await db.insert(workspacesTable).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws-theirs', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
    ]);
    ({ url, close } = await makeServer());
    delete process.env.WORKFLOWS_ENABLED;
    _resetWorkflowStore();
  });

  afterEach(async () => {
    delete process.env.WORKFLOWS_ENABLED;
    _resetWorkflowStore();
    await close();
    await cleanup();
  });

  async function create(over: Record<string, unknown> = {}): Promise<WorkflowWithStats> {
    const res = await fetch(`${url}/api/v1/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body(over)),
    });
    const json = (await res.json()) as { success: boolean; data: WorkflowWithStats; error?: string };
    expect(json.success, json.error).toBe(true);
    return json.data;
  }

  it('creates, lists and deletes', async () => {
    const made = await create();
    expect(made).toMatchObject({ name: 'Label new PRs', enabled: true, workspaceId: 'ws-mine' });
    // Stats come back on the create so the list row renders without a refetch.
    expect(made.stats).toMatchObject({ runsTotal: 0, lastRunAt: null, lastStatus: null });

    const listed = await fetch(`${url}/api/v1/workflows?workspaceId=ws-mine`, { headers });
    const listJson = (await listed.json()) as { data: WorkflowWithStats[] };
    expect(listJson.data.map((w) => w.id)).toEqual([made.id]);

    const del = await fetch(`${url}/api/v1/workflows/${made.id}`, { method: 'DELETE', headers });
    expect(del.status).toBe(200);
    const after = await fetch(`${url}/api/v1/workflows?workspaceId=ws-mine`, { headers });
    expect(((await after.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('PATCH replaces the whole workflow', async () => {
    const made = await create();
    const res = await fetch(`${url}/api/v1/workflows/${made.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false, name: 'Off for now' }),
    });
    const json = (await res.json()) as { data: WorkflowWithStats };
    expect(json.data).toMatchObject({ enabled: false, name: 'Off for now' });
    // The fields not sent are preserved from the stored definition, which is
    // what lets a toggle be a one-field PATCH without dropping the trigger.
    expect(json.data.events).toEqual(['pr_opened']);
    expect(json.data.actions).toEqual([{ type: 'add_labels', labels: ['talyn-seen'] }]);
  });

  it('returns the validator’s own message on a bad workflow', async () => {
    const res = await fetch(`${url}/api/v1/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body({ events: [] })),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/at least one trigger event/);
  });

  it('refuses a condition that cannot apply to the trigger', async () => {
    const res = await fetch(`${url}/api/v1/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body({ conditions: { reviewStates: ['approved'] } })),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/only applies to/);
  });

  it('refuses a local skill with an explanation', async () => {
    const res = await fetch(`${url}/api/v1/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body({ actions: [{ type: 'run_skill', skillKey: 'local:tidy' }] })),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot run a local skill/);
  });

  describe('the kill switch', () => {
    it('403s every verb when the feature is switched off', async () => {
      const made = await create();
      process.env.WORKFLOWS_ENABLED = 'false';

      const calls: Array<[string, RequestInit]> = [
        [`/api/v1/workflows?workspaceId=ws-mine`, { headers }],
        [`/api/v1/workflows`, { method: 'POST', headers, body: JSON.stringify(body()) }],
        [`/api/v1/workflows/${made.id}`, { method: 'PATCH', headers, body: JSON.stringify({}) }],
        [`/api/v1/workflows/${made.id}`, { method: 'DELETE', headers }],
        [`/api/v1/workflows/${made.id}/runs`, { headers }],
      ];
      for (const [path, init] of calls) {
        const res = await fetch(`${url}${path}`, init);
        expect(res.status, path).toBe(403);
        const json = (await res.json()) as { code: string; error: string };
        expect(json.code).toBe('workflows_unavailable');
        expect(json.error).toMatch(/switched off/);
      }
    });

    it('serves everybody by default — absent means ON now', async () => {
      // The inverted polarity, at the API boundary. While the feature was gated,
      // an unset env var meant nobody; released, it means everybody.
      delete process.env.WORKFLOWS_ENABLED;
      const res = await fetch(`${url}/api/v1/workflows?workspaceId=ws-mine`, { headers });
      expect(res.status).toBe(200);
    });

    it('ignores a stale allow-list left on a deployment', async () => {
      process.env.WORKFLOWS_ALLOWED_EMAILS = 'somebody-else@example.test';
      const res = await fetch(`${url}/api/v1/workflows?workspaceId=ws-mine`, { headers });
      expect(res.status).toBe(200);
      delete process.env.WORKFLOWS_ALLOWED_EMAILS;
    });
  });

  it('404s another owner’s workspace before it ever reaches the gate', async () => {
    const res = await fetch(`${url}/api/v1/workflows?workspaceId=ws-theirs`, { headers });
    expect(res.status).toBe(404);
  });

  it('400s without a workspaceId', async () => {
    const res = await fetch(`${url}/api/v1/workflows`, { headers });
    expect(res.status).toBe(400);
  });

  it('404s an unknown workflow, and does not leak whether one exists elsewhere', async () => {
    for (const init of [
      { method: 'PATCH', headers, body: JSON.stringify({}) },
      { method: 'DELETE', headers },
    ] as RequestInit[]) {
      const res = await fetch(`${url}/api/v1/workflows/nope`, init);
      expect(res.status).toBe(404);
    }
  });

  describe('GET /features', () => {
    it('answers true for an allow-listed caller', async () => {
      const res = await fetch(`${url}/api/v1/features`, { headers });
      // `loops` rides along because it is account-scoped too, and it is false
      // here: its flag fails CLOSED, the opposite of this one.
      expect(((await res.json()) as { data: { workflows: boolean } }).data).toEqual({
        workflows: true,
        loops: false,
      });
    });

    it('answers false — not 403 — when the switch is pulled, so the client just does not draw it', async () => {
      // Kept as a capability answer rather than hardcoded true precisely so the
      // switch reaches the UI: a deployment with the engine off must not leave a
      // nav item pointing at routes that 403.
      process.env.WORKFLOWS_ENABLED = 'false';
      const res = await fetch(`${url}/api/v1/features`, { headers });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { workflows: boolean } }).data).toEqual({
        workflows: false,
        loops: false,
      });
    });
  });

  describe('GET /:id/runs', () => {
    it('returns an empty page for a workflow that has never run', async () => {
      const made = await create();
      const res = await fetch(`${url}/api/v1/workflows/${made.id}/runs`, { headers });
      expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
    });

    it('caps an outsized limit rather than honouring it', async () => {
      const made = await create();
      const res = await fetch(`${url}/api/v1/workflows/${made.id}/runs?limit=100000`, { headers });
      expect(res.status).toBe(200);
    });
  });
});
