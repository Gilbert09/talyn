import { useState } from 'react';
import { CreditCard, Loader2 } from 'lucide-react';
import {
  CREDIT_PACKS,
  CREDIT_PACK_IDS,
  PLAN_LIMITS,
  PLAN_PRICES,
  PLAN_TIER_LABELS,
  formatBoxHoursLabel,
  formatUsd,
  tierSoldAnnually,
  type BillingPricing,
  type CreditPackId,
  type SellableTier,
  type UsageResetOffer,
} from '@talyn/shared';
import { api, ApiError } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { trackBillingFailure } from '../../stores/billing';
import { formatLongDate, goToHostedPage, maxNeedsPortal, maxPricesOf } from '../../lib/usageBilling';
import { useBillingStore } from '../../stores/billing';
import { toast } from '../../stores/toast';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

export type Period = 'monthly' | 'annual';

/** Pro's list prices from the status, else the shared constants. */
export function proPrices(pricing: BillingPricing | undefined): { monthly: string; annual: string } {
  return {
    monthly: formatUsd(pricing?.proMonthlyMicros ?? PLAN_PRICES.pro.monthlyMicros, 0),
    annual: formatUsd(pricing?.proAnnualMicros ?? PLAN_PRICES.pro.annualMicros ?? 0, 0),
  };
}

/**
 * A sellable plan's list prices, or null for Max when this account may not buy
 * it. `annual` is null for Max, which is sold monthly only.
 */
export function planPrices(
  plan: SellableTier,
  pricing: BillingPricing | undefined
): { monthly: string; annual: string | null } | null {
  if (plan === 'pro') return proPrices(pricing);
  const max = maxPricesOf({ pricing });
  return max ? { monthly: formatUsd(max.monthlyMicros, 0), annual: null } : null;
}

export function legacyMonthlyPrice(pricing: BillingPricing | undefined): string {
  return formatUsd(pricing?.legacyProMonthlyMicros ?? PLAN_PRICES.legacy_pro.monthlyMicros, 0);
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The three credit packs. A click goes to Polar's hosted checkout in this tab. */
export function CreditPackButtons({ placement, className }: { placement: string; className?: string }) {
  const [busy, setBusy] = useState<CreditPackId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buy = async (pack: CreditPackId) => {
    setBusy(pack);
    setError(null);
    trackEvent('credits_checkout_started', { pack, placement });
    try {
      useBillingStore.getState().markCreditCheckoutStarted(pack);
      const { url } = await api.billing.creditCheckout({ pack });
      goToHostedPage(url);
    } catch (err) {
      useBillingStore.getState().clearCreditCheckout();
      trackBillingFailure('credit_checkout_failed', 'create_checkout', err);
      setError(errorText(err, 'Could not start the checkout.'));
      setBusy(null);
    }
  };

  return (
    <div className={className}>
      <div className="grid grid-cols-3 gap-2">
        {CREDIT_PACK_IDS.map((id) => {
          const pack = CREDIT_PACKS[id];
          return (
            <button
              key={id}
              type="button"
              data-attr={`credit-pack-${id}`}
              disabled={busy !== null}
              onClick={() => void buy(id)}
              className="rounded-md border p-3 text-left transition-colors hover:border-primary disabled:opacity-60"
            >
              <div className="flex items-center gap-1 text-lg font-semibold">
                {busy === id ? <Loader2 className="h-4 w-4 animate-spin" /> : formatUsd(pack.priceMicros, 0)}
              </div>
              <div className="text-xs text-muted-foreground">
                {pack.bonusPercent
                  ? `+${pack.bonusPercent}% bonus: ${formatUsd(pack.creditMicros, 0)} of credits`
                  : 'No bonus'}
              </div>
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

const USAGE_RESET_ERRORS: Record<string, string> = {
  usage_reset_requires_paid_plan: 'A usage reset needs a paid plan.',
  nothing_to_reset: 'You have not used any box-hours yet. There is nothing to reset.',
  usage_reset_unavailable: 'Usage reset is not available for this account.',
};

/**
 * "Reset usage": pay the plan's monthly price once to get the full allowance
 * back now. Renders nothing unless the status carries a reset offer.
 */
export function UsageResetAction({
  offer,
  periodEnd,
  resets,
  placement,
  className,
}: {
  offer: UsageResetOffer | undefined;
  periodEnd: string;
  resets?: number;
  placement: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!offer) return null;

  const buy = async () => {
    setBusy(true);
    setError(null);
    trackEvent('usage_reset_checkout_started', { tier: offer.tier, placement });
    try {
      const { url } = await api.billing.usageResetCheckout();
      goToHostedPage(url);
    } catch (err) {
      trackBillingFailure('usage_reset_checkout_failed', 'create_checkout', err);
      const code = err instanceof ApiError ? err.code : undefined;
      setError((code && USAGE_RESET_ERRORS[code]) || errorText(err, 'Could not start the checkout.'));
      setBusy(false);
    }
  };

  return (
    <div className={cn('space-y-2', className)} data-testid="usage-reset">
      <Button variant="outline" size="sm" data-attr="usage-reset-checkout" disabled={busy} onClick={() => void buy()} className="gap-2">
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        Reset usage: {formatUsd(offer.priceMicros, 0)}
      </Button>
      <p className="text-xs text-muted-foreground">
        Pay your plan&apos;s monthly price once to get all {formatBoxHoursLabel(offer.includedWsec)} back now. Your
        period still ends on {formatLongDate(periodEnd)}. Unused hours do not carry over.
      </p>
      {resets != null && resets > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="usage-reset-count">
          Reset {resets} {resets === 1 ? 'time' : 'times'} this period
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function PeriodOption({
  label,
  price,
  hint,
  selected,
  onSelect,
  disabled,
}: {
  label: string;
  price: string;
  hint?: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      disabled={disabled}
      className={cn(
        'rounded-md border p-3 text-left transition-colors',
        selected ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40',
        disabled && 'opacity-60'
      )}
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="text-lg font-semibold">{price}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </button>
  );
}

/**
 * Pick monthly or annual Pro, or monthly Max, then buy it (Free) or move to it
 * (a paid subscription).
 *
 * `mode: 'checkout'` sends the browser to Polar. `mode: 'change'` changes the
 * live subscription in place, with no checkout. Only upgrades go through
 * here: a smaller plan goes through the billing portal, and so does Pro
 * annual to Max. Renders nothing for Max when this account may not buy it.
 */
export function PlanForm({
  plan = 'pro',
  mode,
  placement,
  onChanged,
}: {
  plan?: SellableTier;
  mode: 'checkout' | 'change';
  placement: string;
  onChanged?: () => void;
}) {
  const status = useBillingStore((s) => s.status);
  const prices = planPrices(plan, status?.pricing);
  const [chosenPeriod, setPeriod] = useState<Period>('monthly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!prices) return null;
  if (plan === 'max' && mode === 'change' && maxNeedsPortal(status)) {
    return (
      <div className="space-y-2" data-testid="max-via-portal">
        <p className="text-xs text-muted-foreground">Max is monthly only. To move from annual Pro to Max, use Manage billing.</p>
        <PortalButton secondary />
      </div>
    );
  }
  const planLabel = PLAN_TIER_LABELS[plan];
  // Max is sold monthly only.
  const period: Period = tierSoldAnnually(plan) ? chosenPeriod : 'monthly';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'checkout') {
        trackEvent('checkout_started', { period, plan, placement });
        const { url } = await api.billing.checkout({ period, plan });
        goToHostedPage(url);
        return;
      }
      trackEvent('plan_change_started', { period, to: plan, placement });
      useBillingStore.getState().markPlanChangeStarted(period);
      await api.billing.changePlan({ to: plan, period });
      await useBillingStore.getState().refresh();
      toast.success(
        `You are on ${planLabel} now`,
        plan === 'pro'
          ? `${PLAN_LIMITS.pro.includedBoxHours} box-hours a month start today.`
          : 'Your new box-hours are ready to use.'
      );
      setBusy(false);
      onChanged?.();
    } catch (err) {
      trackBillingFailure(mode === 'checkout' ? 'checkout_failed' : 'plan_change_failed', 'create_checkout', err);
      if (mode === 'change') useBillingStore.getState().clearPlanChange();
      const code = err instanceof ApiError ? err.code : undefined;
      if (code === 'already_subscribed') {
        setError(`You already have a subscription. Use "${plan === 'pro' ? 'Move to Pro' : 'Upgrade to Max'}" to change it.`);
      } else if (code === 'no_subscription') {
        setError(`There is no subscription to change. Buy ${planLabel} instead.`);
      } else if (code === 'max_plan_unavailable') {
        setError('Max is not available for this account.');
      } else if (code === 'downgrade_via_portal') {
        setError('To move to a smaller plan, use Manage billing.');
      } else if (code === 'annual_to_monthly_via_portal') {
        setError('To move from an annual plan to a monthly plan, use Manage billing.');
      } else {
        setError(errorText(err, mode === 'checkout' ? 'Could not start the checkout.' : 'Could not change the plan.'));
      }
      setBusy(false);
    }
  };

  const label = plan === 'max' ? 'Upgrade to Max' : mode === 'checkout' ? 'Upgrade to Pro' : 'Move to Pro';
  return (
    <div className="space-y-3">
      {prices.annual != null && (
        <div className="grid grid-cols-2 gap-2">
          <PeriodOption
            label="Monthly"
            price={`${prices.monthly}/mo`}
            selected={period === 'monthly'}
            onSelect={() => setPeriod('monthly')}
            disabled={busy}
          />
          <PeriodOption
            label="Annual"
            price={`${prices.annual}/yr`}
            hint="2 months free"
            selected={period === 'annual'}
            onSelect={() => setPeriod('annual')}
            disabled={busy}
          />
        </div>
      )}
      <Button onClick={() => void submit()} disabled={busy} className="w-full gap-2" data-attr={`${plan}-${mode}`}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {label}: {period === 'annual' && prices.annual != null ? `${prices.annual}/yr` : `${prices.monthly}/mo`}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** "Manage billing": opens Polar's customer portal. Cancels, card changes and downgrades go there. */
export function PortalButton({ secondary = false }: { secondary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.billing.portal();
      goToHostedPage(url);
    } catch (err) {
      trackBillingFailure('plan_change_failed', 'portal', err);
      setError(err instanceof Error ? err.message : 'Could not open the billing portal.');
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Button
        variant={secondary ? 'link' : 'default'}
        data-attr="plan-manage-billing"
        onClick={() => void open()}
        disabled={busy}
        className="gap-2"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
        Manage billing
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
