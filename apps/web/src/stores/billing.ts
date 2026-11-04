import { create } from 'zustand';
import {
  AUTO_KEEP_DEFAULT_ERROR_CODE,
  CREDIT_PACKS,
  CREDIT_PACK_IDS,
  type CreditPackId,
  AUTO_REVIEW_ERROR_CODE,
  MERGE_QUEUE_LIMIT_ERROR_CODE,
  REVIEW_CYCLE_LIMIT_ERROR_CODE,
  TASK_LIMIT_ERROR_CODE,
  WORKFLOW_LIMIT_ERROR_CODE,
  LOOP_LIMIT_ERROR_CODE,
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_EXHAUSTED_ERROR_CODE,
  type BillingStatus,
} from '@talyn/shared';
import { api, ApiError } from '../lib/api';
import { captureAnalyticsException, trackEvent } from '../lib/analytics';
import {
  CREDITS_REQUIRE_PAID_PLAN_ERROR_CODE,
  boxRefusalFromError,
  type BoxRefusalNotice,
} from '../lib/usageBilling';

/**
 * Billing state: the user's plan/usage snapshot plus the upgrade-modal flag.
 *
 * The snapshot is server-authoritative (`GET /billing/status`) — never
 * derived from the local task list, which doesn't span every workspace the
 * user owns. It refreshes on app start, on window focus, on the
 * `subscription:updated` WS push, and in a short poll burst right after a
 * checkout/portal page is opened in the browser (webhooks can lag the
 * checkout by a few seconds, and the WS may be reconnecting at that moment).
 */

const POLL_BURST_INTERVAL_MS = 3_000;
const POLL_BURST_MAX_MS = 2 * 60_000;

interface BillingState {
  status: BillingStatus | null;
  upgradeModalOpen: boolean;
  /** What the user was refused, so the modal can pitch that thing. */
  upgradeReason: UpgradeReason | null;
  /** The refusal's own notice (usage billing), so the modal can quote it. */
  upgradeNotice: BoxRefusalNotice | null;
  setStatus: (status: BillingStatus) => void;
  setUpgradeModalOpen: (
    open: boolean,
    reason?: UpgradeReason | null,
    notice?: BoxRefusalNotice | null
  ) => void;
  /** Re-fetch the snapshot from the backend. Safe to call repeatedly. */
  refresh: () => Promise<void>;
  /** Start (or restart) the post-checkout poll burst. */
  startCheckoutPollBurst: () => void;
  markPlanChangeStarted: (period: 'monthly' | 'annual') => void;
  clearPlanChange: () => void;
  markCreditCheckoutStarted: (pack: CreditPackId) => void;
  clearCreditCheckout: () => void;
  stopCheckoutPollBurst: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollDeadline = 0;
let pendingPlanChange: { from: string; period: 'monthly' | 'annual' } | null = null;
let returnFailureReported = false;
const CREDIT_CHECKOUT_KEY = 'billing_credit_checkout';

function pendingCreditCheckout(): { pack: CreditPackId; ids: string[] } | null {
  try {
    const raw = sessionStorage.getItem(CREDIT_CHECKOUT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { pack?: CreditPackId; ids?: unknown };
    if (!CREDIT_PACK_IDS.includes(value.pack as CreditPackId) || !Array.isArray(value.ids)) return null;
    return { pack: value.pack as CreditPackId, ids: value.ids.filter((id): id is string => typeof id === 'string') };
  } catch {
    return null;
  }
}

export function trackBillingFailure(event: 'checkout_failed' | 'plan_change_failed' | 'credit_checkout_failed' | 'team_checkout_failed', stage: 'create_checkout' | 'portal' | 'return', err: unknown): void {
  const error = err && typeof err === 'object' ? err as { code?: unknown; status?: unknown } : null;
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : undefined;
  const status = typeof error?.status === 'number' ? error.status : undefined;
  trackEvent(event, { stage, code, status });
  captureAnalyticsException(err, { stage, code, status });
}

export const useBillingStore = create<BillingState>((set, get) => ({
  status: null,
  upgradeModalOpen: false,
  upgradeReason: null,
  upgradeNotice: null,

  setStatus: (status) => {
    const prev = get().status;
    set({ status });
    // Conversion signal: fire once when a free plan flips to paid *within the
    // session* (checkout completing via the WS push / poll burst, or a comp).
    // Guarding on prev existing + being free means loading an already-upgraded
    // account on startup doesn't count as an upgrade.
    if (prev?.plan === 'free' && status.plan !== 'free') {
      trackEvent('upgrade_completed', { plan_source: status.planSource });
    }
    const priorLots = new Set(prev?.credits?.lots.map((lot) => lot.id) ?? []);
    const pending = pendingCreditCheckout();
    const knownLots = prev ? priorLots : new Set(pending?.ids ?? []);
    if (prev?.credits || pending) {
      for (const lot of status.credits?.lots ?? []) {
        if (knownLots.has(lot.id) || (lot.source !== 'purchase' && lot.source !== 'auto_topup')) continue;
        const pack = CREDIT_PACK_IDS.find((id) => CREDIT_PACKS[id].creditMicros === lot.totalMicros);
        if (pack) trackEvent('credit_purchase_completed', { pack, amount_micros: CREDIT_PACKS[pack].priceMicros, source: lot.source === 'auto_topup' ? 'auto_topup' : 'manual' });
        if (pending && lot.source === 'purchase' && pack === pending.pack) get().clearCreditCheckout();
      }
    }
    if (prev) {
      const from = prev.tier ?? prev.plan;
      const to = status.tier ?? status.plan;
      if (pendingPlanChange && from === pendingPlanChange.from && to !== from) {
        trackEvent('plan_changed', { from, to, period: pendingPlanChange.period });
        pendingPlanChange = null;
      }
    }
    // The burst exists to catch the plan flip; once we're not free (or
    // billing turns out to be off) there's nothing left to poll for.
    if (status.plan !== 'free' || !status.billingEnabled) {
      get().stopCheckoutPollBurst();
    }
  },

  setUpgradeModalOpen: (upgradeModalOpen, reason, notice) =>
    // Clear the reason on close so the next open can't inherit stale copy.
    set({
      upgradeModalOpen,
      upgradeReason: upgradeModalOpen ? (reason ?? null) : null,
      upgradeNotice: upgradeModalOpen ? (notice ?? null) : null,
    }),

  refresh: async () => {
    try {
      get().setStatus(await api.billing.status());
    } catch (err) {
      const creditReturn = pendingCreditCheckout() !== null;
      if (!returnFailureReported && (pollTimer || pendingPlanChange || creditReturn)) {
        trackBillingFailure(pendingPlanChange ? 'plan_change_failed' : creditReturn ? 'credit_checkout_failed' : 'checkout_failed', 'return', err);
        returnFailureReported = true;
      }
      // Transient (offline / backend restart) — keep the last snapshot; the
      // next focus/WS/poll tick retries. Enforcement is server-side anyway.
    }
  },

  startCheckoutPollBurst: () => {
    returnFailureReported = false;
    pollDeadline = Date.now() + POLL_BURST_MAX_MS;
    if (pollTimer) return; // already running — just extended the deadline
    pollTimer = setInterval(() => {
      if (Date.now() > pollDeadline) {
        get().stopCheckoutPollBurst();
        return;
      }
      void get().refresh();
    }, POLL_BURST_INTERVAL_MS);
  },

  markPlanChangeStarted: (period) => {
    returnFailureReported = false;
    const current = get().status;
    pendingPlanChange = current ? { from: current.tier ?? current.plan, period } : null;
  },
  clearPlanChange: () => { pendingPlanChange = null; },
  markCreditCheckoutStarted: (pack) => {
    returnFailureReported = false;
    try {
      sessionStorage.setItem(CREDIT_CHECKOUT_KEY, JSON.stringify({ pack, ids: get().status?.credits?.lots.map((lot) => lot.id) ?? [] }));
    } catch { /* Checkout still works without session storage. */ }
  },
  clearCreditCheckout: () => {
    try { sessionStorage.removeItem(CREDIT_CHECKOUT_KEY); } catch { /* Storage can be disabled. */ }
  },

  stopCheckoutPollBurst: () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  },
}));

/**
 * The 402 codes that open the modal. The old count-cap codes stay: the
 * production backend sends them until usage billing ships.
 */
const BILLING_LIMIT_CODES: ReadonlySet<string> = new Set([
  USAGE_EXHAUSTED_ERROR_CODE,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  CREDITS_REQUIRE_PAID_PLAN_ERROR_CODE,
  TASK_LIMIT_ERROR_CODE,
  MERGE_QUEUE_LIMIT_ERROR_CODE,
  WORKFLOW_LIMIT_ERROR_CODE,
  LOOP_LIMIT_ERROR_CODE,
  AUTO_KEEP_DEFAULT_ERROR_CODE,
  REVIEW_CYCLE_LIMIT_ERROR_CODE,
  AUTO_REVIEW_ERROR_CODE,
]);

/**
 * Why the modal opened. The two limit codes are usage caps the modal can
 * describe from the live snapshot ("you're using all 3"); a FEATURE code has no
 * count behind it, so the modal has to be told which feature was asked for or
 * it pitches a limit the user is nowhere near.
 */
export type UpgradeReason =
  | 'compare_plans'
  | 'task_limit'
  | 'merge_queue_limit'
  | 'workflow_limit'
  | 'loop_limit'
  | 'auto_keep_default'
  /**
   * Nothing was refused — something silently did not happen. Auto-keep wanted
   * a fix run for a watched PR and every free-plan slot was busy, so the run
   * was skipped. There is no request behind it, so this reason never arrives
   * through `maybeHandleBillingLimit` (a 402 interceptor); `useDeferredRuns`
   * raises it from the PR list instead.
   *
   * It needs its own copy because the user did not DO anything. Reusing
   * `task_limit` would answer "you're using all 3" to someone who never
   * clicked, which reads as a non-sequitur rather than an explanation.
   */
  | 'task_deferred'
  /**
   * A free plan already has a code review in flight. A usage cap, but unlike
   * `task_limit` it arrives as an EXPLICIT server reason rather than being derived
   * from the snapshot — so it outranks the derived ones in the modal's branch
   * order, or somebody simultaneously at the task limit gets the wrong pitch.
   */
  | 'code_review_limit'
  /**
   * Turning ON automatic review of every new pull request. A FEATURE reason, so it
   * sits with `auto_keep_default` ABOVE every usage branch: the user ticked a
   * checkbox and is nowhere near a count, and quoting one answers a question they
   * did not ask.
   */
  | 'auto_review'
  // Usage billing. Each arrives as an explicit server code with a notice, so
  // each outranks every derived branch in the modal.
  /** The period's box-hours and the credits are spent. */
  | 'usage_exhausted'
  /** The plan cannot start the box size that was asked for. */
  | 'size_requires_pro'
  /** Every box the plan runs at once is in use. */
  | 'concurrent_box_limit'
  /** A Free account tried to buy credits. */
  | 'credits_require_paid_plan'
  /** Nothing was refused: the person asked to upgrade (the gauge, the plan page). */
  | 'upgrade'
  /** Nothing was refused: the person asked to buy credits. */
  | 'add_credits';

function reasonFor(code: string): UpgradeReason {
  if (code === USAGE_EXHAUSTED_ERROR_CODE) return 'usage_exhausted';
  if (code === SIZE_REQUIRES_PRO_ERROR_CODE) return 'size_requires_pro';
  if (code === CONCURRENT_BOX_LIMIT_ERROR_CODE) return 'concurrent_box_limit';
  if (code === CREDITS_REQUIRE_PAID_PLAN_ERROR_CODE) return 'credits_require_paid_plan';
  if (code === MERGE_QUEUE_LIMIT_ERROR_CODE) return 'merge_queue_limit';
  if (code === WORKFLOW_LIMIT_ERROR_CODE) return 'workflow_limit';
  if (code === LOOP_LIMIT_ERROR_CODE) return 'loop_limit';
  if (code === AUTO_KEEP_DEFAULT_ERROR_CODE) return 'auto_keep_default';
  if (code === REVIEW_CYCLE_LIMIT_ERROR_CODE) return 'code_review_limit';
  if (code === AUTO_REVIEW_ERROR_CODE) return 'auto_review';
  return 'task_limit';
}

/**
 * Shared 402 interception: when `err` is a free-plan limit rejection (task
 * concurrency or merge-queue cap), record the paywall impression, open the
 * upgrade modal (and refresh the snapshot so it shows live usage), and return
 * true. Callers keep their generic error handling for everything else.
 *
 * `trigger` is the action the user was taking when they hit the wall
 * (e.g. 'task_create', 'task_retry', 'merge_queue') — the entry point of the
 * monetization funnel, broken out so we can see which surface drives upgrades.
 */
export function maybeHandleBillingLimit(err: unknown, trigger?: string): boolean {
  // The code first: most errors carry none, and a plain Error should not need
  // the ApiError class at all.
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (typeof code !== 'string' || !BILLING_LIMIT_CODES.has(code) || !(err instanceof ApiError)) {
    return false;
  }
  const store = useBillingStore.getState();
  const status = store.status;
  const reason = reasonFor(code);
  const notice = boxRefusalFromError(err);
  trackEvent('paywall_shown', {
    // 'task_limit' | 'merge_queue_limit' | 'workflow_limit' | 'loop_limit' |
    // 'auto_keep_default' — what was refused.
    reason,
    trigger: trigger ?? 'unknown',
    // Live usage at the moment of the wall (the pre-refresh snapshot).
    active_tasks: status?.activeTasks,
    active_task_limit: status?.activeTaskLimit,
    queued_prs: status?.queuedPrs,
    merge_queue_limit: status?.mergeQueueLimit,
    workflows: status?.workflows,
    workflow_limit: status?.workflowLimit,
    loops: status?.loops,
    loop_limit: status?.loopLimit,
    active_reviews: status?.activeReviews,
    active_review_limit: status?.activeReviewLimit,
    plan: status?.plan,
    tier: status?.tier,
    usage_percent: status?.usage?.percent,
  });
  void store.refresh();
  store.setUpgradeModalOpen(true, reason, notice);
  return true;
}
