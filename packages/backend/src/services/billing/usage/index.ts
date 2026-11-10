/**
 * Usage ledger: the public API that gates (WP3/WP5) and metering hooks (WP4)
 * code against. Money is integer micro-dollars; usage is integer weighted
 * seconds (see `packages/shared/src/pricing.ts`).
 *
 * `openInterval` and `closeInterval` never throw: they run inside dispatch and
 * poller paths, and a billing failure must not fail a task or a session. A
 * failure is recorded on the debug bus; the meter's sweep repairs the ledger
 * within a minute.
 */
import { runWithoutScope } from '../../../db/client.js';
import { billingEnabled } from '../entitlements.js';
import { debugBus } from '../../debugBus.js';
import { chargeOwnerAt, type UsageBudget } from './charge.js';
import { suspendWorkbenchIfExhausted as suspendIfExhausted } from './exhaustion.js';
import { countOpen, insertOpenInterval, markIntervalClosed, type EndReason, type OpenIntervalInput } from './intervals.js';

export type { UsageSubjectKind } from '@talyn/shared';
export type { EndReason, OpenIntervalInput } from './intervals.js';
export type { UsageBudget } from './charge.js';
export { grantCreditLot, reverseCreditLot, liveLots, creditBalance, type GrantCreditLotInput } from './credits.js';
export { resolveUsageTier, type UsageTier } from './tier.js';
export {
  applyUsageReset,
  countUsageResets,
  markUsageResetRefunded,
  usageResetAvailability,
  type UsageResetRefusal,
} from './resets.js';
export { initUsageMeter, usageMeter } from './meter.js';

/**
 * Start metering a box. Idempotent per sandbox: a second open while one is
 * open is a no-op.
 */
export async function openInterval(input: OpenIntervalInput): Promise<void> {
  try {
    await insertOpenInterval(input);
  } catch (error) {
    debugBus.recordEvent({
      service: 'billing',
      action: 'usage_open_failed',
      summary: `Could not open a usage interval for ${input.sandboxId}`,
      ok: false,
      error,
      workspaceId: input.workspaceId ?? undefined,
    });
  }
}

/**
 * Stop metering a box at `endedAt`, then charge its owner. A close with no
 * open interval is a no-op.
 */
export async function closeInterval(sandboxId: string, endedAt: Date, reason: EndReason): Promise<void> {
  try {
    const closed = await markIntervalClosed(sandboxId, endedAt, reason);
    if (closed) await runWithoutScope(() => chargeOwnerAt(closed.ownerId, new Date()));
  } catch (error) {
    debugBus.recordEvent({
      service: 'billing',
      action: 'usage_close_failed',
      summary: `Could not close the usage interval for ${sandboxId}`,
      ok: false,
      error,
    });
  }
}

/** Boxes of the owner with an open interval. */
export async function countOpenBoxes(ownerId: string): Promise<number> {
  return countOpen(ownerId);
}

/**
 * The owner's budget for the current period, after charging what is owed.
 *
 * `exhausted` is the ledger's fact and does NOT look at `billingEnabled()`:
 * a gate must check that itself (enforcement only applies when the POLAR_*
 * env group is set).
 */
export async function getBudget(ownerId: string): Promise<UsageBudget> {
  return runWithoutScope(async () => (await chargeOwnerAt(ownerId, new Date())).budget);
}

/** Charge the owner's open intervals up to now. Idempotent and safe across replicas. */
export async function chargeOwner(ownerId: string): Promise<void> {
  await runWithoutScope(() => chargeOwnerAt(ownerId, new Date()));
}

/**
 * Suspend a workbench box now when its owner is out of budget and no turn of
 * it runs. For the end of a turn (`finishTurn`), so the box does not stay
 * awake until the next meter tick. Does nothing when billing is not
 * configured. Never throws.
 */
export async function suspendWorkbenchIfExhausted(workbenchId: string): Promise<boolean> {
  if (!billingEnabled()) return false;
  return runWithoutScope(() => suspendIfExhausted(workbenchId, async (ownerId) => (await getBudget(ownerId)).exhausted));
}
