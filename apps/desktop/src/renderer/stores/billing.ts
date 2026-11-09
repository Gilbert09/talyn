import { create } from 'zustand';
import {
  AUTO_KEEP_DEFAULT_ERROR_CODE,
  CREDIT_PACKS,
  CREDIT_PACK_IDS,
  AUTO_REVIEW_ERROR_CODE,
  MERGE_QUEUE_LIMIT_ERROR_CODE,
  REVIEW_CYCLE_LIMIT_ERROR_CODE,
  TASK_LIMIT_ERROR_CODE,
  WORKFLOW_LIMIT_ERROR_CODE,
  LOOP_LIMIT_ERROR_CODE,
  USAGE_BILLING_ERROR_CODES,
  PLAN_TIER_LABELS,
  formatBoxHoursUsage,
  formatUsd,
  type BillingStatus,
  type UsageAlertEvent,
  type UsageExhaustedEvent,
} from '@talyn/shared';
import { api, type ApiError } from '../lib/api';
import { captureAnalyticsException, trackEvent } from '../lib/analytics';
import {
  CREDITS_REQUIRE_PAID_PLAN_CODE,
  claimUsageAlert,
  formatShortDate,
  hasUsageBilling,
  noticeFromDetails,
  usageAlertKey,
  usageReasonForCode,
  type BoxNotice,
  type UsageUpgradeReason,
} from '../lib/usageBilling';
import { toast } from './toast';
import { useWorkspaceStore } from './workspace';

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

/** What a checkout poll burst waits for: a plan change, or credits landing. */
export type CheckoutKind = 'plan' | 'credits';

/** A session's box that the plan would not wake, from `POST /workbenches/:id/wake`. */
export interface SessionRefusal {
  status: 'exhausted' | 'box_limit';
  notice: BoxNotice | null;
}

interface BillingState {
  status: BillingStatus | null;
  upgradeModalOpen: boolean;
  /** What the user was refused, so the modal can pitch that thing. */
  upgradeReason: UpgradeReason | null;
  /** The refusal's own notice (402 body or a deferral), when there is one. */
  upgradeNotice: BoxNotice | null;
  /** Sessions whose box the plan would not wake, by workbench id. */
  sessionRefusals: Record<string, SessionRefusal>;
  setStatus: (status: BillingStatus) => void;
  setUpgradeModalOpen: (open: boolean, reason?: UpgradeReason | null, notice?: BoxNotice | null) => void;
  setSessionRefusal: (workbenchId: string, refusal: SessionRefusal | null) => void;
  /** Re-fetch the snapshot from the backend. Safe to call repeatedly. */
  refresh: () => Promise<void>;
  /** Start (or restart) the post-checkout poll burst. */
  startCheckoutPollBurst: (kind?: CheckoutKind) => void;
  markPlanChangeStarted: (period: 'monthly' | 'annual') => void;
  clearPlanChange: () => void;
  stopCheckoutPollBurst: () => void;
  /** `billing:usage_alert`: refresh, and say so once per threshold per period. */
  handleUsageAlert: (event: UsageAlertEvent) => void;
  /** `billing:exhausted`: refresh, and say so once per period. */
  handleExhausted: (event: UsageExhaustedEvent) => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollDeadline = 0;
/** What the running burst compares against to know its checkout landed. */
let burstBaseline: { kind: CheckoutKind; plan: string | null; balanceMicros: number } | null = null;
let pendingPlanChange: { from: string; period: 'monthly' | 'annual' } | null = null;
let returnFailureReported = false;

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
  sessionRefusals: {},

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
    if (prev) {
      const priorLots = new Set(prev.credits?.lots.map((lot) => lot.id) ?? []);
      for (const lot of prev.credits ? (status.credits?.lots ?? []) : []) {
        if (priorLots.has(lot.id) || (lot.source !== 'purchase' && lot.source !== 'auto_topup')) continue;
        const pack = CREDIT_PACK_IDS.find((id) => CREDIT_PACKS[id].creditMicros === lot.totalMicros);
        if (pack) trackEvent('credit_purchase_completed', { pack, amount_micros: CREDIT_PACKS[pack].priceMicros, source: lot.source === 'auto_topup' ? 'auto_topup' : 'manual' });
      }
      const from = prev.tier ?? prev.plan;
      const to = status.tier ?? status.plan;
      if (pendingPlanChange && from === pendingPlanChange.from && to !== from) {
        trackEvent('plan_changed', { from, to, period: pendingPlanChange.period });
        pendingPlanChange = null;
      }
    }
    // Box-hours came back (a reset, credits, an upgrade): a session refused
    // on wake may start again, so its notice must not linger.
    if (hasUsageBilling(status) && !status.usage.exhausted && Object.keys(get().sessionRefusals).length > 0) {
      const kept = Object.fromEntries(
        Object.entries(get().sessionRefusals).filter(([, r]) => r.status === 'box_limit'),
      );
      set({ sessionRefusals: kept });
    }
    if (!status.billingEnabled) {
      get().stopCheckoutPollBurst();
      return;
    }
    if (!pollTimer) return;
    const landed = checkoutLanded(burstBaseline, status);
    if (landed) {
      announceCheckout(landed, status);
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

  setSessionRefusal: (workbenchId, refusal) => {
    const current = get().sessionRefusals;
    if (!refusal && !(workbenchId in current)) return;
    const next = { ...current };
    if (refusal) next[workbenchId] = refusal;
    else delete next[workbenchId];
    set({ sessionRefusals: next });
  },

  refresh: async () => {
    try {
      get().setStatus(await api.billing.status());
    } catch (err) {
      if (pollTimer && !returnFailureReported) {
        trackBillingFailure(pendingPlanChange ? 'plan_change_failed' : burstBaseline?.kind === 'credits' ? 'credit_checkout_failed' : 'checkout_failed', 'return', err);
        returnFailureReported = true;
      }
      // Transient (offline / backend restart) — keep the last snapshot; the
      // next focus/WS/poll tick retries. Enforcement is server-side anyway.
    }
  },

  startCheckoutPollBurst: (kind = 'plan') => {
    returnFailureReported = false;
    pollDeadline = Date.now() + POLL_BURST_MAX_MS;
    const current = get().status;
    burstBaseline = {
      kind,
      plan: current ? (current.tier ?? current.plan) : null,
      balanceMicros: current?.credits?.balanceMicros ?? 0,
    };
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
    const current = get().status;
    pendingPlanChange = current ? { from: current.tier ?? current.plan, period } : null;
  },
  clearPlanChange: () => { pendingPlanChange = null; },

  stopCheckoutPollBurst: () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    burstBaseline = null;
  },

  handleUsageAlert: (event) => {
    void get().refresh();
    if (!claimUsageAlert(usageAlertKey(event.periodEnd, event.thresholdPct))) return;
    const usage = formatBoxHoursUsage(event.usedWsec, event.includedWsec);
    const reset = formatShortDate(event.periodEnd);
    trackEvent('usage_alert_shown', { threshold: event.thresholdPct, tier: event.tier });
    if (event.thresholdPct >= 100) {
      const paid = event.tier !== 'free';
      toast.info(
        'You have used your included box-hours',
        paid
          ? `${usage}. Boxes now use your credits until ${reset}.`
          : `${usage}. New boxes start again on ${reset}.`,
        alertAction(event.tier, true),
      );
      return;
    }
    toast.info(
      `${event.thresholdPct}% of your box-hours used`,
      `${usage} this period. Included hours reset on ${reset}.`,
      alertAction(event.tier, event.thresholdPct >= 80),
    );
  },

  handleExhausted: (event) => {
    void get().refresh();
    if (!claimUsageAlert(usageAlertKey(event.periodEnd, 'exhausted'))) return;
    trackEvent('usage_exhausted_shown', { tier: event.tier });
    const reset = formatShortDate(event.periodEnd);
    toast.info(
      'Out of hours: new boxes paused',
      event.creditsAllowed
        ? `Running turns finish. Add credits or turn on auto top-up to start new boxes. Included hours reset on ${reset}.`
        : `Running turns finish. New boxes start again on ${reset}, or upgrade to Pro for more hours.`,
      alertAction(event.tier, true),
    );
  },
}));

/** What landed while a burst ran, or null while the checkout is still pending. */
function checkoutLanded(
  baseline: typeof burstBaseline,
  status: BillingStatus,
): CheckoutKind | null {
  if (!baseline) return status.plan !== 'free' ? 'plan' : null;
  if (baseline.kind === 'credits') {
    return (status.credits?.balanceMicros ?? 0) > baseline.balanceMicros ? 'credits' : null;
  }
  const now = status.tier ?? status.plan;
  if (baseline.plan === null) return status.plan !== 'free' ? 'plan' : null;
  return now !== baseline.plan ? 'plan' : null;
}

/** The success notice for a checkout that landed in this session. */
function announceCheckout(kind: CheckoutKind, status: BillingStatus): void {
  if (!hasUsageBilling(status)) return; // the old modal shows its own success state
  if (kind === 'credits') {
    toast.success('Credits added', `Your balance is ${formatUsd(status.credits?.balanceMicros ?? 0)}.`);
    return;
  }
  toast.success(`You are on ${PLAN_TIER_LABELS[status.tier]}`, 'Your new box-hours are ready to use.');
}

/** The toast button for an alert: credits for a paid tier, else the upgrade. */
function alertAction(tier: UsageAlertEvent['tier'], urgent: boolean) {
  if (tier === 'free') {
    return {
      label: 'Upgrade',
      onClick: () => useBillingStore.getState().setUpgradeModalOpen(true, 'usage_alert'),
    };
  }
  if (tier === 'legacy_pro' && !urgent) {
    return {
      label: 'Move to Pro',
      onClick: () => useBillingStore.getState().setUpgradeModalOpen(true, 'usage_alert'),
    };
  }
  return { label: 'Add credits', onClick: () => useWorkspaceStore.getState().openSettings('billing') };
}

/** The 402 codes the plan can reject with: the old count caps and the usage-billing box gate. */
const BILLING_LIMIT_CODES: ReadonlySet<string> = new Set([
  ...USAGE_BILLING_ERROR_CODES,
  CREDITS_REQUIRE_PAID_PLAN_CODE,
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
  /**
   * Usage billing. A box refusal (`usage_exhausted`, `size_requires_pro`,
   * `concurrent_box_limit`), credits on a plan that cannot hold them, or the
   * action button on a usage alert. The modal reads the tier and the notice.
   */
  | UsageUpgradeReason
  | 'usage_alert'
  /** Nothing was refused: a Pro subscriber asked for Max from the plan page. */
  | 'upgrade';

function reasonFor(code: string): UpgradeReason {
  const usage = usageReasonForCode(code);
  if (usage) return usage;
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
  if (!isApiError(err) || !err.code || !BILLING_LIMIT_CODES.has(err.code)) {
    return false;
  }
  const store = useBillingStore.getState();
  const status = store.status;
  const reason = reasonFor(err.code);
  const notice = noticeFromDetails(err.details);
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
  store.setUpgradeModalOpen(true, reason, notice ?? (err.message ? { code: err.code, message: err.message } : null));
  return true;
}

/**
 * By name, not `instanceof`: `@talyn/client` ships CommonJS and ESM builds,
 * and a 402 thrown by one copy must still be read by code holding the other.
 */
function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && err.name === 'ApiError';
}
