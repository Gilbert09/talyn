import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import type { BillingStatus } from '@talyn/shared';
import { billingRoutes } from '../../routes/billing.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  tasks as tasksTable,
  users as usersTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';

const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };
const POLAR_KEYS = [
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
  'POLAR_ENVIRONMENT',
  'POLAR_PRODUCT_ID_MONTHLY',
  'POLAR_PRODUCT_ID_ANNUAL',
];
const savedEnv: Record<string, string | undefined> = {};

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let close: () => Promise<void>;

function setPolarEnv() {
  process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
  process.env.POLAR_WEBHOOK_SECRET = 'whsec_x';
  process.env.POLAR_ENVIRONMENT = 'sandbox';
  process.env.POLAR_PRODUCT_ID_MONTHLY = 'prod-m';
  process.env.POLAR_PRODUCT_ID_ANNUAL = 'prod-a';
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  for (const k of POLAR_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  await seedUser(db);
  await db
    .insert(workspacesTable)
    .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} });

  const app = express();
  app.use(express.json());
  app.use('/billing', requireAuth, wrapAsyncRoutes(billingRoutes()));
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  url = `http://127.0.0.1:${addr.port}`;
  close = () =>
    new Promise<void>((res) => {
      server.closeAllConnections();
      server.close(() => res());
    });
});

afterEach(async () => {
  for (const k of POLAR_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await close();
  await cleanup();
});

async function getStatus(): Promise<BillingStatus> {
  const res = await fetch(`${url}/billing/status`, { headers });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: BillingStatus };
  return body.data;
}

describe('GET /billing/status', () => {
  it('reports billing disabled when unconfigured', async () => {
    const status = await getStatus();
    expect(status).toMatchObject({
      billingEnabled: false,
      plan: 'unlimited',
      planSource: 'billing_disabled',
      activeTaskLimit: null,
    });
  });

  it('reports the free plan with live usage when configured', async () => {
    setPolarEnv();
    await db.insert(tasksTable).values({
      id: 't1',
      workspaceId: 'ws1',
      type: 'code_writing',
      status: 'queued',
      title: 't',
      description: 'd',
    });
    const status = await getStatus();
    expect(status).toMatchObject({
      billingEnabled: true,
      plan: 'free',
      planSource: 'default',
      activeTasks: 1,
      activeTaskLimit: 3,
    });
  });

  it('reports a comped user as override/unlimited', async () => {
    setPolarEnv();
    await db
      .update(usersTable)
      .set({ planOverride: 'unlimited' })
      .where(eq(usersTable.id, TEST_USER_ID));
    const status = await getStatus();
    expect(status).toMatchObject({
      plan: 'unlimited',
      planSource: 'override',
      activeTaskLimit: null,
    });
  });

  it('reports subscription state (renewal date, cancel flag, raw status)', async () => {
    setPolarEnv();
    await db
      .update(usersTable)
      .set({
        plan: 'unlimited',
        subscriptionStatus: 'active',
        currentPeriodEnd: new Date('2026-08-06T00:00:00.000Z'),
        cancelAtPeriodEnd: true,
      })
      .where(eq(usersTable.id, TEST_USER_ID));
    const status = await getStatus();
    expect(status).toMatchObject({
      plan: 'unlimited',
      planSource: 'subscription',
      subscriptionStatus: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: '2026-08-06T00:00:00.000Z',
    });
  });
});

describe('checkout / portal when billing is not configured', () => {
  it.each([{ path: 'checkout' }, { path: 'portal' }])('/billing/$path returns 400', async ({ path }) => {
    const res = await fetch(`${url}/billing/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not configured/i);
  });
});
