/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UpgradeModal } from '../renderer/components/modals/UpgradeModal';
import { BillingSettings } from '../renderer/components/settings/sections/BillingSettings';
import { useBillingStore } from '../renderer/stores/billing';
import { trackEvent } from '../renderer/lib/analytics';
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
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() } }));

function SettingsWithModal() {
  const open = useBillingStore((s) => s.upgradeModalOpen);
  const setOpen = useBillingStore((s) => s.setUpgradeModalOpen);
  return (
    <>
      <BillingSettings />
      <UpgradeModal open={open} onOpenChange={setOpen} />
    </>
  );
}

function show(status: ReturnType<typeof usageStatus>) {
  useBillingStore.setState({ status, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  statusFetch.mockResolvedValue(status);
  return render(<SettingsWithModal />);
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

  it('captures plan page clicks with their locations', () => {
    show(usageStatus('pro'));
    fireEvent.click(screen.getByRole('button', { name: 'Compare plans' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    expect(trackEvent).toHaveBeenCalledWith('compare_plans_opened', { where: 'plan_page' });
    expect(trackEvent).toHaveBeenCalledWith('add_credits_clicked', { where: 'plan_page' });
  });

  it('keeps the old page on an older backend', async () => {
    const status = oldStatus();
    useBillingStore.setState({ status, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
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
    expect(plan).toHaveTextContent('10 box-hours a month, 2 boxes at once, small and standard boxes.');
    expect(screen.getByTestId('usage-card')).toHaveTextContent('7.5 of 10 box-hours');
    expect(screen.getByTestId('usage-card')).toHaveTextContent(/Resets /);
    expect(screen.getByTestId('open-boxes')).toHaveTextContent('1 of 2 boxes running now');
    const sizes = screen.getByTestId('sizes-table');
    expect(within(sizes).getAllByText('Pro')).toHaveLength(3);
    expect(sizes).not.toBeVisible();
    expect(screen.queryByText('$0.11/h')).toBeNull();
    expect(screen.queryByTestId('credits-card')).toBeNull();
    expect(screen.queryByTestId('auto-topup')).toBeNull();
    expect(screen.getByText(/mobile app is coming soon/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    fireEvent.click(screen.getByRole('button', { name: /Annual/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro: $400/yr' }));
    await waitFor(() => expect(checkout).toHaveBeenCalledWith({ period: 'annual', plan: 'pro' }));
  });

  it('shows Free credits it still holds, without packs to buy', () => {
    show(usageStatus('free', { balanceMicros: 3_000_000 }));
    expect(screen.queryByTestId('credits-card')).toBeNull();
    expect(screen.getByText('$3.00')).not.toBeVisible();
    expect(screen.queryByTestId('credit-packs')).toBeNull();
  });

  it('shows the exhausted state with what to do', () => {
    show(usageStatus('free', { usedHours: 10, exhausted: true }));
    expect(screen.getByTestId('usage-card')).toHaveTextContent(
      'Out of hours: new boxes paused. Running turns finish. Upgrade to Pro, or wait for the reset.',
    );
  });

  it('offers Legacy Pro the move with what changes', async () => {
    changePlan.mockResolvedValue({ ok: true });
    show(usageStatus('legacy_pro', { usedHours: 20 }));
    expect(screen.getByTestId('plan-card')).toHaveTextContent('Legacy Pro');
    expect(screen.getByTestId('plan-card')).toHaveTextContent('$15/month');
    fireEvent.click(screen.getByRole('button', { name: 'Move to Pro' }));
    const move = screen.getByTestId('legacy-changes');
    expect(move).toHaveTextContent('50 box-hours a month becomes 200 box-hours');
    fireEvent.click(screen.getByRole('button', { name: /Annual/ }));
    expect(move).toHaveTextContent('$15 a month becomes $400 a year');
    fireEvent.click(screen.getByRole('button', { name: /Monthly/ }));
    expect(move).toHaveTextContent('$15 a month becomes $40 a month');
    fireEvent.click(screen.getAllByRole('button', { name: 'Move to Pro' })[1]);
    await waitFor(() => expect(changePlan).toHaveBeenCalledWith({ to: 'pro', period: 'monthly' }));
    expect(screen.queryByTestId('credit-packs')).toBeNull();
    expect(screen.queryByTestId('auto-topup')).toBeNull();
  });

  it('shows Pro credits, lots and expiry, and buys a pack', async () => {
    creditCheckout.mockResolvedValue({ url: 'u' });
    show(
      usageStatus('pro', {
        usedHours: 37.5,
        balanceMicros: 30_000_000,
        expiringSoonMicros: 5_000_000,
        lots: [
          {
            id: 'l1',
            totalMicros: 25_000_000,
            remainingMicros: 5_000_000,
            source: 'purchase',
            purchasedAt: '2025-11-20T00:00:00Z',
            expiresAt: '2026-11-20T00:00:00Z',
          },
          {
            id: 'l2',
            totalMicros: 25_000_000,
            remainingMicros: 25_000_000,
            source: 'auto_topup',
            purchasedAt: '2026-10-01T00:00:00Z',
            expiresAt: '2027-10-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(screen.getByTestId('plan-card')).toHaveTextContent('$40/month or $400/year');
    expect(screen.getByRole('button', { name: /Manage billing/ })).toBeInTheDocument();
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
    expect(screen.queryByText('$0.11/h')).toBeNull();
    expect(screen.queryByTestId('credit-packs')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    expect(screen.getByText('$0.11/h')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '$500 (+10% bonus)' }));
    await waitFor(() => expect(creditCheckout).toHaveBeenCalledWith({ pack: '500' }));
  });

  it('opens team settings for a team seat', () => {
    const openSettings = jest.fn();
    useWorkspaceStore.setState({ openSettings });
    show(
      usageStatus('pro', {
        overrides: {
          planSource: 'team',
          team: {
            id: 't',
            name: 'Acme',
            isAdmin: false,
            hasSeat: true,
            soleAdmin: false,
            active: true,
            paidPersonallyToo: false,
          },
        },
      }),
    );
    expect(screen.getByTestId('plan-card')).toHaveTextContent('Paid for by your team, Acme.');
    fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }));
    expect(openSettings).toHaveBeenCalledWith('teams');
    expect(portal).not.toHaveBeenCalled();
  });

  it.each([false, true])('shows auto top-up enabled=%s without prices until Add credits opens', (enabled) => {
    const status = usageStatus('pro');
    status.autoTopup = { ...status.autoTopup!, enabled };
    show(status);
    expect(screen.getByText(`Auto top-up: ${enabled ? 'On' : 'Off'}`)).toBeVisible();
    expect(screen.queryByText('$0.11/h')).toBeNull();
    expect(screen.queryByLabelText('Trigger balance in dollars')).toBeNull();
    const add = screen.getByRole('button', { name: 'Add credits' });
    expect(add).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(add);
    expect(add).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('$0.11/h')).toBeVisible();
    expect(screen.getByLabelText('Trigger balance in dollars')).toBeVisible();
    fireEvent.click(add);
    expect(screen.queryByText('$0.11/h')).toBeNull();
    expect(add).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps usage details closed until requested', () => {
    show(usageStatus('pro'));
    const summary = screen.getByText('How usage is counted');
    const disclosure = summary.closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    expect(screen.getByTestId('sizes-table')).not.toBeVisible();
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute('open');
    expect(screen.getByTestId('sizes-table')).toBeVisible();
    expect(screen.queryByText('$0.11/h')).toBeNull();
  });

  it.each([
    [0, false, '100', '100% left'],
    [26, false, '87', '87% left'],
    [199, false, '1', '1.0% left'],
    [210, false, '0', '0% left'],
    [20, true, '0', '0% left'],
  ])('shows usage left for %s hours and exhausted=%s', (usedHours, exhausted, value, label) => {
    show(usageStatus('pro', { usedHours, exhausted }));
    expect(screen.getByRole('progressbar', { name: 'Box-hours left' })).toHaveAttribute('aria-valuenow', value);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText(`${usedHours} of 200 box-hours used`)).toBeVisible();
  });

  it.each(['free', 'legacy_pro', 'pro'] as const)('opens the existing modal to compare %s', (tier) => {
    show(usageStatus(tier));
    fireEvent.click(screen.getByRole('button', { name: 'Compare plans' }));
    expect(useBillingStore.getState().upgradeModalOpen).toBe(true);
    expect(screen.getByRole('heading', { level: 2 })).toBeVisible();
  });

  it.each([
    [false, 'active', 'Active', 'Renews'],
    [true, 'active', 'Cancels on', 'Ends'],
    [false, 'past_due', 'Payment failed', 'Renews'],
  ])(
    'shows subscription status with cancel=%s and status=%s',
    async (cancelAtPeriodEnd, subscriptionStatus, label, dateLabel) => {
      portal.mockResolvedValue({ url: 'portal' });
      show(
        usageStatus('pro', {
          overrides: { cancelAtPeriodEnd, subscriptionStatus, currentPeriodEnd: '2026-12-01T00:00:00Z' },
        }),
      );
      expect(screen.getByTestId('plan-card')).toHaveTextContent(label);
      expect(screen.getByTestId('plan-card')).toHaveTextContent(`${dateLabel} December 1, 2026`);
      fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }));
      await waitFor(() => expect(portal).toHaveBeenCalled());
    },
  );

  describe('auto top-up', () => {
    it('validates before saving', async () => {
      show(usageStatus('pro'));
      fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
      const form = screen.getByTestId('auto-topup');
      fireEvent.change(within(form).getByLabelText('Monthly limit in dollars'), { target: { value: '10' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
      expect(await within(form).findByText('The monthly limit must cover at least one top-up.')).toBeInTheDocument();
      expect(autoTopupUpdate).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a negative trigger',
        'Trigger balance in dollars',
        '-1',
        'The trigger balance must be a dollar amount, 0 or more.',
      ],
      [
        'a word for a limit',
        'Monthly limit in dollars',
        'lots',
        'The monthly limit must be a dollar amount, 0 or more.',
      ],
    ])('refuses %s', async (_label, field, value, message) => {
      show(usageStatus('pro'));
      fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
      const form = screen.getByTestId('auto-topup');
      fireEvent.change(within(form).getByLabelText(field), { target: { value } });
      fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
      expect(await within(form).findByText(message)).toBeInTheDocument();
      expect(autoTopupUpdate).not.toHaveBeenCalled();
    });

    it('saves the settings in micro-dollars', async () => {
      autoTopupUpdate.mockResolvedValue({});
      show(usageStatus('pro'));
      fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
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
      status.autoTopup = {
        ...status.autoTopup!,
        enabled: true,
        lastFailure: 'The card was declined.',
        lastFailureAt: '2026-11-02T00:00:00Z',
      };
      show(status);
      fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
      const form = screen.getByTestId('auto-topup');
      expect(form).toHaveTextContent('The last auto top-up failed');
      expect(form).toHaveTextContent('The card was declined.');
      fireEvent.click(within(form).getByRole('button', { name: 'Buy credits' }));
      await waitFor(() => expect(creditCheckout).toHaveBeenCalledWith({ pack: '25' }));
    });
  });
});
