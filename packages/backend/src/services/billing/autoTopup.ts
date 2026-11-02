import { randomUUID } from 'crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  AUTO_TOPUP_DEFAULTS,
  autoTopupMonthKey,
  CREDIT_PACKS,
  isCreditPackId,
  PLAN_LIMITS,
  type AutoTopupConfig,
  type AutoTopupSettings,
  type CreditLotSource,
  type CreditPackId,
  type Micros,
} from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { autoTopupSettings, users } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { emitSubscriptionUpdated } from '../websocket.js';
import { billingEnabled, buildBillingStatus } from './entitlements.js';
import {
  createDraftOrder,
  creditPackProductId,
  finalizeOrder,
  getCustomerIdForUser,
  getOrder,
  polarErrorName,
  polarStatusCode,
} from './polar.js';
import { creditBalance, grantCreditLot } from './usage/credits.js';
import { resolveUsageTier } from './usage/tier.js';

/**
 * Auto top-up: buy a credit pack off-session when the balance runs low.
 *
 * The charge is Polar's off-session order (preview API): a DRAFT order against
 * the customer's saved payment method, then `finalize`, which charges it
 * synchronously. A charge that fails or is not permitted records
 * `last_failure`; the budget then reads auto top-up as impossible, and the UI
 * shows the "balance low, buy credits" prompt. Nothing retries a failed charge
 * on its own: saving the settings again is the retry (a declined card charged
 * again every minute is how an account gets flagged for card testing).
 *
 * One charge per owner at a time. The claim is a conditional UPDATE on
 * `inflight_order_id` / `inflight_started_at`, not an advisory lock: the
 * claim must survive across a Polar round trip, and a lock held over HTTP
 * pins a pool connection. A claim older than {@link CLAIM_STALE_MS} is
 * abandoned (a crashed replica), and the next attempt first settles the order
 * the old claim left behind, so a crash cannot charge twice.
 *
 * Credits are granted from the finalize response when it says `paid`, and
 * again (a no-op) from the `order.paid` webhook: `grantCreditLot` is unique on
 * the Polar order id. The monthly spend counter moves only with the call that
 * CREATED the lot, so it counts each order once whichever path lands first.
 */

/** A claim older than this belongs to a replica that died mid-charge. */
export const CLAIM_STALE_MS = 10 * 60_000;

const CLAIM_PREFIX = 'claim:';

export const AUTO_TOPUP_SETTINGS_COLUMNS = {
  enabled: autoTopupSettings.enabled,
  triggerMicros: autoTopupSettings.triggerMicros,
  pack: autoTopupSettings.pack,
  monthlyLimitMicros: autoTopupSettings.monthlyLimitMicros,
  monthKey: autoTopupSettings.monthKey,
  monthSpentMicros: autoTopupSettings.monthSpentMicros,
  inflightOrderId: autoTopupSettings.inflightOrderId,
  inflightStartedAt: autoTopupSettings.inflightStartedAt,
  lastFailure: autoTopupSettings.lastFailure,
  lastFailureAt: autoTopupSettings.lastFailureAt,
} as const;

type SettingsRow = Pick<typeof autoTopupSettings.$inferSelect, keyof typeof AUTO_TOPUP_SETTINGS_COLUMNS>;

const db = () => getPoolDbClient();

export function autoTopupSettingsQuery(ownerId: string) {
  return db()
    .select(AUTO_TOPUP_SETTINGS_COLUMNS)
    .from(autoTopupSettings)
    .where(eq(autoTopupSettings.ownerId, ownerId))
    .limit(1);
}

function packOf(row: Pick<SettingsRow, 'pack'>): CreditPackId {
  return isCreditPackId(row.pack) ? row.pack : AUTO_TOPUP_DEFAULTS.pack;
}

function monthSpentOf(row: Pick<SettingsRow, 'monthKey' | 'monthSpentMicros'>, now: Date): Micros {
  return row.monthKey === autoTopupMonthKey(now) ? Number(row.monthSpentMicros) : 0;
}

/** Pure: the public shape of a settings row (defaults when there is none). */
export function toAutoTopupSettings(row: SettingsRow | undefined, now: Date): AutoTopupSettings {
  if (!row) return { ...AUTO_TOPUP_DEFAULTS, monthSpentMicros: 0, lastFailure: null, lastFailureAt: null };
  return {
    enabled: row.enabled,
    triggerMicros: Number(row.triggerMicros),
    pack: packOf(row),
    monthlyLimitMicros: Number(row.monthlyLimitMicros),
    monthSpentMicros: monthSpentOf(row, now),
    lastFailure: row.lastFailure,
    lastFailureAt: row.lastFailureAt ? row.lastFailureAt.toISOString() : null,
  };
}

export async function readAutoTopupSettings(ownerId: string, now = new Date()): Promise<AutoTopupSettings> {
  const [row] = await autoTopupSettingsQuery(ownerId);
  return toAutoTopupSettings(row, now);
}

/**
 * Save the owner's settings (validate with `validateAutoTopupConfig` first).
 * Saving clears `last_failure`: it is the person's "try again" after fixing a
 * payment method, and the next low balance charges once more.
 */
export async function saveAutoTopupSettings(ownerId: string, config: AutoTopupConfig, now = new Date()): Promise<AutoTopupSettings> {
  const values = {
    enabled: config.enabled,
    triggerMicros: config.triggerMicros,
    pack: config.pack,
    monthlyLimitMicros: config.monthlyLimitMicros,
    lastFailure: null,
    lastFailureAt: null,
    updatedAt: now,
  };
  await db()
    .insert(autoTopupSettings)
    .values({ ownerId, ...values })
    .onConflictDoUpdate({ target: autoTopupSettings.ownerId, set: values });
  return readAutoTopupSettings(ownerId, now);
}

/** Take the one-charge-at-a-time claim. False when another charge holds a live claim. */
async function claim(ownerId: string, prev: SettingsRow, token: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  const rows = await db()
    .update(autoTopupSettings)
    .set({ inflightOrderId: token, inflightStartedAt: now, updatedAt: now })
    .where(
      and(
        eq(autoTopupSettings.ownerId, ownerId),
        eq(autoTopupSettings.enabled, true),
        isNull(autoTopupSettings.lastFailure),
        prev.inflightOrderId === null
          ? isNull(autoTopupSettings.inflightOrderId)
          : eq(autoTopupSettings.inflightOrderId, prev.inflightOrderId),
        or(isNull(autoTopupSettings.inflightStartedAt), lt(autoTopupSettings.inflightStartedAt, staleBefore)),
      ),
    )
    .returning({ ownerId: autoTopupSettings.ownerId });
  return rows.length > 0;
}

/** Move the claim from `from` to `to` (the claim token to the real order id). */
async function moveClaim(ownerId: string, from: string, to: string): Promise<void> {
  await db()
    .update(autoTopupSettings)
    .set({ inflightOrderId: to })
    .where(and(eq(autoTopupSettings.ownerId, ownerId), eq(autoTopupSettings.inflightOrderId, from)));
}

async function releaseClaim(ownerId: string, held: string): Promise<void> {
  await db()
    .update(autoTopupSettings)
    .set({ inflightOrderId: null, inflightStartedAt: null })
    .where(and(eq(autoTopupSettings.ownerId, ownerId), eq(autoTopupSettings.inflightOrderId, held)));
}

async function recordFailure(ownerId: string, held: string, message: string, now: Date): Promise<void> {
  await db()
    .update(autoTopupSettings)
    .set({ lastFailure: message, lastFailureAt: now, updatedAt: now })
    .where(eq(autoTopupSettings.ownerId, ownerId));
  await releaseClaim(ownerId, held);
}

export interface SettleCreditOrderInput {
  ownerId: string;
  orderId: string;
  pack: CreditPackId;
  source: Extract<CreditLotSource, 'purchase' | 'auto_topup'>;
  purchasedAt?: Date;
}

/**
 * Grant the credits a paid credit-pack order bought. Idempotent on the order
 * id; both the finalize response and the `order.paid` webhook call it. For an
 * auto top-up it also counts the spend (once, with the call that created the
 * lot), clears `last_failure` and releases the claim the order held.
 */
export async function settleCreditOrder(input: SettleCreditOrderInput, now = new Date()): Promise<{ created: boolean }> {
  const pack = CREDIT_PACKS[input.pack];
  const { created } = await grantCreditLot({
    ownerId: input.ownerId,
    micros: pack.creditMicros,
    source: input.source,
    polarOrderId: input.orderId,
    ...(input.purchasedAt ? { purchasedAt: input.purchasedAt } : {}),
  });
  if (input.source === 'auto_topup') {
    const key = autoTopupMonthKey(now);
    const spend = created
      ? {
          monthSpentMicros: sql`CASE WHEN ${autoTopupSettings.monthKey} = ${key} THEN ${autoTopupSettings.monthSpentMicros} + ${pack.priceMicros} ELSE ${pack.priceMicros} END`,
          monthKey: key,
        }
      : {};
    await db()
      .update(autoTopupSettings)
      .set({
        ...spend,
        lastFailure: null,
        lastFailureAt: null,
        inflightOrderId: sql`CASE WHEN ${autoTopupSettings.inflightOrderId} = ${input.orderId} THEN NULL ELSE ${autoTopupSettings.inflightOrderId} END`,
        inflightStartedAt: sql`CASE WHEN ${autoTopupSettings.inflightOrderId} = ${input.orderId} THEN NULL ELSE ${autoTopupSettings.inflightStartedAt} END`,
        updatedAt: now,
      })
      .where(eq(autoTopupSettings.ownerId, input.ownerId));
  }
  return { created };
}

/** User-facing sentence for a refused or failed charge. Pure, for tests. */
export function failureMessage(err: unknown): string {
  const status = polarStatusCode(err);
  const name = polarErrorName(err);
  if (name === 'PaymentActionRequired') {
    return 'Your bank asked to confirm the automatic payment, which cannot happen while you are away. Buy credits by hand, then save auto top-up again.';
  }
  if (status === 402) {
    return 'Your card was declined. Update your payment method in the billing portal, then save auto top-up again.';
  }
  if (status === 403) {
    return 'Automatic charges are not available on this account yet. Buy credits by hand.';
  }
  if (status !== null) {
    return `The automatic charge failed (Polar answered ${status}). Buy credits by hand, then save auto top-up again.`;
  }
  return 'The automatic charge failed. Buy credits by hand, then save auto top-up again.';
}

export const NO_CUSTOMER_MESSAGE =
  'There is no saved payment method for automatic charges. Buy credits by hand once, then save auto top-up again.';

/** A 4xx is Polar's answer about THIS charge; anything else leaves its outcome unknown. */
function isDefiniteRefusal(err: unknown): boolean {
  const status = polarStatusCode(err);
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isPaid(order: { paid?: boolean; status?: string }): boolean {
  return order.paid === true || order.status === 'paid';
}

function orderCreatedAt(order: { createdAt?: Date | string }): Date | undefined {
  if (!order.createdAt) return undefined;
  const date = order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

async function pushStatus(ownerId: string): Promise<void> {
  try {
    emitSubscriptionUpdated(ownerId, await buildBillingStatus(ownerId));
  } catch {
    // Best effort: the next status poll heals the client.
  }
}

/** The outcome of one attempt, for the debug bus and the tests. */
export type AutoTopupOutcome =
  | 'granted'
  | 'billing_off'
  | 'not_enabled'
  | 'failed_before'
  | 'plan_has_no_credits'
  | 'monthly_limit'
  | 'above_trigger'
  | 'in_flight'
  | 'pending'
  | 'in_doubt'
  | 'refused';

async function customerIdFor(ownerId: string): Promise<string | null> {
  const [row] = await db()
    .select({ polarCustomerId: users.polarCustomerId })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  return row?.polarCustomerId ?? (await getCustomerIdForUser(ownerId));
}

/** One attempt. Throws only on a database error; Polar errors are outcomes. */
export async function runAutoTopUp(ownerId: string, shortfallMicros: Micros, now = new Date()): Promise<AutoTopupOutcome> {
  if (!billingEnabled()) return 'billing_off';
  const [row] = await autoTopupSettingsQuery(ownerId);
  if (!row?.enabled) return 'not_enabled';
  if (row.lastFailure) return 'failed_before';
  const { tier } = await resolveUsageTier(ownerId);
  if (!PLAN_LIMITS[tier].creditsAllowed) return 'plan_has_no_credits';

  const pack = packOf(row);
  if (monthSpentOf(row, now) + CREDIT_PACKS[pack].priceMicros > Number(row.monthlyLimitMicros)) return 'monthly_limit';
  if (shortfallMicros <= 0 && (await creditBalance(ownerId, now)) >= Number(row.triggerMicros)) return 'above_trigger';

  const attemptId = randomUUID();
  const token = `${CLAIM_PREFIX}${attemptId}`;
  if (!(await claim(ownerId, row, token, now))) return 'in_flight';
  let held = token;

  // A stale claim that names a real order: settle it before charging again.
  const leftover = row.inflightOrderId && !row.inflightOrderId.startsWith(CLAIM_PREFIX) ? row.inflightOrderId : null;

  try {
    let orderId: string | null = null;
    if (leftover) {
      const previous = await getOrder(leftover);
      if (isPaid(previous)) {
        await moveClaim(ownerId, held, leftover);
        const purchasedAt = orderCreatedAt(previous);
        await settleCreditOrder({ ownerId, orderId: leftover, pack, source: 'auto_topup', ...(purchasedAt ? { purchasedAt } : {}) }, now);
        return 'granted';
      }
      if (previous.status === 'pending') {
        // Still being charged: hold the claim for it, start nothing new.
        await moveClaim(ownerId, held, leftover);
        return 'pending';
      }
      if (previous.status === 'draft') orderId = leftover;
    }

    if (!orderId) {
      const customerId = await customerIdFor(ownerId);
      if (!customerId) {
        await recordFailure(ownerId, held, NO_CUSTOMER_MESSAGE, now);
        await pushStatus(ownerId);
        return 'refused';
      }
      const productId = creditPackProductId(pack);
      if (!productId) throw new Error(`Polar product id for the ${pack} credit pack is not set`);
      const draft = await createDraftOrder({
        customerId,
        productId,
        metadata: { kind: 'auto_topup', owner_id: ownerId, pack, attempt_id: attemptId },
        idempotencyKey: attemptId,
      });
      orderId = draft.id;
    }
    await moveClaim(ownerId, held, orderId);
    held = orderId;

    const order = await finalizeOrder(orderId);
    if (!isPaid(order)) {
      // Charged asynchronously: `order.paid` settles it. The claim stays, so
      // no second charge starts while this one is pending.
      return 'pending';
    }
    const purchasedAt = orderCreatedAt(order);
    await settleCreditOrder({ ownerId, orderId, pack, source: 'auto_topup', ...(purchasedAt ? { purchasedAt } : {}) }, now);
    return 'granted';
  } catch (err) {
    if (isDefiniteRefusal(err)) {
      await recordFailure(ownerId, held, failureMessage(err), now);
      await pushStatus(ownerId);
      return 'refused';
    }
    if (held === token) {
      // Nothing was created: release, and let the next low balance try again.
      await releaseClaim(ownerId, held);
    }
    // Otherwise a finalize whose outcome is unknown keeps its claim. The
    // webhook settles it if it was paid; after CLAIM_STALE_MS the next attempt
    // reads the order and settles or re-finalizes it.
    debugBus.recordEvent({ service: 'billing', action: 'auto_topup_error', summary: 'Auto top-up charge did not complete', ok: false, error: err });
    return 'in_doubt';
  }
}

/**
 * The usage meter's hook (see `usage/charge.ts`). True only when a lot was
 * granted before returning, so the meter can burn the shortfall from it at
 * once. Never throws.
 */
export async function tryAutoTopUp(ownerId: string, shortfallMicros: Micros): Promise<boolean> {
  try {
    const outcome = await runAutoTopUp(ownerId, shortfallMicros);
    // Only attempts that reached Polar. The refusals before it repeat on every
    // meter tick and would flood the bus.
    if (['granted', 'pending', 'refused', 'in_doubt'].includes(outcome)) {
      debugBus.recordEvent({
        service: 'billing',
        action: 'auto_topup',
        summary: `Auto top-up: ${outcome}`,
        ok: outcome === 'granted' || outcome === 'pending',
      });
    }
    return outcome === 'granted';
  } catch (error) {
    debugBus.recordEvent({ service: 'billing', action: 'auto_topup_error', summary: 'Auto top-up failed', ok: false, error });
    return false;
  }
}
