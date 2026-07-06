import { Polar } from '@polar-sh/sdk';
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
      error: err instanceof Error ? err.message : String(err),
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
