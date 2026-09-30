import type { Request, Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks';
import { getPoolDbClient } from '../../db/client.js';
import {
  billingEvents as billingEventsTable,
  teams as teamsTable,
  users as usersTable,
} from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { emitSubscriptionUpdated } from '../websocket.js';
import { billingEnabled, buildBillingStatus } from './entitlements.js';
import { isTeamProductId, polarWebhookSecret, teamIdFromCustomerExternalId } from './polar.js';
import { seatAllAdmins, teamAudienceUserIds } from './teams.js';
import { notifyTodiex, type TodiexLevel } from '../todiex.js';
import {
  compactMetadata,
  describeUser,
  personLabel,
  personMetadata,
} from '../todiexContext.js';

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

/**
 * The slice of Polar's subscription entity we read.
 *
 * The first six fields drive the state machine. The rest are display only —
 * what somebody actually wants to know when their phone says a subscription
 * landed: who bought it, which product, and for how much. All optional,
 * because none of them may decide anything: an older event that lacks them
 * still applies, it just reads with less detail.
 */
export interface PolarSubscription {
  id: string;
  status: string;
  currentPeriodEnd?: Date | string | null;
  cancelAtPeriodEnd?: boolean;
  customerId?: string;
  customer?: {
    id?: string;
    externalId?: string | null;
    email?: string | null;
    name?: string | null;
  };
  /** Minor units (cents), as Polar sends them. */
  amount?: number | null;
  currency?: string | null;
  /** 'month' | 'year'. */
  recurringInterval?: string | null;
  product?: { name?: string | null } | null;
  /** Routes a team subscription even when its customer lacks our external id. */
  productId?: string | null;
  /** Seat count on a seat-based (team) subscription; absent on a personal one. */
  seats?: number | null;
}

export interface ApplyResult {
  applied: boolean;
  reason?: 'no_user' | 'no_team' | 'stale' | 'ignored_type';
  userId?: string;
  /** Set instead of `userId` when the event was a team subscription's. */
  teamId?: string;
  /** The team's first subscription ever — the moment its creator is seated. */
  firstActivation?: boolean;
  /**
   * Was THIS subscription already granting paid access before this event?
   *
   * Read before the write, and the only reason it is carried out of here: it is
   * what tells a subscription starting apart from one that was already running
   * — see {@link describeSubscriptionEvent}. Absent when nothing was applied.
   */
  previouslyGranting?: boolean;
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
/**
 * How a subscription event should read on a phone.
 *
 * Polar sends one `subscription.updated` for a great many transitions, so the
 * status carries the meaning rather than the event type. `past_due` is the
 * closest thing to a payment failure that reaches us: Polar keeps granting
 * access through its own dunning, and only a later `revoked` ends it, so this
 * is the moment worth knowing about while it can still be saved.
 *
 * Returns null for the transitions not worth a notification — a `trialing`
 * heartbeat, a metadata-only update. Exported for tests.
 *
 * **One sale is ONE notification.** Polar announces a new subscription twice,
 * `subscription.created` then `subscription.active` seconds later, with
 * identical content, and each carries its own `webhook-id` — so the per-event
 * dedupe key cannot see they are the same news, and the feed showed both
 * (observed 2026-09-21). `previouslyGranting` is what distinguishes them: the
 * second one arrives with the subscription already stored as granting.
 *
 * Stated on BOTH start events rather than by dropping `subscription.active`,
 * because Polar does not promise an order. Whichever lands first announces the
 * start; the other stores nothing. An `active` that follows a lapse —
 * `past_due` recovered, a revoked subscription resumed — is NOT a repeat and
 * still announces, which is the whole reason the rule is about the stored state
 * and not about the event name.
 */
export function describeSubscriptionEvent(
  eventType: string,
  status: string,
  opts: { previouslyGranting?: boolean } = {}
): { kind: string; level: TodiexLevel; title: string } | null {
  if (eventType === 'subscription.revoked' || status === 'canceled') {
    return { kind: 'subscription.cancelled', level: 'warn', title: 'Talyn subscription ended' };
  }
  if (status === 'past_due') {
    return { kind: 'payment.failed', level: 'error', title: 'Talyn payment failed — in dunning' };
  }
  const starting = !opts.previouslyGranting;
  if (eventType === 'subscription.created' && GRANTING_STATUSES.has(status)) {
    return starting
      ? { kind: 'subscription.created', level: 'success', title: 'New Talyn subscription' }
      : null;
  }
  if (eventType === 'subscription.active') {
    return starting
      ? { kind: 'subscription.active', level: 'success', title: 'Talyn subscription active' }
      : null;
  }
  return null;
}

/** Polar's minor units as money a person reads: 2000 + 'usd' → "$20.00". */
export function formatSubscriptionPrice(
  amount: number | null | undefined,
  currency: string | null | undefined
): string | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const code = (currency || 'usd').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(
      amount / 100
    );
  } catch {
    // An unknown or malformed currency code — still worth showing the number.
    return `${(amount / 100).toFixed(2)} ${code}`;
  }
}

/** A period end as a date somebody can read: "16 Oct 2026". */
export function formatPeriodEnd(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * The subscription, in one line, for the body of the notification.
 *
 * Reads as "Talyn Unlimited, $20.00/month. Status active, renews 16 Oct
 * 2026." and degrades a clause at a time — an event carrying no product and
 * no price still says what the status is, which is what the line used to say
 * on its own. `cancelAtPeriodEnd` turns "renews" into "access until", because
 * those are opposite pieces of news and the date alone does not distinguish
 * them.
 */
export function summarizeSubscription(sub: PolarSubscription): string {
  const price = formatSubscriptionPrice(sub.amount, sub.currency);
  const plan = [
    sub.product?.name ?? null,
    price ? `${price}${sub.recurringInterval ? `/${sub.recurringInterval}` : ''}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const periodEnd = formatPeriodEnd(sub.currentPeriodEnd);
  const state = [
    `Status ${sub.status}`,
    periodEnd ? `${sub.cancelAtPeriodEnd ? 'access until' : 'renews'} ${periodEnd}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return [plan ? `${plan}.` : null, `${state}.`].filter(Boolean).join(' ');
}

/**
 * A team subscription is recognised by its customer's `team_` external id OR
 * by its product. Either is enough, and neither ever falls through to the
 * user lookup: a team event applied to a users row would give the BUYER
 * Unlimited on the team's money and then take it away on the team's cancel.
 */
export function isTeamSubscription(sub: PolarSubscription): boolean {
  return (
    teamIdFromCustomerExternalId(sub.customer?.externalId) !== null ||
    isTeamProductId(sub.productId)
  );
}

async function resolveTeamId(sub: PolarSubscription): Promise<string | null> {
  const db = getPoolDbClient();
  const fromExternal = teamIdFromCustomerExternalId(sub.customer?.externalId);
  if (fromExternal) {
    const rows = await db
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(eq(teamsTable.id, fromExternal))
      .limit(1);
    if (rows[0]) return rows[0].id;
  }
  const customerId = sub.customerId ?? sub.customer?.id;
  if (customerId) {
    const rows = await db
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(eq(teamsTable.polarCustomerId, customerId))
      .limit(1);
    if (rows[0]) return rows[0].id;
  }
  return null;
}

function periodEndOf(sub: PolarSubscription): Date | null {
  return sub.currentPeriodEnd == null
    ? null
    : sub.currentPeriodEnd instanceof Date
      ? sub.currentPeriodEnd
      : new Date(sub.currentPeriodEnd);
}

/**
 * Apply one team subscription event to the `teams` row — the same state
 * machine as a personal subscription (granting statuses, `revoked` ends it
 * now, the per-subscription stale guard), writing `plan` = 'team' | 'none'
 * and the seat count Polar bills for.
 *
 * `seats_purchased` is only ever written from here. A count lowered below the
 * seats already assigned (in the Polar portal, say) is stored as it is: the
 * admin sees the team as over-allocated and nobody is un-seated silently.
 */
export async function applyTeamSubscriptionEvent(
  eventType: string,
  sub: PolarSubscription,
  occurredAt: Date
): Promise<ApplyResult> {
  const db = getPoolDbClient();
  const teamId = await resolveTeamId(sub);
  if (!teamId) return { applied: false, reason: 'no_team' };

  const [current] = await db
    .select({
      subscriptionId: teamsTable.polarSubscriptionId,
      eventAt: teamsTable.subscriptionEventAt,
      status: teamsTable.subscriptionStatus,
    })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  const sameSubscription = current?.subscriptionId === sub.id;
  const previouslyGranting = sameSubscription && GRANTING_STATUSES.has(current?.status ?? '');
  if (sameSubscription && current?.eventAt && occurredAt < current.eventAt) {
    return { applied: false, reason: 'stale', teamId };
  }

  const grants = eventType !== 'subscription.revoked' && GRANTING_STATUSES.has(sub.status);
  const seats =
    typeof sub.seats === 'number' && Number.isInteger(sub.seats) && sub.seats >= 0
      ? sub.seats
      : null;

  await db
    .update(teamsTable)
    .set({
      plan: grants ? 'team' : 'none',
      ...(seats !== null ? { seatsPurchased: seats } : {}),
      polarSubscriptionId: sub.id,
      ...(sub.customerId ?? sub.customer?.id
        ? { polarCustomerId: (sub.customerId ?? sub.customer?.id)! }
        : {}),
      subscriptionStatus: sub.status,
      currentPeriodEnd: periodEndOf(sub),
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
      subscriptionEventAt: occurredAt,
      updatedAt: new Date(),
    })
    .where(eq(teamsTable.id, teamId));

  return {
    applied: true,
    teamId,
    previouslyGranting,
    firstActivation: grants && !current?.subscriptionId,
  };
}

export async function applySubscriptionEvent(
  eventType: string,
  sub: PolarSubscription,
  occurredAt: Date
): Promise<ApplyResult> {
  if (isTeamSubscription(sub)) return applyTeamSubscriptionEvent(eventType, sub, occurredAt);

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
      // For the notification, not for the state machine — the stored status is
      // what says whether this subscription was already running.
      status: usersTable.subscriptionStatus,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const sameSubscription = current[0]?.subscriptionId === sub.id;
  const previouslyGranting =
    sameSubscription && GRANTING_STATUSES.has(current[0]?.status ?? '');
  if (sameSubscription && current[0]?.eventAt && occurredAt < current[0].eventAt) {
    return { applied: false, reason: 'stale', userId };
  }

  // `subscription.revoked` means benefits end NOW regardless of the status
  // field; otherwise the status decides.
  const grants = eventType !== 'subscription.revoked' && GRANTING_STATUSES.has(sub.status);
  const periodEnd = periodEndOf(sub);

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

  return { applied: true, userId, previouslyGranting };
}

/**
 * What an applied team event sets off: the creator's seat on the team's first
 * activation, a fresh billing status to every account the team touches, and
 * the same one-line notification a personal subscription gets. Best-effort
 * after the write — Polar has its answer either way, and a push that fails is
 * healed by the next status poll.
 */
async function afterTeamEvent(
  result: ApplyResult,
  sub: PolarSubscription,
  eventType: string,
  eventId: string,
  occurredAt: Date
): Promise<void> {
  const teamId = result.teamId!;
  try {
    await seatAllAdmins(teamId);
    for (const userId of await teamAudienceUserIds(teamId)) {
      emitSubscriptionUpdated(userId, await buildBillingStatus(userId));
    }
  } catch (err) {
    console.error(`[billing] follow-up for team ${teamId} failed:`, err);
  }

  const described = describeSubscriptionEvent(eventType, sub.status, {
    ...(result.previouslyGranting !== undefined
      ? { previouslyGranting: result.previouslyGranting }
      : {}),
  });
  if (!described) return;
  notifyTodiex(async () => {
    const [team] = await getPoolDbClient()
      .select({ name: teamsTable.name })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1);
    const seats = typeof sub.seats === 'number' ? `${sub.seats} seats` : null;
    const label = [team?.name ?? null, seats].filter(Boolean).join(', ');
    return {
      kind: `team.${described.kind}`,
      level: described.level,
      title: `${described.title} (team)${label ? ` — ${label}` : ''}`,
      message: summarizeSubscription(sub),
      metadata: compactMetadata({
        team_id: teamId,
        team_name: team?.name ?? null,
        seats: typeof sub.seats === 'number' ? sub.seats : null,
        customer_email: sub.customer?.email ?? null,
        customer_name: sub.customer?.name ?? null,
        product: sub.product?.name ?? null,
        price: formatSubscriptionPrice(sub.amount, sub.currency),
        billing_interval: sub.recurringInterval ?? null,
        status: sub.status,
        subscription_id: sub.id,
        polar_event_type: eventType,
      }),
      dedupeKey: `polar:${eventId}`,
      occurredAt: occurredAt.toISOString(),
    };
  });
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
    .set({
      applied: result.applied,
      userId: result.userId ?? null,
      teamId: result.teamId ?? null,
    })
    .where(and(eq(billingEventsTable.eventId, eventId)));

  debugBus.recordEvent({
    service: 'billing',
    action: 'webhook',
    summary: `polar ${event.type}: ${
      result.applied ? 'applied' : `skipped (${result.reason})`
    }`,
  });

  if (result.applied && result.teamId && sub) {
    await afterTeamEvent(result, sub, event.type, eventId, occurredAt);
  }

  if (result.applied && result.userId) {
    emitSubscriptionUpdated(result.userId, await buildBillingStatus(result.userId));

    // Money moving is the one billing signal worth a phone buzz. Keyed on the
    // Polar event id so a redelivery Polar makes after our 200 was lost in
    // flight cannot notify twice — the idempotency gate above already stops
    // one that reaches us, but this covers the half-second where it does not.
    const described = sub
      ? describeSubscriptionEvent(event.type, sub.status, {
          ...(result.previouslyGranting !== undefined
            ? { previouslyGranting: result.previouslyGranting }
            : {}),
        })
      : null;
    if (described) {
      const subscription = sub!;
      const userId = result.userId;
      // Deferred so the lookup happens after this handler has answered Polar
      // — a webhook that waits on anything gets retried. `refresh` because
      // the plan column was written moments ago by applySubscriptionEvent.
      notifyTodiex(async () => {
        const stored = await describeUser(userId, { refresh: true });
        // Polar's customer email is the address that actually paid; ours is
        // the one they signed in with. Prefer ours (it is the account the
        // rest of the feed names) and fall back to Polar's, so an event for
        // a user row we could not read still says who it was about.
        const person = {
          ...stored,
          email: stored.email ?? subscription.customer?.email ?? null,
        };
        const who = personLabel(person);
        const price = formatSubscriptionPrice(subscription.amount, subscription.currency);
        return {
          kind: described.kind,
          level: described.level,
          title: who ? `${described.title} — ${who}` : described.title,
          message: summarizeSubscription(subscription),
          metadata: compactMetadata({
            ...personMetadata(person),
            product: subscription.product?.name ?? null,
            price,
            billing_interval: subscription.recurringInterval ?? null,
            status: subscription.status,
            cancel_at_period_end: subscription.cancelAtPeriodEnd ?? false,
            renews_on: formatPeriodEnd(subscription.currentPeriodEnd),
            customer_name: subscription.customer?.name ?? null,
            subscription_id: subscription.id,
            polar_event_type: event.type,
          }),
          dedupeKey: `polar:${eventId}`,
          occurredAt: occurredAt.toISOString(),
        };
      });
    }
  }

  res.status(200).json({ success: true });
}
