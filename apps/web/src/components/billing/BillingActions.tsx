import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  CREDIT_PACKS,
  CREDIT_PACK_IDS,
  PLAN_LIMITS,
  PLAN_PRICES,
  formatUsd,
  type BillingPricing,
  type CreditPackId,
} from '@talyn/shared';
import { api, ApiError } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { trackBillingFailure } from '../../stores/billing';
import { goToHostedPage } from '../../lib/usageBilling';
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
 * Pick monthly or annual Pro, then buy it (Free) or move to it (Legacy Pro).
 *
 * `mode: 'checkout'` sends the browser to Polar. `mode: 'change'` changes the
 * live Legacy Pro subscription in place, with no checkout.
 */
export function ProPlanForm({
  mode,
  placement,
  onChanged,
}: {
  mode: 'checkout' | 'change';
  placement: string;
  onChanged?: () => void;
}) {
  const pricing = useBillingStore((s) => s.status?.pricing);
  const prices = proPrices(pricing);
  const [period, setPeriod] = useState<Period>('monthly');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'checkout') {
        trackEvent('checkout_started', { period, plan: 'pro', placement });
        const { url } = await api.billing.checkout({ period, plan: 'pro' });
        goToHostedPage(url);
        return;
      }
      trackEvent('plan_change_started', { period, to: 'pro', placement });
      useBillingStore.getState().markPlanChangeStarted(period);
      await api.billing.changePlan({ to: 'pro', period });
      await useBillingStore.getState().refresh();
      toast.success('You are on Pro now', `${PLAN_LIMITS.pro.includedBoxHours} box-hours a month start today.`);
      setBusy(false);
      onChanged?.();
    } catch (err) {
      trackBillingFailure(mode === 'checkout' ? 'checkout_failed' : 'plan_change_failed', 'create_checkout', err);
      if (mode === 'change') useBillingStore.getState().clearPlanChange();
      if (err instanceof ApiError && err.code === 'already_subscribed') {
        setError('You already have a subscription. Use "Move to Pro" to change it.');
      } else if (err instanceof ApiError && err.code === 'no_subscription') {
        setError('There is no subscription to change. Buy Pro instead.');
      } else {
        setError(errorText(err, mode === 'checkout' ? 'Could not start the checkout.' : 'Could not change the plan.'));
      }
      setBusy(false);
    }
  };

  const label = mode === 'checkout' ? 'Upgrade to Pro' : 'Move to Pro';
  return (
    <div className="space-y-3">
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
      <Button onClick={() => void submit()} disabled={busy} className="w-full gap-2" data-attr={`pro-${mode}`}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {label}: {period === 'annual' ? `${prices.annual}/yr` : `${prices.monthly}/mo`}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
