import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Zap } from 'lucide-react';
import {
  CREDIT_PACK_IDS,
  PLAN_LIMITS,
  PLAN_TIER_LABELS,
  formatBoxHoursLabel,
  formatCreditPack,
  formatUsd,
  boxHoursToWeightedSeconds,
  type CreditPackId,
  type PlanTier,
} from '@talyn/shared';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { api } from '../../lib/api';
import { openExternal } from '../../lib/openExternal';
import { trackEvent } from '../../lib/analytics';
import { trackBillingFailure } from '../../stores/billing';
import { formatShortDate, pricingOf, type BoxNotice, type UsageBillingStatus } from '../../lib/usageBilling';
import { useBillingStore, type UpgradeReason } from '../../stores/billing';
import { useWorkspaceStore } from '../../stores/workspace';

type Period = 'monthly' | 'annual';

const hours = (tier: PlanTier) => formatBoxHoursLabel(boxHoursToWeightedSeconds(PLAN_LIMITS[tier].includedBoxHours));

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
}): { title: string; body: string } {
  const { tier, reason, notice } = input;
  const reset = formatShortDate(notice?.periodEnd ?? input.periodEnd ?? '');
  const own = notice?.message?.trim() || null;
  switch (reason) {
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
      if (tier === 'pro') {
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
  const movedToPro = start != null && start.tier !== 'pro' && status.tier === 'pro';
  const creditsLanded = start != null && (status.credits?.balanceMicros ?? 0) > start.balance;

  const pricing = pricingOf(status);
  const { tier } = status;
  const copy = usageUpgradeCopy({ tier, reason, notice, periodEnd: status.usage.periodEnd });
  const creditsAllowed = PLAN_LIMITS[tier].creditsAllowed;
  // A full box cap on Pro is not something money fixes: there is nothing to sell.
  const nothingToSell = tier === 'pro' && reason === 'concurrent_box_limit';

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
      const event = key === 'checkout' ? 'checkout_failed' : key === 'change' ? 'plan_change_failed' : 'credit_checkout_failed';
      trackBillingFailure(event, 'create_checkout', err);
      if (key === 'change') useBillingStore.getState().clearPlanChange();
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const checkoutPro = () =>
    run('checkout', async () => {
      trackEvent('checkout_started', { period, plan: 'pro', reason });
      const { url } = await api.billing.checkout({ period, plan: 'pro' });
      await openExternal(url);
      startCheckoutPollBurst('plan');
      setWaiting(true);
    });

  const moveToPro = () =>
    run('change', async () => {
      trackEvent('plan_change_started', { period, from: tier, reason });
      useBillingStore.getState().markPlanChangeStarted(period);
      await api.billing.changePlan({ to: 'pro', period });
      startCheckoutPollBurst('plan');
      setWaiting(true);
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

  if (movedToPro || creditsLanded) {
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent onClose={() => close(false)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              {movedToPro ? 'You are on Pro' : 'Credits added'}
            </DialogTitle>
            <DialogDescription>
              {movedToPro
                ? `You have ${hours('pro')} a month and every box size.`
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

  const periodPicker = (
    <div className="grid grid-cols-2 gap-2">
      <PlanOption
        label="Annual"
        price={`${formatUsd(pricing.proAnnualMicros, 0)}/yr`}
        hint="2 months free"
        selected={period === 'annual'}
        onSelect={() => setPeriod('annual')}
        disabled={busy !== null || waiting}
      />
      <PlanOption
        label="Monthly"
        price={`${formatUsd(pricing.proMonthlyMicros, 0)}/mo`}
        selected={period === 'monthly'}
        onSelect={() => setPeriod('monthly')}
        disabled={busy !== null || waiting}
      />
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
              {periodPicker}
              <ProFeatures />
            </>
          )}

          {tier === 'legacy_pro' && (
            <>
              {periodPicker}
              <div className="rounded-md border p-3 text-[13px]" data-testid="legacy-changes">
                <p className="font-medium">What changes when you move to Pro</p>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  <li>
                    {hours('legacy_pro')} a month becomes {hours('pro')}.
                  </li>
                  <li>
                    {formatUsd(pricing.legacyProMonthlyMicros, 0)} a month becomes{' '}
                    {period === 'annual'
                      ? `${formatUsd(pricing.proAnnualMicros, 0)} a year`
                      : `${formatUsd(pricing.proMonthlyMicros, 0)} a month`}
                    .
                  </li>
                  <li>The change starts now. Your next invoice is adjusted for the days left.</li>
                </ul>
              </div>
            </>
          )}

          {tier === 'pro' && creditsAllowed && !nothingToSell && (
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
            <Button onClick={checkoutPro} disabled={busy !== null || waiting}>
              {busy === 'checkout' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : waiting ? (
                'Waiting for checkout…'
              ) : (
                `Upgrade to Pro: ${
                  period === 'annual'
                    ? `${formatUsd(pricing.proAnnualMicros, 0)}/yr`
                    : `${formatUsd(pricing.proMonthlyMicros, 0)}/mo`
                }`
              )}
            </Button>
          )}
          {tier === 'legacy_pro' && (
            <>
              <Button variant="outline" onClick={goToSettings} disabled={busy !== null}>
                Add credits
              </Button>
              <Button onClick={moveToPro} disabled={busy !== null || waiting}>
                {busy === 'change' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Move to Pro'}
              </Button>
            </>
          )}
          {tier === 'pro' && !nothingToSell && (
            <Button variant="outline" onClick={goToSettings} disabled={busy !== null}>
              Turn on auto top-up
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProFeatures() {
  return (
    <ul className="space-y-1 text-[13px] text-muted-foreground">
      <li className="flex items-center gap-2">
        <Check className="h-3.5 w-3.5" /> {hours('pro')} a month (100 hours of a large box)
      </li>
      <li className="flex items-center gap-2">
        <Check className="h-3.5 w-3.5" /> Every box size, up to {PLAN_LIMITS.pro.concurrentBoxes} at once
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
