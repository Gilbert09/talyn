import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureAnalyticsException, trackEvent } from '../lib/analytics';
import { api } from '../lib/api';
import { trackBillingFailure, useBillingStore } from '../stores/billing';
import { usageStatus } from './usageBillingFixtures';

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));

const track = vi.mocked(trackEvent);
const capture = vi.mocked(captureAnalyticsException);

describe('billing outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    useBillingStore.getState().stopCheckoutPollBurst();
    useBillingStore.getState().clearPlanChange();
    useBillingStore.setState({ status: null });
  });

  it('captures one return-stage failure during a credit refresh', async () => {
    const err = { code: 'unavailable', status: 503 };
    const status = vi.spyOn(api.billing, 'status').mockRejectedValue(err);
    useBillingStore.getState().setStatus(usageStatus('pro'));
    useBillingStore.getState().markCreditCheckoutStarted('25');
    await useBillingStore.getState().refresh();
    await useBillingStore.getState().refresh();
    expect(track.mock.calls.filter(([event]) => event === 'credit_checkout_failed')).toEqual([
      ['credit_checkout_failed', { stage: 'return', code: 'unavailable', status: 503 }],
    ]);
    status.mockRestore();
  });

  it.each(['purchase', 'auto_topup'] as const)('captures one credit_purchase_completed for a new %s lot', (source) => {
    const lot = { id: 'lot-1', totalMicros: 105_000_000, remainingMicros: 105_000_000, source, purchasedAt: '2026-11-04', expiresAt: '2027-11-04' };
    useBillingStore.getState().setStatus(usageStatus('pro'));
    const landed = usageStatus('pro', { balanceMicros: 105_000_000 });
    landed.credits!.lots = [lot];
    useBillingStore.getState().setStatus(landed);
    useBillingStore.getState().setStatus(landed);
    expect(track.mock.calls.filter(([event]) => event === 'credit_purchase_completed')).toEqual([
      ['credit_purchase_completed', { pack: '100', amount_micros: 100_000_000, source: source === 'purchase' ? 'manual' : 'auto_topup' }],
    ]);
  });

  it('captures a credit purchase after the checkout returns in a new page', () => {
    useBillingStore.getState().setStatus(usageStatus('pro'));
    useBillingStore.getState().markCreditCheckoutStarted('25');
    useBillingStore.setState({ status: null });
    const landed = usageStatus('pro', { balanceMicros: 25_000_000 });
    landed.credits!.lots = [{ id: 'lot-2', totalMicros: 25_000_000, remainingMicros: 25_000_000, source: 'purchase', purchasedAt: '2026-11-04', expiresAt: '2027-11-04' }];
    useBillingStore.getState().setStatus(landed);
    expect(track).toHaveBeenCalledWith('credit_purchase_completed', { pack: '25', amount_micros: 25_000_000, source: 'manual' });
    expect(sessionStorage.getItem('billing_credit_checkout')).toBeNull();
  });

  it.each([
    ['legacy_pro', 'pro', 'annual'],
    ['pro', 'max', 'monthly'],
    ['legacy_pro', 'max', 'annual'],
  ] as const)('captures plan_changed once after a started %s to %s change lands', (from, to, period) => {
    useBillingStore.getState().setStatus(usageStatus(from, { maxOffered: true }));
    useBillingStore.getState().markPlanChangeStarted(period);
    useBillingStore.getState().setStatus(usageStatus(to));
    useBillingStore.getState().setStatus(usageStatus(to));
    expect(track.mock.calls.filter(([event]) => event === 'plan_changed')).toEqual([
      ['plan_changed', { from, to, period }],
    ]);
  });

  it.each(['checkout_failed', 'plan_change_failed', 'credit_checkout_failed', 'team_checkout_failed'] as const)('captures %s and its exception', (event) => {
    const err = { code: 'no_subscription', status: 402 };
    trackBillingFailure(event, 'create_checkout', err);
    expect(track).toHaveBeenCalledWith(event, { stage: 'create_checkout', code: 'no_subscription', status: 402 });
    expect(capture).toHaveBeenCalledWith(err, { stage: 'create_checkout', code: 'no_subscription', status: 402 });
  });
});
