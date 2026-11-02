import {
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  PLAN_PRICES,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_EXHAUSTED_ERROR_CODE,
  type BillingPricing,
  type BillingStatus,
  type PlanTier,
  type SandboxSize,
  type UsageAlertThreshold,
  type UsageSummary,
} from '@talyn/shared';

/**
 * Pure helpers for the usage-billing UI. Nothing here talks to the backend, so
 * the gauge, the plan page and the upgrade modal can share one answer to
 * "which state is this", and the tests can pin it.
 *
 * Every surface keys off {@link hasUsageBilling}. The production backend does
 * not send `tier` or `usage` until usage billing ships, and a branch build talks
 * to it, so their absence means "draw the old view".
 */

/** A billing status from a backend that runs usage billing. */
export type UsageBillingStatus = BillingStatus & { tier: PlanTier; usage: UsageSummary };

export function hasUsageBilling(status: BillingStatus | null | undefined): status is UsageBillingStatus {
  return Boolean(status && status.billingEnabled && status.tier && status.usage);
}

/** 402 code when a plan that cannot hold credits asks for credits or auto top-up. */
export const CREDITS_REQUIRE_PAID_PLAN_CODE = 'credits_require_paid_plan';

/**
 * What a box refusal carries next to its 402 code (`notice` on the error
 * envelope), and what a session wake answers with. Mirrors the backend's
 * `BoxGateNotice`; every field is optional because a client must cope with a
 * body that has none of them.
 */
export interface BoxNotice {
  code?: string;
  message?: string;
  tier?: PlanTier;
  limit?: number;
  active?: number;
  size?: SandboxSize;
  allowedSizes?: SandboxSize[];
  periodEnd?: string;
  creditsAllowed?: boolean;
  retryAt?: string;
}

/** The notice on an error envelope (`ApiError.details.notice`), or null. */
export function noticeFromDetails(details: Record<string, unknown> | undefined): BoxNotice | null {
  const raw = details?.notice;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as BoxNotice;
}

/** Bar colour band: under 50%, 50-79%, 80-99%, and out (100% or exhausted). */
export type GaugeTone = 'ok' | 'notice' | 'warning' | 'danger';

export function gaugeTone(usage: Pick<UsageSummary, 'percent' | 'exhausted'>): GaugeTone {
  if (usage.exhausted || usage.percent >= 100) return 'danger';
  if (usage.percent >= 80) return 'warning';
  if (usage.percent >= 50) return 'notice';
  return 'ok';
}

export const GAUGE_BAR_CLASS: Record<GaugeTone, string> = {
  ok: 'bg-primary',
  notice: 'bg-amber-500',
  warning: 'bg-orange-500',
  danger: 'bg-destructive',
};

export const GAUGE_TEXT_CLASS: Record<GaugeTone, string> = {
  ok: 'text-primary',
  notice: 'text-amber-600 dark:text-amber-400',
  warning: 'text-orange-600 dark:text-orange-400',
  danger: 'text-destructive',
};

/** The gauge's one action. */
export type GaugeAction = 'upgrade' | 'add_credits';

/**
 * "Upgrade" for Free and Legacy Pro, "Add credits" for Pro or for anyone at
 * 80% or more who can hold credits. Free cannot buy credits, so it always
 * gets "Upgrade".
 */
export function gaugeAction(status: UsageBillingStatus): GaugeAction {
  if (status.tier === 'free') return 'upgrade';
  if (status.tier === 'pro') return 'add_credits';
  return status.usage.percent >= 80 || status.usage.exhausted ? 'add_credits' : 'upgrade';
}

export const GAUGE_ACTION_LABELS: Record<GaugeAction, string> = {
  upgrade: 'Upgrade',
  add_credits: 'Add credits',
};

/** List prices from the status, or the shared constants when the status has none. */
export function pricingOf(status: BillingStatus | null | undefined): BillingPricing {
  return (
    status?.pricing ?? {
      proMonthlyMicros: PLAN_PRICES.pro.monthlyMicros,
      proAnnualMicros: PLAN_PRICES.pro.annualMicros ?? 0,
      legacyProMonthlyMicros: PLAN_PRICES.legacy_pro.monthlyMicros,
      boxHourMicros: 220_000,
    }
  );
}

/** "12 Nov", or "12 Nov 2027" when the year is not this one. */
export function formatShortDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Which UpgradeModal reason a 402 code maps to, for the usage-billing codes. */
export type UsageUpgradeReason = 'usage_exhausted' | 'size_requires_pro' | 'concurrent_box_limit' | 'credits_require_paid_plan';

export function usageReasonForCode(code: string): UsageUpgradeReason | null {
  switch (code) {
    case USAGE_EXHAUSTED_ERROR_CODE:
      return 'usage_exhausted';
    case SIZE_REQUIRES_PRO_ERROR_CODE:
      return 'size_requires_pro';
    case CONCURRENT_BOX_LIMIT_ERROR_CODE:
      return 'concurrent_box_limit';
    case CREDITS_REQUIRE_PAID_PLAN_CODE:
      return 'credits_require_paid_plan';
    default:
      return null;
  }
}

/** The 402 code for an auto-keep `deferredReason`, so the modal can treat both alike. */
export function codeForDeferredReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'usage_exhausted':
      return USAGE_EXHAUSTED_ERROR_CODE;
    case 'box_limit_reached':
      return CONCURRENT_BOX_LIMIT_ERROR_CODE;
    case 'size_requires_pro':
      return SIZE_REQUIRES_PRO_ERROR_CODE;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Alerts: once per threshold per period, remembered across launches.
// ---------------------------------------------------------------------------

const ALERT_KEY_PREFIX = 'talyn-usage-alert';

export function usageAlertKey(periodEnd: string, threshold: UsageAlertThreshold | 'exhausted'): string {
  return `${ALERT_KEY_PREFIX}:${periodEnd}:${threshold}`;
}

const shownThisLaunch = new Set<string>();

/**
 * True the first time a key is claimed. Remembered in localStorage so a
 * relaunch does not repeat an alert, and in memory so a private window
 * (where storage throws) still says it once a launch.
 */
export function claimUsageAlert(key: string): boolean {
  if (shownThisLaunch.has(key)) return false;
  shownThisLaunch.add(key);
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, '1');
  } catch {
    // Storage unavailable: the in-memory guard above still holds.
  }
  return true;
}

/** Test seam. */
export function _resetUsageAlertGuard(): void {
  shownThisLaunch.clear();
}
