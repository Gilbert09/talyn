import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { PLAN_PRICES, annualSavingsMicros, formatUsd, type BillingStatus } from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException, trackEvent } from '../../../lib/analytics';
import { useBillingStore } from '../../../stores/billing';
import { toast } from '../../../stores/toast';
import { Button } from '../../ui/button';

/** A monthly Pro subscriber paying for themselves: the only account the switch applies to. */
export function canSwitchToAnnual(status: BillingStatus): boolean {
  return (
    status.tier === 'pro' &&
    status.planSource === 'subscription' &&
    status.period === 'monthly' &&
    !status.cancelAtPeriodEnd &&
    status.subscriptionStatus !== 'past_due'
  );
}

/**
 * "Switch to annual · save $80 a year", with a confirm step. Polar bills the
 * change as a prorated invoice, charged now to the saved card; the amount is
 * Polar's, so the text says that and does not quote a number.
 */
export function AnnualSwitch({ status, placement }: { status: BillingStatus; placement: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done) return <p className="text-xs text-muted-foreground" data-testid="annual-switch-done">Switched to annual. Your plan updates in a moment.</p>;
  if (!canSwitchToAnnual(status)) return null;
  const pricing = {
    proMonthlyMicros: status.pricing?.proMonthlyMicros ?? PLAN_PRICES.pro.monthlyMicros,
    proAnnualMicros: status.pricing?.proAnnualMicros ?? PLAN_PRICES.pro.annualMicros ?? 0,
  };
  const saving = formatUsd(annualSavingsMicros(pricing), 0);
  const annual = formatUsd(pricing.proAnnualMicros, 0);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    trackEvent('annual_switch_started', { placement });
    try {
      await api.billing.changePlan({ to: 'pro', period: 'annual' });
      trackEvent('annual_switch_completed', { placement });
      setDone(true);
      toast.success('Switched to annual', 'Polar invoices the prorated difference now.');
      await useBillingStore.getState().refresh();
    } catch (err) {
      const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
      trackEvent('annual_switch_failed', { placement, code: typeof code === 'string' ? code : undefined });
      captureAnalyticsException(err, { placement, stage: 'annual_switch' });
      setError(err instanceof Error && err.message ? err.message : 'Could not switch to annual. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!confirming) {
    return (
      <Button variant="outline" size="sm" data-attr="plan-switch-annual" onClick={() => setConfirming(true)}>
        Switch to annual · save {saving} a year
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-md border p-3 text-xs" data-testid="annual-switch-confirm">
      <p>
        Switch to annual at {annual}/year? Polar invoices the prorated difference for the rest of your current
        period now, on your saved card. After that your plan renews yearly. To go back to monthly, use Manage billing.
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void confirm()} disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Confirm switch
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setConfirming(false); setError(null); }} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
