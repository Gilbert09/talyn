import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { BillingStatus } from '@talyn/shared';
import { BillingSettings } from '../components/settings/sections/BillingSettings';
import { useBillingStore } from '../stores/billing';
import { oldStatus, usageStatus } from './usageBillingFixtures';

const { billing, goToHostedPage } = vi.hoisted(() => ({
  billing: {
    status: vi.fn(),
    checkout: vi.fn(),
    changePlan: vi.fn(),
    creditCheckout: vi.fn(),
    portal: vi.fn(),
    orders: vi.fn(),
    invoice: vi.fn(),
    autoTopup: { get: vi.fn(), update: vi.fn() },
  },
  goToHostedPage: vi.fn(),
}));

vi.mock('@talyn/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@talyn/client')>();
  return { ...actual, api: { ...actual.api, billing } };
});
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../lib/usageBilling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/usageBilling')>()),
  goToHostedPage,
}));
vi.mock('../components/panels/TeamBilling', () => ({ BillingTeamNotice: () => null }));

function show(status: BillingStatus) {
  useBillingStore.setState({ status, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  billing.status.mockResolvedValue(status);
  return render(<BillingSettings />);
}

describe('BillingSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    billing.orders.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('draws the old page on a backend without usage billing', () => {
    show(oldStatus());
    expect(screen.getByText('Upgrade to Unlimited')).toBeInTheDocument();
    expect(screen.queryByText('Plan and usage')).toBeNull();
    expect(billing.autoTopup.get).not.toHaveBeenCalled();
    expect(billing.creditCheckout).not.toHaveBeenCalled();
  });

  it('shows Free: its hours, the Pro offer, locked sizes and no credits', async () => {
    show(usageStatus('free', { usedHours: 2.5 }));
    expect(screen.getByText('Plan and usage')).toBeInTheDocument();
    expect(screen.getByText(/10 box-hours a month, small and standard boxes, 2 at once/)).toBeInTheDocument();
    expect(screen.getByText('2.5 of 10 box-hours')).toBeInTheDocument();
    expect(screen.getByText(/Resets on /)).toBeInTheDocument();
    expect(screen.getByText('Boxes running now: 0 of 2')).toBeInTheDocument();
    expect(screen.getByText('Upgrade to Pro')).toBeInTheDocument();
    expect(screen.getByText(/Credits and auto top-up come with Pro/)).toBeInTheDocument();
    expect(screen.queryByText('Auto top-up')).toBeNull();
    for (const size of ['medium', 'large', 'xlarge']) {
      const row = document.querySelector(`[data-attr="size-row-${size}"]`) as HTMLElement;
      expect(within(row).getByText('Pro')).toBeInTheDocument();
    }
    for (const size of ['small', 'standard']) {
      const row = document.querySelector(`[data-attr="size-row-${size}"]`) as HTMLElement;
      expect(within(row).queryByText('Pro')).toBeNull();
    }
    expect(screen.getByText(/mobile app is coming soon/)).toBeInTheDocument();
  });

  it('sends Free to the Pro checkout for the chosen period', async () => {
    billing.checkout.mockResolvedValue({ url: 'https://polar.test/checkout' });
    show(usageStatus('free'));
    fireEvent.click(screen.getByRole('button', { name: /Annual/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro: $400/yr' }));
    await waitFor(() => expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/checkout'));
    expect(billing.checkout).toHaveBeenCalledWith({ period: 'annual', plan: 'pro' });
  });

  it('shows a checkout refusal instead of leaving the page', async () => {
    billing.checkout.mockRejectedValue(new Error('Checkout is down.'));
    show(usageStatus('free'));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro: $40/mo' }));
    expect(await screen.findByText('Checkout is down.')).toBeInTheDocument();
    expect(goToHostedPage).not.toHaveBeenCalled();
  });

  it('offers Legacy Pro a move to Pro with what changes', async () => {
    billing.changePlan.mockResolvedValue({ ok: true });
    show(usageStatus('legacy_pro', { usedHours: 20 }));
    expect(screen.getByText(/Your current plan: 50 box-hours a month/)).toBeInTheDocument();
    expect(screen.getByText('Box-hours each month: 50 → 200')).toBeInTheDocument();
    expect(screen.getByText(/Price: \$15 → \$40 a month/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Pro: $40/mo' }));
    await waitFor(() => expect(billing.changePlan).toHaveBeenCalledWith({ to: 'pro', period: 'monthly' }));
    expect(goToHostedPage).not.toHaveBeenCalled();
  });

  it('does not offer a plan change to a Legacy Pro team seat', () => {
    show(usageStatus('legacy_pro', { planSource: 'team' }));
    expect(screen.queryByText('Move to Pro')).toBeNull();
    expect(screen.queryByRole('button', { name: /Manage subscription/ })).toBeNull();
  });

  it('shows Pro its credits, the packs, auto top-up and the portal', async () => {
    billing.portal.mockResolvedValue({ url: 'https://polar.test/portal' });
    const status = usageStatus('pro', { usedHours: 150, balanceMicros: 42_000_000 });
    status.credits!.expiringSoonMicros = 2_000_000;
    status.credits!.lots = [
      { id: 'l1', totalMicros: 25_000_000, remainingMicros: 2_000_000, source: 'purchase', purchasedAt: '2025-11-20T00:00:00Z', expiresAt: '2026-11-20T00:00:00Z' },
      { id: 'l2', totalMicros: 105_000_000, remainingMicros: 40_000_000, source: 'purchase', purchasedAt: '2026-10-01T00:00:00Z', expiresAt: '2027-10-01T00:00:00Z' },
    ];
    show(status);
    expect(screen.getByText('150 of 200 box-hours')).toBeInTheDocument();
    expect(document.querySelector('[data-attr="credit-balance"]')).toHaveTextContent('$42.00');
    expect(screen.getByText('$2.00 expires in the next 30 days.')).toBeInTheDocument();
    expect(screen.getByText('$40.00 of $105.00')).toBeInTheDocument();
    expect(screen.getByText('+5% bonus: $105 of credits')).toBeInTheDocument();
    expect(screen.getByText('+10% bonus: $550 of credits')).toBeInTheDocument();
    expect(document.querySelector('[data-attr="auto-topup-form"]')).not.toBeNull();
    expect(screen.queryByText('Upgrade to Pro')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manage subscription' }));
    await waitFor(() => expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/portal'));
  });

  it('buys a credit pack through the hosted checkout', async () => {
    billing.creditCheckout.mockResolvedValue({ url: 'https://polar.test/credits' });
    show(usageStatus('pro'));
    fireEvent.click(document.querySelector('[data-attr="credit-pack-100"]') as HTMLElement);
    await waitFor(() => expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/credits'));
    expect(billing.creditCheckout).toHaveBeenCalledWith({ pack: '100' });
  });

  it('says the hours are out, with the way forward for the tier', () => {
    show(usageStatus('pro', { usedHours: 200, exhausted: true }));
    expect(screen.getByText(/Out of hours: new boxes are paused.*Add credits or turn on auto top-up/)).toBeInTheDocument();
  });

  it('saves auto top-up and shows a failed charge with a fix', async () => {
    const status = usageStatus('pro');
    status.autoTopup = { ...status.autoTopup!, lastFailure: 'Card declined.', lastFailureAt: '2026-11-02T00:00:00Z' };
    billing.autoTopup.update.mockResolvedValue(status.autoTopup);
    show(status);
    expect(screen.getByText(/The last automatic top-up failed .*Card declined\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Buy credits' }));
    expect(useBillingStore.getState()).toMatchObject({ upgradeModalOpen: true, upgradeReason: 'add_credits' });

    fireEvent.click(screen.getByLabelText('Turn on auto top-up'));
    fireEvent.change(screen.getByLabelText('Trigger balance in dollars'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Top-up amount'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Monthly limit in dollars'), { target: { value: '300' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save auto top-up' }));
    await waitFor(() =>
      expect(billing.autoTopup.update).toHaveBeenCalledWith({
        enabled: true,
        triggerMicros: 10_000_000,
        pack: '100',
        monthlyLimitMicros: 300_000_000,
      })
    );
  });

  it('refuses an auto top-up limit below one pack without calling the backend', async () => {
    show(usageStatus('pro'));
    fireEvent.change(screen.getByLabelText('Top-up amount'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save auto top-up' }));
    expect(await screen.findByText('The monthly limit must cover at least one top-up.')).toBeInTheDocument();
    expect(billing.autoTopup.update).not.toHaveBeenCalled();
  });
});
