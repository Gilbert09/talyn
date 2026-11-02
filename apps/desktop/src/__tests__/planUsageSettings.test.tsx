/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BillingSettings } from '../renderer/components/settings/sections/BillingSettings';
import { useBillingStore } from '../renderer/stores/billing';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { oldStatus, usageStatus } from '../testing/billingStatus';

const statusFetch = jest.fn();
const orders = jest.fn();
const checkout = jest.fn();
const changePlan = jest.fn();
const creditCheckout = jest.fn();
const portal = jest.fn();
const autoTopupUpdate = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: {
    billing: {
      status: (...a: unknown[]) => statusFetch(...a),
      orders: (...a: unknown[]) => orders(...a),
      checkout: (...a: unknown[]) => checkout(...a),
      changePlan: (...a: unknown[]) => changePlan(...a),
      creditCheckout: (...a: unknown[]) => creditCheckout(...a),
      portal: (...a: unknown[]) => portal(...a),
      autoTopup: { update: (...a: unknown[]) => autoTopupUpdate(...a) },
    },
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../renderer/lib/openExternal', () => ({ openExternal: jest.fn() }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() } }));

function show(status: ReturnType<typeof usageStatus>) {
  useBillingStore.setState({ status });
  statusFetch.mockResolvedValue(status);
  return render(<BillingSettings />);
}

describe('BillingSettings with usage billing', () => {
  beforeEach(() => {
    [statusFetch, orders, checkout, changePlan, creditCheckout, portal, autoTopupUpdate].forEach((m) => m.mockReset());
    // Order history has its own tests; left pending here so it never re-renders mid-test.
    orders.mockReturnValue(new Promise(() => undefined));
    useWorkspaceStore.setState({ features: null } as never);
    useBillingStore.getState().stopCheckoutPollBurst();
  });
  afterEach(() => {
    useBillingStore.getState().stopCheckoutPollBurst();
    cleanup();
  });

  it('keeps the old page on an older backend', async () => {
    const status = oldStatus();
    useBillingStore.setState({ status });
    statusFetch.mockResolvedValue(status);
    render(<BillingSettings />);
    expect(screen.getByText('Billing')).toBeInTheDocument();
    expect(screen.getByText('Upgrade to Unlimited')).toBeInTheDocument();
    expect(screen.getByText('Active tasks')).toBeInTheDocument();
    expect(screen.queryByTestId('usage-card')).toBeNull();
  });

  it('shows Free: plan, usage, locked sizes and the Pro upgrade, with no credits form', async () => {
    checkout.mockResolvedValue({ url: 'u' });
    show(usageStatus('free', { usedHours: 7.5 }));
    expect(screen.getByText('Plan and usage')).toBeInTheDocument();
    const plan = screen.getByTestId('plan-card');
    expect(plan).toHaveTextContent('Free');
    expect(plan).toHaveTextContent('$0');
    expect(plan).toHaveTextContent('10 box-hours a month, 2 boxes at once, small and standard boxes.');
    expect(screen.getByTestId('usage-card')).toHaveTextContent('7.5 of 10 box-hours');
    expect(screen.getByTestId('usage-card')).toHaveTextContent(/Resets on/);
    expect(screen.getByTestId('open-boxes')).toHaveTextContent('1 of 2 boxes running now');
    const sizes = screen.getByTestId('sizes-table');
    expect(within(sizes).getAllByText('Pro')).toHaveLength(3);
    expect(sizes).toHaveTextContent('$0.11/h');
    expect(sizes).toHaveTextContent('$0.275/h');
    expect(screen.queryByTestId('credits-card')).toBeNull();
    expect(screen.queryByTestId('auto-topup')).toBeNull();
    expect(screen.getByText(/mobile app is coming soon/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('upgrade-pro')).getByRole('button', { name: /Upgrade annual/ }));
    await waitFor(() => expect(checkout).toHaveBeenCalledWith({ period: 'annual', plan: 'pro' }));
  });

  it('shows Free credits it still holds, without packs to buy', () => {
    show(usageStatus('free', { balanceMicros: 3_000_000 }));
    const credits = screen.getByTestId('credits-card');
    expect(credits).toHaveTextContent('$3.00');
    expect(credits).toHaveTextContent('Buying credits comes with Pro');
    expect(screen.queryByTestId('credit-packs')).toBeNull();
  });

  it('shows the exhausted state with what to do', () => {
    show(usageStatus('free', { usedHours: 10, exhausted: true }));
    expect(screen.getByTestId('usage-card')).toHaveTextContent('Out of hours: new boxes paused. Running turns finish. Upgrade to Pro, or wait for the reset.');
  });

  it('offers Legacy Pro the move with what changes', async () => {
    changePlan.mockResolvedValue({ ok: true });
    show(usageStatus('legacy_pro', { usedHours: 20 }));
    expect(screen.getByTestId('plan-card')).toHaveTextContent('Legacy Pro');
    expect(screen.getByTestId('plan-card')).toHaveTextContent('$15/month');
    const move = screen.getByTestId('move-to-pro');
    expect(move).toHaveTextContent('50 box-hours a month becomes 200 box-hours');
    expect(move).toHaveTextContent('$15 a month becomes $400 a year');
    fireEvent.change(within(move).getByLabelText('Billing period'), { target: { value: 'monthly' } });
    expect(move).toHaveTextContent('$15 a month becomes $40 a month');
    fireEvent.click(within(move).getByRole('button', { name: /Move to Pro/ }));
    await waitFor(() => expect(changePlan).toHaveBeenCalledWith({ to: 'pro', period: 'monthly' }));
    expect(screen.getByTestId('credit-packs')).toBeInTheDocument();
    expect(screen.getByTestId('auto-topup')).toBeInTheDocument();
  });

  it('shows Pro credits, lots and expiry, and buys a pack', async () => {
    creditCheckout.mockResolvedValue({ url: 'u' });
    show(
      usageStatus('pro', {
        usedHours: 37.5,
        balanceMicros: 30_000_000,
        expiringSoonMicros: 5_000_000,
        lots: [
          { id: 'l1', totalMicros: 25_000_000, remainingMicros: 5_000_000, source: 'purchase', purchasedAt: '2025-11-20T00:00:00Z', expiresAt: '2026-11-20T00:00:00Z' },
          { id: 'l2', totalMicros: 25_000_000, remainingMicros: 25_000_000, source: 'auto_topup', purchasedAt: '2026-10-01T00:00:00Z', expiresAt: '2027-10-01T00:00:00Z' },
        ],
      }),
    );
    expect(screen.getByTestId('plan-card')).toHaveTextContent('$40/month or $400/year');
    expect(screen.getByRole('button', { name: /Manage subscription/ })).toBeInTheDocument();
    expect(screen.queryByTestId('upgrade-pro')).toBeNull();
    expect(screen.queryByTestId('move-to-pro')).toBeNull();
    expect(screen.getByTestId('usage-card')).toHaveTextContent('37.5 of 200 box-hours');
    const credits = screen.getByTestId('credits-card');
    expect(credits).toHaveTextContent('$30.00');
    expect(credits).toHaveTextContent('$5.00 expires in the next 30 days.');
    const lots = screen.getByTestId('credit-lots');
    expect(lots).toHaveTextContent('$5.00 of $25.00 · Purchase');
    expect(lots).toHaveTextContent('$25.00 of $25.00 · Auto top-up');
    expect(within(screen.getByTestId('sizes-table')).queryByText('Pro')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '$500 (+10% bonus)' }));
    await waitFor(() => expect(creditCheckout).toHaveBeenCalledWith({ pack: '500' }));
  });

  it('hides personal plan actions for a team seat', () => {
    show(
      usageStatus('pro', {
        overrides: {
          planSource: 'team',
          team: { id: 't', name: 'Acme', isAdmin: false, hasSeat: true, soleAdmin: false, active: true, paidPersonallyToo: false },
        },
      }),
    );
    expect(screen.getByTestId('plan-card')).toHaveTextContent('Paid for by your team, Acme.');
    expect(screen.queryByRole('button', { name: /Manage subscription/ })).toBeNull();
  });

  describe('auto top-up', () => {
    it('validates before saving', async () => {
      show(usageStatus('pro'));
      const form = screen.getByTestId('auto-topup');
      fireEvent.change(within(form).getByLabelText('Monthly limit in dollars'), { target: { value: '10' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
      expect(await within(form).findByText('The monthly limit must cover at least one top-up.')).toBeInTheDocument();
      expect(autoTopupUpdate).not.toHaveBeenCalled();
    });

    it.each([
      ['a negative trigger', 'Trigger balance in dollars', '-1', 'The trigger balance must be a dollar amount, 0 or more.'],
      ['a word for a limit', 'Monthly limit in dollars', 'lots', 'The monthly limit must be a dollar amount, 0 or more.'],
    ])('refuses %s', async (_label, field, value, message) => {
      show(usageStatus('pro'));
      const form = screen.getByTestId('auto-topup');
      fireEvent.change(within(form).getByLabelText(field), { target: { value } });
      fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
      expect(await within(form).findByText(message)).toBeInTheDocument();
      expect(autoTopupUpdate).not.toHaveBeenCalled();
    });

    it('saves the settings in micro-dollars', async () => {
      autoTopupUpdate.mockResolvedValue({});
      show(usageStatus('pro'));
      const form = screen.getByTestId('auto-topup');
      expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();
      fireEvent.click(within(form).getByRole('checkbox'));
      fireEvent.change(within(form).getByLabelText('Trigger balance in dollars'), { target: { value: '7.5' } });
      fireEvent.change(within(form).getByLabelText('Top-up pack'), { target: { value: '100' } });
      fireEvent.change(within(form).getByLabelText('Monthly limit in dollars'), { target: { value: '200' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(autoTopupUpdate).toHaveBeenCalledWith({
          enabled: true,
          triggerMicros: 7_500_000,
          pack: '100',
          monthlyLimitMicros: 200_000_000,
        }),
      );
    });

    it('shows the last failure with a Buy credits fix', async () => {
      creditCheckout.mockResolvedValue({ url: 'u' });
      const status = usageStatus('pro');
      status.autoTopup = { ...status.autoTopup!, enabled: true, lastFailure: 'The card was declined.', lastFailureAt: '2026-11-02T00:00:00Z' };
      show(status);
      const form = screen.getByTestId('auto-topup');
      expect(form).toHaveTextContent('The last auto top-up failed');
      expect(form).toHaveTextContent('The card was declined.');
      fireEvent.click(within(form).getByRole('button', { name: 'Buy credits' }));
      await waitFor(() => expect(creditCheckout).toHaveBeenCalledWith({ pack: '25' }));
    });
  });
});
