import { Polar } from '@polar-sh/sdk';
import {
  TEAM_MIN_SEATS,
  type BillingOrder,
  type TeamPriceTiers,
  type TeamPricing,
} from '@talyn/shared';
import { debugBus } from '../debugBus.js';
import { billingEnabled } from './entitlements.js';

/**
 * Thin wrapper around the Polar SDK — the ONLY module that talks to Polar's
 * API. Everything else goes through the entitlement seam
 * (services/billing/entitlements.ts), so swapping the billing provider means
 * replacing this file + webhook.ts and nothing else.
 *
 * Env (all-or-nothing, enforced by validateEnv):
 *   POLAR_ACCESS_TOKEN        — org access token
 *   POLAR_WEBHOOK_SECRET      — standard-webhooks signing secret
 *   POLAR_ENVIRONMENT         — 'sandbox' | 'production'
 *   POLAR_PRODUCT_ID_MONTHLY  — the $15/mo product
 *   POLAR_PRODUCT_ID_ANNUAL   — the annual product
 * Optional:
 *   POLAR_SUCCESS_URL         — browser landing page after checkout
 * Optional group (all-or-nothing) — the team plan:
 *   POLAR_PRODUCT_ID_TEAM_MONTHLY — seat-based team product, monthly
 *   POLAR_PRODUCT_ID_TEAM_ANNUAL  — seat-based team product, annual
 */

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
 * Create a hosted-checkout session for the $15/mo or annual product,
 * pre-linked to our user: `externalCustomerId` becomes the Polar customer's
 * `external_id`, which arrives on every subsequent webhook — that's the
 * whole user-mapping story. Returns the URL to open in the system browser.
 */
export async function createCheckoutUrl(
  userId: string,
  period: 'monthly' | 'annual'
): Promise<string> {
  const productId =
    period === 'annual'
      ? process.env.POLAR_PRODUCT_ID_ANNUAL
      : process.env.POLAR_PRODUCT_ID_MONTHLY;
  if (!productId) throw new Error(`Polar product id for ${period} is not set`);

  const checkout = await timed('POST', 'checkouts.create', () =>
    getPolarClient().checkouts.create({
      products: [productId],
      externalCustomerId: userId,
      ...(process.env.POLAR_SUCCESS_URL ? { successUrl: process.env.POLAR_SUCCESS_URL } : {}),
    })
  );
  return checkout.url;
}

/**
 * Create an authenticated customer-portal session (manage / cancel /
 * invoices — all hosted by Polar). Addressed by our user id via the
 * external-customer form, so it works without storing the Polar customer id.
 * Throws if Polar has no customer for this user yet (never checked out).
 */
export async function createPortalUrl(userId: string): Promise<string> {
  const session = await timed('POST', 'customerSessions.create', () =>
    getPolarClient().customerSessions.create({ externalCustomerId: userId })
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

function teamProductId(period: 'monthly' | 'annual'): string | undefined {
  return period === 'annual'
    ? process.env.POLAR_PRODUCT_ID_TEAM_ANNUAL
    : process.env.POLAR_PRODUCT_ID_TEAM_MONTHLY;
}

/**
 * Whether the team plan can be sold here. Its product ids are their own
 * all-or-nothing group (validateEnv), so a deployment can bill personally
 * without selling teams.
 */
export function teamBillingConfigured(): boolean {
  return (
    billingEnabled() &&
    Boolean(process.env.POLAR_PRODUCT_ID_TEAM_MONTHLY) &&
    Boolean(process.env.POLAR_PRODUCT_ID_TEAM_ANNUAL)
  );
}

export function isTeamProductId(productId: string | null | undefined): boolean {
  if (!productId) return false;
  return (
    productId === process.env.POLAR_PRODUCT_ID_TEAM_MONTHLY ||
    productId === process.env.POLAR_PRODUCT_ID_TEAM_ANNUAL
  );
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
      ...(process.env.POLAR_SUCCESS_URL ? { successUrl: process.env.POLAR_SUCCESS_URL } : {}),
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
