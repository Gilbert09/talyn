import { Check, Zap } from 'lucide-react';
import { BILLING_PERIOD_LABELS, PLAN_LIMITS, PLAN_PRICES, PLAN_TIER_LABELS, SANDBOX_SIZES, formatBoxHoursLabel, boxHoursToWeightedSeconds, formatUsd, type PlanTier } from '@talyn/shared';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { AnnualSwitch } from '../settings/sections/AnnualSwitch';
import { useBillingStore, type UpgradeReason } from '../../stores/billing';
import { useWorkspaceStore } from '../../stores/workspace';
import { trackEvent } from '../../lib/analytics';
import {
  MAX_INCLUDED_TEXT,
  PRO_INCLUDED_TEXT,
  maxPricesOf,
  refusalSentence,
  type BoxRefusalNotice,
  type UsageBillingView,
} from '../../lib/usageBilling';
import { CreditPackButtons, PlanForm, PortalButton, legacyMonthlyPrice, proPrices } from '../billing/BillingActions';

/** What the modal offers, in order. The Max offers appear only when the status carries Max prices. */
export type UsageOffer = 'pro_checkout' | 'max_checkout' | 'move_to_pro' | 'move_to_max' | 'credits' | 'auto_topup';

const GRID_COLUMNS: Record<number, string> = { 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5' };

export interface UsageModalCopy {
  title: string;
  body: string;
  offers: UsageOffer[];
}

const PRO_PITCH =
  `Pro includes ${PRO_INCLUDED_TEXT} a month, every box size, ` +
  `up to ${PLAN_LIMITS.pro.concurrentBoxes} boxes at once, and credits when you need more.`;

/**
 * The modal's title, text and offers for a reason, a refusal notice and a
 * tier. Pure, so each reason and tier is tested without a render.
 */
export function usageModalCopy(
  reason: UpgradeReason | null,
  notice: BoxRefusalNotice | null,
  view: Pick<UsageBillingView, 'tier'> & { status: Pick<UsageBillingView['status'], 'planSource' | 'autoTopup' | 'pricing'> }
): UsageModalCopy {
  const { tier } = view;
  const said = notice ? refusalSentence(notice) : null;
  const maxPrices = maxPricesOf(view.status);

  if (reason === 'compare_plans') {
    return { title: 'Compare plans', body: 'See what each plan includes.', offers: [] };
  }

  if (tier === 'free') {
    const offers: UsageOffer[] = maxPrices ? ['pro_checkout', 'max_checkout'] : ['pro_checkout'];
    switch (reason) {
      case 'usage_exhausted':
        return { title: 'Out of box-hours', body: said ?? `You have used all ${PLAN_LIMITS.free.includedBoxHours} box-hours of this period. ${PRO_PITCH}`, offers };
      case 'size_requires_pro':
        return {
          title: 'This size needs Pro',
          body: `${said ?? 'This box size needs the Pro plan.'} Free runs small and standard boxes. Pro runs every size.`,
          offers,
        };
      case 'concurrent_box_limit':
        return { title: 'All your boxes are busy', body: said ?? `The Free plan runs ${PLAN_LIMITS.free.concurrentBoxes} boxes at the same time. ${PRO_PITCH}`, offers };
      case 'credits_require_paid_plan':
      case 'add_credits':
        return {
          title: 'Credits need Pro',
          body: `The Free plan does not include credits. ${PRO_PITCH}`,
          offers,
        };
      case 'auto_keep_default':
        return {
          title: 'Keep every new PR green with Pro',
          body:
            'Keeping every new PR mergeable is a Pro feature. Talyn watches each PR you open and fixes conflicts and red CI ' +
            'without you asking. You can still turn it on for one PR at a time on Free.',
          offers,
        };
      case 'auto_review':
        return {
          title: 'Review every new PR with Pro',
          body:
            'Reviewing every new pull request automatically is a Pro feature. You can still review PRs one at a time on Free.',
          offers,
        };
      case 'task_deferred':
        return {
          title: 'A fix run is waiting',
          body:
            'Talyn wanted to fix one of your watched PRs, but your plan could not start a box. It tries again on its own. ' +
            PRO_PITCH,
          offers,
        };
      default:
        return { title: 'Upgrade to Pro', body: said ?? PRO_PITCH, offers };
    }
  }

  const subscribed = view.status.planSource === 'subscription';
  const canChangePlan = tier === 'legacy_pro' && subscribed;
  const canMoveToMax = maxPrices != null && subscribed && (tier === 'legacy_pro' || tier === 'pro');
  const topUpOff = !view.status.autoTopup?.enabled;
  const creditOffers: UsageOffer[] = topUpOff ? ['credits', 'auto_topup'] : ['credits'];

  if (reason === 'concurrent_box_limit') {
    return { title: 'All your boxes are busy', body: said ?? 'A new box can start when one stops.', offers: [] };
  }

  if (tier === 'legacy_pro') {
    const prices = proPrices(view.status.pricing);
    const move =
      `Pro gives you ${PLAN_LIMITS.pro.includedBoxHours} box-hours a month instead of ` +
      `${PLAN_LIMITS.legacy_pro.includedBoxHours}, for ${prices.monthly} a month instead of ${legacyMonthlyPrice(view.status.pricing)}.`;
    const moves: UsageOffer[] = !canChangePlan ? [] : canMoveToMax ? ['move_to_pro', 'move_to_max'] : ['move_to_pro'];
    if (reason === 'upgrade') {
      return { title: 'Move to Pro', body: move, offers: [...moves, 'credits'] };
    }
    const title = reason === 'usage_exhausted' ? 'Out of box-hours' : 'Add credits';
    const body = said ?? 'Credits keep new boxes starting after your included hours run out.';
    return {
      title,
      body: canChangePlan ? `${body} Or move to Pro: ${move}` : body,
      offers: [...creditOffers, ...moves],
    };
  }

  // Pro and Max.
  if (reason === 'upgrade' && tier === 'pro' && canMoveToMax) {
    return {
      title: 'Upgrade to Max',
      body:
        `Max gives you ${MAX_INCLUDED_TEXT} a month instead of ${PRO_INCLUDED_TEXT}, ` +
        `for ${formatUsd(maxPrices.monthlyMicros, 0)} a month.`,
      offers: ['move_to_max', 'credits'],
    };
  }
  if (reason === 'usage_exhausted') {
    return { title: 'Out of box-hours', body: said ?? 'Add credits or turn on auto top-up to start new boxes.', offers: creditOffers };
  }
  return {
    title: 'Add credits',
    body: said ?? 'Credits keep new boxes starting after your included hours run out. They last 12 months.',
    offers: creditOffers,
  };
}

/** The usage-billing modal: Pro or Max checkout, a plan upgrade, credit packs, auto top-up. */
export function UsageUpgradeModal({
  open,
  onOpenChange,
  view,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: UsageBillingView;
}) {
  const reason = useBillingStore((s) => s.upgradeReason);
  const notice = useBillingStore((s) => s.upgradeNotice);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const teamsOffered = useWorkspaceStore((s) => s.features?.teams === true);
  const copy = usageModalCopy(reason, notice, view);

  const close = () => onOpenChange(false);

  if (reason === 'compare_plans') {
    const maxPrices = maxPricesOf(view.status);
    const plans: Array<PlanTier | 'team'> = ['free', 'pro', 'team'];
    if (maxPrices || view.tier === 'max') plans.splice(2, 0, 'max');
    if (view.tier === 'legacy_pro') plans.splice(1, 0, 'legacy_pro');
    const current = view.tier === 'legacy_pro' ? view.tier : view.status.planSource === 'team' ? 'team' : view.tier;
    const subscribed = view.status.planSource === 'subscription';
    const pricing = view.status.pricing;
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-5xl" onClose={close}>
          <DialogHeader>
            <DialogTitle>Compare plans</DialogTitle>
            <DialogDescription>See what each plan includes.</DialogDescription>
          </DialogHeader>
          <div className={`grid gap-3 sm:grid-cols-2 ${GRID_COLUMNS[plans.length] ?? 'lg:grid-cols-3'}`}>
            {plans.map((plan) => {
              const limits = PLAN_LIMITS[plan === 'team' ? 'pro' : plan];
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
              return (
                <div key={plan} data-testid={`compare-plan-${plan}`} className="flex flex-col rounded-md border p-3 text-sm">
                  <div className="font-semibold">{plan === 'team' ? 'Team' : PLAN_TIER_LABELS[plan]}</div>
                  <div className="mt-1 font-medium">
                    {formatUsd(monthly, 0)}/mo
                    {plan === 'team' ? ' per seat' : ''}
                  </div>
                  {annual != null && (
                    <div className="text-xs text-muted-foreground">
                      {formatUsd(annual, 0)}/yr
                      {plan === 'team' ? ' per seat' : ''}
                      {' · Save '}{formatUsd(monthly * 12 - annual, 0)}/yr
                    </div>
                  )}
                  <ul className="my-3 space-y-1 text-xs text-muted-foreground">
                    <li>{plan === 'max' ? MAX_INCLUDED_TEXT : formatBoxHoursLabel(boxHoursToWeightedSeconds(limits.includedBoxHours))} per month</li>
                    <li>{limits.concurrentBoxes} concurrent boxes</li>
                    <li>Box sizes: {limits.sizes.map((size) => SANDBOX_SIZES[size].label).join(', ')}</li>
                    <li>Credits: {limits.creditsAllowed ? 'Yes' : 'No'}</li>
                    {plan === 'team' && <li>Each seat has its own included box-hours.</li>}
                  </ul>
                  <div className="mt-auto space-y-2">
                    {plan === current ? (
                      <>
                        <p className="font-medium text-primary">
                          Your plan{plan !== 'team' && view.status.planSource === 'subscription' && view.status.period ? ` · ${BILLING_PERIOD_LABELS[view.status.period]}` : ''}
                        </p>
                        {(plan === 'pro' || plan === 'max') && <AnnualSwitch status={view.status} placement="compare_plans" />}
                      </>
                    ) : plan === 'pro' && view.tier === 'free' ? (
                      <PlanForm mode="checkout" placement="upgrade_modal" />
                    ) : plan === 'pro' && view.tier === 'legacy_pro' && subscribed ? (
                      <PlanForm mode="change" placement="upgrade_modal" onChanged={close} />
                    ) : plan === 'pro' && view.tier === 'max' && subscribed ? (
                      <>
                        <p className="text-xs text-muted-foreground">To move to Pro, use Manage billing. The change starts at your next renewal.</p>
                        <PortalButton secondary />
                      </>
                    ) : plan === 'max' && view.tier === 'free' ? (
                      <PlanForm plan="max" mode="checkout" placement="upgrade_modal" />
                    ) : plan === 'max' && (view.tier === 'pro' || view.tier === 'legacy_pro') && subscribed ? (
                      <PlanForm plan="max" mode="change" placement="upgrade_modal" onChanged={close} />
                    ) : plan === 'team' ? (
                      <Button variant="outline" className="w-full" onClick={() => { trackEvent('team_offer_opened', { placement: 'upgrade_modal' }); close(); openSettings('teams'); }}>Explore Team</Button>
                    ) : null}
                    {limits.creditsAllowed && plan === current && (
                      <button type="button" className="text-xs text-primary hover:underline" onClick={() => { close(); openSettings('billing'); }}>Add credits</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter><Button variant="ghost" onClick={close}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClose={close}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            {copy.title}
          </DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {copy.offers.map((offer) => {
            switch (offer) {
              case 'pro_checkout':
                return (
                  <div key={offer} className="space-y-3">
                    <PlanForm mode="checkout" placement="upgrade_modal" />
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      <li className="flex items-center gap-2">
                        <Check className="h-4 w-4" /> {PRO_INCLUDED_TEXT} every month
                      </li>
                      <li className="flex items-center gap-2">
                        <Check className="h-4 w-4" /> Every box size, up to {PLAN_LIMITS.pro.concurrentBoxes} at once
                      </li>
                      <li className="flex items-center gap-2">
                        <Check className="h-4 w-4" /> Credits and auto top-up
                      </li>
                      <li className="flex items-center gap-2">
                        <Check className="h-4 w-4" /> Cancel anytime from Settings
                      </li>
                    </ul>
                  </div>
                );
              case 'move_to_pro':
                return (
                  <div key={offer} className="space-y-2">
                    <p className="text-sm font-medium">Move to Pro</p>
                    <PlanForm mode="change" placement="upgrade_modal" onChanged={close} />
                  </div>
                );
              case 'max_checkout':
              case 'move_to_max':
                return (
                  <div key={offer} className="space-y-2" data-testid={`offer-${offer}`}>
                    <p className="text-sm font-medium">Max · {MAX_INCLUDED_TEXT} a month</p>
                    {offer === 'max_checkout' ? (
                      <PlanForm plan="max" mode="checkout" placement="upgrade_modal" />
                    ) : (
                      <PlanForm plan="max" mode="change" placement="upgrade_modal" onChanged={close} />
                    )}
                  </div>
                );
              case 'credits':
                return (
                  <div key={offer} className="space-y-2">
                    <p className="text-sm font-medium">Add credits</p>
                    <CreditPackButtons placement="upgrade_modal" />
                  </div>
                );
              case 'auto_topup':
                return (
                  <p key={offer} className="text-sm text-muted-foreground">
                    Or{' '}
                    <button
                      type="button"
                      className="text-primary underline-offset-2 hover:underline"
                      onClick={() => {
                        close();
                        openSettings('billing');
                      }}
                    >
                      turn on auto top-up
                    </button>{' '}
                    so this does not happen again.
                  </p>
                );
            }
          })}
          {teamsOffered && copy.offers.includes('pro_checkout') && (
            <p className="text-sm text-muted-foreground">
              Buying for a team?{' '}
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => {
                  trackEvent('team_offer_opened', { placement: 'upgrade_modal' });
                  close();
                  openSettings('teams');
                }}
              >
                Pay for everyone on one invoice
              </button>
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close}>
            {copy.offers.length === 0 ? 'Done' : 'Not now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
