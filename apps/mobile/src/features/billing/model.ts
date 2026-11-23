import {
  CREDIT_PACKS, CREDIT_PACK_IDS, INVALID_RETURN_TO_CODE, MICROS_PER_DOLLAR, PLAN_LIMITS, PLAN_PRICES, PLAN_TIER_LABELS, SANDBOX_SIZES,
  BILLING_PERIOD_LABELS, formatBoxHoursLabel, formatPlanPeriodLine, formatUsd, isSellableTier, sellableTierPrices,
  tierSoldAnnually, validateAutoTopupConfig,
  type AutoTopupConfig, type BillingPricing, type BillingStatus, type CreditPackId, type PlanTier, type SellableTier, type UsageResetOffer,
} from '@talyn/shared';

import type { PurchaseMode } from '../../config';
import type { UsageView } from '../usage/model';

export type Period = 'monthly' | 'annual';

/** "200 box-hours". The same plan copy web repeats. */
export const PRO_INCLUDED_TEXT = formatBoxHoursLabel(PLAN_LIMITS.pro.includedBoxHours * 3600);
export const FREE_INCLUDED_TEXT = formatBoxHoursLabel(PLAN_LIMITS.free.includedBoxHours * 3600);
export const LEGACY_INCLUDED_TEXT = formatBoxHoursLabel(PLAN_LIMITS.legacy_pro.includedBoxHours * 3600);
export const MAX_INCLUDED_TEXT = `${PLAN_LIMITS.max.includedBoxHours.toLocaleString('en-US')} box-hours`;

const PRO_PITCH = `Pro includes ${PRO_INCLUDED_TEXT} a month, every box size, `
  + `up to ${PLAN_LIMITS.pro.concurrentBoxes} boxes at once, and credits when you need more.`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "30 November 2026". */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

function pricingOf(pricing: BillingPricing | undefined): BillingPricing {
  return {
    proMonthlyMicros: PLAN_PRICES.pro.monthlyMicros,
    proAnnualMicros: PLAN_PRICES.pro.annualMicros ?? 0,
    legacyProMonthlyMicros: PLAN_PRICES.legacy_pro.monthlyMicros,
    boxHourMicros: 0,
    ...pricing,
  };
}

/** Max's prices, or null when this account may not buy Max. Mirrors web `maxPricesOf`. */
export function maxPricesOf(status: Pick<BillingStatus, 'pricing'> | null | undefined) {
  return status?.pricing ? sellableTierPrices('max', status.pricing) : null;
}

/** A sellable plan's list prices, or null for Max when it is not on offer. Max has no annual price. */
export function planPrices(plan: SellableTier, pricing: BillingPricing | undefined): { monthly: string; annual: string | null } | null {
  if (plan === 'pro') {
    const full = pricingOf(pricing);
    return { monthly: formatUsd(full.proMonthlyMicros, 0), annual: formatUsd(full.proAnnualMicros, 0) };
  }
  const max = maxPricesOf({ pricing });
  return max ? { monthly: formatUsd(max.monthlyMicros, 0), annual: null } : null;
}

/** A Pro annual subscriber who may buy Max: that move goes through the billing portal. */
export function maxNeedsPortal(status: Pick<BillingStatus, 'tier' | 'planSource' | 'period' | 'pricing'> | null | undefined): boolean {
  return status?.tier === 'pro' && status.planSource === 'subscription' && status.period === 'annual' && maxPricesOf(status) != null;
}

/** A monthly Pro subscriber paying for themselves. Mirrors web `canSwitchToAnnual`. */
export function canSwitchToAnnual(status: BillingStatus): boolean {
  return isSellableTier(status.tier) && tierSoldAnnually(status.tier) && status.planSource === 'subscription'
    && status.period === 'monthly' && !status.cancelAtPeriodEnd && status.subscriptionStatus !== 'past_due';
}

/** What a monthly Pro subscriber saves a year on annual billing, as "$80". */
export function annualSaving(status: BillingStatus): string | null {
  if (!isSellableTier(status.tier)) return null;
  const prices = sellableTierPrices(status.tier, pricingOf(status.pricing));
  if (prices?.annualMicros == null) return null;
  return formatUsd(Math.max(0, prices.monthlyMicros * 12 - prices.annualMicros), 0);
}

// ---------------------------------------------------------------------------
// Plan summary
// ---------------------------------------------------------------------------

export interface PlanSummary {
  label: string;
  /** "Pro · Monthly · $40/month", or what the plan includes. */
  detail: string;
  state: string;
  stateTone: 'muted' | 'destructive' | 'warning';
  renews: string | null;
  notes: string[];
  pastDue: boolean;
}

/** The plan card's lines. Mirrors web `PlanAndUsage`. */
export function planSummary(view: UsageView): PlanSummary {
  const { status, tier } = view;
  const limits = PLAN_LIMITS[tier];
  const comped = status.planSource === 'override';
  const teamPaid = status.planSource === 'team';
  const subscribed = status.planSource === 'subscription';
  const pastDue = status.subscriptionStatus === 'past_due';
  const includes = tier === 'free'
    ? `${FREE_INCLUDED_TEXT} a month, small and standard boxes, ${limits.concurrentBoxes} at once.`
    : tier === 'legacy_pro'
      ? `${LEGACY_INCLUDED_TEXT} a month, every size, up to ${limits.concurrentBoxes} at once.`
      : `${tier === 'max' ? MAX_INCLUDED_TEXT : PRO_INCLUDED_TEXT} a month, every size, up to ${limits.concurrentBoxes} at once.`;
  const period = tier !== 'free' && !comped && !teamPaid ? formatPlanPeriodLine(tier, status.period, pricingOf(status.pricing)) : null;
  const notes: string[] = [];
  if (tier === 'max' && subscribed) notes.push('To move to Pro, use Manage subscription. The change starts at your next renewal.');
  if (maxNeedsPortal(status)) notes.push('Max is monthly only. To move from annual Pro to Max, use Manage subscription.');
  if (comped) notes.push('Complimentary plan. Nothing to pay.');
  if (teamPaid && status.team) notes.push(`Paid for by your team, ${status.team.name}.`);
  const ends = status.currentPeriodEnd ? longDate(status.currentPeriodEnd) : '';
  return {
    label: PLAN_TIER_LABELS[tier],
    detail: period ? `${period}. ${includes}` : includes,
    state: pastDue ? 'Payment failed' : status.cancelAtPeriodEnd ? `Cancels${ends ? ` on ${ends}` : ' at the end of this period'}` : 'Active',
    stateTone: pastDue ? 'destructive' : status.cancelAtPeriodEnd ? 'warning' : 'muted',
    renews: subscribed && ends && !status.cancelAtPeriodEnd ? `Renews ${ends}` : null,
    notes,
    pastDue,
  };
}

// ---------------------------------------------------------------------------
// Plan cards and their actions
// ---------------------------------------------------------------------------

export type CardTier = PlanTier;

export type PlanAction =
  | { kind: 'checkout'; plan: SellableTier; period: Period; label: string }
  | { kind: 'change'; plan: SellableTier; period: Period; label: string; confirm?: string }
  | { kind: 'portal'; label: string };

export interface PlanCard {
  tier: CardTier;
  label: string;
  price: string;
  priceDetail: string | null;
  features: string[];
  current: boolean;
  /** "Your plan · Monthly". */
  badge: string | null;
  action: PlanAction | null;
  note: string | null;
}

/** The cards to compare: Free, Pro and Max, with Legacy Pro for the people who hold it. Max only when it is offered. */
export function cardTiers(view: Pick<UsageView, 'tier' | 'status'>): CardTier[] {
  const tiers: CardTier[] = ['free'];
  if (view.tier === 'legacy_pro') tiers.push('legacy_pro');
  tiers.push('pro');
  if (maxPricesOf(view.status) || view.tier === 'max') tiers.push('max');
  return tiers;
}

function cardPrice(tier: CardTier, period: Period, pricing: BillingPricing | undefined): { price: string; detail: string | null } {
  const full = pricingOf(pricing);
  if (tier === 'free') return { price: '$0', detail: null };
  if (tier === 'legacy_pro') return { price: `${formatUsd(full.legacyProMonthlyMicros, 0)}/mo`, detail: 'No longer sold' };
  if (tier === 'max') {
    const monthly = full.maxMonthlyMicros ?? PLAN_PRICES.max.monthlyMicros;
    return { price: `${formatUsd(monthly, 0)}/mo`, detail: period === 'annual' ? 'Monthly only' : null };
  }
  if (period === 'annual') {
    const saving = formatUsd(Math.max(0, full.proMonthlyMicros * 12 - full.proAnnualMicros), 0);
    return { price: `${formatUsd(full.proAnnualMicros, 0)}/yr`, detail: `Save ${saving} a year` };
  }
  return { price: `${formatUsd(full.proMonthlyMicros, 0)}/mo`, detail: null };
}

function cardFeatures(tier: CardTier): string[] {
  const limits = PLAN_LIMITS[tier];
  return [
    `${tier === 'max' ? MAX_INCLUDED_TEXT : formatBoxHoursLabel(limits.includedBoxHours * 3600)} a month`,
    `${limits.concurrentBoxes} boxes at the same time`,
    limits.sizes.length === Object.keys(SANDBOX_SIZES).length ? 'Every box size' : 'Small and standard boxes',
    limits.creditsAllowed ? 'Credits and auto top-up' : 'No credits',
  ];
}

/**
 * The button a card shows, or null. Free buys through checkout, a paid
 * subscription moves up with a plan change, and every move down goes through
 * the billing portal. `none` sells nothing. Mirrors the web compare-plans grid.
 */
export function planAction(view: Pick<UsageView, 'tier' | 'status'>, card: CardTier, period: Period, mode: PurchaseMode): PlanAction | null {
  if (mode === 'none') return null;
  const { tier, status } = view;
  const subscribed = status.planSource === 'subscription';
  if (status.planSource === 'team' || status.planSource === 'override') return null;
  if (card === tier) {
    if (period !== 'annual' || !canSwitchToAnnual(status) || !isSellableTier(tier)) return null;
    const saving = annualSaving(status);
    return { kind: 'change', plan: tier, period: 'annual', label: saving ? `Switch to annual · save ${saving} a year` : 'Switch to annual',
      confirm: annualConfirmText(status) };
  }
  if (card === 'free' || card === 'legacy_pro') return card === 'free' && subscribed ? { kind: 'portal', label: 'Manage subscription' } : null;
  const prices = planPrices(card, status.pricing);
  if (!prices) return null;
  const chosen: Period = card === 'max' ? 'monthly' : period;
  const price = chosen === 'annual' && prices.annual ? `${prices.annual}/yr` : `${prices.monthly}/mo`;
  if (tier === 'free') return { kind: 'checkout', plan: card, period: chosen, label: `Upgrade to ${PLAN_TIER_LABELS[card]}: ${price}` };
  if (!subscribed) return null;
  if (card === 'pro') {
    if (tier === 'legacy_pro') return { kind: 'change', plan: 'pro', period: chosen, label: `Move to Pro: ${price}` };
    if (tier === 'max') return { kind: 'portal', label: 'Manage subscription' };
    return null;
  }
  // Max, from Pro or Legacy Pro.
  if (maxNeedsPortal(status)) return { kind: 'portal', label: 'Manage subscription' };
  return { kind: 'change', plan: 'max', period: 'monthly', label: `Upgrade to Max: ${price}` };
}

function cardNote(view: Pick<UsageView, 'tier' | 'status'>, card: CardTier, mode: PurchaseMode): string | null {
  const { tier, status } = view;
  if (card === tier) return null;
  if (mode === 'none') return null;
  if (status.planSource === 'team' && card !== 'free') return 'Your team pays for your plan.';
  if (status.planSource !== 'subscription') return null;
  if (card === 'free') return 'To move to Free, cancel in Manage subscription.';
  if (card === 'pro' && tier === 'max') return 'The change starts at your next renewal.';
  if (card === 'max' && maxNeedsPortal(status)) return 'Max is monthly only. To move from annual Pro to Max, use Manage subscription.';
  return null;
}

/** The plan cards for the status, the chosen billing period and the purchase mode. */
export function planCards(view: Pick<UsageView, 'tier' | 'status'>, period: Period, mode: PurchaseMode): PlanCard[] {
  return cardTiers(view).map((tier) => {
    const { price, detail } = cardPrice(tier, period, view.status.pricing);
    const current = tier === view.tier;
    const subscribedPeriod = current && view.status.planSource === 'subscription' && view.status.period
      ? ` · ${BILLING_PERIOD_LABELS[view.status.period]}` : '';
    return {
      tier, label: PLAN_TIER_LABELS[tier], price, priceDetail: detail, features: cardFeatures(tier), current,
      badge: current ? `Your plan${subscribedPeriod}` : null,
      action: planAction(view, tier, period, mode), note: cardNote(view, tier, mode),
    };
  });
}

/** Whether the monthly and annual switch means anything: some card shows an annual price. */
export function showsPeriodSwitch(view: Pick<UsageView, 'tier' | 'status'>, mode: PurchaseMode): boolean {
  if (mode === 'none') return false;
  return view.tier === 'free' || canSwitchToAnnual(view.status) || (view.tier === 'legacy_pro' && view.status.planSource === 'subscription');
}

export function annualConfirmText(status: BillingStatus): string {
  const prices = isSellableTier(status.tier) ? sellableTierPrices(status.tier, pricingOf(status.pricing)) : null;
  const annual = prices?.annualMicros != null ? formatUsd(prices.annualMicros, 0) : '';
  return `Switch to annual${annual ? ` at ${annual}/year` : ''}? Polar invoices the prorated difference for the rest of your current period now, `
    + 'on your saved card. After that your plan renews yearly. To go back to monthly, use Manage subscription.';
}

/** The confirmation after a plan change. Mirrors the web toast. */
export function changedPlanMessage(plan: SellableTier, period: Period, wasTier: PlanTier): string {
  if (plan === wasTier && period === 'annual') return 'Switched to annual. Your plan updates in a moment.';
  return plan === 'pro'
    ? `You are on Pro now. ${PLAN_LIMITS.pro.includedBoxHours} box-hours a month start today.`
    : `You are on ${PLAN_TIER_LABELS[plan]} now. Your new box-hours are ready to use.`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface BillingErrorCopy {
  message: string;
  /** Offer "Manage subscription": the portal does what was refused. */
  portal: boolean;
}

/** A billing refusal as the sentence web shows, and whether the portal is the fix. */
export function billingErrorCopy(error: unknown, context: { plan?: SellableTier; action: 'checkout' | 'change' | 'credits' | 'reset' | 'portal' }): BillingErrorCopy {
  const { code, message } = (error && typeof error === 'object' ? error : {}) as { code?: unknown; message?: unknown };
  const label = context.plan ? PLAN_TIER_LABELS[context.plan] : 'a plan';
  switch (code) {
    case 'already_subscribed':
      return { message: `You already have a subscription. Use "${context.plan === 'max' ? 'Upgrade to Max' : 'Move to Pro'}" to change it.`, portal: false };
    case 'no_subscription':
      return { message: `There is no subscription to change. Buy ${label} instead.`, portal: false };
    case 'max_plan_unavailable':
      return { message: 'Max is not available for this account.', portal: false };
    case 'downgrade_via_portal':
      return { message: 'To move to a smaller plan, use Manage subscription.', portal: true };
    case 'annual_to_monthly_via_portal':
      return { message: 'To move from an annual plan to a monthly plan, use Manage subscription.', portal: true };
    case 'monthly_only':
      return { message: 'Max is monthly only. To move from annual Pro to Max, use Manage subscription.', portal: true };
    case 'credits_require_paid_plan':
      return { message: `The Free plan does not include credits. ${PRO_PITCH}`, portal: false };
    case 'usage_reset_requires_paid_plan':
      return { message: 'A usage reset needs a paid plan.', portal: false };
    case 'nothing_to_reset':
      return { message: 'You have not used any box-hours yet. There is nothing to reset.', portal: false };
    case 'usage_reset_unavailable':
      return { message: 'Usage reset is not available for this account.', portal: false };
  }
  const fallback = context.action === 'change' ? 'Could not change the plan.'
    : context.action === 'portal' ? 'Could not open the billing portal.' : 'Could not start the checkout.';
  return { message: typeof message === 'string' && message.trim() ? message : fallback, portal: false };
}

/** An old server that refuses the return target: the caller tries again without it. */
export function refusesReturnTarget(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return code === INVALID_RETURN_TO_CODE || (status === 400 && code === undefined);
}

// ---------------------------------------------------------------------------
// Refusal notices (`/billing?reason=…`, or `?note=…`)
// ---------------------------------------------------------------------------

export type BillingReason = 'usage_exhausted' | 'size_requires_pro';

export function billingReasonOf(value: unknown): BillingReason | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === 'usage_exhausted' || raw === 'size_requires_pro' ? raw : null;
}

export interface ReasonNotice { title: string; body: string; sizeLink: boolean }

/** Why a box was refused, for the notice at the top of the plan page. Mirrors web `usageModalCopy`. */
export function reasonNotice(reason: BillingReason, view: Pick<UsageView, 'tier' | 'usage'>, mode: PurchaseMode): ReasonNotice {
  const { tier } = view;
  const resets = longDate(view.usage.periodEnd);
  if (reason === 'size_requires_pro') {
    const body = tier === 'free'
      ? `This box size needs the Pro plan. Free runs small and standard boxes. ${mode === 'none' ? 'Choose a smaller size for the repository.' : 'Pro runs every size.'}`
      : 'This box size is not available on your plan. Choose a smaller size for the repository.';
    return { title: 'This size needs Pro', body, sizeLink: true };
  }
  if (tier === 'free') {
    const body = mode === 'none'
      ? `You have used all ${PLAN_LIMITS.free.includedBoxHours} box-hours of this period.${resets ? ` They reset on ${resets}.` : ''}`
      : `You have used all ${PLAN_LIMITS.free.includedBoxHours} box-hours of this period. ${PRO_PITCH}`;
    return { title: 'Out of box-hours', body, sizeLink: false };
  }
  return {
    title: 'Out of box-hours',
    body: mode === 'none'
      ? `You have used your included box-hours and your credits.${resets ? ` Hours reset on ${resets}.` : ''}`
      : 'Add credits or turn on auto top-up to start new boxes.',
    sizeLink: false,
  };
}

// ---------------------------------------------------------------------------
// Credits and auto top-up
// ---------------------------------------------------------------------------

export interface PackOption { id: CreditPackId; price: string; detail: string }

export function creditPackOptions(): PackOption[] {
  return CREDIT_PACK_IDS.map((id) => {
    const pack = CREDIT_PACKS[id];
    return { id, price: formatUsd(pack.priceMicros, 0),
      detail: pack.bonusPercent ? `+${pack.bonusPercent}% bonus: ${formatUsd(pack.creditMicros, 0)} of credits` : 'No bonus' };
  });
}

export interface CreditLotLine { id: string; amount: string; expires: string }

/** Live lots with something left, soonest expiry first. */
export function creditLotLines(status: BillingStatus): CreditLotLine[] {
  return (status.credits?.lots ?? [])
    .filter((lot) => lot.remainingMicros > 0)
    .sort((a, b) => new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime())
    .map((lot) => ({ id: lot.id, amount: `${formatUsd(lot.remainingMicros)} of ${formatUsd(lot.totalMicros)}`, expires: `Expires ${longDate(lot.expiresAt)}` }));
}

/** Whole or decimal dollars as typed, to micro-dollars. Null when it is not an amount. */
export function dollarsToMicros(text: string): number | null {
  const trimmed = text.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100) * (MICROS_PER_DOLLAR / 100);
}

function microsToDollarText(micros: number): string {
  return formatUsd(micros).replace(/^\$/, '').replace(/\.00$/, '').replace(/,/g, '');
}

export interface TopupDraft { enabled: boolean; trigger: string; pack: CreditPackId; limit: string }

export function topupDraftFrom(settings: AutoTopupConfig): TopupDraft {
  return { enabled: settings.enabled, trigger: microsToDollarText(settings.triggerMicros), pack: settings.pack,
    limit: microsToDollarText(settings.monthlyLimitMicros) };
}

/** The draft as a config, or the problems with it. Mirrors web `configFromDraft`. */
export function topupConfigFromDraft(draft: TopupDraft): { config: AutoTopupConfig } | { errors: string[] } {
  const triggerMicros = dollarsToMicros(draft.trigger);
  const monthlyLimitMicros = dollarsToMicros(draft.limit);
  const errors: string[] = [];
  if (triggerMicros === null) errors.push('Enter the trigger balance in dollars, for example 5.');
  if (monthlyLimitMicros === null) errors.push('Enter the monthly limit in dollars, for example 100.');
  if (triggerMicros === null || monthlyLimitMicros === null) return { errors };
  const config: AutoTopupConfig = { enabled: draft.enabled, triggerMicros, pack: draft.pack, monthlyLimitMicros };
  const problems = validateAutoTopupConfig(config);
  return problems.length ? { errors: problems } : { config };
}

/** "On: buy $25 below $5, at most $100 a month." */
export function topupSummary(settings: AutoTopupConfig): string {
  if (!settings.enabled) return 'Off';
  return `On: buy ${formatUsd(CREDIT_PACKS[settings.pack].priceMicros, 0)} below ${formatUsd(settings.triggerMicros, 0)}, `
    + `at most ${formatUsd(settings.monthlyLimitMicros, 0)} a month`;
}

/** "$40.00", or "€40.00" for another currency. Amounts are in cents. */
export function orderAmount(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  if (code === 'USD') return formatUsd(amount * 10_000);
  return `${(amount / 100).toFixed(2)} ${code}`;
}

// ---------------------------------------------------------------------------
// Usage reset
// ---------------------------------------------------------------------------

/** The action label, such as "Reset usage: $40". */
export function usageResetLabel(offer: UsageResetOffer): string {
  return `Reset usage: ${formatUsd(offer.priceMicros, 0)}`;
}

/** What the reset does, in one line. */
export function usageResetDetail(offer: UsageResetOffer, periodEnd: string | null | undefined): string {
  const ends = longDate(periodEnd);
  return `Pay your plan's monthly price once to get all ${formatBoxHoursLabel(offer.includedWsec)} back now. `
    + `Your period still ends${ends ? ` on ${ends}` : ''}. Unused hours do not carry over.`;
}

/** "Reset 1 time this period", or null when there was none. */
export function usageResetCount(resets: number | undefined): string | null {
  if (!resets || resets < 1) return null;
  return `Reset ${resets} ${resets === 1 ? 'time' : 'times'} this period`;
}
