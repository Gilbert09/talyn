import { Check, Zap } from 'lucide-react';
import { PLAN_LIMITS } from '@talyn/shared';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { useBillingStore, type UpgradeReason } from '../../stores/billing';
import { useWorkspaceStore } from '../../stores/workspace';
import { trackEvent } from '../../lib/analytics';
import {
  PRO_INCLUDED_TEXT,
  refusalSentence,
  type BoxRefusalNotice,
  type UsageBillingView,
} from '../../lib/usageBilling';
import { CreditPackButtons, ProPlanForm, legacyMonthlyPrice, proPrices } from '../billing/BillingActions';

/** What the modal offers, in order. */
export type UsageOffer = 'pro_checkout' | 'move_to_pro' | 'credits' | 'auto_topup';

export interface UsageModalCopy {
  title: string;
  body: string;
  offers: UsageOffer[];
}

const PRO_PITCH =
  `Pro includes ${PRO_INCLUDED_TEXT} a month (100 hours of a large box), every box size, ` +
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

  if (tier === 'free') {
    const offers: UsageOffer[] = ['pro_checkout'];
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

  const canChangePlan = tier === 'legacy_pro' && view.status.planSource === 'subscription';
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
    if (reason === 'upgrade') {
      return { title: 'Move to Pro', body: move, offers: canChangePlan ? ['move_to_pro', 'credits'] : ['credits'] };
    }
    const title = reason === 'usage_exhausted' ? 'Out of box-hours' : 'Add credits';
    const body = said ?? 'Credits keep new boxes starting after your included hours run out.';
    return {
      title,
      body: canChangePlan ? `${body} Or move to Pro: ${move}` : body,
      offers: canChangePlan ? [...creditOffers, 'move_to_pro'] : creditOffers,
    };
  }

  // Pro.
  if (reason === 'usage_exhausted') {
    return { title: 'Out of box-hours', body: said ?? 'Add credits or turn on auto top-up to start new boxes.', offers: creditOffers };
  }
  return {
    title: 'Add credits',
    body: said ?? 'Credits keep new boxes starting after your included hours run out. They last 12 months.',
    offers: creditOffers,
  };
}

/** The usage-billing modal: Pro checkout, Move to Pro, credit packs, auto top-up. */
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
                    <ProPlanForm mode="checkout" placement="upgrade_modal" />
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
                    <ProPlanForm mode="change" placement="upgrade_modal" onChanged={close} />
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
