import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { CREDIT_PACKS, type CreditPackId } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { autoTopupSettings, creditLedger, creditLots, users } from '../db/schema.js';
import * as websocketModule from '../services/websocket.js';

// Polar is mocked at the module seam: these tests are about the claim, the
// policy and the ledger, not the SDK.
const polar = vi.hoisted(() => ({
  createDraftOrder: vi.fn(),
  finalizeOrder: vi.fn(),
  getOrder: vi.fn(),
  getCustomerIdForUser: vi.fn(),
}));
vi.mock('../services/billing/polar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/billing/polar.js')>();
  return { ...actual, ...polar };
});

const {
  CLAIM_STALE_MS,
  NO_CUSTOMER_MESSAGE,
  failureMessage,
  readAutoTopupSettings,
  runAutoTopUp,
  saveAutoTopupSettings,
  settleCreditOrder,
  toAutoTopupSettings,
  tryAutoTopUp,
} = await import('../services/billing/autoTopup.js');

const { chargeOwnerAt } = await import('../services/billing/usage/charge.js');
const { insertOpenInterval } = await import('../services/billing/usage/intervals.js');

const OWNER = 'owner-a';
const OTHER = 'owner-b';
const NOW = new Date('2026-11-10T12:00:00.000Z');
const PRODUCT_ENV = {
  POLAR_ACCESS_TOKEN: 'polar-test-token',
  POLAR_PRODUCT_ID_CREDITS_25: 'prod-c25',
  POLAR_PRODUCT_ID_CREDITS_100: 'prod-c100',
  POLAR_PRODUCT_ID_CREDITS_500: 'prod-c500',
} as const;
const savedEnv: Record<string, string | undefined> = {};

function polarError(statusCode: number, error?: string) {
  return Object.assign(new Error(`polar ${statusCode}`), { statusCode, ...(error ? { error } : {}) });
}

function order(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, status, paid: status === 'paid', createdAt: NOW, ...extra };
}

let db: Database;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  for (const [k, v] of Object.entries(PRODUCT_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  await seedUser(db, { id: OWNER });
  await seedUser(db, { id: OTHER });
  await db.update(users).set({ planOverride: 'pro', polarCustomerId: 'cust-a' }).where(eq(users.id, OWNER));
  vi.spyOn(websocketModule, 'emitSubscriptionUpdated').mockImplementation(() => {});
  polar.createDraftOrder.mockImplementation(async () => order('ord-1', 'draft'));
  polar.finalizeOrder.mockImplementation(async (id: string) => order(id, 'paid'));
  polar.getOrder.mockImplementation(async (id: string) => order(id, 'draft'));
  polar.getCustomerIdForUser.mockResolvedValue(null);
});

afterEach(async () => {
  for (const k of Object.keys(PRODUCT_ENV)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
  for (const fn of Object.values(polar)) fn.mockReset();
  await cleanup();
});

async function settings(values: Partial<typeof autoTopupSettings.$inferInsert> = {}, ownerId = OWNER) {
  await db.insert(autoTopupSettings).values({
    ownerId,
    enabled: true,
    triggerMicros: 5_000_000,
    pack: '25',
    monthlyLimitMicros: 100_000_000,
    ...values,
  });
}

const row = async (ownerId = OWNER) =>
  (await db.select().from(autoTopupSettings).where(eq(autoTopupSettings.ownerId, ownerId)))[0];
const lots = (ownerId = OWNER) => db.select().from(creditLots).where(eq(creditLots.ownerId, ownerId));

describe('runAutoTopUp — policy', () => {
  it('does nothing when billing is not configured', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    await settings();
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('billing_off');
    expect(polar.createDraftOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['no settings row', null],
    ['turned off', { enabled: false }],
  ])('does nothing with %s', async (_name, values) => {
    if (values) await settings(values);
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('not_enabled');
    expect(polar.createDraftOrder).not.toHaveBeenCalled();
  });

  it.each([
    ['free', 'plan_has_no_credits'],
    ['pro', 'granted'],
    ['legacy_pro', 'granted'],
  ])('tier %s → %s', async (override, outcome) => {
    await db.update(users).set({ planOverride: override }).where(eq(users.id, OWNER));
    await settings();
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe(outcome);
  });

  it('refuses while a recorded failure stands, without calling Polar', async () => {
    await settings({ lastFailure: 'Your card was declined.', lastFailureAt: NOW });
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('failed_before');
    expect(polar.createDraftOrder).not.toHaveBeenCalled();
  });

  it.each<[string, { pack: CreditPackId; spent: number; key: string | null; limit: number }, string]>([
    ['room for one more $25', { pack: '25', spent: 75_000_000, key: '2026-11', limit: 100_000_000 }, 'granted'],
    ['a $25 would pass the limit', { pack: '25', spent: 80_000_000, key: '2026-11', limit: 100_000_000 }, 'monthly_limit'],
    ['a $100 pack over a $100 limit after one', { pack: '100', spent: 100_000_000, key: '2026-11', limit: 150_000_000 }, 'monthly_limit'],
    ['last month spend does not count', { pack: '25', spent: 100_000_000, key: '2026-10', limit: 100_000_000 }, 'granted'],
    ['no month yet', { pack: '25', spent: 0, key: null, limit: 25_000_000 }, 'granted'],
  ])('monthly limit: %s', async (_name, { pack, spent, key, limit }, outcome) => {
    await settings({ pack, monthSpentMicros: spent, monthKey: key, monthlyLimitMicros: limit });
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe(outcome);
  });

  it.each<[string, number, number, string]>([
    ['balance above the trigger, no shortfall', 6_000_000, 0, 'above_trigger'],
    ['balance at the trigger, no shortfall', 5_000_000, 0, 'above_trigger'],
    ['balance below the trigger', 4_999_999, 0, 'granted'],
    ['a shortfall ignores the trigger', 6_000_000, 10, 'granted'],
  ])('trigger: %s', async (_name, balance, shortfall, outcome) => {
    await settings();
    if (balance > 0) {
      await db.insert(creditLots).values({
        id: 'lot-existing',
        ownerId: OWNER,
        totalMicros: balance,
        remainingMicros: balance,
        source: 'purchase',
        purchasedAt: NOW,
        expiresAt: new Date('2027-06-01T00:00:00Z'),
      });
    }
    expect(await runAutoTopUp(OWNER, shortfall, NOW)).toBe(outcome);
  });
});

describe('runAutoTopUp — a charge that works', () => {
  it.each<CreditPackId>(['25', '100', '500'])('grants the %s pack with its bonus and counts the price', async (pack) => {
    await settings({ pack, monthlyLimitMicros: 1_000_000_000 });
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('granted');

    expect(polar.createDraftOrder).toHaveBeenCalledTimes(1);
    const draft = polar.createDraftOrder.mock.calls[0][0];
    expect(draft).toMatchObject({
      customerId: 'cust-a',
      productId: `prod-c${pack}`,
      metadata: { kind: 'auto_topup', owner_id: OWNER, pack },
    });
    // One idempotency key per attempt, carried in the metadata too.
    expect(draft.idempotencyKey).toBe(draft.metadata.attempt_id);
    expect(polar.finalizeOrder).toHaveBeenCalledWith('ord-1');

    const [lot] = await lots();
    expect(lot).toMatchObject({
      polarOrderId: 'ord-1',
      source: 'auto_topup',
      totalMicros: CREDIT_PACKS[pack].creditMicros,
      remainingMicros: CREDIT_PACKS[pack].creditMicros,
    });
    const after = await row();
    expect(after).toMatchObject({
      monthKey: '2026-11',
      monthSpentMicros: CREDIT_PACKS[pack].priceMicros,
      inflightOrderId: null,
      inflightStartedAt: null,
      lastFailure: null,
    });
  });

  it('resets last month counter on the first charge of a month', async () => {
    await settings({ monthKey: '2026-10', monthSpentMicros: 75_000_000 });
    await runAutoTopUp(OWNER, 1_000, NOW);
    expect(await row()).toMatchObject({ monthKey: '2026-11', monthSpentMicros: 25_000_000 });
  });

  it('looks the customer up by external id when none is stored', async () => {
    await db.update(users).set({ polarCustomerId: null }).where(eq(users.id, OWNER));
    polar.getCustomerIdForUser.mockResolvedValue('cust-from-polar');
    await settings();
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('granted');
    expect(polar.getCustomerIdForUser).toHaveBeenCalledWith(OWNER);
    expect(polar.createDraftOrder.mock.calls[0][0].customerId).toBe('cust-from-polar');
  });

  it('a later order.paid for the same order grants and counts nothing more', async () => {
    await settings();
    await runAutoTopUp(OWNER, 1_000, NOW);
    expect(await settleCreditOrder({ ownerId: OWNER, orderId: 'ord-1', pack: '25', source: 'auto_topup' }, NOW)).toEqual({
      created: false,
    });
    expect(await lots()).toHaveLength(1);
    expect((await row()).monthSpentMicros).toBe(25_000_000);
  });

  it('keeps the claim while a finalize answers pending, and starts nothing new', async () => {
    await settings();
    polar.finalizeOrder.mockImplementation(async (id: string) => order(id, 'pending'));
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('pending');
    expect(await lots()).toHaveLength(0);
    expect((await row()).inflightOrderId).toBe('ord-1');
    expect(await runAutoTopUp(OWNER, 1_000, new Date(NOW.getTime() + 60_000))).toBe('in_flight');
    expect(polar.createDraftOrder).toHaveBeenCalledTimes(1);

    // order.paid lands: credits granted, claim released, spend counted.
    await settleCreditOrder({ ownerId: OWNER, orderId: 'ord-1', pack: '25', source: 'auto_topup' }, NOW);
    expect(await row()).toMatchObject({ inflightOrderId: null, monthSpentMicros: 25_000_000 });
  });

  it('tryAutoTopUp answers true only when a lot was granted', async () => {
    await settings();
    expect(await tryAutoTopUp(OWNER, 1_000)).toBe(true);
    polar.createDraftOrder.mockImplementation(async () => order('ord-2', 'draft'));
    polar.finalizeOrder.mockImplementation(async (id: string) => order(id, 'pending'));
    await db.update(autoTopupSettings).set({ monthSpentMicros: 0 });
    expect(await tryAutoTopUp(OWNER, 1_000)).toBe(false);
  });

  it('tryAutoTopUp never throws', async () => {
    await settings();
    polar.createDraftOrder.mockImplementation(() => {
      throw new TypeError('boom');
    });
    await expect(tryAutoTopUp(OWNER, 1_000)).resolves.toBe(false);
  });
});

describe('runAutoTopUp — a charge that fails', () => {
  it.each([
    ['declined', polarError(402, 'PaymentFailed'), /declined/],
    ['needs the cardholder (SCA)', polarError(402, 'PaymentActionRequired'), /confirm/],
    ['off-session charges not enabled', polarError(403, 'OffSessionChargesNotEnabled'), /not available/],
    ['order not a draft', polarError(412, 'OrderNotDraft'), /Polar answered 412/],
  ])('%s: records the failure, releases the claim, grants nothing', async (_name, err, message) => {
    await settings();
    polar.finalizeOrder.mockRejectedValue(err);
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('refused');
    const after = await row();
    expect(after.lastFailure).toMatch(message);
    expect(after.lastFailureAt?.toISOString()).toBe(NOW.toISOString());
    expect(after).toMatchObject({ inflightOrderId: null, inflightStartedAt: null, monthSpentMicros: 0 });
    expect(await lots()).toHaveLength(0);
    // The UI's "buy credits" prompt reads it, and nothing charges again by itself.
    expect((await readAutoTopupSettings(OWNER, NOW)).lastFailure).toMatch(message);
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('failed_before');
    expect(polar.finalizeOrder).toHaveBeenCalledTimes(1);
  });

  it('a refused draft order (create 403) is a recorded failure too', async () => {
    await settings();
    polar.createDraftOrder.mockRejectedValue(polarError(403));
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('refused');
    expect((await row()).lastFailure).toMatch(/not available/);
  });

  it('no Polar customer: records the no-payment-method failure without a draft', async () => {
    await db.update(users).set({ polarCustomerId: null }).where(eq(users.id, OWNER));
    await settings();
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('refused');
    expect((await row()).lastFailure).toBe(NO_CUSTOMER_MESSAGE);
    expect(polar.createDraftOrder).not.toHaveBeenCalled();
  });

  it('saving the settings clears the failure, and the next charge clears nothing it should keep', async () => {
    await settings({ lastFailure: 'Your card was declined.', lastFailureAt: NOW, monthKey: '2026-11', monthSpentMicros: 25_000_000 });
    await saveAutoTopupSettings(OWNER, { enabled: true, triggerMicros: 5_000_000, pack: '25', monthlyLimitMicros: 100_000_000 }, NOW);
    expect(await row()).toMatchObject({ lastFailure: null, lastFailureAt: null, monthSpentMicros: 25_000_000 });
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('granted');
    expect((await row()).monthSpentMicros).toBe(50_000_000);
  });

  it('a successful charge clears a failure recorded meanwhile', async () => {
    await settings({ lastFailure: 'old', lastFailureAt: NOW, inflightOrderId: 'ord-9', inflightStartedAt: NOW });
    await settleCreditOrder({ ownerId: OWNER, orderId: 'ord-9', pack: '25', source: 'auto_topup' }, NOW);
    expect(await row()).toMatchObject({ lastFailure: null, lastFailureAt: null, inflightOrderId: null });
  });

  it('a network failure at create releases the claim and records nothing', async () => {
    await settings();
    polar.createDraftOrder.mockRejectedValue(new TypeError('fetch failed'));
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('in_doubt');
    expect(await row()).toMatchObject({ lastFailure: null, inflightOrderId: null });
  });

  it.each([
    ['a network failure', new TypeError('fetch failed')],
    ['a 500', polarError(500)],
    ['a 429', polarError(429)],
  ])('%s at finalize keeps the claim on the order (the outcome is unknown)', async (_name, err) => {
    await settings();
    polar.finalizeOrder.mockRejectedValue(err);
    expect(await runAutoTopUp(OWNER, 1_000, NOW)).toBe('in_doubt');
    expect(await row()).toMatchObject({ lastFailure: null, inflightOrderId: 'ord-1' });
    expect(await runAutoTopUp(OWNER, 1_000, new Date(NOW.getTime() + CLAIM_STALE_MS - 1))).toBe('in_flight');
  });
});

describe('runAutoTopUp — a stale claim', () => {
  const later = new Date(NOW.getTime() + CLAIM_STALE_MS + 1_000);

  it('settles a stale order that was paid, without a new charge', async () => {
    await settings({ inflightOrderId: 'ord-old', inflightStartedAt: NOW });
    polar.getOrder.mockResolvedValue(order('ord-old', 'paid'));
    expect(await runAutoTopUp(OWNER, 1_000, later)).toBe('granted');
    expect(polar.createDraftOrder).not.toHaveBeenCalled();
    expect(polar.finalizeOrder).not.toHaveBeenCalled();
    expect((await lots())[0]).toMatchObject({ polarOrderId: 'ord-old' });
    expect((await row()).inflightOrderId).toBeNull();
  });

  it('re-finalizes a stale draft instead of creating a second order', async () => {
    await settings({ inflightOrderId: 'ord-old', inflightStartedAt: NOW });
    polar.getOrder.mockResolvedValue(order('ord-old', 'draft'));
    expect(await runAutoTopUp(OWNER, 1_000, later)).toBe('granted');
    expect(polar.createDraftOrder).not.toHaveBeenCalled();
    expect(polar.finalizeOrder).toHaveBeenCalledWith('ord-old');
  });

  it('waits on a stale order still pending', async () => {
    await settings({ inflightOrderId: 'ord-old', inflightStartedAt: NOW });
    polar.getOrder.mockResolvedValue(order('ord-old', 'pending'));
    expect(await runAutoTopUp(OWNER, 1_000, later)).toBe('pending');
    expect(polar.createDraftOrder).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ inflightOrderId: 'ord-old' });
  });

  it('starts a new order after a stale void one', async () => {
    await settings({ inflightOrderId: 'ord-old', inflightStartedAt: NOW });
    polar.getOrder.mockResolvedValue(order('ord-old', 'void'));
    expect(await runAutoTopUp(OWNER, 1_000, later)).toBe('granted');
    expect(polar.createDraftOrder).toHaveBeenCalledTimes(1);
  });

  it('takes over a stale bare claim (crash before the draft existed)', async () => {
    await settings({ inflightOrderId: 'claim:dead', inflightStartedAt: NOW });
    expect(await runAutoTopUp(OWNER, 1_000, later)).toBe('granted');
    expect(polar.getOrder).not.toHaveBeenCalled();
  });

  it('does not take over a live claim', async () => {
    await settings({ inflightOrderId: 'claim:alive', inflightStartedAt: NOW });
    expect(await runAutoTopUp(OWNER, 1_000, new Date(NOW.getTime() + 60_000))).toBe('in_flight');
    expect(polar.createDraftOrder).not.toHaveBeenCalled();
  });
});

describe('runAutoTopUp — concurrency', () => {
  it('two attempts at once charge once', async () => {
    await settings({ monthlyLimitMicros: 1_000_000_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    polar.finalizeOrder.mockImplementation(async (id: string) => {
      await gate;
      return order(id, 'paid');
    });
    const first = runAutoTopUp(OWNER, 1_000, NOW);
    const second = runAutoTopUp(OWNER, 1_000, NOW);
    // Let both reach the claim before the charge completes.
    await new Promise((r) => setTimeout(r, 50));
    release();
    const outcomes = (await Promise.all([first, second])).sort();
    expect(outcomes).toEqual(['granted', 'in_flight']);
    expect(polar.createDraftOrder).toHaveBeenCalledTimes(1);
    expect(await lots()).toHaveLength(1);
  });

  it('one owner claim does not block another owner', async () => {
    await settings({ inflightOrderId: 'claim:alive', inflightStartedAt: NOW });
    await settings({}, OTHER);
    await db.update(users).set({ planOverride: 'pro', polarCustomerId: 'cust-b' }).where(eq(users.id, OTHER));
    expect(await runAutoTopUp(OTHER, 1_000, NOW)).toBe('granted');
    expect(await lots(OTHER)).toHaveLength(1);
    expect(await lots(OWNER)).toHaveLength(0);
  });
});

describe('settleCreditOrder', () => {
  it('a manual purchase grants credits and leaves the auto top-up counter alone', async () => {
    await settings({ monthKey: '2026-11', monthSpentMicros: 25_000_000, lastFailure: 'declined', lastFailureAt: NOW });
    expect(await settleCreditOrder({ ownerId: OWNER, orderId: 'ord-m', pack: '100', source: 'purchase' }, NOW)).toEqual({
      created: true,
    });
    expect((await lots())[0]).toMatchObject({ source: 'purchase', totalMicros: 105_000_000 });
    expect(await row()).toMatchObject({ monthSpentMicros: 25_000_000, lastFailure: 'declined' });
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.ownerId, OWNER));
    expect(ledger).toEqual([expect.objectContaining({ deltaMicros: 105_000_000, reason: 'purchase' })]);
  });
});

describe('pure helpers', () => {
  it('toAutoTopupSettings: defaults without a row; a counter from another month reads 0', () => {
    expect(toAutoTopupSettings(undefined, NOW)).toEqual({
      enabled: false,
      triggerMicros: 5_000_000,
      pack: '25',
      monthlyLimitMicros: 100_000_000,
      monthSpentMicros: 0,
      lastFailure: null,
      lastFailureAt: null,
    });
    const base = {
      enabled: true,
      triggerMicros: 1,
      pack: 'bogus',
      monthlyLimitMicros: 2,
      monthKey: '2026-10',
      monthSpentMicros: 99,
      inflightOrderId: null,
      inflightStartedAt: null,
      lastFailure: null,
      lastFailureAt: null,
    };
    expect(toAutoTopupSettings(base, NOW)).toMatchObject({ pack: '25', monthSpentMicros: 0 });
    expect(toAutoTopupSettings({ ...base, monthKey: '2026-11' }, NOW).monthSpentMicros).toBe(99);
  });

  it.each([
    [polarError(402, 'PaymentFailed'), /declined/],
    [polarError(402, 'PaymentActionRequired'), /confirm/],
    [polarError(403), /not available/],
    [polarError(422), /422/],
    [new Error('x'), /^The automatic charge failed\. /],
  ])('failureMessage %#', (err, expected) => {
    expect(failureMessage(err)).toMatch(expected);
  });
});

describe('through the usage meter', () => {
  // A Legacy Pro owner (50 included box-hours) runs one standard box for 51
  // hours: one box-hour of overage, $0.22, with no credits.
  const START = new Date('2026-11-02T00:00:00.000Z');
  const END = new Date(START.getTime() + 51 * 3600 * 1000);

  beforeEach(async () => {
    vi.spyOn(websocketModule, 'emitUsageAlert').mockImplementation(() => {});
    vi.spyOn(websocketModule, 'emitUsageExhausted').mockImplementation(() => {});
    await db.update(users).set({ planOverride: 'legacy_pro' }).where(eq(users.id, OWNER));
    await insertOpenInterval({ ownerId: OWNER, subjectKind: 'task', subjectId: 't1', sandboxId: 'sb-1', size: 'standard', startedAt: START });
  });

  it('a top-up that works pays the overage from the new lot', async () => {
    await settings();
    const result = await chargeOwnerAt(OWNER, END);
    expect(result.exhausted).toBe(false);
    const [lot] = await lots();
    expect(lot.totalMicros).toBe(25_000_000);
    expect(lot.remainingMicros).toBe(25_000_000 - 220_000);
  });

  it('a refused top-up leaves the owner out of budget and auto top-up impossible', async () => {
    await settings();
    polar.finalizeOrder.mockRejectedValue(polarError(402, 'PaymentFailed'));
    const result = await chargeOwnerAt(OWNER, END);
    expect(result.exhausted).toBe(true);
    expect(result.budget.autoTopupPossible).toBe(false);
    expect(await lots()).toHaveLength(0);
    // The next tick reads the recorded failure and does not charge again.
    const next = await chargeOwnerAt(OWNER, new Date(END.getTime() + 60_000));
    expect(next.exhausted).toBe(true);
    expect(polar.finalizeOrder).toHaveBeenCalledTimes(1);
  });
});
