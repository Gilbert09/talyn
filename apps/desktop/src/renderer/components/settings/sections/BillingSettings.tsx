import { useEffect, useState } from 'react';
import { AlertCircle, Check, CreditCard, Loader2, Zap } from 'lucide-react';
import { api } from '../../../lib/api';
import { openExternal } from '../../../lib/openExternal';
import { cn } from '../../../lib/utils';
import { useBillingStore } from '../../../stores/billing';
import { BillingTeamNotice } from '../../panels/TeamBilling';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { SettingsPage } from '../../ui/settings';
import { hasUsageBilling } from '../../../lib/usageBilling';
import { PlanUsageSettings } from './PlanUsageSettings';
import { OrderHistory, formatRenewalDate } from './BillingOrderHistory';

/** One free-plan usage row: label, n/limit count, and a fill bar that goes
 *  destructive at the cap. Used for active tasks and the merge queue. */
function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const atLimit = used >= limit;
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-medium', atLimit && 'text-destructive')}>
          {used}/{limit}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', atLimit ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${Math.min(100, (used / Math.max(1, limit)) * 100)}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Settings → Billing. With usage billing it is the plan and usage page; on an
 * older backend (the production backend until release) it is the old page.
 */
export function BillingSettings() {
  const status = useBillingStore((s) => s.status);
  if (hasUsageBilling(status)) return <PlanUsageSettings status={status} />;
  return <LegacyBillingSettings />;
}

function LegacyBillingSettings() {
  const status = useBillingStore((s) => s.status);
  const refresh = useBillingStore((s) => s.refresh);
  const startCheckoutPollBurst = useBillingStore((s) => s.startCheckoutPollBurst);
  const [portalBusy, setPortalBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState<null | 'monthly' | 'annual'>(null);
  const [awaitingCheckout, setAwaitingCheckout] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const billingOn = status?.billingEnabled === true;

  // Live usage on entry — the snapshot's activeTasks goes stale as tasks
  // finish in the background.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Checkout directly from the plan cards — the settings page IS the pitch,
  // so no modal detour here (the UpgradeModal stays for the at-limit flow).
  const startCheckout = async (period: 'monthly' | 'annual') => {
    setCheckoutBusy(period);
    setError(null);
    try {
      const { url } = await api.billing.checkout({ period });
      await openExternal(url);
      startCheckoutPollBurst();
      setAwaitingCheckout(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout');
    } finally {
      setCheckoutBusy(null);
    }
  };

  const openPortal = async () => {
    setPortalBusy(true);
    setError(null);
    try {
      const { url } = await api.billing.portal();
      await openExternal(url);
      // Portal changes (cancel/resume/payment method) also land via webhook.
      startCheckoutPollBurst();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the billing portal');
    } finally {
      setPortalBusy(false);
    }
  };

  if (!status) {
    return (
      <SettingsPage title="Billing">
        <Card className="p-3">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
        </Card>
      </SettingsPage>
    );
  }

  if (!status.billingEnabled) {
    return (
      <SettingsPage title="Billing">
        <div>
          <Card className="p-3">
            <p className="text-xs text-muted-foreground">
              Billing is not configured on this backend — all plans run without limits.
            </p>
          </Card>
        </div>
      </SettingsPage>
    );
  }

  const comped = status.planSource === 'override';
  // A team seat pays: there is no personal subscription to manage or renew.
  const teamPaid = status.planSource === 'team';
  const free = status.plan === 'free';
  const pastDue = status.subscriptionStatus === 'past_due';
  const limit = status.activeTaskLimit ?? 0;

  return (
    <SettingsPage title="Billing">
      <div>
        <Card className="p-3 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Current plan</p>
              <p className="text-[13px] font-medium flex items-center gap-2">
                {free ? 'Free' : 'Unlimited'}
                {!free && <Zap className="w-3.5 h-3.5 text-primary" />}
              </p>
              {comped && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Complimentary plan — unlimited tasks, nothing to pay.
                </p>
              )}
              {teamPaid && status.team && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Paid for by your team, {status.team.name}.
                </p>
              )}
              {free && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Up to {limit} tasks running, {status.mergeQueueLimit ?? limit} PRs in the
                  merge queue, {status.workflowLimit ?? limit} workflows and{' '}
                  {status.loopLimit ?? limit} loops, across all your workspaces.
                </p>
              )}
              {!free && !comped && !teamPaid && status.currentPeriodEnd && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {status.cancelAtPeriodEnd
                    ? `Unlimited until ${formatRenewalDate(status.currentPeriodEnd)}, then Free.`
                    : `Renews ${formatRenewalDate(status.currentPeriodEnd)}.`}
                </p>
              )}
            </div>
          </div>

          {free && (
            <>
              <UsageMeter label="Active tasks" used={status.activeTasks} limit={limit} />
              <UsageMeter
                label="Merge queue"
                used={status.queuedPrs}
                limit={status.mergeQueueLimit ?? limit}
              />
              <UsageMeter
                label="Workflows"
                used={status.workflows}
                limit={status.workflowLimit ?? limit}
              />
              <UsageMeter
                label="Loops"
                used={status.loops}
                limit={status.loopLimit ?? limit}
              />
            </>
          )}

          {pastDue && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <AlertCircle className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />
              <p className="text-xs">
                Your last payment failed. Update your payment method to keep unlimited tasks —
                the plan drops to Free if the retries run out.
              </p>
            </div>
          )}

          {!comped && !free && !teamPaid && (
            <Button
              variant="outline"
              size="sm"
              onClick={openPortal}
              disabled={portalBusy}
            >
              {portalBusy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CreditCard className="w-3.5 h-3.5" />
              )}
              {status.cancelAtPeriodEnd ? 'Resume or manage subscription' : 'Manage subscription'}
            </Button>
          )}

          {/* Checkout errors render under the plan cards below; this slot is
              for the portal path only. */}
          {!free && error && <p className="text-xs text-destructive">{error}</p>}
        </Card>
      </div>

      <BillingTeamNotice status={status} />

      {free && (
        <div>
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-2">Upgrade to Unlimited</h3>
          <div className="grid grid-cols-2 gap-3">
            <Card className="p-3 flex flex-col gap-3 relative border-primary/40">
              <span className="absolute right-3 top-3 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                2 months free
              </span>
              <div>
                <p className="text-[13px] font-medium">Annual</p>
                <p className="text-lg font-semibold">
                  $150
                  <span className="text-xs font-normal text-muted-foreground"> /year</span>
                </p>
              </div>
              <Button
                onClick={() => startCheckout('annual')}
                disabled={checkoutBusy !== null || awaitingCheckout}
                className="mt-auto"
              >
                {checkoutBusy === 'annual' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Zap className="w-3.5 h-3.5" />
                )}
                Upgrade annual
              </Button>
            </Card>
            <Card className="p-3 flex flex-col gap-3">
              <div>
                <p className="text-[13px] font-medium">Monthly</p>
                <p className="text-lg font-semibold">
                  $15
                  <span className="text-xs font-normal text-muted-foreground"> /month</span>
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => startCheckout('monthly')}
                disabled={checkoutBusy !== null || awaitingCheckout}
                className="mt-auto"
              >
                {checkoutBusy === 'monthly' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Zap className="w-3.5 h-3.5" />
                )}
                Upgrade monthly
              </Button>
            </Card>
          </div>

          {awaitingCheckout && (
            <p className="text-xs text-muted-foreground mt-3">
              <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
              Finish checkout in your browser — this page updates by itself once payment
              completes.
            </p>
          )}
          {error && <p className="text-xs text-destructive mt-3">{error}</p>}

          <ul className="space-y-1.5 text-xs text-muted-foreground mt-3">
            <li className="flex items-center gap-2">
              <Check className="w-3.5 h-3.5" /> Unlimited concurrent tasks
            </li>
            <li className="flex items-center gap-2">
              <Check className="w-3.5 h-3.5" /> Merge queue &amp; auto-keep-mergeable never wait for a
              free slot
            </li>
            <li className="flex items-center gap-2">
              <Check className="w-3.5 h-3.5" /> Cancel anytime
            </li>
          </ul>
        </div>
      )}

      {billingOn && <OrderHistory planKey={status.plan} fallbackName="Talyn Unlimited" />}
    </SettingsPage>
  );
}
