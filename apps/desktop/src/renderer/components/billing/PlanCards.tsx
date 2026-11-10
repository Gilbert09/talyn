import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import {
  BILLING_PERIOD_LABELS,
  PLAN_LIMITS,
  PLAN_PRICES,
  PLAN_TIER_LABELS,
  SANDBOX_SIZES,
  formatUsd,
  isSellableTier,
  tierSoldAnnually,
  type PlanTier,
  type SellableTier,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { openExternal } from '../../lib/openExternal';
import { trackEvent } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { includedHoursText, maxNeedsPortal, maxPricesOf, pricingOf, type UsageBillingStatus } from '../../lib/usageBilling';
import { trackBillingFailure, useBillingStore } from '../../stores/billing';
import { useWorkspaceStore } from '../../stores/workspace';
import { AnnualSwitch } from '../settings/sections/AnnualSwitch';
import { Button } from '../ui/button';

type Period = 'monthly' | 'annual';
export type PlanCardTier = PlanTier | 'team';

/** Free, Pro, Max and Team, with Legacy Pro for the people who hold it. Max only when it is offered or held. */
export function planCardTiers(status: UsageBillingStatus): PlanCardTier[] {
  const plans: PlanCardTier[] = ['free', 'pro', 'team'];
  if (maxPricesOf(status) || status.tier === 'max') plans.splice(2, 0, 'max');
  if (status.tier === 'legacy_pro') plans.splice(1, 0, 'legacy_pro');
  return plans;
}

function planFeatures(plan: PlanCardTier): string[] {
  const limits = PLAN_LIMITS[plan === 'team' ? 'pro' : plan];
  const features = [
    `${includedHoursText(plan === 'team' ? 'pro' : plan)} per month`,
    `${limits.concurrentBoxes} boxes at the same time`,
    limits.sizes.length === Object.keys(SANDBOX_SIZES).length ? 'Every box size' : 'Small and standard boxes',
    limits.creditsAllowed ? 'Credits and auto top-up' : 'No credits',
  ];
  if (plan === 'team') features.push('Each seat has its own included box-hours');
  return features;
}

export function PlanOption({
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
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`rounded-md border p-3 text-left transition-colors ${
        selected ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <div className="text-[13px] font-medium">{label}</div>
      <div className="text-sm font-semibold">{price}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </button>
  );
}

/**
 * Every plan side by side: its price, what it includes, and the move to it
 * when there is one. Settings → Plan and usage shows it on the page; the
 * Compare plans modal shows it in a dialog and passes `onLeave` to close itself.
 */
export function PlanCards({
  status,
  placement,
  onLeave,
  className,
}: {
  status: UsageBillingStatus;
  placement: 'plan_page' | 'compare_plans';
  onLeave?: () => void;
  className?: string;
}) {
  const startCheckoutPollBurst = useBillingStore((s) => s.startCheckoutPollBurst);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const [period, setPeriod] = useState<Period>('monthly');
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pricing = pricingOf(status);
  const maxPrices = maxPricesOf(status);
  const { tier } = status;
  const subscribed = status.planSource === 'subscription';
  // Max is monthly only, so Pro annual to Max goes through the portal, never change-plan.
  const maxViaPortal = maxNeedsPortal(status);
  const canMoveToMax = maxPrices != null && subscribed && (tier === 'pro' || tier === 'legacy_pro') && !maxViaPortal;
  const current: PlanCardTier = tier === 'legacy_pro' ? tier : status.planSource === 'team' ? 'team' : tier;
  const periodFor = (to: SellableTier): Period => (tierSoldAnnually(to) ? period : 'monthly');
  const blocked = busy !== null || waiting;
  const plans = planCardTiers(status);

  async function run(key: 'checkout' | 'change' | 'portal', fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      trackBillingFailure(key === 'checkout' ? 'checkout_failed' : 'plan_change_failed', key === 'portal' ? 'portal' : 'create_checkout', err);
      if (key === 'change') useBillingStore.getState().clearPlanChange();
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const checkout = (to: SellableTier) =>
    run('checkout', async () => {
      const toPeriod = periodFor(to);
      trackEvent('checkout_started', { period: toPeriod, plan: to, placement });
      const { url } = await api.billing.checkout({ period: toPeriod, plan: to });
      await openExternal(url);
      startCheckoutPollBurst('plan');
      setWaiting(true);
    });

  const changePlan = (to: SellableTier) =>
    run('change', async () => {
      const toPeriod = periodFor(to);
      trackEvent('plan_change_started', { period: toPeriod, from: tier, to, placement });
      useBillingStore.getState().markPlanChangeStarted(toPeriod);
      await api.billing.changePlan({ to, period: toPeriod });
      startCheckoutPollBurst('plan');
      setWaiting(true);
    });

  // A move to a smaller plan (Max to Pro), or Pro annual to Max, goes through the portal, never change-plan.
  const openPortal = () =>
    run('portal', async () => {
      const { url } = await api.billing.portal();
      await openExternal(url);
      startCheckoutPollBurst('plan');
    });

  const spinner = (key: string, label: string) =>
    busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : label;

  const portalButton = (
    <Button className="w-full" variant="outline" onClick={openPortal} disabled={busy !== null}>
      {spinner('portal', 'Manage billing')}
    </Button>
  );

  // Only Pro is sold annually, so the picker shows only when a Pro purchase or move is on offer.
  const showPeriodPicker = tier === 'free' || (tier === 'legacy_pro' && subscribed);

  return (
    <div className="space-y-3">
      {showPeriodPicker && (
        <div className="grid max-w-sm grid-cols-2 gap-2">
          <PlanOption
            label="Annual"
            price={`${formatUsd(pricing.proAnnualMicros, 0)}/yr`}
            hint="2 months free"
            selected={period === 'annual'}
            onSelect={() => setPeriod('annual')}
            disabled={blocked}
          />
          <PlanOption
            label="Monthly"
            price={`${formatUsd(pricing.proMonthlyMicros, 0)}/mo`}
            selected={period === 'monthly'}
            onSelect={() => setPeriod('monthly')}
            disabled={blocked}
          />
        </div>
      )}
      <div className={cn('grid gap-3 sm:grid-cols-2', className)} data-testid="plan-cards">
        {plans.map((card) => {
          const label = card === 'team' ? 'Team' : PLAN_TIER_LABELS[card];
          const isCurrent = card === current;
          const limits = PLAN_LIMITS[card === 'team' ? 'pro' : card];
          const monthly =
            card === 'free'
              ? PLAN_PRICES.free.monthlyMicros
              : card === 'legacy_pro'
                ? pricing.legacyProMonthlyMicros
                : card === 'max'
                  ? (maxPrices?.monthlyMicros ?? PLAN_PRICES.max.monthlyMicros)
                  : pricing.proMonthlyMicros;
          // Max is sold monthly only.
          const annual =
            card === 'free' || card === 'max'
              ? null
              : card === 'legacy_pro'
                ? PLAN_PRICES.legacy_pro.annualMicros
                : pricing.proAnnualMicros;
          const perSeat = card === 'team' ? ' per seat' : '';
          const badge = isCurrent
            ? `Your plan${card !== 'team' && subscribed && status.period ? ` · ${BILLING_PERIOD_LABELS[status.period]}` : ''}`
            : null;
          return (
            <div
              key={card}
              data-testid={`compare-plan-${card}`}
              aria-label={`${label} plan${isCurrent ? ', your plan' : ''}`}
              className={cn(
                'flex flex-col gap-3 rounded-lg border bg-card p-3 text-[13px]',
                isCurrent && 'border-primary ring-1 ring-primary'
              )}
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 font-semibold">{label}</span>
                {badge && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{badge}</span>
                )}
              </div>
              <div>
                <div className="flex flex-wrap items-baseline gap-x-1">
                  <span className="text-xl font-semibold tabular-nums">{formatUsd(monthly, 0)}</span>
                  {card !== 'free' && <span className="text-muted-foreground">/mo{perSeat}</span>}
                </div>
                {annual != null && (
                  <div className="text-xs text-muted-foreground">
                    {formatUsd(annual, 0)}/yr{perSeat} · Save {formatUsd(monthly * 12 - annual, 0)}/yr
                  </div>
                )}
                {card === 'legacy_pro' && <div className="text-xs text-muted-foreground">No longer sold</div>}
              </div>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {planFeatures(card).map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>
              <div className="mt-auto space-y-2">
                {isCurrent ? (
                  isSellableTier(card) && <AnnualSwitch status={status} placement={placement} />
                ) : card === 'pro' && tier === 'free' ? (
                  <Button className="w-full" onClick={() => checkout('pro')} disabled={blocked}>{spinner('checkout', 'Upgrade to Pro')}</Button>
                ) : card === 'pro' && tier === 'legacy_pro' && subscribed ? (
                  <Button className="w-full" onClick={() => changePlan('pro')} disabled={blocked}>{spinner('change', 'Move to Pro')}</Button>
                ) : card === 'pro' && tier === 'max' && subscribed ? (
                  <>
                    <p className="text-xs text-muted-foreground">To move to Pro, use Manage billing. The change starts at your next renewal.</p>
                    {portalButton}
                  </>
                ) : card === 'max' && maxViaPortal ? (
                  <>
                    <p className="text-xs text-muted-foreground" data-testid="max-via-portal">
                      Max is monthly only. To move from annual Pro to Max, use Manage billing.
                    </p>
                    {portalButton}
                  </>
                ) : card === 'max' && tier === 'free' ? (
                  <Button className="w-full" onClick={() => checkout('max')} disabled={blocked}>{spinner('checkout', 'Upgrade to Max')}</Button>
                ) : card === 'max' && canMoveToMax ? (
                  <Button className="w-full" onClick={() => changePlan('max')} disabled={blocked}>{spinner('change', 'Upgrade to Max')}</Button>
                ) : card === 'team' ? (
                  <Button
                    className="w-full"
                    variant="outline"
                    onClick={() => {
                      trackEvent('team_offer_opened', { placement });
                      onLeave?.();
                      openSettings('teams');
                    }}
                  >
                    Explore Team
                  </Button>
                ) : null}
                {onLeave && limits.creditsAllowed && isCurrent && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => {
                      onLeave();
                      openSettings('billing');
                    }}
                  >
                    Add credits
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {waiting && <p className="text-[13px] text-muted-foreground">Finish in your browser. This updates by itself once payment completes.</p>}
      {error && <p className="text-[13px] text-destructive">{error}</p>}
    </div>
  );
}
