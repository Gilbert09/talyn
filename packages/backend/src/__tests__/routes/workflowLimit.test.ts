import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { validateWorkflow, WORKFLOW_LIMIT_ERROR_CODE } from '@talyn/shared';
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
 * POST /workflows has no plan cap any more: usage billing removed the free
 * plan's three-workflow limit. These tests pin that a workflow is never
 * refused for a count, on any tier, with billing on or off. Uses the REAL
 * apiErrorHandler.
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

describe('POST /workflows has no plan cap', () => {
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

  // Usage billing removed the workflow cap (it was 3 on the free plan). A rule
  // spends nothing by existing; a run it starts is a box, gated where the task
  // is created.
  const MANY = 8;

  it.each([
    { label: 'free', set: {} },
    { label: 'old Unlimited subscriber', set: { plan: 'unlimited' } },
    { label: 'comp', set: { planOverride: 'unlimited' } },
    { label: 'legacy_pro override', set: { planOverride: 'legacy_pro' } },
  ])('a $label owner keeps any number of workflows across workspaces', async ({ set }) => {
    if (Object.keys(set).length) await db.update(usersTable).set(set).where(eq(usersTable.id, TEST_USER_ID));
    for (let i = 0; i < MANY; i++) {
      expect((await post({ workspaceId: i % 2 === 0 ? 'ws-mine' : 'ws-second' })).status).toBe(200);
    }
    expect((await countIn('ws-mine')) + (await countIn('ws-second'))).toBe(MANY);
  });

  it('disabled workflows are never refused either', async () => {
    for (let i = 0; i < MANY; i++) expect((await post({ enabled: false })).status).toBe(200);
  });

  it('another owner’s workflows change nothing', async () => {
    for (let i = 0; i < MANY; i++) {
      await createWorkflow('ws-theirs', validateWorkflow(body({ workspaceId: 'ws-theirs' })));
    }
    expect((await post()).status).toBe(200);
  });

  it('is never refused with the old workflow code, billing on or off', async () => {
    for (const billing of [true, false]) {
      if (billing) process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
      else delete process.env.POLAR_ACCESS_TOKEN;
      for (let i = 0; i < 4; i++) {
        const res = await post();
        expect(res.status).toBe(200);
        expect(((await res.json()) as { code?: string }).code).not.toBe(WORKFLOW_LIMIT_ERROR_CODE);
      }
    }
  });
});
