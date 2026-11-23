import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { includedWeightedSeconds, usagePeriodFor, type PlanTier, type UsageResetTier } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { usageIntervals, usagePeriods, usageResets, users } from '../db/schema.js';
import * as websocketModule from '../services/websocket.js';
import { domainEvents } from '../services/events.js';
import { readBudget } from '../services/billing/usage/charge.js';
import { insertOpenInterval } from '../services/billing/usage/intervals.js';
import { applyUsageReset, countUsageResets, markUsageResetRefunded } from '../services/billing/usage/resets.js';
import { applyOrderEvent } from '../services/billing/webhook.js';
import { usageResetTierForProduct } from '../services/billing/polar.js';

const OWNER = TEST_USER_ID;
const NOV = new Date('2026-11-01T00:00:00.000Z');
const T0 = new Date('2026-11-10T12:00:00.000Z');
const HOUR = 3600;

const RESET_ENV: Record<string, string> = {
  POLAR_PRODUCT_ID_RESET_PRO: 'prod-reset-pro',
  POLAR_PRODUCT_ID_RESET_MAX: 'prod-reset-max',
  POLAR_PRODUCT_ID_RESET_LEGACY_PRO: 'prod-reset-legacy',
  POLAR_PRODUCT_ID_CREDITS_25: 'prod-c25',
};
const saved: Record<string, string | undefined> = {};

let db: Database;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  for (const [k, v] of Object.entries(RESET_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  await seedUser(db);
  vi.spyOn(websocketModule, 'emitUsageAlert').mockImplementation(() => {});
  vi.spyOn(websocketModule, 'emitUsageExhausted').mockImplementation(() => {});
  vi.spyOn(websocketModule, 'emitSubscriptionUpdated').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of Object.keys(RESET_ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await cleanup();
});

const setTier = (planOverride: string | null) => db.update(users).set({ planOverride }).where(eq(users.id, OWNER));

async function seedPeriod(tier: PlanTier, row: Partial<typeof usagePeriods.$inferInsert> = {}, start = NOV) {
  const period = usagePeriodFor({ now: start, anchor: null });
  await db.insert(usagePeriods).values({
    ownerId: OWNER,
    periodStart: period.start,
    periodEnd: period.end,
    tier,
    includedWsec: includedWeightedSeconds(tier),
    ...row,
  });
}

const periodRow = async (start = NOV) =>
  (await db.select().from(usagePeriods).where(eq(usagePeriods.periodStart, start)))[0];

describe('applyUsageReset', () => {
  it('moves used hours out, restores the full allowance and clears alerts and exhaustion', async () => {
    await setTier('pro');
    const stamp = new Date('2026-11-09T00:00:00.000Z');
    await seedPeriod('pro', {
      usedWsec: 230 * HOUR,
      creditMicrosUsed: 5_000_000,
      alert50At: stamp,
      alert80At: stamp,
      alert100At: stamp,
      exhaustedAt: stamp,
    });
    const restored = vi.fn();
    domainEvents.on('billing:budget_restored', restored);

    const result = await applyUsageReset({ ownerId: OWNER, polarOrderId: 'ord-1', tier: 'pro', now: T0 });

    expect(result).toEqual({ applied: true, periodStart: NOV, usedBeforeWsec: 230 * HOUR, includedWsec: 200 * HOUR });
    const row = await periodRow();
    expect(row).toMatchObject({
      usedWsec: 0,
      resetUsedWsec: 230 * HOUR,
      includedWsec: 200 * HOUR,
      creditMicrosUsed: 5_000_000,
      alert50At: null,
      alert80At: null,
      alert100At: null,
      exhaustedAt: null,
    });
    expect(restored).toHaveBeenCalledWith({ ownerId: OWNER });
    domainEvents.off('billing:budget_restored', restored);
    const budget = await readBudget(OWNER, T0);
    expect(budget).toMatchObject({ includedLeftWsec: 200 * HOUR, usedWsec: 0, exhausted: false });
    expect(await countUsageResets(OWNER, NOV)).toBe(1);
  });

  it('applies once per order: a redelivery is a no-op', async () => {
    await setTier('pro');
    await seedPeriod('pro', { usedWsec: 50 * HOUR });
    await applyUsageReset({ ownerId: OWNER, polarOrderId: 'ord-1', tier: 'pro', now: T0 });
    await db.update(usagePeriods).set({ usedWsec: 7 * HOUR });

    expect(await applyUsageReset({ ownerId: OWNER, polarOrderId: 'ord-1', tier: 'pro', now: T0 })).toEqual({ applied: false });
    expect(await periodRow()).toMatchObject({ usedWsec: 7 * HOUR, resetUsedWsec: 50 * HOUR });
    expect(await countUsageResets(OWNER, NOV)).toBe(1);
  });

  it('a second order resets again and adds to the moved total', async () => {
    await setTier('pro');
    await seedPeriod('pro', { usedWsec: 200 * HOUR });
    await applyUsageReset({ ownerId: OWNER, polarOrderId: 'ord-1', tier: 'pro', now: T0 });
    await db.update(usagePeriods).set({ usedWsec: 150 * HOUR });
    await applyUsageReset({ ownerId: OWNER, polarOrderId: 'ord-2', tier: 'pro', now: T0 });
    expect(await periodRow()).toMatchObject({ usedWsec: 0, resetUsedWsec: 350 * HOUR });
    expect(await countUsageResets(OWNER, NOV)).toBe(2);
  });

  it('charges running boxes up to the reset first, so those seconds count before it', async () => {
    await setTier('pro');
    await seedPeriod('pro', { usedWsec: 10 * HOUR });
    await insertOpenInterval({
      ownerId: OWNER,
      workspaceId: null,
      subjectKind: 'task',
      subjectId: 't1',
      sandboxId: 'sb-1',
      size: 'standard',
      startedAt: new Date(T0.getTime() - 2 * HOUR * 1000),
    });

    const result = await applyUsageReset({ ownerId: OWNER, polarOrderId: 'ord-1', tier: 'pro', now: T0 });

    expect(result.usedBeforeWsec).toBe(12 * HOUR);
    expect(await periodRow()).toMatchObject({ usedWsec: 0, resetUsedWsec: 12 * HOUR });
    const [interval] = await db.select().from(usageIntervals);
    expect(interval.billedThrough.getTime()).toBe(T0.getTime());
  });

  it('creates the period row when the owner has none yet', async () => {
    await setTier('pro');
    const result = await applyUsageReset({ ownerId: OWNER, polarOrderId: 'ord-1', tier: 'pro', now: T0 });
    expect(result).toMatchObject({ applied: true, usedBeforeWsec: 0 });
    expect(await periodRow()).toMatchObject({ usedWsec: 0, includedWsec: 200 * HOUR });
  });

  it.each<[UsageResetTier, string | null, number]>([
    ['pro', 'max', 200],
    ['max', 'pro', 1000],
    ['pro', null, 200],
    ['legacy_pro', 'legacy_pro', 50],
  ])('a %s reset gives that tier’s hours when the owner is on %s', async (paidFor, override, hours) => {
    await setTier(override);
    const result = await applyUsageReset({ ownerId: OWNER, polarOrderId: 'ord-1', tier: paidFor, now: T0 });
    expect(result.includedWsec).toBe(hours * HOUR);
    expect((await periodRow()).includedWsec).toBe(hours * HOUR);
  });
});

describe('markUsageResetRefunded', () => {
  it('marks an applied reset and leaves the hours alone', async () => {
    await setTier('pro');
    await seedPeriod('pro', { usedWsec: 100 * HOUR });
    await applyUsageReset({ ownerId: OWNER, polarOrderId: 'ord-1', tier: 'pro', now: T0 });
    expect(await markUsageResetRefunded({ ownerId: OWNER, polarOrderId: 'ord-1', tier: 'pro', now: T0 })).toBe(true);
    const [reset] = await db.select().from(usageResets);
    expect(reset.refundedAt?.getTime()).toBe(T0.getTime());
    expect(await periodRow()).toMatchObject({ usedWsec: 0, resetUsedWsec: 100 * HOUR });
  });

  it('a refund that overtakes order.paid stops the late reset', async () => {
    await setTier('pro');
    await seedPeriod('pro', { usedWsec: 100 * HOUR });
    expect(await markUsageResetRefunded({ ownerId: OWNER, polarOrderId: 'ord-1', tier: 'pro', now: T0 })).toBe(false);
    expect(await applyUsageReset({ ownerId: OWNER, polarOrderId: 'ord-1', tier: 'pro', now: T0 })).toEqual({ applied: false });
    expect(await periodRow()).toMatchObject({ usedWsec: 100 * HOUR, resetUsedWsec: 0 });
    expect(await countUsageResets(OWNER, NOV)).toBe(0);
  });
});

describe('usage reset orders in the webhook', () => {
  const order = (overrides: Record<string, unknown> = {}) => ({
    id: 'ord-r1',
    status: 'paid',
    productId: 'prod-reset-pro',
    customerId: 'cust-1',
    customer: { id: 'cust-1', externalId: OWNER, email: 'a@example.com' },
    metadata: { kind: 'usage_reset', tier: 'pro' },
    totalAmount: 4000,
    currency: 'usd',
    ...overrides,
  });
  const now = () => usagePeriodFor({ now: new Date(), anchor: null }).start;

  it.each([
    ['prod-reset-pro', 'pro'],
    ['prod-reset-max', 'max'],
    ['prod-reset-legacy', 'legacy_pro'],
    ['prod-c25', null],
    [null, null],
  ])('product %s resets %s', (productId, tier) => {
    expect(usageResetTierForProduct(productId)).toBe(tier);
  });

  it('order.paid resets once; a redelivered order.paid does nothing', async () => {
    await setTier('pro');
    await seedPeriod('pro', { usedWsec: 80 * HOUR }, now());

    const first = await applyOrderEvent('order.paid', order());
    expect(first).toEqual({ applied: true, userId: OWNER, resetTier: 'pro', resetUsedBeforeWsec: 80 * HOUR });
    expect(await periodRow(now())).toMatchObject({ usedWsec: 0, resetUsedWsec: 80 * HOUR });

    const again = await applyOrderEvent('order.paid', order());
    expect(again).toMatchObject({ applied: false, reason: 'already_granted', resetTier: 'pro' });
  });

  it('order.refunded records the refund and reports whether the reset ran', async () => {
    await setTier('pro');
    await seedPeriod('pro', { usedWsec: 80 * HOUR }, now());
    await applyOrderEvent('order.paid', order());
    const refunded = await applyOrderEvent('order.refunded', order({ status: 'refunded', refundedAmount: 4000 }));
    expect(refunded).toEqual({ applied: true, userId: OWNER, resetTier: 'pro', resetWasApplied: true });
    expect(await periodRow(now())).toMatchObject({ usedWsec: 0, resetUsedWsec: 80 * HOUR });
  });

  it('a team customer never maps to a user', async () => {
    const result = await applyOrderEvent('order.paid', order({ customer: { id: 'cust-t', externalId: 'team_abc' } }));
    expect(result).toMatchObject({ applied: false, reason: 'no_user', resetTier: 'pro' });
    expect(await db.select().from(usageResets)).toHaveLength(0);
  });

  it('a credit pack order still goes the credit way', async () => {
    const result = await applyOrderEvent('order.paid', order({ id: 'ord-c', productId: 'prod-c25' }));
    expect(result).toMatchObject({ pack: '25' });
    expect(result.resetTier).toBeUndefined();
  });
});
