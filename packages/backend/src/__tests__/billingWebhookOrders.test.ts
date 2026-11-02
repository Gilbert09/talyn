import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  autoTopupSettings,
  billingEvents as billingEventsTable,
  creditLedger,
  creditLots,
  teams as teamsTable,
  users as usersTable,
} from '../db/schema.js';
import * as websocketModule from '../services/websocket.js';

// Plain JSON events instead of standard-webhooks signatures (see billingWebhook.test.ts).
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

const { handlePolarWebhook, applyOrderEvent } = await import('../services/billing/webhook.js');
const { burnCredits } = await import('../services/billing/usage/credits.js');

const POLAR_ENV = {
  POLAR_ACCESS_TOKEN: 'polar-test-token',
  POLAR_WEBHOOK_SECRET: 'whsec_test',
  POLAR_ENVIRONMENT: 'sandbox',
  POLAR_PRODUCT_ID_PRO_MONTHLY: 'prod-pro-m',
  POLAR_PRODUCT_ID_PRO_ANNUAL: 'prod-pro-a',
  POLAR_PRODUCT_ID_CREDITS_25: 'prod-c25',
  POLAR_PRODUCT_ID_CREDITS_100: 'prod-c100',
  POLAR_PRODUCT_ID_CREDITS_500: 'prod-c500',
  POLAR_PRODUCT_ID_MONTHLY: 'prod-legacy-m',
  POLAR_PRODUCT_ID_ANNUAL: 'prod-legacy-a',
  POLAR_PRODUCT_ID_TEAM_MONTHLY: 'prod-team-m',
  POLAR_PRODUCT_ID_TEAM_ANNUAL: 'prod-team-a',
  POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY: 'prod-team-pro-m',
  POLAR_PRODUCT_ID_TEAM_PRO_ANNUAL: 'prod-team-pro-a',
} as const;
const savedEnv: Record<string, string | undefined> = {};

let db: Database;
let cleanup: () => Promise<void>;
let url: string;
let close: () => Promise<void>;

function creditOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    status: 'paid',
    paid: true,
    productId: 'prod-c100',
    customerId: 'cust-1',
    customer: { id: 'cust-1', externalId: TEST_USER_ID, email: 'a@example.com' },
    metadata: { kind: 'credit_pack', pack: '100' },
    createdAt: '2026-11-10T12:00:00.000Z',
    totalAmount: 10000,
    refundedAmount: 0,
    currency: 'usd',
    ...overrides,
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    status: 'active',
    currentPeriodEnd: '2026-12-06T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    customerId: 'cust-1',
    customer: { id: 'cust-1', externalId: TEST_USER_ID },
    productId: 'prod-pro-m',
    ...overrides,
  };
}

async function post(eventId: string, body: unknown, opts: { timestamp?: number } = {}) {
  return fetch(`${url}/webhooks/polar`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': eventId,
      'webhook-timestamp': String(opts.timestamp ?? 1_790_000_000),
      'webhook-signature': 'v1,good',
    },
    body: JSON.stringify(body),
  });
}

const lots = (ownerId = TEST_USER_ID) => db.select().from(creditLots).where(eq(creditLots.ownerId, ownerId));
const user = async () => (await db.select().from(usersTable).where(eq(usersTable.id, TEST_USER_ID)))[0];

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  for (const [k, v] of Object.entries(POLAR_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  await seedUser(db);
  vi.spyOn(websocketModule, 'emitSubscriptionUpdated').mockImplementation(() => {});

  const app = express();
  // Like index.ts: a thrown handler answers 500, which makes Polar retry.
  app.post('/webhooks/polar', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    handlePolarWebhook(req, res).catch(() => {
      if (!res.headersSent) res.status(500).json({ success: false });
    });
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

describe('order.paid — credit packs', () => {
  it.each([
    ['prod-c25', 25_000_000],
    ['prod-c100', 105_000_000],
    ['prod-c500', 550_000_000],
  ])('%s grants %i micro-dollars of credit (the pack bonus included)', async (productId, micros) => {
    const res = await post('evt-1', { type: 'order.paid', data: creditOrder({ productId }) });
    expect(res.status).toBe(200);
    const [lot] = await lots();
    expect(lot).toMatchObject({ polarOrderId: 'ord-1', source: 'purchase', totalMicros: micros, remainingMicros: micros });
    // Twelve months from the order's own date, not from the delivery.
    expect(lot.purchasedAt.toISOString()).toBe('2026-11-10T12:00:00.000Z');
    expect(lot.expiresAt.toISOString()).toBe('2027-11-10T12:00:00.000Z');
    const [event] = await db.select().from(billingEventsTable);
    expect(event).toMatchObject({ eventType: 'order.paid', applied: true, userId: TEST_USER_ID });
    expect(websocketModule.emitSubscriptionUpdated).toHaveBeenCalledWith(TEST_USER_ID, expect.anything());
  });

  it('a redelivery of the same event is a duplicate and grants nothing', async () => {
    await post('evt-1', { type: 'order.paid', data: creditOrder() });
    const res = await post('evt-1', { type: 'order.paid', data: creditOrder() });
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(await lots()).toHaveLength(1);
  });

  it('a second event id for the same order grants nothing more', async () => {
    await post('evt-1', { type: 'order.paid', data: creditOrder() });
    await post('evt-2', { type: 'order.paid', data: creditOrder() });
    expect(await lots()).toHaveLength(1);
    const events = await db.select().from(billingEventsTable);
    expect(events.find((e) => e.eventId === 'evt-2')?.applied).toBe(false);
    const ledger = await db.select().from(creditLedger);
    expect(ledger).toHaveLength(1);
  });

  it('an auto top-up order is recorded as one and counted once', async () => {
    await db.insert(autoTopupSettings).values({ ownerId: TEST_USER_ID, enabled: true, inflightOrderId: 'ord-1', inflightStartedAt: new Date() });
    const data = creditOrder({ productId: 'prod-c25', metadata: { kind: 'auto_topup', owner_id: TEST_USER_ID, pack: '25' } });
    await post('evt-1', { type: 'order.paid', data });
    await post('evt-2', { type: 'order.paid', data });
    expect((await lots())[0]).toMatchObject({ source: 'auto_topup', totalMicros: 25_000_000 });
    const [settings] = await db.select().from(autoTopupSettings);
    expect(settings).toMatchObject({ monthSpentMicros: 25_000_000, inflightOrderId: null });
  });

  it.each([
    ['a subscription renewal (Pro product)', { productId: 'prod-pro-m' }],
    ['a product this backend does not know', { productId: 'prod-other' }],
    ['no product', { productId: null }],
  ])('%s grants nothing', async (_name, overrides) => {
    const res = await post('evt-1', { type: 'order.paid', data: creditOrder(overrides) });
    expect(res.status).toBe(200);
    expect(await lots()).toHaveLength(0);
    expect((await db.select().from(billingEventsTable))[0].applied).toBe(false);
  });

  it('a team customer never receives credits, nor does its buyer', async () => {
    await db.insert(teamsTable).values({ id: 'team-1', name: 'Acme', polarCustomerId: 'cust-1' });
    await post('evt-1', {
      type: 'order.paid',
      data: creditOrder({ customer: { id: 'cust-1', externalId: 'team_team-1' } }),
    });
    expect(await db.select().from(creditLots)).toHaveLength(0);
  });

  it('an unknown customer is recorded and acknowledged', async () => {
    const res = await post('evt-1', {
      type: 'order.paid',
      data: creditOrder({ customerId: 'cust-x', customer: { id: 'cust-x', externalId: 'nobody' } }),
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(creditLots)).toHaveLength(0);
  });

  it('a grant that fails is retried by the next delivery, not swallowed as a duplicate', async () => {
    const credits = await import('../services/billing/usage/credits.js');
    const spy = vi.spyOn(credits, 'grantCreditLot').mockRejectedValueOnce(new Error('db down'));
    const failed = await post('evt-1', { type: 'order.paid', data: creditOrder() });
    expect(failed.status).toBe(500);
    expect(await db.select().from(billingEventsTable)).toHaveLength(0);
    spy.mockRestore();
    const retried = await post('evt-1', { type: 'order.paid', data: creditOrder() });
    expect(retried.status).toBe(200);
    expect(await lots()).toHaveLength(1);
  });

  it('maps by the stored customer id when the external id is missing', async () => {
    await db.update(usersTable).set({ polarCustomerId: 'cust-9' }).where(eq(usersTable.id, TEST_USER_ID));
    await post('evt-1', {
      type: 'order.paid',
      data: creditOrder({ customerId: 'cust-9', customer: { id: 'cust-9', externalId: null } }),
    });
    expect(await lots()).toHaveLength(1);
  });
});

describe('order.refunded', () => {
  it('takes back what is left of the lot', async () => {
    await post('evt-1', { type: 'order.paid', data: creditOrder() });
    await burnCredits(TEST_USER_ID, 5_000_000, new Date('2026-11-11T00:00:00Z'));
    await post('evt-2', { type: 'order.refunded', data: creditOrder({ status: 'refunded', refundedAmount: 10000 }) });
    const [lot] = await lots();
    expect(lot.remainingMicros).toBe(0);
    const refunds = (await db.select().from(creditLedger)).filter((r) => r.reason === 'refund');
    expect(refunds).toEqual([expect.objectContaining({ deltaMicros: -100_000_000 })]);
  });

  it('a refund redelivered under a new event id takes back nothing more', async () => {
    await post('evt-1', { type: 'order.paid', data: creditOrder() });
    await post('evt-2', { type: 'order.refunded', data: creditOrder({ status: 'refunded', refundedAmount: 10000 }) });
    await post('evt-3', { type: 'order.refunded', data: creditOrder({ status: 'refunded', refundedAmount: 10000 }) });
    const refunds = (await db.select().from(creditLedger)).filter((r) => r.reason === 'refund' && r.deltaMicros !== 0);
    expect(refunds).toHaveLength(1);
  });

  it('a refund that overtakes order.paid leaves nothing to grant later', async () => {
    await post('evt-2', { type: 'order.refunded', data: creditOrder({ status: 'refunded', refundedAmount: 10000 }) });
    await post('evt-1', { type: 'order.paid', data: creditOrder() });
    const all = await lots();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ remainingMicros: 0, totalMicros: 0, source: 'refund_reversal' });
  });

  it.each([
    ['status partially_refunded', { status: 'partially_refunded', refundedAmount: 5000 }],
    ['an amount below the total', { status: 'refunded', refundedAmount: 5000 }],
  ])('a partial refund (%s) leaves the credit for an operator', async (_name, overrides) => {
    await post('evt-1', { type: 'order.paid', data: creditOrder() });
    await post('evt-2', { type: 'order.refunded', data: creditOrder(overrides) });
    expect((await lots())[0].remainingMicros).toBe(105_000_000);
    const result = await applyOrderEvent('order.refunded', creditOrder(overrides));
    expect(result).toMatchObject({ applied: false, reason: 'partial_refund' });
  });

  it('a refund of a subscription order is ignored', async () => {
    const res = await post('evt-1', { type: 'order.refunded', data: creditOrder({ productId: 'prod-pro-m' }) });
    expect(res.status).toBe(200);
    expect(await db.select().from(creditLots)).toHaveLength(0);
  });
});

describe('subscription events write the product id', () => {
  it.each([
    ['Pro monthly', 'prod-pro-m'],
    ['Pro annual', 'prod-pro-a'],
    ['old Unlimited', 'prod-legacy-m'],
  ])('%s → users.polar_product_id', async (_name, productId) => {
    await post('evt-1', { type: 'subscription.updated', data: subscription({ productId }) });
    expect(await user()).toMatchObject({ polarProductId: productId, plan: 'unlimited' });
  });

  it('an event without a product keeps the stored one', async () => {
    await post('evt-1', { type: 'subscription.created', data: subscription({ productId: 'prod-legacy-m' }) });
    await post('evt-2', { type: 'subscription.updated', data: subscription({ productId: undefined }) }, { timestamp: 1_790_000_100 });
    expect((await user()).polarProductId).toBe('prod-legacy-m');
  });

  it('a plan change lands; a late, older event does not undo it', async () => {
    await post('evt-1', { type: 'subscription.updated', data: subscription({ productId: 'prod-pro-m' }) }, { timestamp: 1_790_000_200 });
    await post('evt-0', { type: 'subscription.updated', data: subscription({ productId: 'prod-legacy-m' }) }, { timestamp: 1_790_000_100 });
    expect((await user()).polarProductId).toBe('prod-pro-m');
  });

  it.each([
    ['the Pro team product', 'prod-team-pro-m', 'pro'],
    ['the old team product', 'prod-team-a', 'legacy_pro'],
  ])('a team on %s gets tier %s', async (_name, productId, tier) => {
    await db.insert(teamsTable).values({ id: 'team-1', name: 'Acme' });
    await post('evt-1', {
      type: 'subscription.active',
      data: subscription({ productId, seats: 3, customer: { id: 'cust-t', externalId: 'team_team-1' }, customerId: 'cust-t' }),
    });
    const [team] = await db.select().from(teamsTable).where(eq(teamsTable.id, 'team-1'));
    expect(team).toMatchObject({ tier, polarProductId: productId, plan: 'team', seatsPurchased: 3 });
    // The buyer's own row is untouched.
    expect((await user()).polarProductId).toBeNull();
  });

  it('a team event with an unknown product keeps the team tier', async () => {
    await db.insert(teamsTable).values({ id: 'team-1', name: 'Acme', tier: 'pro' });
    await post('evt-1', {
      type: 'subscription.updated',
      data: subscription({ productId: 'prod-mystery', customer: { id: 'cust-t', externalId: 'team_team-1' }, customerId: 'cust-t' }),
    });
    const [team] = await db.select().from(teamsTable).where(eq(teamsTable.id, 'team-1'));
    expect(team.tier).toBe('pro');
  });
});
