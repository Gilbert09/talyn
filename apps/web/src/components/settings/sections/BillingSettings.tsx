import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Download, Loader2, Lock, Smartphone, Zap } from 'lucide-react';
import {
  PLAN_LIMITS,
  PLAN_PRICES,
  PLAN_TIER_LABELS,
  SANDBOX_SIZES,
  formatBoxHoursUsage,
  formatPricePerHour,
  formatPlanPeriodLine,
  formatUsd,
  isSellableTier,
  sizePriceTable,
  type BillingOrder,
  type PlanTier,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { trackEvent } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
import { openExternal } from '../../../lib/openExternal';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useBillingStore } from '../../../stores/billing';
import {
  FREE_INCLUDED_TEXT,
  GAUGE_BAR_CLASS,
  LEGACY_INCLUDED_TEXT,
  MAX_INCLUDED_TEXT,
  PRO_INCLUDED_TEXT,
  formatLeftPercent,
  formatLongDate,
  formatShortDate,
  gaugeTone,
  leftPercent,
  maxNeedsPortal,
  usageBillingOf,
  type UsageBillingView,
} from '../../../lib/usageBilling';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { BillingTeamNotice } from '../../panels/TeamBilling';
import { CreditPackButtons, PortalButton, UsageResetAction, legacyMonthlyPrice, planPrices, proPrices } from '../../billing/BillingActions';
import { PlanCards } from '../../billing/PlanCards';
import { AutoTopupForm } from './AutoTopupForm';
import { LegacyBillingSettings, formatOrderAmount } from './LegacyBillingSettings';

/**
 * Settings → Billing. The plan and usage page when the backend serves usage
 * billing; the old Free / Unlimited page otherwise.
 */
export function BillingSettings() {
  const status = useBillingStore((s) => s.status);
  const view = useMemo(() => usageBillingOf(status), [status]);
  if (!view) return <LegacyBillingSettings />;
  return <PlanAndUsage view={view} />;
}

function tierPrice(tier: PlanTier, view: UsageBillingView): string {
  if (tier === 'free') return '$0';
  if (tier === 'legacy_pro') return `${legacyMonthlyPrice(view.status.pricing)}/month`;
  const prices = planPrices(tier, view.status.pricing) ?? proPrices(undefined);
  return prices.annual ? `${prices.monthly}/month or ${prices.annual}/year` : `${prices.monthly}/month`;
}

export function PlanAndUsage({ view }: { view: UsageBillingView }) {
  const refresh = useBillingStore((s) => s.refresh);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const { status, tier } = view;
  const limits = PLAN_LIMITS[tier];

  // Live usage on entry; the snapshot goes stale while boxes run.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const comped = status.planSource === 'override';
  const teamPaid = status.planSource === 'team';
  const subscribed = status.planSource === 'subscription';
  const pastDue = status.subscriptionStatus === 'past_due';
  const maxViaPortal = maxNeedsPortal(status);

  return (
    <div className="space-y-6" data-attr="plan-and-usage">
      <div>
        <h3 className="mb-4 text-lg font-semibold">Plan and usage</h3>
        <Card className="space-y-4 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Your plan</p>
              <p className="flex items-center gap-2 font-medium">
                {PLAN_TIER_LABELS[tier]}
                {tier !== 'free' && <Zap className="h-4 w-4 text-primary" />}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {tier !== 'free' && !comped && !teamPaid && (
                  <span data-testid="plan-period-line">
                    {formatPlanPeriodLine(tier, status.period, {
                      proMonthlyMicros: status.pricing?.proMonthlyMicros ?? PLAN_PRICES.pro.monthlyMicros,
                      proAnnualMicros: status.pricing?.proAnnualMicros ?? PLAN_PRICES.pro.annualMicros ?? 0,
                      legacyProMonthlyMicros: status.pricing?.legacyProMonthlyMicros ?? PLAN_PRICES.legacy_pro.monthlyMicros,
                      maxMonthlyMicros: status.pricing?.maxMonthlyMicros,
                    }) ?? `Plan prices: ${tierPrice(tier, view)}`}
                    .{' '}
                  </span>
                )}
                {tier === 'free' &&
                  `${FREE_INCLUDED_TEXT} a month, small and standard boxes, ${limits.concurrentBoxes} at once.`}
                {isSellableTier(tier) &&
                  `${tier === 'max' ? MAX_INCLUDED_TEXT : PRO_INCLUDED_TEXT} a month, every size, up to ${limits.concurrentBoxes} at once.`}
                {tier === 'legacy_pro' &&
                  `Your current plan: ${LEGACY_INCLUDED_TEXT} a month, every size, up to ${limits.concurrentBoxes} at once.`}
              </p>
              {tier === 'max' && subscribed && (
                <p className="mt-1 text-sm text-muted-foreground" data-testid="max-to-pro-hint">
                  To move to Pro, use Manage billing. The change starts at your next renewal.
                </p>
              )}
              {maxViaPortal && (
                <p className="mt-1 text-sm text-muted-foreground" data-testid="max-via-portal-hint">
                  Max is monthly only. To move from annual Pro to Max, use Manage billing.
                </p>
              )}
              {comped && <p className="mt-1 text-sm text-muted-foreground">Complimentary plan. Nothing to pay.</p>}
              {teamPaid && status.team && (
                <p className="mt-1 text-sm text-muted-foreground">Paid for by your team, {status.team.name}.</p>
              )}
              <p className={cn('mt-1 text-sm', pastDue ? 'text-destructive' : 'text-muted-foreground')}>
                {pastDue
                  ? 'Payment failed'
                  : status.cancelAtPeriodEnd
                    ? `Cancels${status.currentPeriodEnd ? ` on ${formatLongDate(status.currentPeriodEnd)}` : ' at the end of this period'}`
                    : 'Active'}
              </p>
              {subscribed && status.currentPeriodEnd && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {status.cancelAtPeriodEnd
                    ? `Ends ${formatLongDate(status.currentPeriodEnd)}`
                    : `Renews ${formatLongDate(status.currentPeriodEnd)}.`}
                </p>
              )}
            </div>
          </div>

          {pastDue && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="text-sm">
                Your last payment failed. Update your payment method to keep your plan. The plan drops to Free if the
                retries run out.
              </p>
            </div>
          )}

          {(teamPaid || subscribed) && (
            <div className="flex flex-wrap items-center gap-2">
              {teamPaid ? (
                <Button data-attr="plan-manage-billing" onClick={() => openSettings('teams')}>
                  Manage billing
                </Button>
              ) : (
                <PortalButton />
              )}
            </div>
          )}
        </Card>
      </div>

      <UsageCard view={view} />

      <div>
        <h3 className="mb-4 text-lg font-semibold">Plans</h3>
        <PlanCards view={view} placement="plan_page" />
      </div>

      {limits.creditsAllowed && <CreditsCard view={view} />}

      <details className="rounded-lg border bg-card p-4" data-attr="usage-explanation">
        <summary className="cursor-pointer text-sm font-medium">How usage is counted</summary>
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            One box-hour is a standard box running for one hour. Sleeping boxes use nothing. Included hours go first,
            then credits. Boxes use credits at their hourly price. Credits expire 12 months after you buy them.
          </p>
          {!limits.creditsAllowed && (
            <p className="text-sm text-muted-foreground">
              Credits and auto top-up come with Pro. Credits let you start new boxes after your included hours run out.
            </p>
          )}
          <SizesCard tier={tier} view={view} />
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Smartphone className="h-4 w-4 shrink-0" />
            The mobile app is coming soon. It is included in every plan.
          </p>
        </div>
      </details>

      <BillingTeamNotice status={status} />

      <OrderHistory />
    </div>
  );
}

export function UsageCard({ view }: { view: UsageBillingView }) {
  const { usage, status } = view;
  const tone = gaugeTone(usage);
  const percent = leftPercent(usage.percent, usage.exhausted);
  return (
    <div>
      <h3 className="mb-4 text-lg font-semibold">This period</h3>
      <Card className="space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="font-medium" data-attr="usage-text">
            {formatLeftPercent(usage.percent, usage.exhausted)}
          </span>
          <span className="text-muted-foreground">Resets {formatShortDate(usage.periodEnd)}</span>
        </div>
        <div
          className="relative h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Box-hours left"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className={cn('h-full rounded-full transition-all', GAUGE_BAR_CLASS[tone])}
            style={{ width: `${percent}%` }}
          />
        </div>
        {usage.exhausted && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="text-sm">
              Out of hours: new boxes are paused. Running turns finish.{' '}
              {PLAN_LIMITS[view.tier].creditsAllowed
                ? 'Add credits or turn on auto top-up to start new boxes now.'
                : `New boxes can start again on ${formatLongDate(usage.periodEnd)}, or upgrade to Pro now.`}
            </p>
          </div>
        )}
        <p className="text-sm text-muted-foreground">{formatBoxHoursUsage(usage.usedWsec, usage.includedWsec)} used</p>
        <UsageResetAction offer={status.usageReset} periodEnd={usage.periodEnd} resets={usage.resets} placement="billing_settings" />
        {status.concurrentBoxes && (
          <p className="text-sm text-muted-foreground" data-attr="concurrent-boxes">
            Boxes running now: {status.concurrentBoxes.used} of {status.concurrentBoxes.limit}
          </p>
        )}
      </Card>
    </div>
  );
}

export function SizesCard({
  tier,
  view,
  showPrices = false,
}: {
  tier: PlanTier;
  view: UsageBillingView;
  showPrices?: boolean;
}) {
  const rows = view.status.sizePrices ?? sizePriceTable(tier);
  return (
    <div>
      <h3 className="mb-4 text-lg font-semibold">Box sizes</h3>
      <Card className="divide-y p-0">
        {rows.map((row) => {
          const size = SANDBOX_SIZES[row.size];
          return (
            <div
              key={row.size}
              className="flex items-center gap-3 px-4 py-2.5 text-sm"
              data-attr={`size-row-${row.size}`}
            >
              <div className="min-w-0 flex-1">
                <p className={cn('font-medium', !row.allowed && 'text-muted-foreground')}>{size?.label ?? row.size}</p>
                <p className="text-xs text-muted-foreground">
                  Uses {row.weight} box-hour{row.weight === 1 ? '' : 's'} per hour
                </p>
              </div>
              {showPrices && (
                <span className="tabular-nums text-muted-foreground">{formatPricePerHour(row.priceMicrosPerHour)}</span>
              )}
              {!row.allowed && (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3" /> Pro
                </span>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function CreditsCard({ view }: { view: UsageBillingView }) {
  const [addingCredits, setAddingCredits] = useState(false);
  const credits = view.status.credits;
  const balance = credits?.balanceMicros ?? 0;
  const lots = (credits?.lots ?? []).filter((lot) => lot.remainingMicros > 0);
  return (
    <div>
      <h3 className="mb-4 text-lg font-semibold">Credits</h3>
      <Card className="space-y-4 p-4">
        <div>
          <p className="text-sm text-muted-foreground">Balance</p>
          <p className="text-2xl font-semibold tabular-nums" data-attr="credit-balance">
            {formatUsd(balance)}
          </p>
          <p className="text-sm text-muted-foreground">Auto top-up: {view.status.autoTopup?.enabled ? 'On' : 'Off'}</p>
          {view.status.autoTopup?.lastFailure && (
            <p className="text-sm text-destructive">The last auto top-up failed.</p>
          )}
          {credits && credits.expiringSoonMicros > 0 && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              {formatUsd(credits.expiringSoonMicros)} expires in the next 30 days.
            </p>
          )}
        </div>
        {lots.length > 0 && (
          <ul className="space-y-1 text-sm">
            {lots.map((lot) => (
              <li key={lot.id} className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {formatUsd(lot.remainingMicros)} of {formatUsd(lot.totalMicros)}
                </span>
                <span className="text-xs text-muted-foreground">Expires {formatLongDate(lot.expiresAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <Button
          variant="outline"
          data-attr="plan-add-credits"
          aria-expanded={addingCredits}
          aria-controls="add-credits-panel"
          onClick={() => { trackEvent('add_credits_clicked', { where: 'plan_page' }); setAddingCredits(!addingCredits); }}
        >
          Add credits
        </Button>
        {addingCredits && (
          <div id="add-credits-panel" className="space-y-4">
            <CreditPackButtons placement="billing_settings" />
            <p className="text-xs text-muted-foreground">Credits expire 12 months after you buy them.</p>
            <SizesCard tier={view.tier} view={view} showPrices />
            {view.status.autoTopup && (
              <div className="space-y-3">
                <h4 className="text-sm font-medium">Auto top-up</h4>
                <AutoTopupForm settings={view.status.autoTopup} />
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function OrderHistory() {
  const status = useBillingStore((s) => s.status);
  const [orders, setOrders] = useState<BillingOrder[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.billing
      .orders()
      .then((rows) => {
        if (!cancelled) setOrders(rows);
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [status?.tier, status?.credits?.balanceMicros]);

  if (!orders || orders.length === 0) return null;

  const openInvoice = async (orderId: string) => {
    // The invoice opens in a new tab. Reserve it now, while the click still
    // allows a popup; the URL arrives after an await.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    setBusy(orderId);
    setError(null);
    try {
      const { url } = await api.billing.invoice(orderId);
      if (tab && !tab.closed) tab.location.replace(url);
      else await openExternal(url);
    } catch (err) {
      tab?.close();
      setError(err instanceof Error ? err.message : 'Could not fetch the invoice.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h3 className="mb-4 text-lg font-semibold">Order history</h3>
      <Card className="divide-y p-0">
        {orders.map((order) => (
          <div key={order.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{order.productName ?? 'Talyn'}</p>
              <p className="text-xs text-muted-foreground">
                {formatLongDate(order.createdAt)}
                {order.invoiceNumber ? ` · ${order.invoiceNumber}` : ''}
              </p>
            </div>
            <div className="text-sm font-medium tabular-nums">{formatOrderAmount(order.amount, order.currency)}</div>
            {order.status !== 'paid' && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">
                {order.status.replace('_', ' ')}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void openInvoice(order.id)}
              disabled={busy !== null}
              className="shrink-0 gap-1.5"
            >
              {busy === order.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Invoice
            </Button>
          </div>
        ))}
      </Card>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
