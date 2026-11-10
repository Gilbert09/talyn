import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Zap } from 'lucide-react';
import {
  BILLING_PERIOD_LABELS,
  CREDIT_PACK_IDS,
  PLAN_LIMITS,
  PLAN_PRICES,
  PLAN_TIER_LABELS,
  SANDBOX_SIZES,
  SELLABLE_TIERS,
  formatCreditPack,
  formatUsd,
  isSellableTier,
  isTierUpgrade,
  tierSoldAnnually,
  type CreditPackId,
  type PlanTier,
  type SellableTier,
} from '@talyn/shared';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { AnnualSwitch } from '../settings/sections/AnnualSwitch';
import { UsageResetAction } from '../billing/UsageResetAction';
import { api } from '../../lib/api';
import { openExternal } from '../../lib/openExternal';
import { trackEvent } from '../../lib/analytics';
import { trackBillingFailure } from '../../stores/billing';
import {
  formatShortDate,
  includedHoursText,
  maxNeedsPortal,
  maxPricesOf,
  pricingOf,
  type BoxNotice,
  type UsageBillingStatus,
} from '../../lib/usageBilling';
import { useBillingStore, type UpgradeReason } from '../../stores/billing';
import { useWorkspaceStore } from '../../stores/workspace';

type Period = 'monthly' | 'annual';
/** `annualMicros` is null for Max, which is sold monthly only. */
type Prices = { monthlyMicros: number; annualMicros: number | null };

const hours = includedHoursText;

const GRID_COLUMNS: Record<number, string> = { 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5' };

const perPeriod = (prices: Prices, period: Period) =>
  period === 'annual' && prices.annualMicros != null
    ? `${formatUsd(prices.annualMicros, 0)}/yr`
    : `${formatUsd(prices.monthlyMicros, 0)}/mo`;

/**
 * The modal's title and first paragraph for a tier and a reason. The notice's
 * own sentence wins when the backend sent one: it names the real numbers and
 * dates, and the client never re-derives them.
 */
export function usageUpgradeCopy(input: {
  tier: PlanTier;
  reason: UpgradeReason | null;
  notice: BoxNotice | null;
  periodEnd?: string;
  /** True when the status carries Max prices, so this account may buy Max. */
  maxOffered?: boolean;
}): { title: string; body: string } {
  const { tier, reason, notice } = input;
  const reset = formatShortDate(notice?.periodEnd ?? input.periodEnd ?? '');
  const own = notice?.message?.trim() || null;
  switch (reason) {
    case 'compare_plans':
      return { title: 'Compare plans', body: 'See what each plan includes.' };
    case 'usage_exhausted':
      return {
        title: 'You are out of box-hours',
        body:
          own ??
          (tier === 'free'
            ? `You have used all ${hours('free')} of this period. New boxes start again on ${reset}. Pro includes ${hours('pro')} a month.`
            : `You have used your included box-hours and your credits for this period. Add credits or turn on auto top-up to start new boxes. Included hours reset on ${reset}.`),
      };
    case 'size_requires_pro':
      return {
        title: 'Larger boxes need Pro',
        body:
          own ??
          'The Free plan runs small and standard boxes. Pro runs every size, from small to X-Large.',
      };
    case 'concurrent_box_limit': {
      const limit = notice?.limit ?? PLAN_LIMITS[tier].concurrentBoxes;
      return {
        title: 'All your boxes are busy',
        body:
          own ??
          `The ${PLAN_TIER_LABELS[tier]} plan runs ${limit} boxes at the same time. A new box can start when one stops.` +
            (tier === 'free' ? ` Pro runs up to ${PLAN_LIMITS.pro.concurrentBoxes} at once.` : ''),
      };
    }
    case 'credits_require_paid_plan':
      return {
        title: 'Credits come with Pro',
        body: 'Credits and auto top-up keep boxes running after your included hours. They come with Pro.',
      };
    case 'auto_keep_default':
      return {
        title: 'Keep every new PR mergeable',
        body:
          'Auto-keeping every new PR is a Pro feature. It watches each PR you open, so an agent clears conflicts and red CI without you asking. You can still turn it on for one PR at a time.',
      };
    case 'auto_review':
      return {
        title: 'Review every new pull request',
        body:
          'Automatic review of every new pull request is a Pro feature. You can still review pull requests one at a time.',
      };
    case 'task_deferred':
      return {
        title: 'A fix run is waiting',
        body:
          own ??
          'Talyn wanted to fix one of your watched PRs, but your plan could not start a box. It tries again by itself.',
      };
    default:
      if (tier === 'pro' && reason === 'upgrade' && input.maxOffered) {
        return { title: 'Upgrade to Max', body: `Max includes ${hours('max')} a month instead of ${hours('pro')}.` };
      }
      if (isSellableTier(tier)) {
        return { title: 'Add credits', body: 'Credits keep your boxes running after your included box-hours.' };
      }
      if (tier === 'legacy_pro') {
        return {
          title: 'Move to Pro',
          body: `Pro includes ${hours('pro')} a month instead of ${hours('legacy_pro')}, every box size and credits.`,
        };
      }
      return {
        title: 'Upgrade to Pro',
        body: `Pro includes ${hours('pro')} a month, every box size and up to ${PLAN_LIMITS.pro.concurrentBoxes} boxes at once.`,
      };
  }
}

/** The upgrade modal on a backend with usage billing. */
export function UsageUpgradeModal({
  status,
  open,
  onOpenChange,
}: {
  status: UsageBillingStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const reason = useBillingStore((s) => s.upgradeReason);
  const notice = useBillingStore((s) => s.upgradeNotice);
  const startCheckoutPollBurst = useBillingStore((s) => s.startCheckoutPollBurst);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const [period, setPeriod] = useState<Period>('monthly');
  const [plan, setPlan] = useState<SellableTier>('pro');
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the user had when the modal opened, so it can say when that changed.
  const startRef = useRef<{ tier: PlanTier; balance: number } | null>(null);
  useEffect(() => {
    if (open) startRef.current = { tier: status.tier, balance: status.credits?.balanceMicros ?? 0 };
    // Only the open edge matters; the live status is compared against it.
  }, [open]);
  const start = startRef.current;
  const movedUp = start != null && isTierUpgrade(start.tier, status.tier);
  const creditsLanded = reason !== 'compare_plans' && start != null && (status.credits?.balanceMicros ?? 0) > start.balance;

  const pricing = pricingOf(status);
  // Null when this account may not buy Max: then Max shows nowhere.
  const maxPrices = maxPricesOf(status);
  const proPrices: Prices = { monthlyMicros: pricing.proMonthlyMicros, annualMicros: pricing.proAnnualMicros };
  const priceOf = (p: SellableTier): Prices => (p === 'max' && maxPrices ? maxPrices : proPrices);
  const { tier } = status;
  const subscribed = status.planSource === 'subscription';
  // Max is monthly only, so Pro annual to Max goes through the portal, never change-plan.
  const maxViaPortal = maxNeedsPortal(status);
  const canMoveToMax = maxPrices != null && subscribed && (tier === 'pro' || tier === 'legacy_pro') && !maxViaPortal;
  // A Pro subscriber who asked to upgrade: the modal sells Max in place of credits.
  const upgradeToMax = tier === 'pro' && reason === 'upgrade' && (canMoveToMax || maxViaPortal);
  // Free and Legacy Pro pick between Pro and Max when Max is offered.
  const choosePlan = maxPrices != null && (tier === 'free' || tier === 'legacy_pro');
  const target: SellableTier = upgradeToMax ? 'max' : choosePlan ? plan : 'pro';
  const targetPrices = priceOf(target);
  const periodFor = (to: SellableTier): Period => (tierSoldAnnually(to) ? period : 'monthly');
  const chosenPeriod = periodFor(target);
  const copy = usageUpgradeCopy({ tier, reason, notice, periodEnd: status.usage.periodEnd, maxOffered: maxPrices != null });
  const creditsAllowed = PLAN_LIMITS[tier].creditsAllowed;
  // A full box cap on Pro or Max is not something money fixes: there is nothing to sell.
  const nothingToSell = isSellableTier(tier) && reason === 'concurrent_box_limit';

  function close(next: boolean) {
    if (!next) {
      setWaiting(false);
      setError(null);
    }
    onOpenChange(next);
  }

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const event =
        key === 'checkout' ? 'checkout_failed' : key === 'change' || key === 'portal' ? 'plan_change_failed' : 'credit_checkout_failed';
      trackBillingFailure(event, key === 'portal' ? 'portal' : 'create_checkout', err);
      if (key === 'change') useBillingStore.getState().clearPlanChange();
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const checkout = (to: SellableTier) =>
    run('checkout', async () => {
      const toPeriod = periodFor(to);
      trackEvent('checkout_started', { period: toPeriod, plan: to, reason });
      const { url } = await api.billing.checkout({ period: toPeriod, plan: to });
      await openExternal(url);
      startCheckoutPollBurst('plan');
      setWaiting(true);
    });

  const changePlan = (to: SellableTier) =>
    run('change', async () => {
      const toPeriod = periodFor(to);
      trackEvent('plan_change_started', { period: toPeriod, from: tier, to, reason });
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

  const buyCredits = (pack: CreditPackId) =>
    run(`pack-${pack}`, async () => {
      trackEvent('credit_checkout_started', { pack, reason });
      const { url } = await api.billing.creditCheckout({ pack });
      await openExternal(url);
      startCheckoutPollBurst('credits');
      setWaiting(true);
    });

  const goToSettings = () => {
    close(false);
    openSettings('billing');
  };

  if (movedUp || creditsLanded) {
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent onClose={() => close(false)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              {movedUp ? `You are on ${PLAN_TIER_LABELS[tier]}` : 'Credits added'}
            </DialogTitle>
            <DialogDescription>
              {movedUp
                ? `You have ${hours(tier)} a month and every box size.`
                : `Your credit balance is ${formatUsd(status.credits?.balanceMicros ?? 0)}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => close(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // No picker for a plan sold monthly only (Max).
  const periodPicker = (prices: Prices) =>
    prices.annualMicros != null && (
      <div className="grid grid-cols-2 gap-2">
        <PlanOption
          label="Annual"
          price={`${formatUsd(prices.annualMicros, 0)}/yr`}
          hint="2 months free"
          selected={period === 'annual'}
          onSelect={() => setPeriod('annual')}
          disabled={busy !== null || waiting}
        />
        <PlanOption
          label="Monthly"
          price={`${formatUsd(prices.monthlyMicros, 0)}/mo`}
          selected={period === 'monthly'}
          onSelect={() => setPeriod('monthly')}
          disabled={busy !== null || waiting}
        />
      </div>
    );

  const portalButton = (
    <Button className="w-full" variant="outline" onClick={openPortal} disabled={busy !== null}>
      {busy === 'portal' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Manage billing'}
    </Button>
  );
  const maxPortalNote = (
    <p className="text-muted-foreground" data-testid="max-via-portal">
      Max is monthly only. To move from annual Pro to Max, use Manage billing.
    </p>
  );

  const planPicker = choosePlan && (
    <div className="grid grid-cols-2 gap-2" data-testid="plan-picker">
      {SELLABLE_TIERS.map((p) => (
        <PlanOption
          key={p}
          label={PLAN_TIER_LABELS[p]}
          price={perPeriod(priceOf(p), periodFor(p))}
          hint={`${hours(p)} a month`}
          selected={target === p}
          onSelect={() => setPlan(p)}
          disabled={busy !== null || waiting}
        />
      ))}
    </div>
  );

  if (reason === 'compare_plans') {
    const plans: Array<PlanTier | 'team'> = ['free', 'pro', 'team'];
    if (maxPrices || tier === 'max') plans.splice(2, 0, 'max');
    if (tier === 'legacy_pro') plans.splice(1, 0, 'legacy_pro');
    const current = tier === 'legacy_pro' ? tier : status.planSource === 'team' ? 'team' : tier;
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="max-w-5xl" onClose={() => close(false)}>
          <DialogHeader>
            <DialogTitle>Compare plans</DialogTitle>
            <DialogDescription>See what each plan includes.</DialogDescription>
          </DialogHeader>
          {(tier === 'free' || (tier === 'legacy_pro' && subscribed)) && (
            <div className="mb-4 max-w-sm">{periodPicker(proPrices)}</div>
          )}
          <div className={`grid gap-3 sm:grid-cols-2 ${GRID_COLUMNS[plans.length] ?? 'lg:grid-cols-3'}`}>
            {plans.map((card) => {
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
                card === 'legacy_pro'
                  ? PLAN_PRICES.legacy_pro.annualMicros
                  : card === 'max'
                    ? null
                    : pricing.proAnnualMicros;
              return (
                <div key={card} data-testid={`compare-plan-${card}`} className="flex flex-col rounded-md border p-3 text-[13px]">
                  <div className="font-semibold">{card === 'team' ? 'Team' : PLAN_TIER_LABELS[card]}</div>
                  <div className="mt-1 font-medium">
                    {formatUsd(monthly, 0)}/mo{card === 'team' ? ' per seat' : ''}
                  </div>
                  {annual != null && card !== 'free' && (
                    <div className="text-muted-foreground">
                      {formatUsd(annual, 0)}/yr{card === 'team' ? ' per seat' : ''} · Save {formatUsd(monthly * 12 - annual, 0)}/yr
                    </div>
                  )}
                  <ul className="my-3 space-y-1 text-muted-foreground">
                    <li>{hours(card === 'team' ? 'pro' : card)} per month</li>
                    <li>{limits.concurrentBoxes} concurrent boxes</li>
                    <li>Box sizes: {limits.sizes.map((size) => SANDBOX_SIZES[size].label).join(', ')}</li>
                    <li>Credits: {limits.creditsAllowed ? 'Yes' : 'No'}</li>
                    {card === 'team' && <li>Each seat has its own included box-hours.</li>}
                  </ul>
                  <div className="mt-auto space-y-2">
                    {card === current ? (
                      <>
                        <p className="font-medium text-primary">
                          Your plan{card !== 'team' && subscribed && status.period ? ` · ${BILLING_PERIOD_LABELS[status.period]}` : ''}
                        </p>
                        {isSellableTier(card) && <AnnualSwitch status={status} placement="compare_plans" />}
                      </>
                    ) : card === 'pro' && tier === 'free' ? (
                      <Button className="w-full" onClick={() => checkout('pro')} disabled={busy !== null || waiting}>Upgrade to Pro</Button>
                    ) : card === 'pro' && tier === 'legacy_pro' && subscribed ? (
                      <Button className="w-full" onClick={() => changePlan('pro')} disabled={busy !== null || waiting}>Move to Pro</Button>
                    ) : card === 'pro' && tier === 'max' && subscribed ? (
                      <>
                        <p className="text-muted-foreground">To move to Pro, use Manage billing. The change starts at your next renewal.</p>
                        {portalButton}
                      </>
                    ) : card === 'max' && maxViaPortal ? (
                      <>
                        {maxPortalNote}
                        {portalButton}
                      </>
                    ) : card === 'max' && tier === 'free' ? (
                      <Button className="w-full" onClick={() => checkout('max')} disabled={busy !== null || waiting}>Upgrade to Max</Button>
                    ) : card === 'max' && canMoveToMax ? (
                      <Button className="w-full" onClick={() => changePlan('max')} disabled={busy !== null || waiting}>Upgrade to Max</Button>
                    ) : card === 'team' ? (
                      <Button className="w-full" variant="outline" onClick={() => { close(false); openSettings('teams'); }}>Explore Team</Button>
                    ) : null}
                    {limits.creditsAllowed && card === current && (
                      <button type="button" className="text-xs text-primary hover:underline" onClick={goToSettings}>Add credits</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {waiting && <p className="mt-3 text-[13px] text-muted-foreground">Finish in your browser. This updates by itself once payment completes.</p>}
          {error && <p className="mt-3 text-[13px] text-destructive">{error}</p>}
          <DialogFooter><Button variant="ghost" onClick={() => close(false)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // What a move in place changes: Legacy Pro to Pro or Max, or Pro monthly to Max.
  const fromPrice =
    tier === 'legacy_pro'
      ? `${formatUsd(pricing.legacyProMonthlyMicros, 0)} a month`
      : `${formatUsd(pricing.proMonthlyMicros, 0)} a month`;
  const changes = (
    <div className="rounded-md border p-3 text-[13px]" data-testid={tier === 'legacy_pro' ? 'legacy-changes' : 'max-changes'}>
      <p className="font-medium">What changes when you move to {PLAN_TIER_LABELS[target]}</p>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        <li>
          {hours(tier)} a month becomes {hours(target)}.
        </li>
        <li>
          {fromPrice} becomes{' '}
          {chosenPeriod === 'annual' && targetPrices.annualMicros != null
            ? `${formatUsd(targetPrices.annualMicros, 0)} a year`
            : `${formatUsd(targetPrices.monthlyMicros, 0)} a month`}
          .
        </li>
        <li>The change starts now. Your next invoice is adjusted for the days left.</li>
      </ul>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent onClose={() => close(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4" />
            {copy.title}
          </DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {tier === 'free' && (
            <>
              {planPicker}
              {periodPicker(targetPrices)}
              <PlanFeatures tier={target} />
            </>
          )}

          {maxViaPortal && upgradeToMax ? (
            <div className="text-[13px]">{maxPortalNote}</div>
          ) : (
            (tier === 'legacy_pro' || upgradeToMax) && (
              <>
                {planPicker}
                {periodPicker(targetPrices)}
                {changes}
              </>
            )
          )}

          {isSellableTier(tier) && creditsAllowed && !nothingToSell && !upgradeToMax && (
            <div className="grid grid-cols-3 gap-2" data-testid="credit-packs">
              {CREDIT_PACK_IDS.map((pack) => (
                <Button
                  key={pack}
                  variant="outline"
                  onClick={() => buyCredits(pack)}
                  disabled={busy !== null || waiting}
                  className="h-auto flex-col py-2"
                >
                  {busy === `pack-${pack}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : formatCreditPack(pack)}
                </Button>
              ))}
            </div>
          )}

          {!nothingToSell && !upgradeToMax && (
            <UsageResetAction offer={status.usageReset} periodEnd={status.usage.periodEnd} resets={status.usage.resets} placement="upgrade_modal" />
          )}

          {waiting && (
            <p className="text-[13px] text-muted-foreground">
              <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
              Finish in your browser. This updates by itself once payment completes.
            </p>
          )}
          {error && <p className="text-[13px] text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)} disabled={busy !== null}>
            {nothingToSell ? 'Done' : 'Not now'}
          </Button>
          {tier === 'free' && (
            <Button onClick={() => checkout(target)} disabled={busy !== null || waiting}>
              {busy === 'checkout' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : waiting ? (
                'Waiting for checkout…'
              ) : (
                `Upgrade to ${PLAN_TIER_LABELS[target]}: ${perPeriod(targetPrices, chosenPeriod)}`
              )}
            </Button>
          )}
          {tier === 'legacy_pro' && (
            <>
              <Button variant="outline" onClick={goToSettings} disabled={busy !== null}>
                Add credits
              </Button>
              <Button onClick={() => changePlan(target)} disabled={busy !== null || waiting}>
                {busy === 'change' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : target === 'max' ? 'Upgrade to Max' : 'Move to Pro'}
              </Button>
            </>
          )}
          {upgradeToMax && maxViaPortal && (
            <Button onClick={openPortal} disabled={busy !== null}>
              {busy === 'portal' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Manage billing'}
            </Button>
          )}
          {upgradeToMax && !maxViaPortal && (
            <Button onClick={() => changePlan('max')} disabled={busy !== null || waiting}>
              {busy === 'change' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                `Upgrade to Max: ${perPeriod(targetPrices, chosenPeriod)}`
              )}
            </Button>
          )}
          {isSellableTier(tier) && !nothingToSell && !upgradeToMax && (
            <Button variant="outline" onClick={goToSettings} disabled={busy !== null}>
              Turn on auto top-up
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What a paid plan includes, for the Free upgrade. */
function PlanFeatures({ tier }: { tier: SellableTier }) {
  return (
    <ul className="space-y-1 text-[13px] text-muted-foreground">
      <li className="flex items-center gap-2">
        <Check className="h-3.5 w-3.5" /> {hours(tier)} a month
      </li>
      <li className="flex items-center gap-2">
        <Check className="h-3.5 w-3.5" /> Every box size, up to {PLAN_LIMITS[tier].concurrentBoxes} at once
      </li>
      <li className="flex items-center gap-2">
        <Check className="h-3.5 w-3.5" /> Credits and auto top-up when you need more
      </li>
      <li className="flex items-center gap-2">
        <Check className="h-3.5 w-3.5" /> Keep every new PR mergeable and review it automatically
      </li>
      <li className="flex items-center gap-2">
        <Check className="h-3.5 w-3.5" /> Cancel anytime from Settings
      </li>
    </ul>
  );
}

function PlanOption({
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
