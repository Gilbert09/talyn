import {
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  PLAN_LIMITS,
  PLAN_TIER_LABELS,
  SANDBOX_SIZES,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_BILLING_ERROR_CODES,
  USAGE_EXHAUSTED_ERROR_CODE,
  formatBoxHoursLabel,
  formatBoxHoursUsage,
  formatCreditBalance,
  isPlanTier,
  sellableTierPrices,
  type BillingStatus,
  type PlanTier,
  type SandboxSize,
  type UsageBillingErrorCode,
  type UsageSummary,
} from '@talyn/shared';
import { ApiError } from './api';

/**
 * Usage billing helpers for the web app.
 *
 * The production backend does not send the usage fields until usage billing
 * ships, so every surface asks {@link usageBillingOf} first and draws the old
 * UI when it answers null.
 */

/** ApiResponse.code when a Free account tries to buy credits. */
export const CREDITS_REQUIRE_PAID_PLAN_ERROR_CODE = 'credits_require_paid_plan';

/**
 * The `notice` a box refusal carries beside its 402 code (and on a workbench
 * wake answer). It mirrors the backend's `BoxGateNotice`; every field but the
 * code and the message is optional because each refusal fills only its own.
 */
export interface BoxRefusalNotice {
  code: UsageBillingErrorCode;
  message: string;
  tier?: PlanTier;
  workspaceId?: string;
  limit?: number;
  active?: number;
  size?: SandboxSize;
  allowedSizes?: SandboxSize[];
  periodEnd?: string;
  creditsAllowed?: boolean;
  retryAt?: string;
}

export interface UsageBillingView {
  tier: PlanTier;
  usage: UsageSummary;
  status: BillingStatus;
}

/** The status's usage-billing part, or null on a backend without usage billing. */
export function usageBillingOf(status: BillingStatus | null | undefined): UsageBillingView | null {
  if (!status || !status.billingEnabled) return null;
  if (!isPlanTier(status.tier) || !status.usage) return null;
  return { tier: status.tier, usage: status.usage, status };
}

export function isUsageBillingCode(code: unknown): code is UsageBillingErrorCode {
  return typeof code === 'string' && (USAGE_BILLING_ERROR_CODES as readonly string[]).includes(code);
}

/** The refusal notice of a usage-billing 402, or null when `err` is something else. */
export function boxRefusalFromError(err: unknown): BoxRefusalNotice | null {
  if (!(err instanceof ApiError) || !isUsageBillingCode(err.code)) return null;
  const raw = err.details?.notice;
  const notice = raw && typeof raw === 'object' ? (raw as Partial<BoxRefusalNotice>) : {};
  return {
    ...notice,
    code: err.code,
    message: typeof notice.message === 'string' && notice.message ? notice.message : err.message,
  };
}

/** A notice from an untyped payload (a wake answer), or null when it is not one. */
export function boxRefusalFromPayload(payload: unknown): BoxRefusalNotice | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { code?: unknown; notice?: unknown };
  const notice = p.notice && typeof p.notice === 'object' ? (p.notice as Partial<BoxRefusalNotice>) : {};
  const code = isUsageBillingCode(p.code) ? p.code : notice.code;
  if (!isUsageBillingCode(code)) return null;
  return { ...notice, code, message: typeof notice.message === 'string' ? notice.message : '' };
}

export type GaugeTone = 'ok' | 'half' | 'high' | 'full';

/** The bar colour follows the alert thresholds: 50, 80 and 100 percent. */
export function gaugeTone(usage: Pick<UsageSummary, 'percent' | 'exhausted'>): GaugeTone {
  if (usage.exhausted || usage.percent >= 100) return 'full';
  if (usage.percent >= 80) return 'high';
  if (usage.percent >= 50) return 'half';
  return 'ok';
}

export function leftPercent(percent: number, exhausted: boolean): number {
  return exhausted ? 0 : Math.min(100, Math.max(0, 100 - percent));
}

export function formatLeftPercent(percent: number, exhausted: boolean): string {
  const left = leftPercent(percent, exhausted);
  if (left > 0 && left < 1) return 'Less than 1% left';
  return `${Number(left.toFixed(left < 10 && left > 0 ? 1 : 0))}% left`;
}

export const GAUGE_BAR_CLASS: Record<GaugeTone, string> = {
  ok: 'bg-primary',
  half: 'bg-amber-400',
  high: 'bg-orange-500',
  full: 'bg-destructive',
};

export const GAUGE_TEXT_CLASS: Record<GaugeTone, string> = {
  ok: 'text-primary',
  half: 'text-amber-500',
  high: 'text-orange-500',
  full: 'text-destructive',
};

export type GaugeAction = 'upgrade' | 'add_credits';

/** "Add credits" shows only when less than this share of the period's hours is left. */
export const ADD_CREDITS_BELOW_LEFT_PCT = 5;

/**
 * The card's button, or null for none. Free cannot buy credits, so it always
 * gets "Upgrade". A paid plan gets "Add credits" only when less than
 * ADD_CREDITS_BELOW_LEFT_PCT of its hours is left, or none is. Otherwise Pro
 * and Max get no button and Legacy Pro gets "Upgrade".
 */
export function gaugeAction(view: UsageBillingView): GaugeAction | null {
  const creditsAllowed = PLAN_LIMITS[view.tier].creditsAllowed;
  if (!creditsAllowed) return 'upgrade';
  const { includedWsec, usedWsec, exhausted } = view.usage;
  const low = exhausted || 100 * (includedWsec - usedWsec) < ADD_CREDITS_BELOW_LEFT_PCT * includedWsec;
  if (low) return 'add_credits';
  return view.tier === 'legacy_pro' ? 'upgrade' : null;
}

export function gaugeActionLabel(action: GaugeAction): string {
  return action === 'upgrade' ? 'Upgrade' : 'Add credits';
}

/** "Nov 30". The reset is near, so the year adds nothing. */
export function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "November 30, 2026". */
export function formatLongDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** The lines the gauge and its collapsed tooltip show. */
export function gaugeSummary(view: UsageBillingView): {
  tierLabel: string;
  leftText: string;
  usageText: string;
  resetText: string;
  creditsText: string | null;
  exhaustedText: string | null;
} {
  const balance = view.status.credits?.balanceMicros ?? 0;
  return {
    tierLabel: PLAN_TIER_LABELS[view.tier],
    leftText: formatLeftPercent(view.usage.percent, view.usage.exhausted),
    usageText: `${formatLeftPercent(view.usage.percent, view.usage.exhausted)} (${formatBoxHoursUsage(view.usage.usedWsec, view.usage.includedWsec)} used)`,
    resetText: `Resets ${formatShortDate(view.usage.periodEnd)}`,
    creditsText: balance > 0 ? `${formatCreditBalance(balance)} credits` : null,
    exhaustedText: view.usage.exhausted ? 'Out of hours: new boxes paused' : null,
  };
}

function sizeName(size: SandboxSize): string {
  return SANDBOX_SIZES[size]?.label.split(' · ')[0] ?? size;
}

/**
 * A sentence for a refusal. The backend's own message wins; this is the
 * fallback for a notice that arrived without one.
 */
export function refusalSentence(notice: BoxRefusalNotice): string {
  if (notice.message) return notice.message;
  switch (notice.code) {
    case USAGE_EXHAUSTED_ERROR_CODE:
      return notice.creditsAllowed
        ? 'You have used your included box-hours and your credits. Add credits to start new boxes.'
        : `You have used all your box-hours for this period.${
            notice.periodEnd ? ` They reset on ${formatLongDate(notice.periodEnd)}.` : ''
          }`;
    case CONCURRENT_BOX_LIMIT_ERROR_CODE:
      return `Your plan runs ${notice.limit ?? 'a limited number of'} boxes at the same time. A new box can start when one stops.`;
    case SIZE_REQUIRES_PRO_ERROR_CODE:
      return `${notice.size ? `${sizeName(notice.size)} boxes need` : 'This box size needs'} the Pro plan.`;
  }
}

/** The title of a refusal, short enough for a notice heading. */
export function refusalTitle(code: UsageBillingErrorCode): string {
  switch (code) {
    case USAGE_EXHAUSTED_ERROR_CODE:
      return 'Out of box-hours';
    case CONCURRENT_BOX_LIMIT_ERROR_CODE:
      return 'All your boxes are busy';
    case SIZE_REQUIRES_PRO_ERROR_CODE:
      return 'This size needs Pro';
  }
}

/** The plan copy both the modal and the plan page repeat. */
export const PRO_INCLUDED_TEXT = formatBoxHoursLabel(PLAN_LIMITS.pro.includedBoxHours * 3600);
export const FREE_INCLUDED_TEXT = formatBoxHoursLabel(PLAN_LIMITS.free.includedBoxHours * 3600);
export const LEGACY_INCLUDED_TEXT = formatBoxHoursLabel(PLAN_LIMITS.legacy_pro.includedBoxHours * 3600);
/** "1,000 box-hours", with a thousands separator. */
export const MAX_INCLUDED_TEXT = `${PLAN_LIMITS.max.includedBoxHours.toLocaleString('en-US')} box-hours`;

/**
 * Max's prices, or null when this account may not buy Max. The backend sends
 * them only when Max is on offer (or already held), so null means "never show Max".
 */
export function maxPricesOf(
  status: Pick<BillingStatus, 'pricing'> | null | undefined
): { monthlyMicros: number; annualMicros: number | null } | null {
  return status?.pricing ? sellableTierPrices('max', status.pricing) : null;
}

/**
 * True for a Pro annual subscriber who may buy Max. Max is monthly only, so
 * that move is annual to monthly: the backend refuses it in place and the
 * billing portal does it instead.
 */
export function maxNeedsPortal(
  status: Pick<BillingStatus, 'tier' | 'planSource' | 'period' | 'pricing'> | null | undefined
): boolean {
  return (
    status?.tier === 'pro' &&
    status.planSource === 'subscription' &&
    status.period === 'annual' &&
    maxPricesOf(status) != null
  );
}

/**
 * Leave the app for a hosted Polar page (checkout or portal).
 *
 * A full-page navigation, not `window.open`: the URL is fetched first, and
 * the `await` spends the click's user activation, so a new tab would be
 * popup-blocked. Polar sends the browser back to `/settings/billing`.
 */
export function goToHostedPage(url: string): void {
  window.location.assign(url);
}

export type DeferredReason = 'usage_exhausted' | 'box_limit_reached' | 'size_requires_pro';

const DEFERRAL_CODES: Record<DeferredReason, UsageBillingErrorCode> = {
  usage_exhausted: USAGE_EXHAUSTED_ERROR_CODE,
  box_limit_reached: CONCURRENT_BOX_LIMIT_ERROR_CODE,
  size_requires_pro: SIZE_REQUIRES_PRO_ERROR_CODE,
};

/**
 * An auto-keep deferral as a refusal notice, or null when the row carries no
 * reason (a backend older than usage billing: the caller keeps its old copy).
 */
export function deferralNotice(state: {
  deferredReason?: DeferredReason | null;
  deferredMessage?: string | null;
  deferredRetryAt?: string | null;
} | null | undefined): BoxRefusalNotice | null {
  const reason = state?.deferredReason;
  if (!reason || !(reason in DEFERRAL_CODES)) return null;
  return {
    code: DEFERRAL_CODES[reason],
    message: state?.deferredMessage ?? '',
    ...(state?.deferredRetryAt ? { retryAt: state.deferredRetryAt } : {}),
  };
}

/** The modal reason for a refusal code. */
export function upgradeReasonForCode(code: UsageBillingErrorCode): 'usage_exhausted' | 'concurrent_box_limit' | 'size_requires_pro' {
  if (code === USAGE_EXHAUSTED_ERROR_CODE) return 'usage_exhausted';
  if (code === CONCURRENT_BOX_LIMIT_ERROR_CODE) return 'concurrent_box_limit';
  return 'size_requires_pro';
}

/** "Waiting for box-hours or credits", with the retry time when there is one. */
export function deferralTitle(notice: BoxRefusalNotice): string {
  const base = refusalSentence(notice) || refusalTitle(notice.code);
  if (!notice.retryAt) return base;
  const at = new Date(notice.retryAt);
  if (Number.isNaN(at.getTime())) return base;
  return `${base} Talyn looks again at ${at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
}
