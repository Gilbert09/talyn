import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  boxRefusalReason,
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  TASK_STATUS_TERMINAL,
  USAGE_EXHAUSTED_ERROR_CODE,
  type BoxRefusalReason,
} from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { loopRuns, workflowRuns, workspaces } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { domainEvents, type DomainBudgetRestoredEvent, type DomainTaskStatusEvent } from '../events.js';
import { ownerOfWorkspace } from '../workflows/owner.js';
import {
  billingEnabled,
  ConcurrentBoxLimitError,
  isBoxGateError,
  UsageExhaustedError,
  withBoxGate,
  type BoxGateDecision,
  type BoxGateError,
  type BoxGateOptions,
} from './entitlements.js';

/**
 * What an unattended run does when the box gate refuses it, and how it avoids
 * asking again on every tick.
 *
 * Unattended callers (loops, merge-queue fixes, auto-keep, workflows,
 * automatic reviews) never answer a 402: nobody waits on them. They record a
 * VISIBLE deferral carrying the refusal's notice, and look again later.
 *
 * **When "later" is.** A full concurrency cap clears when a box stops, which
 * is minutes: {@link BOX_SLOT_RETRY_MS}. Exhausted hours clear at the period
 * reset (`notice.retryAt`), or the moment credits arrive. The recheck is
 * therefore the earlier of the reset and {@link EXHAUSTED_RECHECK_MS}, and a
 * `billing:budget_restored` domain event (credits granted, exhaustion
 * cleared) pulls parked loop and workflow runs forward at once.
 *
 * **Why an owner hold.** Auto-keep ticks every minute per PR, the merge queue
 * re-evaluates stale groups every two minutes, and an automatic review is
 * considered on every PR snapshot. Without a hold, an owner who is out of
 * hours for three weeks would have each of those charge the ledger and write
 * a deferral row on every pass. The hold remembers the refusal per owner, in
 * process, until its recheck time; unattended callers inside it get the same
 * refusal without a ledger read. A person's request never reads the hold: it
 * always gets a fresh answer, and a fresh pass clears the hold.
 *
 * The hold is per process, so each replica learns a refusal once per recheck.
 */

/**
 * How long a full concurrency cap holds unattended work before it asks again.
 * One loop-sweep interval: asking faster than the sweeps that ask buys
 * nothing, and a slot frees when another box stops, not on a schedule.
 */
export const BOX_SLOT_RETRY_MS = 30_000;

/**
 * The longest an exhausted owner's unattended work waits before it asks
 * again. Credits can arrive at any moment (a purchase, an operator grant, a
 * plan change the ledger has not seen yet), and the domain event covers only
 * the ones this process saw. One ledger read per quarter hour per owner is
 * the cost of noticing the rest.
 */
export const EXHAUSTED_RECHECK_MS = 15 * 60_000;

/** A refusal as an unattended run's history records it. */
export interface BoxDeferral {
  reason: BoxRefusalReason;
  /** User-facing: the gate's own sentence. */
  message: string;
  /** When the run looks again (ISO). Null when it will not (a size the plan cannot start). */
  retryAt: string | null;
}

/** When a refused unattended run should look again. Null: never on its own. */
export function deferralRetryAt(err: BoxGateError, now = Date.now()): Date | null {
  switch (err.code) {
    case USAGE_EXHAUSTED_ERROR_CODE: {
      const reset = err.notice.retryAt ? Date.parse(err.notice.retryAt) : Number.NaN;
      const recheck = now + EXHAUSTED_RECHECK_MS;
      return new Date(Number.isFinite(reset) && reset > now ? Math.min(reset, recheck) : recheck);
    }
    case CONCURRENT_BOX_LIMIT_ERROR_CODE:
      return new Date(now + BOX_SLOT_RETRY_MS);
    default:
      return null;
  }
}

/**
 * The event code a history row (a merge-queue entry, a code review) records
 * for a run the plan refused. `deferred_task_limit` stays in old histories.
 */
export type BoxDeferralEventCode = 'deferred_usage_exhausted' | 'deferred_box_limit' | 'deferred_size_requires_pro';

export function boxDeferralEventCode(err: BoxGateError): BoxDeferralEventCode {
  switch (boxRefusalReason(err.code)) {
    case 'usage_exhausted':
      return 'deferred_usage_exhausted';
    case 'box_limit_reached':
      return 'deferred_box_limit';
    case 'size_requires_pro':
      return 'deferred_size_requires_pro';
  }
}

/** The refusal in the shape a run's history stores. */
export function boxDeferral(err: BoxGateError, now = Date.now()): BoxDeferral {
  const retryAt = deferralRetryAt(err, now);
  return { reason: boxRefusalReason(err.code), message: err.message, retryAt: retryAt ? retryAt.toISOString() : null };
}

// ---------------------------------------------------------------------------
// The owner hold
// ---------------------------------------------------------------------------

const holds = new Map<string, { until: number; error: BoxGateError }>();

/** Tests: forget every hold. */
export function resetBoxDeferralsForTests(): void {
  holds.clear();
  owners.clear();
}

/** Remember a refusal so unattended callers do not ask again before its recheck time. */
export function noteBoxRefusal(ownerId: string, err: BoxGateError, now = Date.now()): void {
  const until = deferralRetryAt(err, now);
  if (!until) return;
  holds.set(ownerId, { until: until.getTime(), error: err });
}

/**
 * The refusal an unattended caller should get without asking, or null.
 * `unmetered` (a PostHog Code run) is not held by used-up hours, only by a
 * full box cap: it costs no hours.
 */
export function ownerBoxHold(ownerId: string, opts: { unmetered?: boolean; now?: number } = {}): BoxGateError | null {
  const hold = holds.get(ownerId);
  if (!hold) return null;
  if (hold.until <= (opts.now ?? Date.now())) {
    holds.delete(ownerId);
    return null;
  }
  if (opts.unmetered && hold.error.code === USAGE_EXHAUSTED_ERROR_CODE) return null;
  return hold.error;
}

/**
 * Forget an owner's hold: a gate just passed, or the budget came back.
 * `onlyBoxLimit` keeps an exhausted hold, for a freed slot that says
 * nothing about hours.
 */
export function releaseBoxHold(ownerId: string, opts: { onlyBoxLimit?: boolean } = {}): void {
  const hold = holds.get(ownerId);
  if (!hold) return;
  if (opts.onlyBoxLimit && hold.error.code !== CONCURRENT_BOX_LIMIT_ERROR_CODE) return;
  holds.delete(ownerId);
}

/** The held refusal, re-stated for this workspace so the notice names it. */
function heldForWorkspace(err: BoxGateError, workspaceId?: string): BoxGateError {
  if (err instanceof UsageExhaustedError && err.notice.periodEnd) {
    return new UsageExhaustedError({ tier: err.notice.tier, periodEnd: new Date(err.notice.periodEnd), workspaceId });
  }
  if (err instanceof ConcurrentBoxLimitError) {
    return new ConcurrentBoxLimitError(err.limit, err.active, err.notice.tier, workspaceId);
  }
  return err;
}

/** A workspace's owner rarely changes; a short cache saves a read per tick. */
const OWNER_TTL_MS = 10 * 60_000;
const owners = new Map<string, { ownerId: string; expiresAt: number }>();

async function ownerFor(workspaceId: string): Promise<string | null> {
  const hit = owners.get(workspaceId);
  if (hit && hit.expiresAt > Date.now()) return hit.ownerId;
  const ownerId = await ownerOfWorkspace(workspaceId);
  if (ownerId) owners.set(workspaceId, { ownerId, expiresAt: Date.now() + OWNER_TTL_MS });
  return ownerId;
}

/**
 * The held refusal for a workspace's owner, or null. For callers that must
 * decide before they write anything (the merge queue claims an entry before
 * it creates the task).
 */
export async function workspaceBoxHold(workspaceId: string, opts: { unmetered?: boolean } = {}): Promise<BoxGateError | null> {
  if (!billingEnabled()) return null;
  const ownerId = await ownerFor(workspaceId);
  if (!ownerId) return null;
  const held = ownerBoxHold(ownerId, opts);
  return held ? heldForWorkspace(held, workspaceId) : null;
}

/**
 * {@link withBoxGate}, with the hold. An unattended caller inside a hold gets
 * the held refusal and reads nothing. Every refusal updates the hold, and a
 * pass clears it, attended or not, so a person's fresh answer also frees the
 * unattended work behind it.
 */
export async function runBoxGate<T>(
  ownerId: string,
  options: BoxGateOptions,
  fn: (decision: BoxGateDecision) => Promise<T>
): Promise<T> {
  if (options.unattended && billingEnabled()) {
    const held = ownerBoxHold(ownerId, { unmetered: options.unmetered });
    if (held) throw heldForWorkspace(held, options.workspaceId);
  }
  let passed = false;
  try {
    const result = await withBoxGate(ownerId, options, (decision) => {
      passed = true;
      return fn(decision);
    });
    return result;
  } catch (err) {
    if (!passed && isBoxGateError(err)) noteBoxRefusal(ownerId, err);
    throw err;
  } finally {
    if (passed) releaseBoxHold(ownerId);
  }
}

// ---------------------------------------------------------------------------
// Waking parked work
// ---------------------------------------------------------------------------

/**
 * Pull an owner's parked loop and workflow runs forward to now. Only the runs
 * parked on `usage_exhausted`: a full concurrency cap has its own short retry.
 * Returns how many rows moved.
 */
export async function wakeParkedRuns(ownerId: string): Promise<number> {
  const db = getPoolDbClient();
  const owned = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.ownerId, ownerId));
  const now = new Date();
  const loops = await db
    .update(loopRuns)
    .set({ retryAfter: now })
    .where(
      and(
        eq(loopRuns.status, 'waiting_slot'),
        eq(loopRuns.failureCode, 'usage_exhausted'),
        gt(loopRuns.retryAfter, now),
        inArray(loopRuns.workspaceId, owned)
      )
    )
    .returning({ id: loopRuns.id });
  const workflows = await db
    .update(workflowRuns)
    .set({ retryAfter: now })
    .where(
      and(
        eq(workflowRuns.status, 'pending_retry'),
        gt(workflowRuns.retryAfter, now),
        sql`${workflowRuns.actions} @> '[{"code":"usage_exhausted"}]'::jsonb`,
        inArray(workflowRuns.workspaceId, owned)
      )
    )
    .returning({ id: workflowRuns.id });
  return loops.length + workflows.length;
}

let initialized = false;

/**
 * Listen for the two moments a hold should end early: the budget came back
 * (`billing:budget_restored`), and a task finished, which frees a box slot.
 * Scope-escaped like every domain listener: the emitter often runs inside a
 * request's transaction.
 */
export function initBoxDeferrals(): void {
  if (initialized) return;
  initialized = true;
  domainEvents.on('billing:budget_restored', ({ ownerId }: DomainBudgetRestoredEvent) => {
    releaseBoxHold(ownerId);
    void runWithoutScope(async () => {
      try {
        const woken = await wakeParkedRuns(ownerId);
        if (woken > 0) {
          debugBus.recordEvent({
            service: 'billing',
            action: 'deferrals_woken',
            summary: `Budget back: ${woken} parked run(s) are due now`,
            ok: true,
          });
        }
      } catch (error) {
        debugBus.recordEvent({ service: 'billing', action: 'deferrals_wake_failed', summary: 'Could not wake parked runs', ok: false, error });
      }
    });
  });
  domainEvents.on('task:status', (evt: DomainTaskStatusEvent) => {
    if (!TASK_STATUS_TERMINAL[evt.status]) return;
    void runWithoutScope(async () => {
      try {
        const ownerId = await ownerFor(evt.workspaceId);
        if (ownerId) releaseBoxHold(ownerId, { onlyBoxLimit: true });
      } catch {
        // The hold ends at its own time anyway.
      }
    });
  });
}
