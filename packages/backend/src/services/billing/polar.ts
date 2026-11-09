import { Polar } from '@polar-sh/sdk';
import type { Order } from '@polar-sh/sdk/models/components/order.js';
import {
  CREDIT_PACK_IDS,
  PLAN_TIER_LABELS,
  TEAM_MIN_SEATS,
  type BillingOrder,
  type CreditPackId,
  type PaidTier,
  type SellableTier,
  type TeamPriceTiers,
  type TeamPricing,
  type TeamTier,
} from '@talyn/shared';
import { debugBus } from '../debugBus.js';
import { webAppUrl } from '../webApp.js';
import { mobileBillingBounceUrl } from '../mobileReturn.js';
import { billingEnabled } from './entitlements.js';

/**
 * Thin wrapper around the Polar SDK — the ONLY module that talks to Polar's
 * API. Everything else goes through the entitlement seam
 * (services/billing/entitlements.ts), so swapping the billing provider means
 * replacing this file + webhook.ts and nothing else.
 *
 * Env (all-or-nothing, enforced by validateEnv):
 *   POLAR_ACCESS_TOKEN            — org access token
 *   POLAR_WEBHOOK_SECRET          — standard-webhooks signing secret
 *   POLAR_ENVIRONMENT             — 'sandbox' | 'production'
 *   POLAR_PRODUCT_ID_PRO_MONTHLY  — Pro, $40/mo
 *   POLAR_PRODUCT_ID_PRO_ANNUAL   — Pro, $400/yr
 *   POLAR_PRODUCT_ID_CREDITS_25   — one-time credit pack, $25
 *   POLAR_PRODUCT_ID_CREDITS_100  — one-time credit pack, $100 (+5% credit)
 *   POLAR_PRODUCT_ID_CREDITS_500  — one-time credit pack, $500 (+10% credit)
 * Optional — Max, $100/mo, sold monthly only. Max is offered to everybody
 * once it is set. A subscriber keeps Max while their product id is set:
 *   POLAR_PRODUCT_ID_MAX_MONTHLY
 * Optional pair — the old Unlimited products, no longer sold. Their
 * subscribers resolve to Legacy Pro, so keep them set while any exist:
 *   POLAR_PRODUCT_ID_MONTHLY / POLAR_PRODUCT_ID_ANNUAL
 * Optional:
 *   POLAR_SUCCESS_URL             — browser landing page after checkout
 *                                   (default: the web app's billing page)
 * Optional pairs — the team plan. New teams buy the Pro team product when it
 * is set; the old team product stays recognised (its teams are Legacy Pro):
 *   POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY / POLAR_PRODUCT_ID_TEAM_PRO_ANNUAL
 *   POLAR_PRODUCT_ID_TEAM_MONTHLY / POLAR_PRODUCT_ID_TEAM_ANNUAL
 */

export type BillingPeriod = 'monthly' | 'annual';

const PRO_PRODUCT_ENV: Record<BillingPeriod, string> = {
  monthly: 'POLAR_PRODUCT_ID_PRO_MONTHLY',
  annual: 'POLAR_PRODUCT_ID_PRO_ANNUAL',
};
/** Max is sold monthly only, so it has no annual product. */
const MAX_PRODUCT_ENV: Partial<Record<BillingPeriod, string>> = {
  monthly: 'POLAR_PRODUCT_ID_MAX_MONTHLY',
};
const LEGACY_PRODUCT_ENV: Record<BillingPeriod, string> = {
  monthly: 'POLAR_PRODUCT_ID_MONTHLY',
  annual: 'POLAR_PRODUCT_ID_ANNUAL',
};
const TEAM_PRO_PRODUCT_ENV: Record<BillingPeriod, string> = {
  monthly: 'POLAR_PRODUCT_ID_TEAM_PRO_MONTHLY',
  annual: 'POLAR_PRODUCT_ID_TEAM_PRO_ANNUAL',
};
const TEAM_LEGACY_PRODUCT_ENV: Record<BillingPeriod, string> = {
  monthly: 'POLAR_PRODUCT_ID_TEAM_MONTHLY',
  annual: 'POLAR_PRODUCT_ID_TEAM_ANNUAL',
};
export const CREDIT_PACK_PRODUCT_ENV: Record<CreditPackId, string> = {
  '25': 'POLAR_PRODUCT_ID_CREDITS_25',
  '100': 'POLAR_PRODUCT_ID_CREDITS_100',
  '500': 'POLAR_PRODUCT_ID_CREDITS_500',
};

function envProduct(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function matchesAny(productId: string | null | undefined, names: ReadonlyArray<string | undefined>): boolean {
  if (!productId) return false;
  return names.some((name) => name !== undefined && envProduct(name) === productId);
}

export function proProductId(period: BillingPeriod): string | undefined {
  return envProduct(PRO_PRODUCT_ENV[period]);
}

/** The Max product for `period`. Undefined for annual: Max is sold monthly only. */
export function maxProductId(period: BillingPeriod): string | undefined {
  const name = MAX_PRODUCT_ENV[period];
  return name ? envProduct(name) : undefined;
}

/** The product that sells `tier` for `period`, or undefined when it is not set. */
export function planProductId(tier: SellableTier, period: BillingPeriod): string | undefined {
  return tier === 'max' ? maxProductId(period) : proProductId(period);
}

/** The Max product is set, so this deployment can sell Max. */
export function maxProductsConfigured(): boolean {
  return Boolean(maxProductId('monthly'));
}

export function creditPackProductId(pack: CreditPackId): string | undefined {
  return envProduct(CREDIT_PACK_PRODUCT_ENV[pack]);
}

/** The credit pack a product sells, or null for any other product. */
export function creditPackForProduct(productId: string | null | undefined): CreditPackId | null {
  if (!productId) return null;
  return CREDIT_PACK_IDS.find((pack) => creditPackProductId(pack) === productId) ?? null;
}

/**
 * The tier a personal subscription product gives: Pro for the Pro products,
 * Max for the Max products, Legacy Pro for the old Unlimited ones, null for
 * anything else (a credit
 * pack, a team product, an id this deployment does not know).
 */
export function personalProductTier(productId: string | null | undefined): PaidTier | null {
  if (matchesAny(productId, Object.values(PRO_PRODUCT_ENV))) return 'pro';
  if (matchesAny(productId, Object.values(MAX_PRODUCT_ENV))) return 'max';
  if (matchesAny(productId, Object.values(LEGACY_PRODUCT_ENV))) return 'legacy_pro';
  return null;
}

/** The tier a team product gives each seat, or null when the product is not a team product. */
export function teamProductTier(productId: string | null | undefined): TeamTier | null {
  if (matchesAny(productId, Object.values(TEAM_PRO_PRODUCT_ENV))) return 'pro';
  if (matchesAny(productId, Object.values(TEAM_LEGACY_PRODUCT_ENV))) return 'legacy_pro';
  return null;
}

/** Name a subscription product from the same ids that determine its tier. */
export function subscriptionProductLabel(productId: string, team: boolean): string | null {
  const tier = team ? teamProductTier(productId) : personalProductTier(productId);
  if (!tier) return null;
  const products: Partial<Record<BillingPeriod, string>> = team
    ? tier === 'pro' ? TEAM_PRO_PRODUCT_ENV : TEAM_LEGACY_PRODUCT_ENV
    : tier === 'pro' ? PRO_PRODUCT_ENV : tier === 'max' ? MAX_PRODUCT_ENV : LEGACY_PRODUCT_ENV;
  const period = (Object.keys(products) as BillingPeriod[]).find((candidate) => {
    const name = products[candidate];
    return name !== undefined && envProduct(name) === productId;
  });
  const name = `${team ? 'Team ' : ''}${PLAN_TIER_LABELS[tier]}`;
  return period ? `${name} (${period})` : name;
}

/** Where the web app shows billing. Checkout comes back here. */
export const BILLING_PAGE_PATH = '/settings/billing';

/**
 * Where a hosted checkout sends the browser. `POLAR_SUCCESS_URL` (operator
 * env) wins; otherwise the web app's billing page, built with `webAppUrl()`
 * so the target is fixed by env and never by a request. Both keys are left
 * out when no web app is deployed: Polar then shows its own receipt page.
 *
 * `returnTo` is the mobile app's URL base, already checked against
 * `MOBILE_RETURN_SCHEMES` by the route. It wins over both: success and the
 * back button go through our bounce route (Polar accepts only http(s)) to
 * `${returnTo}billing/return?kind=…&result=success|cancel`. When the backend
 * cannot name its own public origin, the web redirects stay.
 */
export function checkoutRedirects(
  kind: 'plan' | 'credits',
  returnTo?: string | null
): { successUrl?: string; returnUrl?: string } {
  if (returnTo) {
    const returnKind = kind === 'plan' ? 'checkout' : 'credits';
    const successUrl = mobileBillingBounceUrl(returnTo, returnKind, 'success');
    const returnUrl = mobileBillingBounceUrl(returnTo, returnKind, 'cancel');
    if (successUrl && returnUrl) return { successUrl, returnUrl };
    console.warn('[billing] mobile returnTo ignored: set TALYN_PUBLIC_API_URL so Polar can return to the app.');
  }
  const success = process.env.POLAR_SUCCESS_URL?.trim() || webAppUrl(BILLING_PAGE_PATH, { checkout: 'success', kind });
  const back = webAppUrl(BILLING_PAGE_PATH);
  return {
    ...(success ? { successUrl: success } : {}),
    ...(back ? { returnUrl: back } : {}),
  };
}

let client: Polar | null = null;

export function getPolarClient(): Polar {
  if (!billingEnabled()) {
    throw new Error('Billing is not configured on this backend (POLAR_* env not set)');
  }
  if (!client) {
    client = new Polar({
      accessToken: process.env.POLAR_ACCESS_TOKEN!,
      server: process.env.POLAR_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    });
  }
  return client;
}

/** Test hook — drop the cached client so env changes take effect. */
export function resetPolarClient(): void {
  client = null;
}

export function polarWebhookSecret(): string {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) throw new Error('POLAR_WEBHOOK_SECRET is not set');
  return secret;
}

/** Time a Polar SDK call and record it on the debug bus (Settings → Debug). */
async function timed<T>(method: string, label: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    debugBus.recordHttp({
      service: 'polar',
      method,
      url: `polar:${label}`,
      durationMs: Date.now() - startedAt,
      ok: true,
    });
    return result;
  } catch (err) {
    debugBus.recordHttp({
      service: 'polar',
      method,
      url: `polar:${label}`,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err,
    });
    throw err;
  }
}

/**
 * Create a hosted-checkout session for Pro or Max (monthly or annual), pre-linked to
 * our user: `externalCustomerId` becomes the Polar customer's `external_id`,
 * which arrives on every subsequent webhook — that's the whole user-mapping
 * story. Returns the URL to open in the system browser.
 *
 * The old Unlimited products are never sold again. Their subscribers move to
 * Pro through {@link changeSubscriptionProduct}, not a second checkout.
 */
export async function createCheckoutUrl(
  userId: string,
  period: BillingPeriod,
  plan: SellableTier = 'pro',
  returnTo: string | null = null
): Promise<string> {
  const productId = planProductId(plan, period);
  if (!productId) throw new Error(`Polar ${PLAN_TIER_LABELS[plan]} product id for ${period} is not set`);

  const checkout = await timed('POST', 'checkouts.create', () =>
    getPolarClient().checkouts.create({
      products: [productId],
      externalCustomerId: userId,
      metadata: { kind: 'plan', plan },
      ...checkoutRedirects('plan', returnTo),
    })
  );
  return checkout.url;
}

/**
 * Hosted checkout for one credit pack (a one-time, fixed-price product). The
 * `order.paid` webhook grants the credits; the product id says which pack, so
 * the metadata is a label for the Polar dashboard, never an input. Discount
 * codes are off: the pack grants a fixed amount of credit whatever was paid.
 */
export async function createCreditCheckoutUrl(
  userId: string,
  pack: CreditPackId,
  returnTo: string | null = null
): Promise<string> {
  const productId = creditPackProductId(pack);
  if (!productId) throw new Error(`Polar product id for the ${pack} credit pack is not set`);
  const checkout = await timed('POST', 'checkouts.create', () =>
    getPolarClient().checkouts.create({
      products: [productId],
      externalCustomerId: userId,
      allowDiscountCodes: false,
      metadata: { kind: 'credit_pack', pack },
      ...checkoutRedirects('credits', returnTo),
    })
  );
  return checkout.url;
}

/**
 * How a plan change bills. `invoice` charges the prorated difference for the
 * rest of the period at once. `prorate` would add it to the next renewal
 * instead, so somebody who upgrades and then cancels before renewal would get
 * Pro hours they never pay for; and a failed card should surface now, while
 * the person is looking at the upgrade, not at renewal.
 */
export const PLAN_CHANGE_PRORATION = 'invoice' as const;

/**
 * Move a live subscription to another recurring product (Legacy Pro → Pro,
 * Pro → Max). Only upgrades come here: see `POST /billing/change-plan`.
 * The `subscription.updated` webhook writes the new product id, and the tier
 * follows it; nothing is written here.
 */
export async function changeSubscriptionProduct(subscriptionId: string, productId: string): Promise<void> {
  await timed('PATCH', 'subscriptions.update', () =>
    getPolarClient().subscriptions.update({
      id: subscriptionId,
      subscriptionUpdate: { productId, prorationBehavior: PLAN_CHANGE_PRORATION },
    })
  );
}

// ---------- Off-session orders (auto top-up) ----------
//
// Preview API on Polar's side: the org needs off-session charges enabled.
// `orders.create` makes a DRAFT against a saved payment method; `finalize`
// charges it synchronously and answers with the order `paid`, or a 4xx with
// the order left in draft (402 declined / action required, 403 not enabled,
// 412 not a draft).

/** The Polar customer id behind our user, or null when Polar has none. */
export async function getCustomerIdForUser(userId: string): Promise<string | null> {
  try {
    const customer = await timed('GET', 'customers.getExternal', () =>
      getPolarClient().customers.getExternal({ externalId: userId })
    );
    return customer.id;
  } catch (err) {
    if (polarStatusCode(err) === 404) return null;
    throw err;
  }
}

export async function createDraftOrder(input: {
  customerId: string;
  productId: string;
  metadata: Record<string, string>;
  /** Sent as the `Idempotency-Key` header; one key per attempt. */
  idempotencyKey: string;
}): Promise<Order> {
  return timed('POST', 'orders.create', () =>
    getPolarClient().orders.create(
      { customerId: input.customerId, productId: input.productId, metadata: input.metadata },
      { headers: { 'Idempotency-Key': input.idempotencyKey } }
    )
  );
}

export async function finalizeOrder(orderId: string): Promise<Order> {
  return timed('POST', 'orders.finalize', () => getPolarClient().orders.finalize({ id: orderId }));
}

export async function getOrder(orderId: string): Promise<Order> {
  return timed('GET', 'orders.get', () => getPolarClient().orders.get({ id: orderId }));
}

/** The HTTP status of a Polar SDK error, or null for anything else (a network failure). */
export function polarStatusCode(err: unknown): number | null {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === 'number' ? code : null;
}

/** The error name Polar sent (`PaymentFailed`, `PaymentActionRequired`, …), when there is one. */
export function polarErrorName(err: unknown): string | null {
  const name = (err as { error?: unknown } | null)?.error;
  return typeof name === 'string' ? name : null;
}

/**
 * Create an authenticated customer-portal session (manage / cancel /
 * invoices — all hosted by Polar). Addressed by our user id via the
 * external-customer form, so it works without storing the Polar customer id.
 * Throws if Polar has no customer for this user yet (never checked out).
 */
export async function createPortalUrl(userId: string, returnTo: string | null = null): Promise<string> {
  // A mobile portal session gets a back button to the app; the web keeps none.
  const returnUrl = returnTo ? mobileBillingBounceUrl(returnTo, 'portal', 'success') : null;
  const session = await timed('POST', 'customerSessions.create', () =>
    getPolarClient().customerSessions.create({
      externalCustomerId: userId,
      ...(returnUrl ? { returnUrl } : {}),
    })
  );
  return session.customerPortalUrl;
}

/**
 * The user's order history (newest first) — the customer is addressed by our
 * user id (`external_customer_id`), so this can never return another user's
 * orders. Draft orders (created at cycle start, not yet finalized) are noise
 * and filtered out.
 */
export async function listOrdersForUser(userId: string): Promise<BillingOrder[]> {
  return listOrdersForCustomer(userId);
}

async function listOrdersForCustomer(externalCustomerId: string): Promise<BillingOrder[]> {
  const page = await timed('GET', 'orders.list', () =>
    getPolarClient().orders.list({
      externalCustomerId,
      limit: 50,
      sorting: ['-created_at'],
    })
  );
  return page.result.items
    .filter((order) => order.status !== 'draft')
    .map((order) => ({
      id: order.id,
      createdAt: order.createdAt.toISOString(),
      amount: order.totalAmount,
      currency: order.currency,
      status: typeof order.status === 'string' ? order.status : String(order.status),
      paid: order.paid,
      productName: order.product?.name ?? null,
      invoiceNumber: order.invoiceNumber,
    }));
}

/**
 * Hosted invoice URL for one of the user's orders. Ownership is enforced
 * here (the order's customer must carry the caller's external id) — the
 * order id alone must never be enough to read someone else's invoice.
 * Invoices are generated lazily on first request; generation is async on
 * Polar's side, so poll briefly before giving up.
 */
export async function getInvoiceUrlForUser(userId: string, orderId: string): Promise<string> {
  return getInvoiceUrlForCustomer(userId, orderId);
}

async function getInvoiceUrlForCustomer(
  externalCustomerId: string,
  orderId: string
): Promise<string> {
  const polar = getPolarClient();
  const order = await timed('GET', 'orders.get', () => polar.orders.get({ id: orderId }));
  if (order.customer?.externalId !== externalCustomerId) {
    throw new OrderNotFoundError(orderId);
  }

  if (!order.isInvoiceGenerated) {
    // 409s if generation is already in flight — treat as "keep polling".
    await timed('POST', 'orders.generateInvoice', () =>
      polar.orders.generateInvoice({ id: orderId })
    ).catch(() => undefined);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      const invoice = await timed('GET', 'orders.invoice', () =>
        polar.orders.invoice({ id: orderId })
      );
      return invoice.url;
    } catch (err) {
      lastError = err;
    }
  }
  console.error(`[billing] invoice for order ${orderId} not ready after polling:`, lastError);
  throw new Error('The invoice is still being generated — try again in a moment.');
}

// ---------- Team plan ----------
//
// A team is its OWN Polar customer, addressed by `team_<id>` as the external
// id. That prefix is what keeps a team's billing apart from its buyer's: the
// buyer's personal customer carries their user id, so a team checkout can
// never land on, or be read back as, the person who paid for it. The webhook
// routes on the same prefix.
//
// Polar sells the QUANTITY only. Who holds a seat is ours (`team_seats`,
// keyed by GitHub id); Polar's own seat-assignment API is deliberately not
// used, because it binds seats to email addresses.

const TEAM_CUSTOMER_PREFIX = 'team_';

export function teamCustomerExternalId(teamId: string): string {
  return `${TEAM_CUSTOMER_PREFIX}${teamId}`;
}

/** The team id behind a Polar external customer id, or null for a personal one. */
export function teamIdFromCustomerExternalId(externalId: string | null | undefined): string | null {
  if (!externalId || !externalId.startsWith(TEAM_CUSTOMER_PREFIX)) return null;
  const teamId = externalId.slice(TEAM_CUSTOMER_PREFIX.length);
  return teamId.length > 0 ? teamId : null;
}

function pairConfigured(names: Record<BillingPeriod, string>): boolean {
  return Boolean(envProduct(names.monthly)) && Boolean(envProduct(names.annual));
}

export function teamProProductId(period: BillingPeriod): string | undefined {
  return pairConfigured(TEAM_PRO_PRODUCT_ENV) ? envProduct(TEAM_PRO_PRODUCT_ENV[period]) : undefined;
}

/**
 * The team product a new team buys: the Pro team product ($40 a seat) when it
 * is configured, else the old team product (whose seats are Legacy Pro).
 */
function teamProductId(period: BillingPeriod): string | undefined {
  return pairConfigured(TEAM_PRO_PRODUCT_ENV)
    ? envProduct(TEAM_PRO_PRODUCT_ENV[period])
    : envProduct(TEAM_LEGACY_PRODUCT_ENV[period]);
}

/**
 * Whether the team plan can be sold here. Its product ids are their own
 * all-or-nothing groups (validateEnv), so a deployment can bill personally
 * without selling teams.
 */
export function teamBillingConfigured(): boolean {
  return billingEnabled() && (pairConfigured(TEAM_PRO_PRODUCT_ENV) || pairConfigured(TEAM_LEGACY_PRODUCT_ENV));
}

export function isTeamProductId(productId: string | null | undefined): boolean {
  return teamProductTier(productId) !== null;
}

/** Hosted checkout for `seats` seats of the team product. */
export async function createTeamCheckoutUrl(
  teamId: string,
  period: 'monthly' | 'annual',
  seats: number
): Promise<string> {
  const productId = teamProductId(period);
  if (!productId) throw new Error(`Polar team product id for ${period} is not set`);
  const checkout = await timed('POST', 'checkouts.create', () =>
    getPolarClient().checkouts.create({
      products: [productId],
      externalCustomerId: teamCustomerExternalId(teamId),
      seats,
      minSeats: TEAM_MIN_SEATS,
      ...checkoutRedirects('plan'),
    })
  );
  return checkout.url;
}

/**
 * Change the seat count on a live team subscription. Polar prorates it; the
 * new count comes back through the `subscription.updated` webhook, which is
 * the only writer of `teams.seats_purchased`.
 */
export async function updateTeamSubscriptionSeats(
  subscriptionId: string,
  seats: number
): Promise<void> {
  await timed('PATCH', 'subscriptions.update', () =>
    getPolarClient().subscriptions.update({
      id: subscriptionId,
      subscriptionUpdate: { seats },
    })
  );
}

export async function createTeamPortalUrl(teamId: string): Promise<string> {
  const session = await timed('POST', 'customerSessions.create', () =>
    getPolarClient().customerSessions.create({
      externalCustomerId: teamCustomerExternalId(teamId),
    })
  );
  return session.customerPortalUrl;
}

export async function listOrdersForTeam(teamId: string): Promise<BillingOrder[]> {
  return listOrdersForCustomer(teamCustomerExternalId(teamId));
}

export async function getInvoiceUrlForTeam(teamId: string, orderId: string): Promise<string> {
  return getInvoiceUrlForCustomer(teamCustomerExternalId(teamId), orderId);
}

interface SeatBasedPriceLike {
  amountType?: string;
  isArchived?: boolean;
  priceCurrency?: string;
  seatTiers?: {
    seatTierType?: string;
    tiers: Array<{ minSeats: number; maxSeats?: number | null; pricePerSeat: number }>;
    minimumSeats: number;
    maximumSeats: number | null;
  };
}

/** The seat tiers of a product's live seat-based price. Pure, for tests. */
export function seatTiersFromPrices(prices: readonly unknown[]): TeamPriceTiers | null {
  const price = (prices as SeatBasedPriceLike[]).find(
    (p) => p.amountType === 'seat_based' && !p.isArchived && p.seatTiers
  );
  if (!price?.seatTiers) return null;
  return {
    currency: price.priceCurrency ?? 'usd',
    tierType: price.seatTiers.seatTierType === 'graduated' ? 'graduated' : 'volume',
    minimumSeats: price.seatTiers.minimumSeats,
    maximumSeats: price.seatTiers.maximumSeats,
    tiers: price.seatTiers.tiers.map((t) => ({
      minSeats: t.minSeats,
      maxSeats: t.maxSeats ?? null,
      pricePerSeat: t.pricePerSeat,
    })),
  };
}

const TEAM_PRICING_TTL_MS = 10 * 60 * 1000;
let teamPricingCache: { at: number; value: TeamPricing } | null = null;

/**
 * The team product's seat tiers, read from Polar and cached for ten minutes.
 * Read rather than hard-coded so a price change in the Polar dashboard is the
 * whole price change — the personal UpgradeModal hard-codes $15/$150 in three
 * places, and that is not a pattern to copy.
 */
export async function getTeamPricing(): Promise<TeamPricing> {
  if (teamPricingCache && Date.now() - teamPricingCache.at < TEAM_PRICING_TTL_MS) {
    return teamPricingCache.value;
  }
  const read = async (period: 'monthly' | 'annual'): Promise<TeamPriceTiers | null> => {
    const id = teamProductId(period);
    if (!id) return null;
    const product = await timed('GET', 'products.get', () => getPolarClient().products.get({ id }));
    return seatTiersFromPrices(product.prices);
  };
  const [monthly, annual] = await Promise.all([read('monthly'), read('annual')]);
  const value = { monthly, annual };
  teamPricingCache = { at: Date.now(), value };
  return value;
}

/** Test hook. */
export function resetTeamPricingCacheForTests(): void {
  teamPricingCache = null;
}

export class OrderNotFoundError extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} not found`);
    this.name = 'OrderNotFoundError';
  }
}

/**
 * Best-effort immediate cancel, used by the account wipe: without it a
 * deleted account would keep a live Polar subscription billing forever with
 * no user row left for webhooks to map back to.
 */
export async function revokeSubscriptionBestEffort(subscriptionId: string): Promise<void> {
  try {
    await timed('POST', 'subscriptions.revoke', () =>
      getPolarClient().subscriptions.revoke({ id: subscriptionId })
    );
  } catch (err) {
    console.error(`[billing] failed to revoke Polar subscription ${subscriptionId}:`, err);
  }
}
