import {
  PLAN_LIMITS, PLAN_TIER_LABELS, formatBoxHoursUsage, formatUsd, isPlanTier,
  type BillingStatus, type PlanTier, type UsageSummary,
} from '@talyn/shared';

import type { Tone } from '../../components/UI';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface UsageView { tier: PlanTier; usage: UsageSummary; status: BillingStatus }

/**
 * The usage-billing part of the status, or null when billing is off or the
 * backend predates usage billing. Mirrors web `usageBillingOf`: null hides Usage.
 */
export function usageViewOf(status: BillingStatus | null | undefined): UsageView | null {
  if (!status || !status.billingEnabled) return null;
  if (!isPlanTier(status.tier) || !status.usage) return null;
  return { tier: status.tier, usage: status.usage, status };
}

export type GaugeLevel = 'ok' | 'half' | 'high' | 'full';

/** The bar colour follows the alert thresholds: 50, 80 and 100 percent. */
export function gaugeLevel(usage: Pick<UsageSummary, 'percent' | 'exhausted'>): GaugeLevel {
  if (usage.exhausted || usage.percent >= 100) return 'full';
  if (usage.percent >= 80) return 'high';
  if (usage.percent >= 50) return 'half';
  return 'ok';
}
export const GAUGE_TONE: Record<GaugeLevel, Tone> = { ok: 'primary', half: 'warning', high: 'warning', full: 'destructive' };

export function leftPercent(percent: number, exhausted: boolean): number {
  return exhausted ? 0 : Math.min(100, Math.max(0, 100 - percent));
}

export function formatLeftPercent(percent: number, exhausted: boolean): string {
  const left = leftPercent(percent, exhausted);
  if (left > 0 && left < 1) return 'Less than 1% left';
  return `${left.toFixed(left < 10 && left > 0 ? 1 : 0)}% left`;
}

/** "30 Nov". The reset is near, so the year adds nothing. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export interface UsageLines {
  plan: string;
  left: string;
  used: string;
  reset: string;
  exhausted: string | null;
  boxes: string;
  credits: string | null;
  expiring: string | null;
  autoTopup: string | null;
  autoTopupProblem: string | null;
  team: string | null;
}

/** Every line the Usage screen shows, from the billing status. Mirrors web `gaugeSummary` and the plan page. */
export function usageLines(view: UsageView): UsageLines {
  const { status, usage, tier } = view;
  const credits = PLAN_LIMITS[tier].creditsAllowed;
  const balance = status.credits?.balanceMicros ?? 0;
  const expiring = status.credits?.expiringSoonMicros ?? 0;
  const boxes = status.concurrentBoxes;
  const limit = boxes?.limit ?? PLAN_LIMITS[tier].concurrentBoxes;
  const topup = status.autoTopup;
  return {
    plan: PLAN_TIER_LABELS[tier],
    left: formatLeftPercent(usage.percent, usage.exhausted),
    used: `${formatBoxHoursUsage(usage.usedWsec, usage.includedWsec)} used`,
    reset: `Resets ${shortDate(usage.periodEnd)}`,
    exhausted: usage.exhausted ? 'Out of hours: new boxes paused' : null,
    boxes: boxes ? `${boxes.used} of ${limit} running` : `Up to ${limit} at the same time`,
    credits: credits ? formatUsd(balance) : null,
    expiring: credits && expiring > 0 ? `${formatUsd(expiring)} expires in the next 30 days` : null,
    autoTopup: !credits || !topup ? null : topup.enabled ? `On, below ${formatUsd(topup.triggerMicros, 0)}` : 'Off',
    autoTopupProblem: topup?.lastFailure ? `The last top-up failed: ${topup.lastFailure}` : null,
    team: status.team ? status.team.hasSeat ? `Seat on ${status.team.name}` : `Admin of ${status.team.name}` : null,
  };
}
