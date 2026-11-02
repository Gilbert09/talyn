import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, CreditCard, Loader2, Lock, Smartphone, Zap } from 'lucide-react';
import {
  AUTO_TOPUP_DEFAULTS,
  CREDIT_PACKS,
  CREDIT_PACK_IDS,
  MICROS_PER_DOLLAR,
  PLAN_LIMITS,
  PLAN_TIER_LABELS,
  SANDBOX_SIZES,
  boxHoursToWeightedSeconds,
  formatBoxHoursLabel,
  formatBoxHoursUsage,
  formatCreditPack,
  formatPricePerHour,
  formatUsd,
  sizePriceTable,
  validateAutoTopupConfig,
  type AutoTopupConfig,
  type CreditLot,
  type CreditPackId,
  type PlanTier,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { openExternal } from '../../../lib/openExternal';
import { trackEvent } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
import {
  GAUGE_BAR_CLASS,
  GAUGE_TEXT_CLASS,
  formatShortDate,
  gaugeTone,
  pricingOf,
  type UsageBillingStatus,
} from '../../../lib/usageBilling';
import { maybeHandleBillingLimit, useBillingStore } from '../../../stores/billing';
import { toast } from '../../../stores/toast';
import { BillingTeamNotice } from '../../panels/TeamBilling';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';
import { SettingsPage } from '../../ui/settings';
import { OrderHistory, formatRenewalDate } from './BillingOrderHistory';

type Period = 'monthly' | 'annual';

const hours = (tier: PlanTier) => formatBoxHoursLabel(boxHoursToWeightedSeconds(PLAN_LIMITS[tier].includedBoxHours));

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

/** Settings → Billing on a backend with usage billing: plan, box-hours, sizes, credits and auto top-up. */
export function PlanUsageSettings({ status }: { status: UsageBillingStatus }) {
  const refresh = useBillingStore((s) => s.refresh);
  const startCheckoutPollBurst = useBillingStore((s) => s.startCheckoutPollBurst);
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<null | 'plan' | 'credits'>(null);
  const [error, setError] = useState<string | null>(null);

  // Live numbers on entry: the meter moves while the app sits open.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The burst ends when the checkout lands (the store announces it).
  const burstLanded = useBillingStore((s) => s.status);
  useEffect(() => {
    setWaiting(null);
  }, [burstLanded?.tier, burstLanded?.credits?.balanceMicros]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (maybeHandleBillingLimit(err, 'billing_settings')) return;
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const checkoutPro = (period: Period) =>
    run(`checkout-${period}`, async () => {
      trackEvent('checkout_started', { period, plan: 'pro', placement: 'settings' });
      const { url } = await api.billing.checkout({ period, plan: 'pro' });
      await openExternal(url);
      startCheckoutPollBurst('plan');
      setWaiting('plan');
    });

  const moveToPro = (period: Period) =>
    run(`change-${period}`, async () => {
      trackEvent('plan_change_started', { period, from: status.tier, placement: 'settings' });
      await api.billing.changePlan({ to: 'pro', period });
      startCheckoutPollBurst('plan');
      setWaiting('plan');
    });

  const buyCredits = (pack: CreditPackId) =>
    run(`pack-${pack}`, async () => {
      trackEvent('credit_checkout_started', { pack, placement: 'settings' });
      const { url } = await api.billing.creditCheckout({ pack });
      await openExternal(url);
      startCheckoutPollBurst('credits');
      setWaiting('credits');
    });

  const openPortal = () =>
    run('portal', async () => {
      const { url } = await api.billing.portal();
      await openExternal(url);
      startCheckoutPollBurst('plan');
    });

  const { tier } = status;
  const creditsAllowed = PLAN_LIMITS[tier].creditsAllowed;
  const hasCredits = (status.credits?.balanceMicros ?? 0) > 0 || (status.credits?.lots.length ?? 0) > 0;

  return (
    <SettingsPage title="Plan and usage">
      <PlanCard status={status} busy={busy} onPortal={openPortal} onCheckout={checkoutPro} onMoveToPro={moveToPro} waiting={waiting === 'plan'} />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <BillingTeamNotice status={status} />
      <UsageCard status={status} />
      {(creditsAllowed || hasCredits) && (
        <CreditsCard status={status} busy={busy} onBuy={buyCredits} waiting={waiting === 'credits'} />
      )}
      {creditsAllowed && <AutoTopupCard status={status} onBuy={buyCredits} />}
      <SizesCard tier={tier} status={status} />
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Smartphone className="h-3.5 w-3.5" />
        The mobile app is coming soon, and it is included on every plan.
      </p>
      <OrderHistory planKey={tier} />
    </SettingsPage>
  );
}

function PlanCard({
  status,
  busy,
  waiting,
  onPortal,
  onCheckout,
  onMoveToPro,
}: {
  status: UsageBillingStatus;
  busy: string | null;
  waiting: boolean;
  onPortal: () => void;
  onCheckout: (period: Period) => void;
  onMoveToPro: (period: Period) => void;
}) {
  const [period, setPeriod] = useState<Period>('annual');
  const pricing = pricingOf(status);
  const { tier } = status;
  const comped = status.planSource === 'override';
  const teamPaid = status.planSource === 'team';
  const pastDue = status.subscriptionStatus === 'past_due';
  const price =
    tier === 'free'
      ? '$0'
      : tier === 'legacy_pro'
        ? `${formatUsd(pricing.legacyProMonthlyMicros, 0)}/month`
        : `${formatUsd(pricing.proMonthlyMicros, 0)}/month or ${formatUsd(pricing.proAnnualMicros, 0)}/year`;
  const canManage = tier !== 'free' && !comped && !teamPaid;
  const disabled = busy !== null || waiting;

  return (
    <div className="space-y-3">
      <Card className="space-y-2 p-3" data-testid="plan-card">
        <div>
          <p className="text-xs text-muted-foreground">Current plan</p>
          <p className="flex items-center gap-2 text-[13px] font-medium">
            {PLAN_TIER_LABELS[tier]}
            {tier !== 'free' && <Zap className="h-3.5 w-3.5 text-primary" />}
            {!comped && !teamPaid && <span className="text-xs font-normal text-muted-foreground">{price}</span>}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {hours(tier)} a month, {PLAN_LIMITS[tier].concurrentBoxes} boxes at once,{' '}
            {tier === 'free' ? 'small and standard boxes.' : 'every box size, credits and auto top-up.'}
          </p>
          {comped && <p className="mt-0.5 text-xs text-muted-foreground">Complimentary plan. Nothing to pay.</p>}
          {teamPaid && status.team && (
            <p className="mt-0.5 text-xs text-muted-foreground">Paid for by your team, {status.team.name}.</p>
          )}
          {canManage && status.currentPeriodEnd && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {status.cancelAtPeriodEnd
                ? `${PLAN_TIER_LABELS[tier]} until ${formatRenewalDate(status.currentPeriodEnd)}, then Free.`
                : `Renews ${formatRenewalDate(status.currentPeriodEnd)}.`}
            </p>
          )}
        </div>

        {pastDue && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <p className="text-xs">
              Your last payment failed. Update your payment method to keep your plan. It drops to Free if the retries
              run out.
            </p>
          </div>
        )}

        {canManage && (
          <Button variant="outline" size="sm" onClick={onPortal} disabled={busy !== null}>
            {busy === 'portal' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" />}
            {status.cancelAtPeriodEnd ? 'Resume or manage subscription' : 'Manage subscription'}
          </Button>
        )}
      </Card>

      {tier === 'free' && (
        <div data-testid="upgrade-pro">
          <SectionTitle>Upgrade to Pro</SectionTitle>
          <div className="grid grid-cols-2 gap-3">
            <Card className="relative flex flex-col gap-3 border-primary/40 p-3">
              <span className="absolute right-3 top-3 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                2 months free
              </span>
              <div>
                <p className="text-[13px] font-medium">Annual</p>
                <p className="text-lg font-semibold">
                  {formatUsd(pricing.proAnnualMicros, 0)}
                  <span className="text-xs font-normal text-muted-foreground"> /year</span>
                </p>
              </div>
              <Button onClick={() => onCheckout('annual')} disabled={disabled} className="mt-auto">
                {busy === 'checkout-annual' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                Upgrade annual
              </Button>
            </Card>
            <Card className="flex flex-col gap-3 p-3">
              <div>
                <p className="text-[13px] font-medium">Monthly</p>
                <p className="text-lg font-semibold">
                  {formatUsd(pricing.proMonthlyMicros, 0)}
                  <span className="text-xs font-normal text-muted-foreground"> /month</span>
                </p>
              </div>
              <Button variant="outline" onClick={() => onCheckout('monthly')} disabled={disabled} className="mt-auto">
                {busy === 'checkout-monthly' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                Upgrade monthly
              </Button>
            </Card>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Pro includes {hours('pro')} a month (100 hours of a large box), every box size, up to{' '}
            {PLAN_LIMITS.pro.concurrentBoxes} boxes at once, credits and auto top-up.
          </p>
          {waiting && <WaitingLine />}
        </div>
      )}

      {tier === 'legacy_pro' && !teamPaid && (
        <Card className="space-y-2 p-3" data-testid="move-to-pro">
          <p className="text-[13px] font-medium">Move to Pro</p>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
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
          <div className="flex items-center gap-2">
            <Select
              aria-label="Billing period"
              className="h-8 w-32 text-xs"
              value={period}
              disabled={disabled}
              onChange={(e) => setPeriod(e.target.value as Period)}
            >
              <option value="annual">Annual</option>
              <option value="monthly">Monthly</option>
            </Select>
            <Button size="sm" onClick={() => onMoveToPro(period)} disabled={disabled}>
              {busy?.startsWith('change-') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              Move to Pro
            </Button>
          </div>
          {waiting && <WaitingLine />}
        </Card>
      )}
    </div>
  );
}

function WaitingLine() {
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
      Finish in your browser. This page updates by itself once payment completes.
    </p>
  );
}

function UsageCard({ status }: { status: UsageBillingStatus }) {
  const { usage } = status;
  const tone = gaugeTone(usage);
  const percent = usage.exhausted ? 100 : usage.percent;
  return (
    <div>
      <SectionTitle>This period</SectionTitle>
      <Card className="space-y-2 p-3" data-testid="usage-card">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className={cn('text-[13px] font-medium', tone !== 'ok' && GAUGE_TEXT_CLASS[tone])}>
            {formatBoxHoursUsage(usage.usedWsec, usage.includedWsec)}
          </span>
          <span className="text-muted-foreground">Resets on {formatShortDate(usage.periodEnd)}</span>
        </div>
        <div
          className="relative h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Box-hours used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className={cn('h-full rounded-full transition-all', GAUGE_BAR_CLASS[tone])} style={{ width: `${percent}%` }} />
          <span aria-hidden className="absolute inset-y-0 left-1/2 w-px bg-background/80" />
          <span aria-hidden className="absolute inset-y-0 left-[80%] w-px bg-background/80" />
        </div>
        {usage.exhausted && (
          <p className="text-xs font-medium text-destructive">
            Out of hours: new boxes paused. Running turns finish.{' '}
            {PLAN_LIMITS[status.tier].creditsAllowed
              ? 'Add credits or turn on auto top-up to start new boxes.'
              : 'Upgrade to Pro, or wait for the reset.'}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          One box-hour is a standard box running for one hour. Sleeping boxes use nothing. Included hours go first, then
          credits.
        </p>
        {status.concurrentBoxes && (
          <p className="text-xs text-muted-foreground" data-testid="open-boxes">
            {status.concurrentBoxes.used} of {status.concurrentBoxes.limit} boxes running now
          </p>
        )}
      </Card>
    </div>
  );
}

function SizesCard({ tier, status }: { tier: PlanTier; status: UsageBillingStatus }) {
  const rows = status.sizePrices ?? sizePriceTable(tier);
  return (
    <div>
      <SectionTitle>Box sizes</SectionTitle>
      <Card className="p-0">
        <table className="w-full text-xs" data-testid="sizes-table">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-3 py-1.5 font-medium">Size</th>
              <th className="px-3 py-1.5 font-medium">Box-hours per hour</th>
              <th className="px-3 py-1.5 font-medium">Price above your plan</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.size} className="border-b last:border-0">
                <td className="px-3 py-1.5">
                  <span className="flex items-center gap-1.5">
                    {SANDBOX_SIZES[row.size].label}
                    {!row.allowed && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">
                        <Lock className="h-2.5 w-2.5" /> Pro
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-1.5 tabular-nums">{row.weight}</td>
                <td className="px-3 py-1.5 tabular-nums">{formatPricePerHour(row.priceMicrosPerHour)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function lotSourceLabel(lot: CreditLot): string {
  switch (lot.source) {
    case 'auto_topup':
      return 'Auto top-up';
    case 'grant':
      return 'Granted';
    case 'refund_reversal':
      return 'Refund reversal';
    default:
      return 'Purchase';
  }
}

function CreditsCard({
  status,
  busy,
  waiting,
  onBuy,
}: {
  status: UsageBillingStatus;
  busy: string | null;
  waiting: boolean;
  onBuy: (pack: CreditPackId) => void;
}) {
  const credits = status.credits;
  const canBuy = PLAN_LIMITS[status.tier].creditsAllowed;
  const balance = credits?.balanceMicros ?? 0;
  const expiring = credits?.expiringSoonMicros ?? 0;
  return (
    <div id="billing-credits">
      <SectionTitle>Credits</SectionTitle>
      <Card className="space-y-3 p-3" data-testid="credits-card">
        <div>
          <p className="text-lg font-semibold tabular-nums">{formatUsd(balance)}</p>
          <p className="text-xs text-muted-foreground">
            Boxes use credits at their size&apos;s hourly price once your included box-hours are spent. Credits expire
            12 months after you buy them.
          </p>
          {expiring > 0 && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {formatUsd(expiring)} expires in the next 30 days.
            </p>
          )}
        </div>
        {credits && credits.lots.length > 0 && (
          <ul className="divide-y rounded-md border text-xs" data-testid="credit-lots">
            {credits.lots.map((lot) => (
              <li key={lot.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
                <span>
                  {formatUsd(lot.remainingMicros)} of {formatUsd(lot.totalMicros)}
                  <span className="text-muted-foreground"> · {lotSourceLabel(lot)}</span>
                </span>
                <span className="text-muted-foreground">Expires {formatShortDate(lot.expiresAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {canBuy ? (
          <div className="grid grid-cols-3 gap-2" data-testid="credit-packs">
            {CREDIT_PACK_IDS.map((pack) => (
              <Button
                key={pack}
                variant="outline"
                size="sm"
                onClick={() => onBuy(pack)}
                disabled={busy !== null || waiting}
              >
                {busy === `pack-${pack}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : formatCreditPack(pack)}
              </Button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Buying credits comes with Pro. Credits you hold still work.</p>
        )}
        {waiting && <WaitingLine />}
      </Card>
    </div>
  );
}

function toDollars(micros: number): string {
  return String(micros / MICROS_PER_DOLLAR);
}

function fromDollars(text: string): number {
  const value = Number(text);
  return Number.isFinite(value) ? Math.round(value * MICROS_PER_DOLLAR) : Number.NaN;
}

function AutoTopupCard({ status, onBuy }: { status: UsageBillingStatus; onBuy: (pack: CreditPackId) => void }) {
  const refresh = useBillingStore((s) => s.refresh);
  const saved = status.autoTopup ?? { ...AUTO_TOPUP_DEFAULTS, monthSpentMicros: 0, lastFailure: null, lastFailureAt: null };
  const [enabled, setEnabled] = useState(saved.enabled);
  const [trigger, setTrigger] = useState(toDollars(saved.triggerMicros));
  const [pack, setPack] = useState<CreditPackId>(saved.pack);
  const [limit, setLimit] = useState(toDollars(saved.monthlyLimitMicros));
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  // A save elsewhere (another device, the WS push) replaces the form's start point.
  useEffect(() => {
    setEnabled(saved.enabled);
    setTrigger(toDollars(saved.triggerMicros));
    setPack(saved.pack);
    setLimit(toDollars(saved.monthlyLimitMicros));
  }, [saved.enabled, saved.triggerMicros, saved.pack, saved.monthlyLimitMicros]);

  const config: AutoTopupConfig = {
    enabled,
    triggerMicros: fromDollars(trigger),
    pack,
    monthlyLimitMicros: fromDollars(limit),
  };
  const dirty =
    config.enabled !== saved.enabled ||
    config.triggerMicros !== saved.triggerMicros ||
    config.pack !== saved.pack ||
    config.monthlyLimitMicros !== saved.monthlyLimitMicros;

  const save = async () => {
    const errors = validateAutoTopupConfig(config).map((e) =>
      e.startsWith('triggerMicros')
        ? 'The trigger balance must be a dollar amount, 0 or more.'
        : e.startsWith('monthlyLimitMicros')
          ? 'The monthly limit must be a dollar amount, 0 or more.'
          : e,
    );
    setProblems(errors);
    if (errors.length > 0) return;
    setSaving(true);
    try {
      await api.billing.autoTopup.update(config);
      trackEvent('auto_topup_saved', { enabled: config.enabled, pack: config.pack });
      toast.success('Auto top-up saved');
      await refresh();
    } catch (err) {
      if (!maybeHandleBillingLimit(err, 'auto_topup')) {
        setProblems([err instanceof Error ? err.message : 'Could not save auto top-up.']);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <SectionTitle>Auto top-up</SectionTitle>
      <Card className="space-y-3 p-3" data-testid="auto-topup">
        {saved.lastFailure && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <div className="flex-1 space-y-1 text-xs">
              <p>
                The last auto top-up failed{saved.lastFailureAt ? ` on ${formatShortDate(saved.lastFailureAt)}` : ''}:{' '}
                {saved.lastFailure}
              </p>
              <p className="text-muted-foreground">Buy credits now, or fix your payment method and save again.</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => onBuy(saved.pack)}>
              Buy credits
            </Button>
          </div>
        )}
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Buy credits automatically when my balance runs low
        </label>
        <div className="grid grid-cols-3 gap-2 text-xs">
          <label className="space-y-1">
            <span className="text-muted-foreground">When the balance is below ($)</span>
            <Input
              aria-label="Trigger balance in dollars"
              inputMode="decimal"
              className="h-8 text-xs"
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Buy</span>
            <Select
              aria-label="Top-up pack"
              className="h-8 text-xs"
              value={pack}
              onChange={(e) => setPack(e.target.value as CreditPackId)}
            >
              {CREDIT_PACK_IDS.map((id) => (
                <option key={id} value={id}>
                  {formatCreditPack(id)}
                </option>
              ))}
            </Select>
          </label>
          <label className="space-y-1">
            <span className="text-muted-foreground">Monthly limit ($)</span>
            <Input
              aria-label="Monthly limit in dollars"
              inputMode="decimal"
              className="h-8 text-xs"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Each top-up charges {formatUsd(CREDIT_PACKS[pack].priceMicros, 0)} to your saved card.{' '}
          {formatUsd(saved.monthSpentMicros)} spent on auto top-up this month.
        </p>
        {problems.map((p) => (
          <p key={p} className="text-xs text-destructive">
            {p}
          </p>
        ))}
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
      </Card>
    </div>
  );
}
