import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { formatBoxHoursLabel, formatUsd, type UsageResetOffer } from '@talyn/shared';
import { api } from '../../lib/api';
import { openExternal } from '../../lib/openExternal';
import { trackEvent } from '../../lib/analytics';
import { formatShortDate } from '../../lib/usageBilling';
import { trackBillingFailure, useBillingStore } from '../../stores/billing';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

const USAGE_RESET_ERRORS: Record<string, string> = {
  usage_reset_requires_paid_plan: 'A usage reset needs a paid plan.',
  nothing_to_reset: 'You have not used any box-hours yet. There is nothing to reset.',
  usage_reset_unavailable: 'Usage reset is not available for this account.',
};

/**
 * "Reset usage": pay the plan's monthly price once to get the full allowance
 * back now. Renders nothing unless the status carries a reset offer.
 */
export function UsageResetAction({
  offer,
  periodEnd,
  resets,
  placement,
  className,
}: {
  offer: UsageResetOffer | undefined;
  periodEnd: string;
  resets?: number;
  placement: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!offer) return null;

  const buy = async () => {
    setBusy(true);
    setError(null);
    trackEvent('usage_reset_checkout_started', { tier: offer.tier, placement });
    try {
      const { url } = await api.billing.usageResetCheckout();
      await openExternal(url);
      useBillingStore.getState().startCheckoutPollBurst('reset');
    } catch (err) {
      trackBillingFailure('usage_reset_checkout_failed', 'create_checkout', err);
      const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
      setError(
        (typeof code === 'string' && USAGE_RESET_ERRORS[code]) ||
          (err instanceof Error && err.message ? err.message : 'Could not start the checkout.')
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('space-y-2', className)} data-testid="usage-reset">
      <Button variant="outline" size="sm" data-attr="usage-reset-checkout" disabled={busy} onClick={() => void buy()}>
        {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
        Reset usage: {formatUsd(offer.priceMicros, 0)}
      </Button>
      <p className="text-xs text-muted-foreground">
        Pay your plan&apos;s monthly price once to get all {formatBoxHoursLabel(offer.includedWsec)} back now. Your
        period still ends on {formatShortDate(periodEnd)}. Unused hours do not carry over.
      </p>
      {resets != null && resets > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="usage-reset-count">
          Reset {resets} {resets === 1 ? 'time' : 'times'} this period
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
