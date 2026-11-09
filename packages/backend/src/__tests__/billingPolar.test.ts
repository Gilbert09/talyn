import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreditPackId } from '@talyn/shared';

// A fake SDK: records each call so the tests can pin the request shapes.
const sdk = vi.hoisted(() => ({
  checkoutsCreate: vi.fn(async (_req: unknown) => ({ url: 'https://polar.test/checkout' })),
  subscriptionsUpdate: vi.fn(async (_req: unknown) => ({})),
  ordersCreate: vi.fn(async (_req: unknown, _opts?: unknown) => ({ id: 'ord-1', status: 'draft' })),
  ordersFinalize: vi.fn(async (req: { id: string }) => ({ id: req.id, status: 'paid', paid: true })),
  customersGetExternal: vi.fn(async (_req: unknown): Promise<{ id: string }> => ({ id: 'cust-1' })),
}));
vi.mock('@polar-sh/sdk', () => ({
  Polar: class {
    checkouts = { create: sdk.checkoutsCreate };
    subscriptions = { update: sdk.subscriptionsUpdate };
    orders = { create: sdk.ordersCreate, finalize: sdk.ordersFinalize };
    customers = { getExternal: sdk.customersGetExternal };
  },
}));

const polar = await import('../services/billing/polar.js');
const { resetWebAppUrlCacheForTests } = await import('../services/webApp.js');

const ENV = {
  POLAR_ACCESS_TOKEN: 'polar-test-token',
  POLAR_PRODUCT_ID_PRO_MONTHLY: 'prod-pro-m',
  POLAR_PRODUCT_ID_PRO_ANNUAL: 'prod-pro-a',
  POLAR_PRODUCT_ID_MAX_MONTHLY: 'prod-max-m',
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
const TOUCHED = [...Object.keys(ENV), 'POLAR_SUCCESS_URL', 'WEB_APP_URL'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of TOUCHED) saved[k] = process.env[k];
  for (const k of TOUCHED) delete process.env[k];
  Object.assign(process.env, ENV);
  resetWebAppUrlCacheForTests();
  polar.resetPolarClient();
});

afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetWebAppUrlCacheForTests();
  for (const fn of Object.values(sdk)) fn.mockClear();
});

describe('product maps', () => {
  it.each<[string | null | undefined, CreditPackId | null]>([
    ['prod-c25', '25'],
    ['prod-c100', '100'],
    ['prod-c500', '500'],
    ['prod-pro-m', null],
    ['prod-unknown', null],
    [null, null],
    ['', null],
  ])('creditPackForProduct(%s) → %s', (id, pack) => {
    expect(polar.creditPackForProduct(id)).toBe(pack);
  });

  it.each([
    ['prod-pro-m', 'pro'],
    ['prod-pro-a', 'pro'],
    ['prod-max-m', 'max'],
    ['prod-legacy-m', 'legacy_pro'],
    ['prod-legacy-a', 'legacy_pro'],
    ['prod-team-pro-m', null],
    ['prod-c25', null],
    [null, null],
  ])('personalProductTier(%s) → %s', (id, tier) => {
    expect(polar.personalProductTier(id)).toBe(tier);
  });

  it.each([
    ['prod-team-pro-m', 'pro'],
    ['prod-team-pro-a', 'pro'],
    ['prod-team-m', 'legacy_pro'],
    ['prod-team-a', 'legacy_pro'],
    ['prod-pro-m', null],
    ['prod-max-m', null],
    [undefined, null],
  ])('teamProductTier(%s) → %s', (id, tier) => {
    expect(polar.teamProductTier(id)).toBe(tier);
    expect(polar.isTeamProductId(id)).toBe(tier !== null);
  });

  it.each([
    ['prod-pro-m', false, 'Pro (monthly)'],
    ['prod-max-m', false, 'Max (monthly)'],
    ['prod-legacy-a', false, 'Legacy Pro (annual)'],
    ['prod-team-pro-a', true, 'Team Pro (annual)'],
    ['prod-unknown', false, null],
  ] as const)('subscriptionProductLabel(%s, team=%s) → %s', (id, team, label) => {
    expect(polar.subscriptionProductLabel(id, team)).toBe(label);
  });

  it.each([
    ['the monthly product set', {}, true],
    ['it unset', { POLAR_PRODUCT_ID_MAX_MONTHLY: '' }, false],
  ])('maxProductsConfigured with %s → %s', (_name, overrides, expected) => {
    Object.assign(process.env, overrides);
    expect(polar.maxProductsConfigured()).toBe(expected);
  });

  it.each([
    ['pro', 'monthly', 'prod-pro-m'],
    ['pro', 'annual', 'prod-pro-a'],
    ['max', 'monthly', 'prod-max-m'],
    ['max', 'annual', undefined],
  ] as const)('planProductId(%s, %s) → %s', (tier, period, id) => {
    expect(polar.planProductId(tier, period)).toBe(id);
  });

  it('an unset env var never matches an empty or missing product id', () => {
    delete process.env.POLAR_PRODUCT_ID_MONTHLY;
    expect(polar.personalProductTier(undefined)).toBeNull();
    expect(polar.personalProductTier('')).toBeNull();
  });
});

describe('team product choice', () => {
  it.each([
    ['both pairs', {}, true],
    ['only the Pro team pair', { POLAR_PRODUCT_ID_TEAM_MONTHLY: '', POLAR_PRODUCT_ID_TEAM_ANNUAL: '' }, true],
    ['only the old team pair', { POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY: '', POLAR_PRODUCT_ID_TEAM_PRO_ANNUAL: '' }, true],
    [
      'neither',
      { POLAR_PRODUCT_ID_TEAM_MONTHLY: '', POLAR_PRODUCT_ID_TEAM_ANNUAL: '', POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY: '', POLAR_PRODUCT_ID_TEAM_PRO_ANNUAL: '' },
      false,
    ],
  ])('teamBillingConfigured with %s → %s', (_name, overrides, expected) => {
    Object.assign(process.env, overrides);
    expect(polar.teamBillingConfigured()).toBe(expected);
  });

  it.each([
    ['the Pro team product when set', {}, 'prod-team-pro-a'],
    ['the old team product otherwise', { POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY: '', POLAR_PRODUCT_ID_TEAM_PRO_ANNUAL: '' }, 'prod-team-a'],
  ])('a new team buys %s', async (_name, overrides, product) => {
    Object.assign(process.env, overrides);
    await polar.createTeamCheckoutUrl('team-1', 'annual', 4);
    expect(sdk.checkoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ products: [product], externalCustomerId: 'team_team-1', seats: 4 })
    );
  });
});

describe('checkout redirects', () => {
  it('nothing when no web app and no success URL are configured', () => {
    expect(polar.checkoutRedirects('plan')).toEqual({});
  });

  it("the web app's billing page, built by webAppUrl", () => {
    process.env.WEB_APP_URL = 'https://app.talyn.dev';
    expect(polar.checkoutRedirects('credits')).toEqual({
      successUrl: 'https://app.talyn.dev/settings/billing?checkout=success&kind=credits',
      returnUrl: 'https://app.talyn.dev/settings/billing',
    });
  });

  it('POLAR_SUCCESS_URL wins for the success page', () => {
    process.env.WEB_APP_URL = 'https://app.talyn.dev';
    process.env.POLAR_SUCCESS_URL = 'https://talyn.dev/thanks';
    expect(polar.checkoutRedirects('plan')).toMatchObject({ successUrl: 'https://talyn.dev/thanks' });
  });
});

describe('request shapes', () => {
  it.each([
    ['monthly', 'prod-pro-m'],
    ['annual', 'prod-pro-a'],
  ] as const)('Pro checkout (%s) sells the Pro product, linked to the user', async (period, product) => {
    await polar.createCheckoutUrl('user-1', period);
    expect(sdk.checkoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ products: [product], externalCustomerId: 'user-1', metadata: { kind: 'plan', plan: 'pro' } })
    );
  });

  it('Max checkout sells the monthly Max product, linked to the user', async () => {
    await polar.createCheckoutUrl('user-1', 'monthly', 'max');
    expect(sdk.checkoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ products: ['prod-max-m'], externalCustomerId: 'user-1', metadata: { kind: 'plan', plan: 'max' } })
    );
  });

  it('annual Max checkout throws: there is no annual Max product', async () => {
    await expect(polar.createCheckoutUrl('user-1', 'annual', 'max')).rejects.toThrow(/Max product id for annual/);
  });

  it('Max checkout throws when the Max product is not configured', async () => {
    delete process.env.POLAR_PRODUCT_ID_MAX_MONTHLY;
    await expect(polar.createCheckoutUrl('user-1', 'monthly', 'max')).rejects.toThrow(/Max product id/);
  });

  it('Pro checkout throws when the Pro product is not configured', async () => {
    delete process.env.POLAR_PRODUCT_ID_PRO_ANNUAL;
    await expect(polar.createCheckoutUrl('user-1', 'annual')).rejects.toThrow(/Pro product id/);
  });

  it.each<[CreditPackId, string]>([
    ['25', 'prod-c25'],
    ['100', 'prod-c100'],
    ['500', 'prod-c500'],
  ])('credit checkout for the %s pack: one product, no discount codes', async (pack, product) => {
    await polar.createCreditCheckoutUrl('user-1', pack);
    expect(sdk.checkoutsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        products: [product],
        externalCustomerId: 'user-1',
        allowDiscountCodes: false,
        metadata: { kind: 'credit_pack', pack },
      })
    );
  });

  it('change plan moves the subscription to the product, invoicing the prorated difference now', async () => {
    await polar.changeSubscriptionProduct('sub-1', 'prod-pro-m');
    expect(sdk.subscriptionsUpdate).toHaveBeenCalledWith({
      id: 'sub-1',
      subscriptionUpdate: { productId: 'prod-pro-m', prorationBehavior: 'invoice' },
    });
  });

  it('a draft order carries the idempotency key as a header', async () => {
    await polar.createDraftOrder({ customerId: 'cust-1', productId: 'prod-c25', metadata: { kind: 'auto_topup' }, idempotencyKey: 'key-1' });
    expect(sdk.ordersCreate).toHaveBeenCalledWith(
      { customerId: 'cust-1', productId: 'prod-c25', metadata: { kind: 'auto_topup' } },
      { headers: { 'Idempotency-Key': 'key-1' } }
    );
  });

  it('finalize addresses the order by id', async () => {
    expect(await polar.finalizeOrder('ord-9')).toMatchObject({ id: 'ord-9', paid: true });
    expect(sdk.ordersFinalize).toHaveBeenCalledWith({ id: 'ord-9' });
  });

  it('getCustomerIdForUser: the id, or null on a 404', async () => {
    expect(await polar.getCustomerIdForUser('user-1')).toBe('cust-1');
    expect(sdk.customersGetExternal).toHaveBeenCalledWith({ externalId: 'user-1' });
    sdk.customersGetExternal.mockRejectedValueOnce(Object.assign(new Error('not found'), { statusCode: 404 }));
    expect(await polar.getCustomerIdForUser('user-2')).toBeNull();
    sdk.customersGetExternal.mockRejectedValueOnce(Object.assign(new Error('down'), { statusCode: 500 }));
    await expect(polar.getCustomerIdForUser('user-3')).rejects.toThrow('down');
  });
});
