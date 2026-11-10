import { Check } from 'lucide-react';
import {
  BILLING_PERIOD_LABELS,
  PLAN_LIMITS,
  PLAN_PRICES,
  PLAN_TIER_LABELS,
  SANDBOX_SIZES,
  boxHoursToWeightedSeconds,
  formatBoxHoursLabel,
  formatUsd,
  type PlanTier,
} from '@talyn/shared';
import { trackEvent } from '../../lib/analytics';
import { cn } from '../../lib/utils';
import { MAX_INCLUDED_TEXT, maxPricesOf, type UsageBillingView } from '../../lib/usageBilling';
import { useWorkspaceStore } from '../../stores/workspace';
import { AnnualSwitch } from '../settings/sections/AnnualSwitch';
import { Button } from '../ui/button';
import { PlanForm, PortalButton } from './BillingActions';

export type PlanCardTier = PlanTier | 'team';

/** Free, Pro, Max and Team, with Legacy Pro for the people who hold it. Max only when it is offered or held. */
export function planCardTiers(view: UsageBillingView): PlanCardTier[] {
  const plans: PlanCardTier[] = ['free', 'pro', 'team'];
  if (maxPricesOf(view.status) || view.tier === 'max') plans.splice(2, 0, 'max');
  if (view.tier === 'legacy_pro') plans.splice(1, 0, 'legacy_pro');
  return plans;
}

function planFeatures(plan: PlanCardTier): string[] {
  const limits = PLAN_LIMITS[plan === 'team' ? 'pro' : plan];
  const included = plan === 'max' ? MAX_INCLUDED_TEXT : formatBoxHoursLabel(boxHoursToWeightedSeconds(limits.includedBoxHours));
  const features = [
    `${included} per month`,
    `${limits.concurrentBoxes} boxes at the same time`,
    limits.sizes.length === Object.keys(SANDBOX_SIZES).length ? 'Every box size' : 'Small and standard boxes',
    limits.creditsAllowed ? 'Credits and auto top-up' : 'No credits',
  ];
  if (plan === 'team') features.push('Each seat has its own included box-hours');
  return features;
}

/**
 * Every plan side by side: its price, what it includes, and the move to it
 * when there is one. Settings → Billing shows it on the page; the Compare
 * plans modal shows it in a dialog and passes `onLeave` to close itself.
 */
export function PlanCards({
  view,
  placement,
  onLeave,
  className,
}: {
  view: UsageBillingView;
  placement: 'plan_page' | 'compare_plans';
  onLeave?: () => void;
  className?: string;
}) {
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const plans = planCardTiers(view);
  const maxPrices = maxPricesOf(view.status);
  const { status, tier } = view;
  const current: PlanCardTier = tier === 'legacy_pro' ? tier : status.planSource === 'team' ? 'team' : tier;
  const subscribed = status.planSource === 'subscription';
  const pricing = status.pricing;
  const formPlacement = placement === 'compare_plans' ? 'upgrade_modal' : 'plan_page';

  return (
    <div className={cn('grid gap-3 sm:grid-cols-2', className)} data-testid="plan-cards">
      {plans.map((plan) => {
        const label = plan === 'team' ? 'Team' : PLAN_TIER_LABELS[plan];
        const isCurrent = plan === current;
        const monthly = plan === 'free'
          ? PLAN_PRICES.free.monthlyMicros
          : plan === 'legacy_pro'
            ? pricing?.legacyProMonthlyMicros ?? PLAN_PRICES.legacy_pro.monthlyMicros
            : plan === 'max'
              ? maxPrices?.monthlyMicros ?? PLAN_PRICES.max.monthlyMicros
              : pricing?.proMonthlyMicros ?? PLAN_PRICES.pro.monthlyMicros;
        // Max is sold monthly only.
        const annual = plan === 'free' || plan === 'max'
          ? null
          : plan === 'legacy_pro'
            ? PLAN_PRICES.legacy_pro.annualMicros
            : pricing?.proAnnualMicros ?? PLAN_PRICES.pro.annualMicros;
        const perSeat = plan === 'team' ? ' per seat' : '';
        const badge = isCurrent
          ? `Your plan${plan !== 'team' && subscribed && status.period ? ` · ${BILLING_PERIOD_LABELS[status.period]}` : ''}`
          : null;
        return (
          <div
            key={plan}
            data-testid={`compare-plan-${plan}`}
            aria-label={`${label} plan${isCurrent ? ', your plan' : ''}`}
            className={cn(
              'flex flex-col gap-3 rounded-lg border bg-card p-4 text-sm',
              isCurrent && 'border-primary ring-1 ring-primary'
            )}
          >
            <div className="flex items-center gap-2">
              <span className="flex-1 font-semibold">{label}</span>
              {badge && (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{badge}</span>
              )}
            </div>
            <div>
              <div className="flex flex-wrap items-baseline gap-x-1">
                <span className="text-2xl font-semibold tabular-nums">{formatUsd(monthly, 0)}</span>
                {plan !== 'free' && <span className="text-muted-foreground">/mo{perSeat}</span>}
              </div>
              {annual != null && (
                <div className="text-xs text-muted-foreground">
                  {formatUsd(annual, 0)}/yr{perSeat} · Save {formatUsd(monthly * 12 - annual, 0)}/yr
                </div>
              )}
              {plan === 'legacy_pro' && <div className="text-xs text-muted-foreground">No longer sold</div>}
            </div>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {planFeatures(plan).map((feature) => (
                <li key={feature} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {feature}
                </li>
              ))}
            </ul>
            <div className="mt-auto space-y-2">
              {isCurrent ? (
                (plan === 'pro' || plan === 'max') && <AnnualSwitch status={status} placement={placement} />
              ) : plan === 'pro' && tier === 'free' ? (
                <PlanForm mode="checkout" placement={formPlacement} />
              ) : plan === 'pro' && tier === 'legacy_pro' && subscribed ? (
                <PlanForm mode="change" placement={formPlacement} onChanged={onLeave} />
              ) : plan === 'pro' && tier === 'max' && subscribed ? (
                <>
                  <p className="text-xs text-muted-foreground">To move to Pro, use Manage billing. The change starts at your next renewal.</p>
                  <PortalButton secondary />
                </>
              ) : plan === 'max' && tier === 'free' ? (
                <PlanForm plan="max" mode="checkout" placement={formPlacement} />
              ) : plan === 'max' && (tier === 'pro' || tier === 'legacy_pro') && subscribed ? (
                <PlanForm plan="max" mode="change" placement={formPlacement} onChanged={onLeave} />
              ) : plan === 'team' ? (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    trackEvent('team_offer_opened', { placement: formPlacement });
                    onLeave?.();
                    openSettings('teams');
                  }}
                >
                  Explore Team
                </Button>
              ) : null}
              {onLeave && isCurrent && PLAN_LIMITS[plan === 'team' ? 'pro' : plan].creditsAllowed && (
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
  );
}
