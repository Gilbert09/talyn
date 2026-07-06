import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks';
import { getPoolDbClient } from '../../db/client.js';
import { billingEvents as billingEventsTable, users as usersTable } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { emitSubscriptionUpdated } from '../websocket.js';
import { billingEnabled, buildBillingStatus } from './entitlements.js';
import { polarWebhookSecret } from './polar.js';

/**
 * Polar webhook receiver — the ONLY writer of the webhook-driven billing
 * columns on `users` (`plan`, `subscription_status`, …; `plan_override` is
 * never touched here). Mounted raw-body/pre-auth in index.ts like the GitHub
 * webhook; the standard-webhooks signature IS the auth. Runs on the unscoped
 * pool: it legitimately writes other users' rows.
 *
 * Delivery semantics:
 * - Idempotent: the INSERT .. ON CONFLICT DO NOTHING on billing_events
 *   (keyed by the `webhook-id` header) is the gate — duplicates ack 200
 *   without re-applying.
 * - Order-safe: an event older (by `webhook-timestamp`) than the last one
 *   applied for the SAME subscription is recorded but not applied. A
 *   different subscription id always applies — that's a cancel + fresh
 *   checkout, not a reorder.
 * - Unmappable events (no user for the customer) are recorded + 200'd:
 *   Polar's retries can never make an unknown user appear.
 */

/** Subscription statuses that keep paid access. `past_due` stays unlimited
 *  through Polar's dunning — the user can recover in the portal; access ends
 *  when Polar transitions the subscription to canceled/revoked. */
const GRANTING_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** The slice of Polar's subscription entity the state machine reads. */
export interface PolarSubscription {
  id: string;
  status: string;
  currentPeriodEnd?: Date | string | null;
  cancelAtPeriodEnd?: boolean;
  customerId?: string;
  customer?: { id?: string; externalId?: string | null };
}

export interface ApplyResult {
  applied: boolean;
  reason?: 'no_user' | 'stale' | 'ignored_type';
  userId?: string;
}

function subscriptionFromEvent(data: unknown): PolarSubscription | null {
  const sub = data as PolarSubscription | null;
  if (!sub || typeof sub.id !== 'string' || typeof sub.status !== 'string') return null;
  return sub;
}

/** Map a Polar subscription to our user: external_id (our uuid) first, then
 *  the stored customer id for events that predate/lack it. */
async function resolveUserId(sub: PolarSubscription): Promise<string | null> {
  const db = getPoolDbClient();
  const externalId = sub.customer?.externalId;
  if (externalId) {
    const rows = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, externalId))
      .limit(1);
    if (rows[0]) return rows[0].id;
  }
  const customerId = sub.customerId ?? sub.customer?.id;
  if (customerId) {
    const rows = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.polarCustomerId, customerId))
      .limit(1);
    if (rows[0]) return rows[0].id;
  }
  return null;
}

/**
 * Apply one subscription event to the users row. Exported for tests; pure
 * state-machine + persistence, no HTTP concerns.
 */
export async function applySubscriptionEvent(
  eventType: string,
  sub: PolarSubscription,
  occurredAt: Date
): Promise<ApplyResult> {
  const db = getPoolDbClient();

  const userId = await resolveUserId(sub);
  if (!userId) return { applied: false, reason: 'no_user' };

  // Out-of-order guard, scoped to THIS subscription: a late delivery of an
  // older state must not overwrite a newer one. `>=` (not `>`) so distinct
  // same-instant events still apply (state is re-derived whole, so
  // last-writer-wins is safe).
  const current = await db
    .select({
      subscriptionId: usersTable.polarSubscriptionId,
      eventAt: usersTable.subscriptionEventAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const sameSubscription = current[0]?.subscriptionId === sub.id;
  if (sameSubscription && current[0]?.eventAt && occurredAt < current[0].eventAt) {
    return { applied: false, reason: 'stale', userId };
  }

  // `subscription.revoked` means benefits end NOW regardless of the status
  // field; otherwise the status decides.
  const grants = eventType !== 'subscription.revoked' && GRANTING_STATUSES.has(sub.status);

  const periodEnd =
    sub.currentPeriodEnd == null
      ? null
      : sub.currentPeriodEnd instanceof Date
        ? sub.currentPeriodEnd
        : new Date(sub.currentPeriodEnd);

  await db
    .update(usersTable)
    .set({
      plan: grants ? 'unlimited' : 'free',
      polarSubscriptionId: sub.id,
      ...(sub.customerId ?? sub.customer?.id
        ? { polarCustomerId: (sub.customerId ?? sub.customer?.id)! }
        : {}),
      subscriptionStatus: sub.status,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
      subscriptionEventAt: occurredAt,
      updatedAt: new Date(),
    })
    .where(eq(usersTable.id, userId));

  return { applied: true, userId };
}

/** Express handler for POST /api/v1/webhooks/polar (raw body). */
export async function handlePolarWebhook(req: Request, res: Response): Promise<void> {
  if (!billingEnabled()) {
    res.status(503).json({ success: false, error: 'Billing is not configured' });
    return;
  }

  const eventId = req.headers['webhook-id'];
  const timestampHeader = req.headers['webhook-timestamp'];
  if (typeof eventId !== 'string' || !eventId) {
    res.status(400).json({ success: false, error: 'Missing webhook-id header' });
    return;
  }

  let event: { type: string; data: unknown };
  try {
    event = validateEvent(
      req.body as Buffer,
      req.headers as Record<string, string>,
      polarWebhookSecret()
    ) as { type: string; data: unknown };
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      debugBus.recordEvent({
        service: 'billing',
        action: 'webhook_rejected',
        summary: 'polar webhook rejected: bad signature',
        ok: false,
      });
      res.status(401).json({ success: false, error: 'Invalid webhook signature' });
      return;
    }
    throw err;
  }

  // standard-webhooks timestamp = unix seconds of the (first) delivery of
  // this event — our ordering watermark.
  const occurredAt =
    typeof timestampHeader === 'string' && /^\d+$/.test(timestampHeader)
      ? new Date(Number(timestampHeader) * 1000)
      : new Date();

  // Idempotency gate: exactly one processor per event id, ever.
  const db = getPoolDbClient();
  const sub = event.type.startsWith('subscription.')
    ? subscriptionFromEvent(event.data)
    : null;
  const inserted = await db
    .insert(billingEventsTable)
    .values({
      eventId,
      eventType: event.type,
      subscriptionId: sub?.id ?? null,
      occurredAt,
    })
    .onConflictDoNothing()
    .returning({ eventId: billingEventsTable.eventId });
  if (inserted.length === 0) {
    res.status(200).json({ success: true, duplicate: true });
    return;
  }

  let result: ApplyResult = { applied: false, reason: 'ignored_type' };
  if (sub) {
    result = await applySubscriptionEvent(event.type, sub, occurredAt);
  }

  await db
    .update(billingEventsTable)
    .set({ applied: result.applied, userId: result.userId ?? null })
    .where(and(eq(billingEventsTable.eventId, eventId)));

  debugBus.recordEvent({
    service: 'billing',
    action: 'webhook',
    summary: `polar ${event.type}: ${
      result.applied ? 'applied' : `skipped (${result.reason})`
    }`,
  });

  if (result.applied && result.userId) {
    emitSubscriptionUpdated(result.userId, await buildBillingStatus(result.userId));
  }

  res.status(200).json({ success: true });
}
