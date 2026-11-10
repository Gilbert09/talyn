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
  formatBoxHoursUsage,
  formatCreditPack,
  formatPlanPeriodLine,
  formatPricePerHour,
  formatUsd,
  isSellableTier,
  sellableTierPrices,
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
  formatLeftPercent,
  formatShortDate,
  gaugeTone,
  includedHoursText,
  leftPercent,
  maxNeedsPortal,
  pricingOf,
  type UsageBillingStatus,
} from '../../../lib/usageBilling';
import { useWorkspaceStore } from '../../../stores/workspace';
import { maybeHandleBillingLimit, trackBillingFailure, useBillingStore } from '../../../stores/billing';
import { toast } from '../../../stores/toast';
import { BillingTeamNotice } from '../../panels/TeamBilling';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';
import { SettingsPage } from '../../ui/settings';
import { OrderHistory, formatRenewalDate } from './BillingOrderHistory';
import { PlanCards } from '../../billing/PlanCards';
import { UsageResetAction } from '../../billing/UsageResetAction';

const hours = includedHoursText;

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

/** Show the plan, usage left, and controls for credits. */
export function PlanUsageSettings({ status }: { status: UsageBillingStatus }) {
  const refresh = useBillingStore((s) => s.refresh);
  const startCheckoutPollBurst = useBillingStore((s) => s.startCheckoutPollBurst);
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<null | 'credits'>(null);
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
      trackBillingFailure(key === 'portal' ? 'plan_change_failed' : 'credit_checkout_failed', key === 'portal' ? 'portal' : 'create_checkout', err);
      if (maybeHandleBillingLimit(err, 'billing_settings')) return;
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(null);
    }
  };

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

  return (
    <SettingsPage title="Plan and usage">
      <PlanCard status={status} busy={busy} onPortal={openPortal} />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <UsageCard status={status} />
      <div>
        <SectionTitle>Plans</SectionTitle>
        <PlanCards status={status} placement="plan_page" />
      </div>
      {creditsAllowed && <CreditsCard status={status} busy={busy} onBuy={buyCredits} waiting={waiting === 'credits'} />}
      <details className="rounded-lg border bg-card p-3" data-attr="usage-explanation">
        <summary className="cursor-pointer text-[13px] font-medium">How usage is counted</summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            One box-hour is a standard box running for one hour. Sleeping boxes use nothing. Included hours go first,
            then credits. Boxes use credits at their hourly price. Credits expire 12 months after you buy them.
          </p>
          <SizesCard tier={tier} status={status} />
          {!creditsAllowed && status.credits && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Credits you hold still work. Buying credits comes with Pro.
              </p>
              <CreditBalance credits={status.credits} />
            </div>
          )}
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Smartphone className="h-3.5 w-3.5" />
            The mobile app is coming soon. It is included on every plan.
          </p>
        </div>
      </details>
      <BillingTeamNotice status={status} />
      <OrderHistory planKey={tier} />
    </SettingsPage>
  );
}

function PlanCard({
  status,
  busy,
  onPortal,
}: {
  status: UsageBillingStatus;
  busy: string | null;
  onPortal: () => void;
}) {
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const pricing = pricingOf(status);
  const { tier } = status;
  const comped = status.planSource === 'override';
  const teamPaid = status.planSource === 'team';
  const pastDue = status.subscriptionStatus === 'past_due';
  const canManage = tier !== 'free' && !comped && !teamPaid;
  const maxViaPortal = maxNeedsPortal(status);
  const prices = isSellableTier(tier) ? sellableTierPrices(tier, pricing) : null;
  const price =
    tier === 'legacy_pro'
      ? `${formatUsd(pricing.legacyProMonthlyMicros, 0)}/month`
      : prices
        ? prices.annualMicros != null
          ? `${formatUsd(prices.monthlyMicros, 0)}/month or ${formatUsd(prices.annualMicros, 0)}/year`
          : `${formatUsd(prices.monthlyMicros, 0)}/month`
        : null;

  const periodLine = formatPlanPeriodLine(tier, status.period, pricing);

  return (
    <Card className="space-y-3 p-3" data-testid="plan-card">
      <div>
        <SectionTitle>Your plan</SectionTitle>
        <p className="flex items-center gap-2 text-[13px] font-medium">
          {PLAN_TIER_LABELS[tier]}
          {tier !== 'free' && <Zap className="h-3.5 w-3.5 text-primary" />}
        </p>
        {tier !== 'free' && !comped && !teamPaid && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="plan-period-line">
            {periodLine ?? (price ? `Plan prices: ${price}` : null)}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          {hours(tier)} a month, {PLAN_LIMITS[tier].concurrentBoxes} boxes at once,{' '}
          {tier === 'free' ? 'small and standard boxes.' : 'every box size, credits and auto top-up.'}
        </p>
        {tier === 'max' && canManage && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="max-to-pro-hint">
            To move to Pro, use Manage billing. The change starts at your next renewal.
          </p>
        )}
        {maxViaPortal && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="max-via-portal-hint">
            Max is monthly only. To move from annual Pro to Max, use Manage billing.
          </p>
        )}
        {comped && <p className="mt-1 text-xs text-muted-foreground">Complimentary plan. Nothing to pay.</p>}
        {teamPaid && status.team && (
          <p className="mt-1 text-xs text-muted-foreground">Paid for by your team, {status.team.name}.</p>
        )}
        <p className={cn('mt-1 text-xs', pastDue ? 'text-destructive' : 'text-muted-foreground')}>
          {pastDue
            ? 'Payment failed'
            : status.cancelAtPeriodEnd
              ? `Cancels${status.currentPeriodEnd ? ` on ${formatRenewalDate(status.currentPeriodEnd)}` : ' at the end of this period'}`
              : 'Active'}
        </p>
        {canManage && status.currentPeriodEnd && (
          <p className="mt-1 text-xs text-muted-foreground">
            {status.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {formatRenewalDate(status.currentPeriodEnd)}
          </p>
        )}
      </div>
      {pastDue && (
        <p className="text-xs text-destructive">
          Your last payment failed. Update your payment method to keep your plan. The plan drops to Free if the retries
          run out.
        </p>
      )}
      {(canManage || teamPaid) && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            data-attr="plan-manage-billing"
            onClick={teamPaid ? () => openSettings('teams') : onPortal}
            disabled={busy !== null}
          >
            {busy === 'portal' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CreditCard className="h-3.5 w-3.5" />
            )}
            Manage billing
          </Button>
        </div>
      )}
    </Card>
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
  const percent = leftPercent(usage.percent, usage.exhausted);
  return (
    <div>
      <SectionTitle>This period</SectionTitle>
      <Card className="space-y-2 p-3" data-testid="usage-card">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className={cn('text-[13px] font-medium', tone !== 'ok' && GAUGE_TEXT_CLASS[tone])}>
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
          <p className="text-xs font-medium text-destructive">
            Out of hours: new boxes paused. Running turns finish.{' '}
            {PLAN_LIMITS[status.tier].creditsAllowed
              ? 'Add credits or turn on auto top-up to start new boxes.'
              : 'Upgrade to Pro, or wait for the reset.'}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{formatBoxHoursUsage(usage.usedWsec, usage.includedWsec)} used</p>
        <UsageResetAction offer={status.usageReset} periodEnd={usage.periodEnd} resets={usage.resets} placement="settings" />
        {status.concurrentBoxes && (
          <p className="text-xs text-muted-foreground" data-testid="open-boxes">
            {status.concurrentBoxes.used} of {status.concurrentBoxes.limit} boxes running now
          </p>
        )}
      </Card>
    </div>
  );
}

function SizesCard({
  tier,
  status,
  showPrices = false,
}: {
  tier: PlanTier;
  status: UsageBillingStatus;
  showPrices?: boolean;
}) {
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
              {showPrices && <th className="px-3 py-1.5 font-medium">Price above your plan</th>}
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
                {showPrices && (
                  <td className="px-3 py-1.5 tabular-nums">{formatPricePerHour(row.priceMicrosPerHour)}</td>
                )}
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

function CreditBalance({ credits }: { credits: UsageBillingStatus['credits'] }) {
  const balance = credits?.balanceMicros ?? 0;
  const expiring = credits?.expiringSoonMicros ?? 0;
  return (
    <>
      <div>
        <p className="text-xs text-muted-foreground">Balance</p>
        <p className="text-lg font-semibold tabular-nums">{formatUsd(balance)}</p>
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
    </>
  );
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
  const [addingCredits, setAddingCredits] = useState(false);
  return (
    <div id="billing-credits">
      <SectionTitle>Credits</SectionTitle>
      <Card className="space-y-3 p-3" data-testid="credits-card">
        <CreditBalance credits={status.credits} />
        <p className="text-xs text-muted-foreground">Auto top-up: {status.autoTopup?.enabled ? 'On' : 'Off'}</p>
        {status.autoTopup?.lastFailure && <p className="text-xs text-destructive">The last auto top-up failed.</p>}
        <Button
          size="sm"
          variant="outline"
          data-attr="plan-add-credits"
          aria-expanded={addingCredits}
          aria-controls="add-credits-panel"
          onClick={() => { trackEvent('add_credits_clicked', { where: 'plan_page' }); setAddingCredits(!addingCredits); }}
        >
          Add credits
        </Button>
        {addingCredits && (
          <div id="add-credits-panel" className="space-y-3">
            <div className="grid grid-cols-3 gap-2" data-testid="credit-packs">
              {CREDIT_PACK_IDS.map((pack) => (
                <Button
                  key={pack}
                  data-attr={`credit-pack-${pack}`}
                  variant="outline"
                  size="sm"
                  onClick={() => onBuy(pack)}
                  disabled={busy !== null || waiting}
                >
                  {busy === `pack-${pack}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : formatCreditPack(pack)}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">Credits expire 12 months after you buy them.</p>
            <SizesCard tier={status.tier} status={status} showPrices />
            <AutoTopupCard status={status} onBuy={onBuy} />
          </div>
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
  const saved = status.autoTopup ?? {
    ...AUTO_TOPUP_DEFAULTS,
    monthSpentMicros: 0,
    lastFailure: null,
    lastFailureAt: null,
  };
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
            <Button size="sm" variant="outline" data-attr="auto-topup-buy-credits" onClick={() => onBuy(saved.pack)}>
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
        <Button size="sm" data-attr="auto-topup-save" onClick={() => void save()} disabled={saving || !dirty}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
      </Card>
    </div>
  );
}
