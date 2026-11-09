import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PlanTier } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { teamSeats, teams, users } from '../db/schema.js';
import {
  LEGACY_PRODUCT_ENV_VARS,
  MAX_PRODUCT_ENV_VARS,
  PRO_PRODUCT_ENV_VARS,
  deriveEntitlement,
  deriveTier,
  deriveTierResolution,
  entitlementQuery,
  hasGrantingSubscription,
  resolveEntitlement,
  subscriptionTier,
  tierFromEntitlementRow,
  tierProductIds,
  type EntitlementSource,
  type TeamBillingRow,
  type TierProductIds,
} from '../services/billing/entitlements.js';
import { resolveUsageTier } from '../services/billing/usage/tier.js';

const IDS: TierProductIds = {
  pro: ['prod-pro-monthly', 'prod-pro-annual'],
  max: ['prod-max-monthly'],
  legacy: ['prod-unlimited-monthly', 'prod-unlimited-annual'],
};

const PRODUCTS = {
  'no product': null,
  'pro monthly': 'prod-pro-monthly',
  'pro annual': 'prod-pro-annual',
  'max monthly': 'prod-max-monthly',
  'old unlimited monthly': 'prod-unlimited-monthly',
  'old unlimited annual': 'prod-unlimited-annual',
  'unknown product': 'prod-something-else',
} as const;
type ProductKind = keyof typeof PRODUCTS;

const TEAMS: Record<string, TeamBillingRow | null> = {
  'no team': null,
  'paid legacy team': { plan: 'team', planOverride: null, tier: 'legacy_pro' },
  'paid pro team': { plan: 'team', planOverride: null, tier: 'pro' },
  'paid team, no tier': { plan: 'team', planOverride: null, tier: null },
  'paid team, unknown tier': { plan: 'team', planOverride: null, tier: 'gold' },
  'lapsed pro team': { plan: 'none', planOverride: null, tier: 'pro' },
  'comped pro team': { plan: 'none', planOverride: 'team', tier: 'pro' },
  'paid pro team blocked by override': { plan: 'team', planOverride: 'none', tier: 'pro' },
};

const OVERRIDES = [null, 'free', 'unlimited', 'pro', 'max', 'legacy_pro', 'gold'] as const;
const PLANS = ['free', 'unlimited', 'pro', 'legacy_pro', 'none'] as const;

/**
 * The spec's order, written out case by case rather than reusing the code
 * under test: override, then own subscription (Pro product → pro, Max
 * product → max, anything else → legacy_pro), then a paid seat (team tier, unknown → legacy_pro),
 * then free.
 */
function expected(
  override: (typeof OVERRIDES)[number],
  plan: (typeof PLANS)[number],
  product: ProductKind,
  team: TeamBillingRow | null
): { tier: PlanTier; source: EntitlementSource } {
  if (override === 'free') return { tier: 'free', source: 'override' };
  if (override === 'unlimited' || override === 'pro') return { tier: 'pro', source: 'override' };
  if (override === 'max') return { tier: 'max', source: 'override' };
  if (override === 'legacy_pro') return { tier: 'legacy_pro', source: 'override' };
  const subscribed = plan === 'unlimited' || plan === 'pro' || plan === 'legacy_pro';
  if (subscribed) {
    const isPro = product === 'pro monthly' || product === 'pro annual';
    const isMax = product === 'max monthly';
    return { tier: isPro ? 'pro' : isMax ? 'max' : 'legacy_pro', source: 'subscription' };
  }
  const paid = team !== null && (team.planOverride === 'team' || (team.planOverride !== 'none' && team.plan === 'team'));
  if (paid) return { tier: team.tier === 'pro' ? 'pro' : 'legacy_pro', source: 'team' };
  return { tier: 'free', source: 'default' };
}

const MATRIX = OVERRIDES.flatMap((override) =>
  PLANS.flatMap((plan) =>
    (Object.keys(PRODUCTS) as ProductKind[]).flatMap((product) =>
      Object.keys(TEAMS).map((team) => ({ override, plan, product, team }))
    )
  )
);

describe('deriveTierResolution: every source × product kind × override × team seat', () => {
  it(`covers ${MATRIX.length} combinations`, () => {
    expect(MATRIX.length).toBe(OVERRIDES.length * PLANS.length * Object.keys(PRODUCTS).length * Object.keys(TEAMS).length);
  });

  it.each(MATRIX)('override=$override plan=$plan product=$product team=$team', ({ override, plan, product, team }) => {
    const row = { plan, planOverride: override, polarProductId: PRODUCTS[product] };
    const want = expected(override, plan, product, TEAMS[team] ?? null);
    expect(deriveEntitlement(row, TEAMS[team], IDS)).toEqual(want);
  });
});

describe('deriveTierResolution: named cases from the spec', () => {
  const end = new Date('2026-11-20T08:00:00.000Z');
  it.each<[string, Parameters<typeof deriveTierResolution>[0], TeamBillingRow | null, PlanTier, EntitlementSource, Date | null]>([
    ['no user row', undefined, TEAMS['paid pro team']!, 'free', 'default', null],
    ['free user', { plan: 'free', planOverride: null }, null, 'free', 'default', null],
    ['old Unlimited subscriber, no stored product → Legacy Pro on their own period', { plan: 'unlimited', planOverride: null, polarProductId: null, currentPeriodEnd: end }, null, 'legacy_pro', 'subscription', end],
    ['old Unlimited product id → Legacy Pro', { plan: 'unlimited', planOverride: null, polarProductId: 'prod-unlimited-annual', currentPeriodEnd: end }, null, 'legacy_pro', 'subscription', end],
    ['new Pro product → Pro on their own period', { plan: 'unlimited', planOverride: null, polarProductId: 'prod-pro-monthly', currentPeriodEnd: end }, null, 'pro', 'subscription', end],
    ['new Max product → Max on their own period', { plan: 'unlimited', planOverride: null, polarProductId: 'prod-max-monthly', currentPeriodEnd: end }, null, 'max', 'subscription', end],
    ['max override on a free user → Max on the calendar month', { plan: 'free', planOverride: 'max' }, null, 'max', 'override', null],
    ['own Max subscription wins over a pro seat', { plan: 'unlimited', planOverride: null, polarProductId: 'prod-max-monthly', currentPeriodEnd: end }, TEAMS['paid pro team']!, 'max', 'subscription', end],
    ['webhook writes the tier as the plan', { plan: 'pro', planOverride: null, polarProductId: 'prod-pro-annual', currentPeriodEnd: end }, null, 'pro', 'subscription', end],
    ['comp (unlimited override) → Pro on the calendar month', { plan: 'free', planOverride: 'unlimited' }, null, 'pro', 'override', null],
    ['pro override on a subscriber keeps their period', { plan: 'unlimited', planOverride: 'pro', currentPeriodEnd: end }, null, 'pro', 'override', end],
    ['free override beats a subscription and drops the anchor', { plan: 'unlimited', planOverride: 'free', currentPeriodEnd: end }, null, 'free', 'override', null],
    ['free override beats a paid seat', { plan: 'free', planOverride: 'free' }, TEAMS['paid pro team']!, 'free', 'override', null],
    ['personal subscription wins over a pro seat', { plan: 'unlimited', planOverride: null, currentPeriodEnd: end }, TEAMS['paid pro team']!, 'legacy_pro', 'subscription', end],
    ['existing team seat → Legacy Pro', { plan: 'free', planOverride: null }, TEAMS['paid legacy team']!, 'legacy_pro', 'team', null],
    ['pro team seat → Pro', { plan: 'free', planOverride: null }, TEAMS['paid pro team']!, 'pro', 'team', null],
    ['lapsed team → free', { plan: 'free', planOverride: null }, TEAMS['lapsed pro team']!, 'free', 'default', null],
    ['garbage override is ignored', { plan: 'free', planOverride: 'gold' }, null, 'free', 'default', null],
    ['past-due plan value grants nothing', { plan: 'past_due', planOverride: null }, null, 'free', 'default', null],
  ])('%s', (_label, row, team, tier, source, periodAnchor) => {
    expect(deriveTierResolution(row, team, IDS)).toEqual({ tier, source, periodAnchor });
  });
});

describe('subscriptionTier', () => {
  it.each<[ProductKind, 'pro' | 'max' | 'legacy_pro']>([
    ['no product', 'legacy_pro'],
    ['pro monthly', 'pro'],
    ['pro annual', 'pro'],
    ['max monthly', 'max'],
    ['old unlimited monthly', 'legacy_pro'],
    ['old unlimited annual', 'legacy_pro'],
    ['unknown product', 'legacy_pro'],
  ])('%s → %s', (product, tier) => {
    expect(subscriptionTier(PRODUCTS[product], IDS)).toBe(tier);
  });

  it('a Pro product reads as Legacy Pro when the Pro env vars are not set', () => {
    expect(subscriptionTier('prod-pro-monthly', { pro: [], legacy: [] })).toBe('legacy_pro');
  });

  it('a Max product reads as Legacy Pro when the Max env vars are not set', () => {
    expect(subscriptionTier('prod-max-monthly', { pro: IDS.pro, legacy: IDS.legacy })).toBe('legacy_pro');
  });
});

describe('hasGrantingSubscription', () => {
  it.each([
    ['unlimited', true],
    ['pro', true],
    ['legacy_pro', true],
    ['free', false],
    ['none', false],
    ['', false],
    [null, false],
    [undefined, false],
  ])('%s → %s', (plan, grants) => {
    expect(hasGrantingSubscription(plan)).toBe(grants);
  });
});

describe('tierProductIds', () => {
  const names = [...PRO_PRODUCT_ENV_VARS, ...MAX_PRODUCT_ENV_VARS, ...LEGACY_PRODUCT_ENV_VARS];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterEach(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it('reads the five product env vars at call time', () => {
    process.env.POLAR_PRODUCT_ID_PRO_MONTHLY = 'pm';
    process.env.POLAR_PRODUCT_ID_PRO_ANNUAL = ' pa ';
    process.env.POLAR_PRODUCT_ID_MAX_MONTHLY = 'mm';
    process.env.POLAR_PRODUCT_ID_MONTHLY = 'um';
    process.env.POLAR_PRODUCT_ID_ANNUAL = 'ua';
    expect(tierProductIds()).toEqual({ pro: ['pm', 'pa'], max: ['mm'], legacy: ['um', 'ua'] });
  });

  it('drops unset and blank values', () => {
    for (const n of names) delete process.env[n];
    process.env.POLAR_PRODUCT_ID_PRO_MONTHLY = '   ';
    process.env.POLAR_PRODUCT_ID_MAX_MONTHLY = '  ';
    expect(tierProductIds()).toEqual({ pro: [], max: [], legacy: [] });
  });

  it('defaults deriveEntitlement to the env Max ids', () => {
    process.env.POLAR_PRODUCT_ID_MAX_MONTHLY = 'env-max';
    expect(deriveEntitlement({ plan: 'unlimited', planOverride: null, polarProductId: 'env-max' }).tier).toBe('max');
  });

  it('defaults deriveEntitlement to the env ids', () => {
    process.env.POLAR_PRODUCT_ID_PRO_ANNUAL = 'env-pro';
    expect(deriveEntitlement({ plan: 'unlimited', planOverride: null, polarProductId: 'env-pro' }).tier).toBe('pro');
  });
});

describe('deriveTier against the database', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const OWNER = 'owner-tier';
  const savedPolar = process.env.POLAR_ACCESS_TOKEN;
  const savedPro = process.env.POLAR_PRODUCT_ID_PRO_MONTHLY;
  const end = new Date('2026-11-20T08:00:00.000Z');

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: OWNER });
    await db.insert(teams).values([
      { id: 'team-pro', name: 'Pro team', plan: 'team', tier: 'pro' },
      { id: 'team-legacy', name: 'Old team', plan: 'team' },
      { id: 'team-lapsed', name: 'Lapsed', plan: 'none', tier: 'pro' },
    ]);
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    process.env.POLAR_PRODUCT_ID_PRO_MONTHLY = 'prod-pro-monthly';
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    await db.delete(teamSeats);
    await db
      .update(users)
      .set({ plan: 'free', planOverride: null, polarProductId: null, currentPeriodEnd: null, githubUserId: 77 })
      .where(eq(users.id, OWNER));
  });

  afterEach(() => {
    if (savedPolar === undefined) delete process.env.POLAR_ACCESS_TOKEN;
    else process.env.POLAR_ACCESS_TOKEN = savedPolar;
    if (savedPro === undefined) delete process.env.POLAR_PRODUCT_ID_PRO_MONTHLY;
    else process.env.POLAR_PRODUCT_ID_PRO_MONTHLY = savedPro;
  });

  async function seat(teamId: string) {
    await db.insert(teamSeats).values({ id: `seat-${teamId}`, teamId, githubUserId: 77, githubLogin: 'owner' });
  }

  it.each<[string, Partial<typeof users.$inferInsert>, string | null, PlanTier, EntitlementSource, Date | null]>([
    ['free, no seat', {}, null, 'free', 'default', null],
    ['old Unlimited subscriber', { plan: 'unlimited', currentPeriodEnd: end }, null, 'legacy_pro', 'subscription', end],
    ['Pro subscriber', { plan: 'unlimited', polarProductId: 'prod-pro-monthly', currentPeriodEnd: end }, null, 'pro', 'subscription', end],
    ['comp', { planOverride: 'unlimited' }, null, 'pro', 'override', null],
    ['legacy_pro override', { planOverride: 'legacy_pro' }, null, 'legacy_pro', 'override', null],
    ['pro seat through the GitHub id', {}, 'team-pro', 'pro', 'team', null],
    ['pre-usage-billing team seat', {}, 'team-legacy', 'legacy_pro', 'team', null],
    ['lapsed team seat', {}, 'team-lapsed', 'free', 'default', null],
    ['free override blocks a seat', { planOverride: 'free' }, 'team-pro', 'free', 'override', null],
  ])('%s', async (_label, set, teamId, tier, source, periodAnchor) => {
    if (Object.keys(set).length) await db.update(users).set(set).where(eq(users.id, OWNER));
    if (teamId) await seat(teamId);
    expect(await deriveTier(OWNER)).toEqual({ tier, source, periodAnchor });
    // The ledger reads the same resolver.
    expect(await resolveUsageTier(OWNER)).toEqual({ tier, periodAnchor });
    // The gate's view, with billing on.
    expect(await resolveEntitlement(OWNER)).toEqual({ tier, source });
  });

  it('an unknown owner is free', async () => {
    expect(await deriveTier('nobody')).toEqual({ tier: 'free', source: 'default', periodAnchor: null });
  });

  it('deriveTier ignores billingEnabled; resolveEntitlement answers Pro with billing off', async () => {
    delete process.env.POLAR_ACCESS_TOKEN;
    expect((await deriveTier(OWNER)).tier).toBe('free');
    expect(await resolveEntitlement(OWNER)).toEqual({ tier: 'pro', source: 'billing_disabled' });
  });

  it('tierFromEntitlementRow agrees with the query row', async () => {
    await db.update(users).set({ plan: 'unlimited', polarProductId: 'prod-pro-monthly' }).where(eq(users.id, OWNER));
    const [row] = await entitlementQuery(OWNER);
    expect(tierFromEntitlementRow(row).tier).toBe('pro');
  });

  it('the query reads explicit columns on the pool, nothing heavy', () => {
    const text = entitlementQuery(OWNER).toSQL().sql;
    expect(text).not.toMatch(/select \*/i);
    for (const col of ['"polar_product_id"', '"tier"', '"current_period_end"']) expect(text).toContain(col);
    for (const heavy of ['transcript', 'last_summary', 'settings']) expect(text).not.toContain(heavy);
  });
});
