import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  PLAN_LIMITS,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_EXHAUSTED_ERROR_CODE,
  includedWeightedSeconds,
  sizePriceTable,
  usagePeriodFor,
  type PlanTier,
} from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import {
  autoTopupSettings,
  tasks as tasksTable,
  usageIntervals,
  usagePeriods,
  users as usersTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import {
  ACTIVE_TASK_STATUSES,
  BILLING_PRICING,
  ConcurrentBoxLimitError,
  UsageExhaustedError,
  assertCanActivateTask,
  buildBillingStatus,
  countActiveTasks,
  billingPeriodOf,
  resolveEntitlement,
  subscriptionPeriod,
  withBoxGate,
} from '../services/billing/entitlements.js';
import { ensurePeriod } from '../services/billing/usage/periods.js';
import { grantCreditLot } from '../services/billing/usage/credits.js';
import * as websocketModule from '../services/websocket.js';
import type { Database } from '../db/client.js';

let db: Database;
let cleanup: () => Promise<void>;
let taskSeq = 0;
const savedPolarToken = process.env.POLAR_ACCESS_TOKEN;
const savedPro = process.env.POLAR_PRODUCT_ID_PRO_MONTHLY;

const OTHER_USER_ID = 'user-other';
const FREE_CAP = PLAN_LIMITS.free.concurrentBoxes;

async function insertTask(workspaceId: string, status: string): Promise<string> {
  const id = `task-${++taskSeq}`;
  await db.insert(tasksTable).values({
    id,
    workspaceId,
    type: 'code_writing',
    status,
    title: 't',
    description: 'd',
  });
  return id;
}

/** Spend the owner's included hours for the current calendar-month period. */
async function exhaustIncluded(tier: PlanTier): Promise<void> {
  const period = usagePeriodFor({ now: new Date() });
  await ensurePeriod(TEST_USER_ID, tier, period);
  await db
    .update(usagePeriods)
    .set({ usedWsec: includedWeightedSeconds(tier) })
    .where(eq(usagePeriods.ownerId, TEST_USER_ID));
}

beforeEach(async () => {
  ({ db, cleanup } = await createTestDb());
  // Billing "configured" for these tests: enforcement on.
  process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
  process.env.POLAR_PRODUCT_ID_PRO_MONTHLY = 'prod-pro-monthly';
  vi.spyOn(websocketModule, 'emitUsageAlert').mockImplementation(() => {});
  vi.spyOn(websocketModule, 'emitUsageExhausted').mockImplementation(() => {});
  vi.spyOn(websocketModule, 'emitSubscriptionUpdated').mockImplementation(() => {});
  await seedUser(db);
  await seedUser(db, { id: OTHER_USER_ID });
  for (const [id, ownerId] of [
    ['ws1', TEST_USER_ID],
    ['ws2', TEST_USER_ID],
    ['ws-other', OTHER_USER_ID],
  ] as const) {
    await db.insert(workspacesTable).values({ id, ownerId, name: id, settings: {} });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedPolarToken === undefined) delete process.env.POLAR_ACCESS_TOKEN;
  else process.env.POLAR_ACCESS_TOKEN = savedPolarToken;
  if (savedPro === undefined) delete process.env.POLAR_PRODUCT_ID_PRO_MONTHLY;
  else process.env.POLAR_PRODUCT_ID_PRO_MONTHLY = savedPro;
  await cleanup();
});

describe('resolveEntitlement', () => {
  it.each([
    { plan: 'free', planOverride: null, polarProductId: null, expected: { tier: 'free', source: 'default' } },
    { plan: 'unlimited', planOverride: null, polarProductId: null, expected: { tier: 'legacy_pro', source: 'subscription' } },
    { plan: 'unlimited', planOverride: null, polarProductId: 'prod-pro-monthly', expected: { tier: 'pro', source: 'subscription' } },
    { plan: 'free', planOverride: 'unlimited', polarProductId: null, expected: { tier: 'pro', source: 'override' } },
    { plan: 'free', planOverride: 'legacy_pro', polarProductId: null, expected: { tier: 'legacy_pro', source: 'override' } },
    // Override wins in BOTH directions: it's a manual pin, not a floor.
    { plan: 'unlimited', planOverride: 'free', polarProductId: 'prod-pro-monthly', expected: { tier: 'free', source: 'override' } },
  ])(
    'plan=$plan override=$planOverride product=$polarProductId → $expected.tier ($expected.source)',
    async ({ plan, planOverride, polarProductId, expected }) => {
      await db.update(usersTable).set({ plan, planOverride, polarProductId }).where(eq(usersTable.id, TEST_USER_ID));
      expect(await resolveEntitlement(TEST_USER_ID)).toEqual(expected);
    }
  );

  it('unknown user resolves to free/default', async () => {
    expect(await resolveEntitlement('user-nonexistent')).toEqual({ tier: 'free', source: 'default' });
  });

  it('billing env absent → pro (enforcement disabled)', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    expect(await resolveEntitlement(TEST_USER_ID)).toEqual({ tier: 'pro', source: 'billing_disabled' });
  });
});

describe('countActiveTasks', () => {
  it.each(ACTIVE_TASK_STATUSES.map((status) => ({ status })))('counts $status tasks', async ({ status }) => {
    await insertTask('ws1', status);
    expect(await countActiveTasks(TEST_USER_ID)).toBe(1);
  });

  it.each([{ status: 'completed' }, { status: 'failed' }, { status: 'cancelled' }])(
    'ignores terminal $status tasks',
    async ({ status }) => {
      await insertTask('ws1', status);
      expect(await countActiveTasks(TEST_USER_ID)).toBe(0);
    }
  );

  it('spans every workspace the owner has, ignoring other owners', async () => {
    await insertTask('ws1', 'queued');
    await insertTask('ws2', 'in_progress');
    await insertTask('ws-other', 'queued');
    expect(await countActiveTasks(TEST_USER_ID)).toBe(2);
    expect(await countActiveTasks(OTHER_USER_ID)).toBe(1);
  });

  it('excludeTaskId drops the named task from the count', async () => {
    const id = await insertTask('ws1', 'queued');
    await insertTask('ws1', 'queued');
    expect(await countActiveTasks(TEST_USER_ID, id)).toBe(1);
  });
});

describe('withBoxGate against the real ledger', () => {
  it('a free owner with hours left and a free slot runs', async () => {
    await expect(withBoxGate(TEST_USER_ID, { size: 'standard' }, async (d) => d)).resolves.toEqual({
      enforced: true,
      tier: 'free',
      size: 'standard',
      downgraded: false,
    });
  });

  it('a free owner whose included hours are spent is refused, and fn never runs', async () => {
    await exhaustIncluded('free');
    const fn = vi.fn(async () => 'ran');
    await expect(withBoxGate(TEST_USER_ID, { size: 'small' }, fn)).rejects.toMatchObject({
      code: USAGE_EXHAUSTED_ERROR_CODE,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('credits keep a Pro owner going after the included hours', async () => {
    await db.update(usersTable).set({ planOverride: 'pro' }).where(eq(usersTable.id, TEST_USER_ID));
    await exhaustIncluded('pro');
    await expect(withBoxGate(TEST_USER_ID, { size: 'large' }, async () => 'x')).rejects.toBeInstanceOf(UsageExhaustedError);
    await grantCreditLot({ ownerId: TEST_USER_ID, micros: 1_000_000, source: 'grant' });
    await expect(withBoxGate(TEST_USER_ID, { size: 'large' }, async () => 'ran')).resolves.toBe('ran');
  });

  it('auto top-up that can still buy a pack keeps a Pro owner going', async () => {
    await db.update(usersTable).set({ planOverride: 'pro' }).where(eq(usersTable.id, TEST_USER_ID));
    await exhaustIncluded('pro');
    await db.insert(autoTopupSettings).values({ ownerId: TEST_USER_ID, enabled: true });
    await expect(withBoxGate(TEST_USER_ID, { size: 'standard' }, async () => 'ran')).resolves.toBe('ran');
  });

  it('billing env absent → no enforcement even out of hours and over the cap', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    await exhaustIncluded('free');
    for (let i = 0; i < FREE_CAP + 2; i++) await insertTask('ws1', 'queued');
    await expect(withBoxGate(TEST_USER_ID, { size: 'xlarge' }, async () => 'ran')).resolves.toBe('ran');
  });

  it('a free owner may not start large, but an unattended run gets small', async () => {
    await expect(withBoxGate(TEST_USER_ID, { size: 'large' }, async () => 'x')).rejects.toMatchObject({
      code: SIZE_REQUIRES_PRO_ERROR_CODE,
    });
    await expect(withBoxGate(TEST_USER_ID, { size: 'large', unattended: true }, async (d) => d.size)).resolves.toBe('small');
  });
});

describe('the concurrent-box cap replaces the active-task cap', () => {
  it.each(Array.from({ length: FREE_CAP }, (_, active) => ({ active })))(
    'free user with $active active tasks passes',
    async ({ active }) => {
      for (let i = 0; i < active; i++) await insertTask('ws1', 'queued');
      expect(await withBoxGate(TEST_USER_ID, { size: 'standard' }, async () => 'created')).toBe('created');
    }
  );

  it(`free user at the cap (${FREE_CAP}) is refused and fn never runs`, async () => {
    for (let i = 0; i < FREE_CAP; i++) await insertTask('ws1', 'queued');
    let ran = false;
    await expect(
      withBoxGate(TEST_USER_ID, { size: 'standard' }, async () => {
        ran = true;
      })
    ).rejects.toMatchObject({ code: CONCURRENT_BOX_LIMIT_ERROR_CODE, limit: FREE_CAP, active: FREE_CAP });
    expect(ran).toBe(false);
  });

  it('the cap spans workspaces and counts open boxes too', async () => {
    await insertTask('ws2', 'pending');
    await db.insert(usageIntervals).values({
      id: 'iv-1',
      ownerId: TEST_USER_ID,
      subjectKind: 'workbench',
      subjectId: 'wb-1',
      sandboxId: 'sb-1',
      size: 'standard',
      weight: '1.00',
      startedAt: new Date(),
      billedThrough: new Date(),
    });
    await expect(withBoxGate(TEST_USER_ID, { size: 'standard' }, async () => undefined)).rejects.toBeInstanceOf(ConcurrentBoxLimitError);
  });

  it.each([
    { label: 'old Unlimited subscriber (Legacy Pro)', set: { plan: 'unlimited' } },
    { label: 'comp (Pro)', set: { planOverride: 'unlimited' } },
    { label: 'Pro subscriber', set: { plan: 'unlimited', polarProductId: 'prod-pro-monthly' } },
  ])('$label passes far beyond the free cap', async ({ set }) => {
    await db.update(usersTable).set(set).where(eq(usersTable.id, TEST_USER_ID));
    for (let i = 0; i < FREE_CAP + 5; i++) await insertTask('ws1', 'queued');
    expect(await withBoxGate(TEST_USER_ID, { size: 'standard' }, async () => 'created')).toBe('created');
  });

  it('terminal tasks free their slot', async () => {
    const ids: string[] = [];
    for (let i = 0; i < FREE_CAP; i++) ids.push(await insertTask('ws1', 'queued'));
    await expect(withBoxGate(TEST_USER_ID, { size: 'standard' }, async () => undefined)).rejects.toBeInstanceOf(ConcurrentBoxLimitError);
    await db.update(tasksTable).set({ status: 'completed' }).where(eq(tasksTable.id, ids[0]));
    expect(await withBoxGate(TEST_USER_ID, { size: 'standard' }, async () => 'created')).toBe('created');
  });
});

describe('assertCanActivateTask', () => {
  it('re-activating an inactive task while the cap is full throws', async () => {
    for (let i = 0; i < FREE_CAP; i++) await insertTask('ws1', 'queued');
    const failedId = await insertTask('ws1', 'failed');
    await expect(assertCanActivateTask(TEST_USER_ID, failedId)).rejects.toBeInstanceOf(ConcurrentBoxLimitError);
  });

  it('idempotent re-queue of a still-active task never self-blocks', async () => {
    const ids: string[] = [];
    for (let i = 0; i < FREE_CAP; i++) ids.push(await insertTask('ws1', 'queued'));
    await expect(assertCanActivateTask(TEST_USER_ID, ids[0])).resolves.toBeUndefined();
  });

  it('refuses an owner out of hours', async () => {
    await exhaustIncluded('free');
    const failedId = await insertTask('ws1', 'failed');
    await expect(assertCanActivateTask(TEST_USER_ID, failedId)).rejects.toBeInstanceOf(UsageExhaustedError);
  });
});

describe('subscriptionPeriod', () => {
  const env = {
    POLAR_PRODUCT_ID_PRO_MONTHLY: 'pro-m',
    POLAR_PRODUCT_ID_PRO_ANNUAL: 'pro-a',
    POLAR_PRODUCT_ID_MONTHLY: 'leg-m',
    POLAR_PRODUCT_ID_ANNUAL: 'leg-a',
    POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY: 'team-m',
    POLAR_PRODUCT_ID_TEAM_PRO_ANNUAL: 'team-a',
  };
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it.each<[string | null | undefined, 'personal' | 'team', 'monthly' | 'annual' | null]>([
    ['pro-m', 'personal', 'monthly'],
    ['pro-a', 'personal', 'annual'],
    ['leg-m', 'personal', 'monthly'],
    ['leg-a', 'personal', 'annual'],
    ['team-m', 'team', 'monthly'],
    ['team-a', 'team', 'annual'],
    ['team-a', 'personal', null],
    ['pro-m', 'team', null],
    ['unknown', 'personal', null],
    [null, 'personal', null],
    [undefined, 'team', null],
    ['', 'personal', null],
  ])('%s (%s) → %s', (id, kind, expected) => {
    expect(subscriptionPeriod(id, kind)).toBe(expected);
  });

  it.each<[Parameters<typeof billingPeriodOf>[0], 'monthly' | 'annual' | null]>([
    ['subscription', 'annual'],
    ['team', 'monthly'],
    ['default', null],
    ['override', null],
  ])('billingPeriodOf %s → %s', (source, expected) => {
    expect(billingPeriodOf(source, 'pro-a', 'team-m')).toBe(expected);
  });

  it('billingPeriodOf ignores a stored product when the plan is free', async () => {
    await db.update(usersTable).set({ polarProductId: 'pro-a' }).where(eq(usersTable.id, TEST_USER_ID));
    expect((await buildBillingStatus(TEST_USER_ID)).period).toBeNull();
  });

  it('status carries the subscriber period', async () => {
    await db.update(usersTable).set({ plan: 'unlimited', polarProductId: 'pro-a' }).where(eq(usersTable.id, TEST_USER_ID));
    expect((await buildBillingStatus(TEST_USER_ID)).period).toBe('annual');
  });
});

describe('buildBillingStatus', () => {
  it('billing disabled: the old shape, no caps, no usage fields', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    await insertTask('ws1', 'queued');
    const status = await buildBillingStatus(TEST_USER_ID);
    expect(status).toEqual({
      billingEnabled: false,
      plan: 'pro',
      planSource: 'billing_disabled',
      cancelAtPeriodEnd: false,
      activeTasks: 1,
      activeTaskLimit: null,
      queuedPrs: 0,
      mergeQueueLimit: null,
      workflows: 0,
      workflowLimit: null,
      loops: 0,
      loopLimit: null,
      activeReviews: 0,
      activeReviewLimit: null,
    });
  });

  it('a free owner: tier, usage, sizes, the box cap; no credits or auto top-up; no count caps', async () => {
    await insertTask('ws1', 'queued');
    const status = await buildBillingStatus(TEST_USER_ID);
    const period = usagePeriodFor({ now: new Date() });
    expect(status).toMatchObject({
      billingEnabled: true,
      plan: 'free',
      planSource: 'default',
      tier: 'free',
      activeTasks: 1,
      activeTaskLimit: FREE_CAP,
      mergeQueueLimit: null,
      workflowLimit: null,
      loopLimit: null,
      activeReviewLimit: null,
      concurrentBoxes: { used: 1, limit: FREE_CAP },
      sizePrices: sizePriceTable('free'),
      pricing: BILLING_PRICING,
      usage: {
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        includedWsec: includedWeightedSeconds('free'),
        usedWsec: 0,
        percent: 0,
        exhausted: false,
      },
    });
    expect(status.credits).toBeUndefined();
    expect(status.autoTopup).toBeUndefined();
  });

  it('reports usage and exhaustion from the ledger', async () => {
    await exhaustIncluded('free');
    const status = await buildBillingStatus(TEST_USER_ID);
    expect(status.usage).toMatchObject({ percent: 100, exhausted: true, usedWsec: includedWeightedSeconds('free') });
  });

  it.each<[string, Partial<typeof usersTable.$inferInsert>, PlanTier, string]>([
    ['old Unlimited subscriber', { plan: 'unlimited' }, 'legacy_pro', 'subscription'],
    ['Pro subscriber', { plan: 'unlimited', polarProductId: 'prod-pro-monthly' }, 'pro', 'subscription'],
    ['comp', { planOverride: 'unlimited' }, 'pro', 'override'],
  ])('%s: plan is the tier, with credits and auto top-up', async (_label, set, tier, source) => {
    await db.update(usersTable).set(set).where(eq(usersTable.id, TEST_USER_ID));
    await grantCreditLot({ ownerId: TEST_USER_ID, micros: 25_000_000, source: 'purchase' });
    const status = await buildBillingStatus(TEST_USER_ID);
    expect(status.plan).toBe(tier);
    expect(status.tier).toBe(tier);
    expect(status.planSource).toBe(source);
    expect(status.activeTaskLimit).toBe(PLAN_LIMITS[tier].concurrentBoxes);
    expect(status.usage?.includedWsec).toBe(includedWeightedSeconds(tier));
    expect(status.credits).toMatchObject({ balanceMicros: 25_000_000, expiringSoonMicros: 0 });
    expect(status.credits?.lots).toHaveLength(1);
    expect(status.autoTopup).toEqual({
      enabled: false,
      triggerMicros: 5_000_000,
      pack: '25',
      monthlyLimitMicros: 100_000_000,
      monthSpentMicros: 0,
      lastFailure: null,
      lastFailureAt: null,
    });
  });

  it('auto top-up reads the saved settings and the current month only', async () => {
    await db.update(usersTable).set({ planOverride: 'pro' }).where(eq(usersTable.id, TEST_USER_ID));
    const failedAt = new Date('2026-10-01T00:00:00.000Z');
    await db.insert(autoTopupSettings).values({
      ownerId: TEST_USER_ID,
      enabled: true,
      triggerMicros: 10_000_000,
      pack: '100',
      monthlyLimitMicros: 300_000_000,
      monthKey: '1999-01',
      monthSpentMicros: 100_000_000,
      lastFailure: 'card_declined',
      lastFailureAt: failedAt,
    });
    expect((await buildBillingStatus(TEST_USER_ID)).autoTopup).toEqual({
      enabled: true,
      triggerMicros: 10_000_000,
      pack: '100',
      monthlyLimitMicros: 300_000_000,
      monthSpentMicros: 0,
      lastFailure: 'card_declined',
      lastFailureAt: failedAt.toISOString(),
    });
  });
});
