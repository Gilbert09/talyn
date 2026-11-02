import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, CreditCard, Download, Loader2, Lock, Smartphone, Zap } from 'lucide-react';
import {
  PLAN_LIMITS,
  PLAN_TIER_LABELS,
  SANDBOX_SIZES,
  USAGE_ALERT_THRESHOLDS,
  formatBoxHoursUsage,
  formatPricePerHour,
  formatUsd,
  sizePriceTable,
  type BillingOrder,
  type PlanTier,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { cn } from '../../../lib/utils';
import { openExternal } from '../../../lib/openExternal';
import { useBillingStore } from '../../../stores/billing';
import {
  FREE_INCLUDED_TEXT,
  GAUGE_BAR_CLASS,
  LEGACY_INCLUDED_TEXT,
  PRO_INCLUDED_TEXT,
  formatLongDate,
  gaugeTone,
  goToHostedPage,
  usageBillingOf,
  type UsageBillingView,
} from '../../../lib/usageBilling';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { BillingTeamNotice } from '../../panels/TeamBilling';
import { CreditPackButtons, ProPlanForm, legacyMonthlyPrice, proPrices } from '../../billing/BillingActions';
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
  const prices = proPrices(view.status.pricing);
  return `${prices.monthly}/month or ${prices.annual}/year`;
}

const PRO_BENEFITS = [
  `${PRO_INCLUDED_TEXT} every month (100 hours of a large box)`,
  'Every box size, up to 100 boxes at once',
  'Credits and auto top-up when you need more',
  'Keep new PRs green and review them automatically',
];

export function PlanAndUsage({ view }: { view: UsageBillingView }) {
  const refresh = useBillingStore((s) => s.refresh);
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

  return (
    <div className="space-y-6" data-attr="plan-and-usage">
      <div>
        <h3 className="mb-4 text-lg font-semibold">Plan and usage</h3>
        <Card className="space-y-4 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Current plan</p>
              <p className="flex items-center gap-2 font-medium">
                {PLAN_TIER_LABELS[tier]}
                {tier !== 'free' && <Zap className="h-4 w-4 text-primary" />}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {tierPrice(tier, view)}.{' '}
                {tier === 'free' &&
                  `${FREE_INCLUDED_TEXT} a month, small and standard boxes, ${limits.concurrentBoxes} at once.`}
                {tier === 'pro' && `${PRO_INCLUDED_TEXT} a month, every size, up to ${limits.concurrentBoxes} at once.`}
                {tier === 'legacy_pro' &&
                  `Your current plan: ${LEGACY_INCLUDED_TEXT} a month, every size, up to ${limits.concurrentBoxes} at once.`}
              </p>
              {comped && <p className="mt-1 text-sm text-muted-foreground">Complimentary plan. Nothing to pay.</p>}
              {teamPaid && status.team && (
                <p className="mt-1 text-sm text-muted-foreground">Paid for by your team, {status.team.name}.</p>
              )}
              {subscribed && status.currentPeriodEnd && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {status.cancelAtPeriodEnd
                    ? `${PLAN_TIER_LABELS[tier]} until ${formatLongDate(status.currentPeriodEnd)}, then Free.`
                    : `Renews ${formatLongDate(status.currentPeriodEnd)}.`}
                </p>
              )}
            </div>
          </div>

          {pastDue && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <p className="text-sm">
                Your last payment failed. Update your payment method to keep your plan. The plan drops to Free if
                the retries run out.
              </p>
            </div>
          )}

          {subscribed && <PortalButton cancelAtPeriodEnd={status.cancelAtPeriodEnd} />}
        </Card>
      </div>

      <UsageCard view={view} />

      {tier === 'free' && (
        <div>
          <h3 className="mb-4 text-lg font-semibold">Upgrade to Pro</h3>
          <Card className="space-y-4 p-4">
            <ProPlanForm mode="checkout" placement="billing_settings" />
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {PRO_BENEFITS.map((line) => (
                <li key={line} className="flex items-center gap-2">
                  <Check className="h-4 w-4 shrink-0" /> {line}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      {tier === 'legacy_pro' && subscribed && <MoveToProCard view={view} />}

      <SizesCard tier={tier} view={view} />

      {limits.creditsAllowed ? (
        <CreditsCard view={view} />
      ) : (
        <div>
          <h3 className="mb-4 text-lg font-semibold">Credits</h3>
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">
              Credits and auto top-up come with Pro. When your included hours run out, credits keep new boxes
              starting.
            </p>
          </Card>
        </div>
      )}

      {limits.creditsAllowed && status.autoTopup && (
        <div>
          <h3 className="mb-4 text-lg font-semibold">Auto top-up</h3>
          <Card className="p-4">
            <AutoTopupForm settings={status.autoTopup} />
          </Card>
        </div>
      )}

      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Smartphone className="h-4 w-4 shrink-0" />
        The mobile app is coming soon. It is included in every plan.
      </p>

      <BillingTeamNotice status={status} />

      <OrderHistory />
    </div>
  );
}

function PortalButton({ cancelAtPeriodEnd }: { cancelAtPeriodEnd: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.billing.portal();
      goToHostedPage(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the billing portal.');
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Button variant="outline" onClick={() => void open()} disabled={busy} className="gap-2">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
        {cancelAtPeriodEnd ? 'Resume or manage subscription' : 'Manage subscription'}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function UsageCard({ view }: { view: UsageBillingView }) {
  const { usage, status } = view;
  const tone = gaugeTone(usage);
  const percent = Math.min(100, Math.max(0, usage.percent));
  return (
    <div>
      <h3 className="mb-4 text-lg font-semibold">This period</h3>
      <Card className="space-y-3 p-4">
        <div className="flex items-baseline justify-between gap-2 text-sm">
          <span className="font-medium" data-attr="usage-text">
            {formatBoxHoursUsage(usage.usedWsec, usage.includedWsec)}
          </span>
          <span className="text-muted-foreground">Resets on {formatLongDate(usage.periodEnd)}</span>
        </div>
        <div
          className="relative h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className={cn('h-full rounded-full transition-all', GAUGE_BAR_CLASS[tone])} style={{ width: `${percent}%` }} />
          {USAGE_ALERT_THRESHOLDS.filter((t) => t < 100).map((t) => (
            <span key={t} aria-hidden className="absolute inset-y-0 w-px bg-background/80" style={{ left: `${t}%` }} />
          ))}
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
        <p className="text-sm text-muted-foreground">
          One box-hour is a standard box running for one hour. Sleeping boxes use nothing.
        </p>
        {status.concurrentBoxes && (
          <p className="text-sm text-muted-foreground" data-attr="concurrent-boxes">
            Boxes running now: {status.concurrentBoxes.used} of {status.concurrentBoxes.limit}
          </p>
        )}
      </Card>
    </div>
  );
}

function MoveToProCard({ view }: { view: UsageBillingView }) {
  const prices = proPrices(view.status.pricing);
  return (
    <div>
      <h3 className="mb-4 text-lg font-semibold">Move to Pro</h3>
      <Card className="space-y-4 p-4">
        <ul className="space-y-1.5 text-sm">
          <li>
            Box-hours each month: {PLAN_LIMITS.legacy_pro.includedBoxHours} → {PLAN_LIMITS.pro.includedBoxHours}
          </li>
          <li>
            Price: {legacyMonthlyPrice(view.status.pricing)} → {prices.monthly} a month (or {prices.annual} a year)
          </li>
          <li className="text-muted-foreground">Everything else stays the same. The change applies to your subscription now.</li>
        </ul>
        <ProPlanForm mode="change" placement="billing_settings" />
      </Card>
    </div>
  );
}

export function SizesCard({ tier, view }: { tier: PlanTier; view: UsageBillingView }) {
  const rows = view.status.sizePrices ?? sizePriceTable(tier);
  return (
    <div>
      <h3 className="mb-4 text-lg font-semibold">Box sizes</h3>
      <Card className="divide-y p-0">
        {rows.map((row) => {
          const size = SANDBOX_SIZES[row.size];
          return (
            <div key={row.size} className="flex items-center gap-3 px-4 py-2.5 text-sm" data-attr={`size-row-${row.size}`}>
              <div className="min-w-0 flex-1">
                <p className={cn('font-medium', !row.allowed && 'text-muted-foreground')}>{size?.label ?? row.size}</p>
                <p className="text-xs text-muted-foreground">
                  Uses {row.weight} box-hour{row.weight === 1 ? '' : 's'} per hour
                </p>
              </div>
              <span className="tabular-nums text-muted-foreground">{formatPricePerHour(row.priceMicrosPerHour)}</span>
              {!row.allowed && (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  <Lock className="h-3 w-3" /> Pro
                </span>
              )}
            </div>
          );
        })}
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        Included hours go first. After that, boxes use credits at the price shown.
      </p>
    </div>
  );
}

function CreditsCard({ view }: { view: UsageBillingView }) {
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
        <div className="space-y-2">
          <p className="text-sm font-medium">Buy credits</p>
          <CreditPackButtons placement="billing_settings" />
          <p className="text-xs text-muted-foreground">Credits expire 12 months after you buy them.</p>
        </div>
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
              {busy === order.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              Invoice
            </Button>
          </div>
        ))}
      </Card>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}
