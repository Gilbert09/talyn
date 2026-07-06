import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { billingEvents as billingEventsTable, users as usersTable } from '../db/schema.js';
import * as websocketModule from '../services/websocket.js';

// Drive the handler with plain JSON events instead of computing
// standard-webhooks signatures: the mock parses the raw body, and rejects
// (like the real verifier) when the test sends the sentinel bad signature.
vi.mock('@polar-sh/sdk/webhooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@polar-sh/sdk/webhooks')>();
  return {
    ...actual,
    validateEvent: (body: Buffer, headers: Record<string, string>, _secret: string) => {
      if (headers['webhook-signature'] === 'bad') {
        throw new actual.WebhookVerificationError('bad signature');
      }
      return JSON.parse(body.toString('utf-8'));
    },
  };
});

// Import AFTER the mock so webhook.ts binds the mocked validateEvent.
const { handlePolarWebhook, applySubscriptionEvent } = await import(
  '../services/billing/webhook.js'
);

const POLAR_ENV = {
  POLAR_ACCESS_TOKEN: 'polar-test-token',
  POLAR_WEBHOOK_SECRET: 'whsec_test',
  POLAR_ENVIRONMENT: 'sandbox',
  POLAR_PRODUCT_ID_MONTHLY: 'prod-monthly',
  POLAR_PRODUCT_ID_ANNUAL: 'prod-annual',
} as const;
const savedEnv: Record<string, string | undefined> = {};

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let close: () => Promise<void>;

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    status: 'active',
    currentPeriodEnd: '2026-08-06T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    customerId: 'cust-1',
    customer: { id: 'cust-1', externalId: TEST_USER_ID },
    ...overrides,
  };
}

async function post(
  eventId: string,
  body: unknown,
  opts: { timestamp?: number; signature?: string } = {}
) {
  return fetch(`${url}/webhooks/polar`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': eventId,
      'webhook-timestamp': String(opts.timestamp ?? 1_780_000_000),
      'webhook-signature': opts.signature ?? 'v1,good',
    },
    body: JSON.stringify(body),
  });
}

async function getUser() {
  const rows = await db.select().from(usersTable).where(eq(usersTable.id, TEST_USER_ID)).limit(1);
  return rows[0];
}

async function getEvents() {
  return db.select().from(billingEventsTable);
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  for (const [k, v] of Object.entries(POLAR_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  await seedUser(db);

  const app = express();
  app.post('/webhooks/polar', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    void handlePolarWebhook(req, res);
  });
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
  for (const k of Object.keys(POLAR_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await close();
  await cleanup();
  vi.restoreAllMocks();
});

describe('handlePolarWebhook — state machine', () => {
  it.each([
    { type: 'subscription.created', status: 'active', expectedPlan: 'unlimited' },
    { type: 'subscription.active', status: 'active', expectedPlan: 'unlimited' },
    // past_due keeps access through dunning — recoverable in the portal.
    { type: 'subscription.updated', status: 'past_due', expectedPlan: 'unlimited' },
    { type: 'subscription.updated', status: 'canceled', expectedPlan: 'free' },
    { type: 'subscription.updated', status: 'unpaid', expectedPlan: 'free' },
    // revoked ends benefits NOW regardless of the status field.
    { type: 'subscription.revoked', status: 'active', expectedPlan: 'free' },
  ])('$type (status=$status) → plan=$expectedPlan', async ({ type, status, expectedPlan }) => {
    const res = await post('evt-1', { type, data: subscription({ status }) });
    expect(res.status).toBe(200);

    const user = await getUser();
    expect(user.plan).toBe(expectedPlan);
    expect(user.subscriptionStatus).toBe(status);
    expect(user.polarSubscriptionId).toBe('sub-1');
    expect(user.polarCustomerId).toBe('cust-1');
    expect(user.currentPeriodEnd?.toISOString()).toBe('2026-08-06T00:00:00.000Z');

    const events = await getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: 'evt-1',
      eventType: type,
      subscriptionId: 'sub-1',
      userId: TEST_USER_ID,
      applied: true,
    });
  });

  it('subscription.canceled with cancel-at-period-end keeps access and sets the flag', async () => {
    await post('evt-1', {
      type: 'subscription.canceled',
      data: subscription({ status: 'active', cancelAtPeriodEnd: true }),
    });
    const user = await getUser();
    expect(user.plan).toBe('unlimited');
    expect(user.cancelAtPeriodEnd).toBe(true);
  });

  it('subscription.uncanceled clears the flag', async () => {
    await post('evt-1', {
      type: 'subscription.canceled',
      data: subscription({ status: 'active', cancelAtPeriodEnd: true }),
    });
    await post('evt-2', {
      type: 'subscription.uncanceled',
      data: subscription({ status: 'active', cancelAtPeriodEnd: false }),
      // later than evt-1
    }, { timestamp: 1_780_000_100 });
    const user = await getUser();
    expect(user.plan).toBe('unlimited');
    expect(user.cancelAtPeriodEnd).toBe(false);
  });

  it('never touches plan_override (comped stays comped through revocation)', async () => {
    await db
      .update(usersTable)
      .set({ planOverride: 'unlimited' })
      .where(eq(usersTable.id, TEST_USER_ID));
    await post('evt-1', { type: 'subscription.revoked', data: subscription({ status: 'canceled' }) });
    const user = await getUser();
    expect(user.plan).toBe('free');
    expect(user.planOverride).toBe('unlimited');
  });

  it('emits subscription:updated to the user on apply', async () => {
    const spy = vi.spyOn(websocketModule, 'emitSubscriptionUpdated');
    await post('evt-1', { type: 'subscription.created', data: subscription() });
    expect(spy).toHaveBeenCalledWith(
      TEST_USER_ID,
      expect.objectContaining({ plan: 'unlimited', planSource: 'subscription' })
    );
  });
});

describe('handlePolarWebhook — delivery semantics', () => {
  it('is idempotent on the event id', async () => {
    await post('evt-1', { type: 'subscription.created', data: subscription() });
    // Simulate drift, then replay the SAME delivery — it must not re-apply.
    await db.update(usersTable).set({ plan: 'free' }).where(eq(usersTable.id, TEST_USER_ID));
    const res = await post('evt-1', { type: 'subscription.created', data: subscription() });
    expect(res.status).toBe(200);
    expect((await getUser()).plan).toBe('free');
    expect(await getEvents()).toHaveLength(1);
  });

  it('ignores an out-of-order older event for the same subscription', async () => {
    await post(
      'evt-2',
      { type: 'subscription.updated', data: subscription({ status: 'canceled' }) },
      { timestamp: 2_000 }
    );
    expect((await getUser()).plan).toBe('free');

    const res = await post(
      'evt-1',
      { type: 'subscription.updated', data: subscription({ status: 'active' }) },
      { timestamp: 1_000 }
    );
    expect(res.status).toBe(200);
    expect((await getUser()).plan).toBe('free'); // stale event did not win

    const events = await getEvents();
    const stale = events.find((e) => e.eventId === 'evt-1');
    expect(stale?.applied).toBe(false);
  });

  it('a DIFFERENT subscription id applies even with an older timestamp (re-subscribe)', async () => {
    await post(
      'evt-2',
      { type: 'subscription.revoked', data: subscription({ status: 'canceled' }) },
      { timestamp: 2_000 }
    );
    const res = await post(
      'evt-3',
      { type: 'subscription.active', data: subscription({ id: 'sub-2', status: 'active' }) },
      { timestamp: 1_500 }
    );
    expect(res.status).toBe(200);
    const user = await getUser();
    expect(user.plan).toBe('unlimited');
    expect(user.polarSubscriptionId).toBe('sub-2');
  });

  it('maps via stored polar_customer_id when the event lacks an external id', async () => {
    await post('evt-1', { type: 'subscription.created', data: subscription() });
    const res = await post(
      'evt-2',
      {
        type: 'subscription.updated',
        data: subscription({ status: 'canceled', customer: { id: 'cust-1', externalId: null } }),
      },
      { timestamp: 1_780_000_100 }
    );
    expect(res.status).toBe(200);
    expect((await getUser()).plan).toBe('free');
  });

  it('acks 200 without applying when no user matches', async () => {
    const res = await post('evt-1', {
      type: 'subscription.created',
      data: subscription({ customerId: 'cust-x', customer: { id: 'cust-x', externalId: 'user-ghost' } }),
    });
    expect(res.status).toBe(200);
    expect((await getUser()).plan).toBe('free');
    const events = await getEvents();
    expect(events[0]).toMatchObject({ eventId: 'evt-1', applied: false, userId: null });
  });

  it('records non-subscription events without applying', async () => {
    const res = await post('evt-1', { type: 'order.paid', data: { id: 'order-1' } });
    expect(res.status).toBe(200);
    const events = await getEvents();
    expect(events[0]).toMatchObject({ eventId: 'evt-1', eventType: 'order.paid', applied: false });
  });

  it('rejects a bad signature with 401 and records nothing', async () => {
    const res = await post(
      'evt-1',
      { type: 'subscription.created', data: subscription() },
      { signature: 'bad' }
    );
    expect(res.status).toBe(401);
    expect(await getEvents()).toHaveLength(0);
    expect((await getUser()).plan).toBe('free');
  });

  it('503s when billing is not configured', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    const res = await post('evt-1', { type: 'subscription.created', data: subscription() });
    expect(res.status).toBe(503);
  });
});

describe('applySubscriptionEvent (direct)', () => {
  it('same-instant events still apply (>= watermark, not >)', async () => {
    const at = new Date(5_000_000);
    await applySubscriptionEvent('subscription.created', subscription({ status: 'active' }) as never, at);
    const result = await applySubscriptionEvent(
      'subscription.updated',
      subscription({ status: 'canceled' }) as never,
      at
    );
    expect(result.applied).toBe(true);
    expect((await getUser()).plan).toBe('free');
  });
});
