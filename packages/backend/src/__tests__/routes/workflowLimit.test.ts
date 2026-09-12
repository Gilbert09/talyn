import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import {
  FREE_PLAN_WORKFLOW_LIMIT,
  validateWorkflow,
  WORKFLOW_LIMIT_ERROR_CODE,
} from '@talyn/shared';
import { workflowRoutes } from '../../routes/workflows.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { users as usersTable, workspaces as workspacesTable } from '../../db/schema.js';
import { _resetWorkflowStore, createWorkflow } from '../../services/workflows/store.js';
import { eq } from 'drizzle-orm';

/**
 * Free-plan workflow cap at the route surface: POST /workflows must 402 with
 * WORKFLOW_LIMIT_ERROR_CODE once the owner keeps FREE_PLAN_WORKFLOW_LIMIT
 * workflows — counted across EVERY workspace they own, because the limit is
 * per user and a second workspace is free to make.
 *
 * Uses the REAL apiErrorHandler, so the status/code contract pinned here is the
 * one production serves. Enforcement is unconditional: the CLI, the MCP server
 * and plain `curl` hit the same gate the desktop does.
 */

const OTHER_USER_ID = 'user-other';
const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};
const savedPolarToken = process.env.POLAR_ACCESS_TOKEN;

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/workflows', requireAuth, wrapAsyncRoutes(workflowRoutes()));
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

describe('free-plan workflow limit at the route surface', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let seq = 0;

  function body(over: Record<string, unknown> = {}) {
    return {
      workspaceId: 'ws-mine',
      name: `Rule ${++seq}`,
      events: ['pr_opened'],
      actions: [{ type: 'add_labels', labels: ['talyn-seen'] }],
      ...over,
    };
  }

  function post(over: Record<string, unknown> = {}) {
    return fetch(`${url}/workflows`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body(over)),
    });
  }

  async function countIn(workspaceId: string): Promise<number> {
    const res = await fetch(`${url}/workflows?workspaceId=${workspaceId}`, { headers });
    return ((await res.json()) as { data: unknown[] }).data.length;
  }

  /** Fill the owner's allowance, spread across both of their workspaces. */
  async function fillAllowance(): Promise<void> {
    for (let i = 0; i < FREE_PLAN_WORKFLOW_LIMIT; i++) {
      const res = await post({ workspaceId: i % 2 === 0 ? 'ws-mine' : 'ws-second' });
      expect(res.status).toBe(200);
    }
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    delete process.env.WORKFLOWS_ENABLED;
    seq = 0;
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await seedUser(db, { id: OTHER_USER_ID, email: 'other@example.test' });
    await db.insert(workspacesTable).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws-second', ownerId: TEST_USER_ID, name: 'second', settings: {} },
      { id: 'ws-theirs', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
    ]);
    _resetWorkflowStore();
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    if (savedPolarToken === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolarToken;
    delete process.env.WORKFLOWS_ENABLED;
    _resetWorkflowStore();
    await close();
    await cleanup();
  });

  it('402s with the workflow code once a free owner is at the limit', async () => {
    await fillAllowance();
    const res = await post();
    expect(res.status).toBe(402);
    const json = (await res.json()) as { code: string; error: string };
    expect(json.code).toBe(WORKFLOW_LIMIT_ERROR_CODE);
    expect(json.error).toMatch(new RegExp(`${FREE_PLAN_WORKFLOW_LIMIT} workflows`));
    // Refused, not silently created.
    expect((await countIn('ws-mine')) + (await countIn('ws-second'))).toBe(
      FREE_PLAN_WORKFLOW_LIMIT
    );
  });

  it('creates normally below the limit', async () => {
    for (let i = 0; i < FREE_PLAN_WORKFLOW_LIMIT - 1; i++) {
      expect((await post()).status).toBe(200);
    }
    expect((await post()).status).toBe(200);
  });

  it('counts every workspace the owner has — a second one is not a second allowance', async () => {
    await fillAllowance();
    // A brand-new workspace does not reset anything.
    expect((await post({ workspaceId: 'ws-second' })).status).toBe(402);
  });

  it('another owner’s workflows never eat a slot', async () => {
    // Seeded through the store rather than the route: these belong to a
    // workspace this caller cannot post to, which is exactly the point.
    for (let i = 0; i < FREE_PLAN_WORKFLOW_LIMIT; i++) {
      await createWorkflow('ws-theirs', validateWorkflow(body({ workspaceId: 'ws-theirs' })));
    }
    await fillAllowance();
    // Our own allowance is what refused us, at our own count — not theirs.
    const res = await post();
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(
      new RegExp(`\\(${FREE_PLAN_WORKFLOW_LIMIT} in use\\)`)
    );
  });

  it('a disabled workflow still occupies its slot', async () => {
    for (let i = 0; i < FREE_PLAN_WORKFLOW_LIMIT; i++) {
      expect((await post({ enabled: false })).status).toBe(200);
    }
    expect((await post()).status).toBe(402);
  });

  it('editing an existing workflow at the limit is never gated', async () => {
    await fillAllowance();
    const listed = await fetch(`${url}/workflows?workspaceId=ws-mine`, { headers });
    const [first] = ((await listed.json()) as { data: { id: string }[] }).data;
    const res = await fetch(`${url}/workflows/${first.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Renamed at the limit', enabled: false }),
    });
    expect(res.status).toBe(200);
    // And switching it back ON is an edit too, not a new workflow.
    const back = await fetch(`${url}/workflows/${first.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    expect(back.status).toBe(200);
  });

  it('deleting a workflow frees its slot', async () => {
    await fillAllowance();
    expect((await post()).status).toBe(402);
    const listed = await fetch(`${url}/workflows?workspaceId=ws-mine`, { headers });
    const [first] = ((await listed.json()) as { data: { id: string }[] }).data;
    expect(
      (await fetch(`${url}/workflows/${first.id}`, { method: 'DELETE', headers })).status
    ).toBe(200);
    expect((await post()).status).toBe(200);
  });

  it('comped (plan_override) owners are unlimited', async () => {
    await db
      .update(usersTable)
      .set({ planOverride: 'unlimited' })
      .where(eq(usersTable.id, TEST_USER_ID));
    await fillAllowance();
    expect((await post()).status).toBe(200);
  });

  it('subscribed owners are unlimited', async () => {
    await db.update(usersTable).set({ plan: 'unlimited' }).where(eq(usersTable.id, TEST_USER_ID));
    await fillAllowance();
    expect((await post()).status).toBe(200);
  });

  it('is off entirely when billing is not configured', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    await fillAllowance();
    expect((await post()).status).toBe(200);
  });
});
