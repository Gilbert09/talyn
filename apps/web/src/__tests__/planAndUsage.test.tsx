import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { BillingStatus } from '@talyn/shared';
import { UpgradeModal } from '../components/modals/UpgradeModal';
import { useWorkspaceStore } from '../stores/workspace';
import { BillingSettings } from '../components/settings/sections/BillingSettings';
import { useBillingStore } from '../stores/billing';
import { trackEvent } from '../lib/analytics';
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
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../lib/usageBilling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/usageBilling')>()),
  goToHostedPage,
}));
vi.mock('../components/panels/TeamBilling', () => ({ BillingTeamNotice: () => null }));

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

function show(status: BillingStatus) {
  useBillingStore.setState({ status, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  billing.status.mockResolvedValue(status);
  return render(<SettingsWithModal />);
}

describe('BillingSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    billing.orders.mockResolvedValue([]);
  });
  afterEach(cleanup);

  it('captures plan page clicks with their locations', () => {
    show(usageStatus('pro'));
    fireEvent.click(screen.getByRole('button', { name: 'Compare plans' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    expect(trackEvent).toHaveBeenCalledWith('compare_plans_opened', { where: 'plan_page' });
    expect(trackEvent).toHaveBeenCalledWith('add_credits_clicked', { where: 'plan_page' });
  });

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
    expect(screen.getByText('2.5 of 10 box-hours used')).toBeInTheDocument();
    expect(screen.getByText(/Resets /)).toBeInTheDocument();
    expect(screen.getByText('Boxes running now: 0 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeVisible();
    expect(screen.queryByText('Credits')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    fireEvent.click(screen.getByRole('button', { name: /Annual/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro: $400/yr' }));
    await waitFor(() => expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/checkout'));
    expect(billing.checkout).toHaveBeenCalledWith({ period: 'annual', plan: 'pro' });
  });

  it('shows a checkout refusal instead of leaving the page', async () => {
    billing.checkout.mockRejectedValue(new Error('Checkout is down.'));
    show(usageStatus('free'));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro: $40/mo' }));
    expect(await screen.findByText('Checkout is down.')).toBeInTheDocument();
    expect(goToHostedPage).not.toHaveBeenCalled();
  });

  it('offers Legacy Pro a move to Pro with what changes', async () => {
    billing.changePlan.mockResolvedValue({ ok: true });
    show(usageStatus('legacy_pro', { usedHours: 20 }));
    expect(screen.getByText(/Your current plan: 50 box-hours a month/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Pro' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Move to Pro' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Pro: $40/mo' }));
    await waitFor(() => expect(billing.changePlan).toHaveBeenCalledWith({ to: 'pro', period: 'monthly' }));
    expect(goToHostedPage).not.toHaveBeenCalled();
  });

  it('does not offer a plan change to a Legacy Pro team seat', () => {
    show(usageStatus('legacy_pro', { planSource: 'team' }));
    expect(screen.queryByText('Move to Pro')).toBeNull();
    expect(screen.getByRole('button', { name: 'Manage billing' })).toBeVisible();
  });

  it('shows Pro its credits, the packs, auto top-up and the portal', async () => {
    billing.portal.mockResolvedValue({ url: 'https://polar.test/portal' });
    const status = usageStatus('pro', { usedHours: 150, balanceMicros: 42_000_000 });
    status.credits!.expiringSoonMicros = 2_000_000;
    status.credits!.lots = [
      {
        id: 'l1',
        totalMicros: 25_000_000,
        remainingMicros: 2_000_000,
        source: 'purchase',
        purchasedAt: '2025-11-20T00:00:00Z',
        expiresAt: '2026-11-20T00:00:00Z',
      },
      {
        id: 'l2',
        totalMicros: 105_000_000,
        remainingMicros: 40_000_000,
        source: 'purchase',
        purchasedAt: '2026-10-01T00:00:00Z',
        expiresAt: '2027-10-01T00:00:00Z',
      },
    ];
    show(status);
    expect(screen.getByText('150 of 200 box-hours used')).toBeInTheDocument();
    expect(document.querySelector('[data-attr="credit-balance"]')).toHaveTextContent('$42.00');
    expect(screen.getByText('$2.00 expires in the next 30 days.')).toBeInTheDocument();
    expect(screen.getByText('$40.00 of $105.00')).toBeInTheDocument();
    expect(screen.queryByText('+5% bonus: $105 of credits')).toBeNull();
    expect(screen.queryByText('$0.11/h')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    expect(screen.getByText('$0.11/h')).toBeVisible();
    expect(screen.getByText('+5% bonus: $105 of credits')).toBeVisible();
    expect(screen.getByText('+10% bonus: $550 of credits')).toBeInTheDocument();
    expect(document.querySelector('[data-attr="auto-topup-form"]')).not.toBeNull();
    expect(screen.queryByText('Upgrade to Pro')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }));
    await waitFor(() => expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/portal'));
  });

  it('buys a credit pack through the hosted checkout', async () => {
    billing.creditCheckout.mockResolvedValue({ url: 'https://polar.test/credits' });
    show(usageStatus('pro'));
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    fireEvent.click(document.querySelector('[data-attr="credit-pack-100"]') as HTMLElement);
    await waitFor(() => expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/credits'));
    expect(billing.creditCheckout).toHaveBeenCalledWith({ pack: '100' });
  });

  it('says the hours are out, with the way forward for the tier', () => {
    show(usageStatus('pro', { usedHours: 200, exhausted: true }));
    expect(
      screen.getByText(/Out of hours: new boxes are paused.*Add credits or turn on auto top-up/)
    ).toBeInTheDocument();
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
    const row = document.querySelector('[data-attr="size-row-small"]');
    expect(disclosure).not.toHaveAttribute('open');
    expect(row).not.toBeVisible();
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute('open');
    expect(row).toBeVisible();
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

  it('opens team settings for a team seat', () => {
    const openSettings = vi.fn();
    useWorkspaceStore.setState({ openSettings });
    show(usageStatus('pro', { planSource: 'team' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }));
    expect(openSettings).toHaveBeenCalledWith('teams');
    expect(billing.portal).not.toHaveBeenCalled();
  });

  it.each([
    [false, 'active', 'Active', 'Renews'],
    [true, 'active', 'Cancels on', 'Ends'],
    [false, 'past_due', 'Payment failed', 'Renews'],
  ])(
    'shows subscription status with cancel=%s and status=%s',
    (cancelAtPeriodEnd, subscriptionStatus, label, dateLabel) => {
      const status = usageStatus('pro');
      Object.assign(status, { cancelAtPeriodEnd, subscriptionStatus, currentPeriodEnd: '2026-12-01T00:00:00Z' });
      show(status);
      expect(screen.getByText(new RegExp(`^${label}`))).toBeVisible();
      expect(screen.getByText(new RegExp(`${dateLabel} December 1, 2026`))).toBeVisible();
    }
  );

  it('saves auto top-up and shows a failed charge with a fix', async () => {
    const status = usageStatus('pro');
    status.autoTopup = { ...status.autoTopup!, lastFailure: 'Card declined.', lastFailureAt: '2026-11-02T00:00:00Z' };
    billing.autoTopup.update.mockResolvedValue(status.autoTopup);
    show(status);
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    expect(screen.getByText(/The last automatic top-up failed .*Card declined\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Buy credits' }));
    expect(useBillingStore.getState()).toMatchObject({ upgradeModalOpen: true, upgradeReason: 'add_credits' });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));

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
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    fireEvent.change(screen.getByLabelText('Top-up amount'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save auto top-up' }));
    expect(await screen.findByText('The monthly limit must cover at least one top-up.')).toBeInTheDocument();
    expect(billing.autoTopup.update).not.toHaveBeenCalled();
  });

  describe('billing period', () => {
    const monthly = () => usageStatus('pro', {}, { period: 'monthly' });

    it.each([
      ['pro', 'monthly', 'Pro · Monthly · $40/month'],
      ['pro', 'annual', 'Pro · Annual · $400/year'],
      ['legacy_pro', 'monthly', 'Legacy Pro · Monthly · $15/month'],
    ] as const)('%s %s shows the period line', (tier, period, text) => {
      show(usageStatus(tier, {}, { period }));
      expect(screen.getByTestId('plan-period-line')).toHaveTextContent(text);
    });

    it('keeps the price list when the period is unknown', () => {
      show(usageStatus('pro', {}, { period: null }));
      expect(screen.getByTestId('plan-period-line')).toHaveTextContent('Plan prices: $40/month or $400/year');
    });

    it.each([
      ['annual', { period: 'annual' as const }],
      ['unknown period', { period: null }],
      ['cancelling', { period: 'monthly' as const, cancelAtPeriodEnd: true }],
      ['past due', { period: 'monthly' as const, subscriptionStatus: 'past_due' }],
      ['team seat', { period: 'monthly' as const, planSource: 'team' as const }],
      ['comp', { period: 'monthly' as const, planSource: 'override' as const }],
    ])('no switch offered when %s', (_name, overrides) => {
      show(usageStatus('pro', {}, overrides));
      expect(screen.queryByRole('button', { name: /Switch to annual/ })).toBeNull();
    });

    it('confirms, switches and tracks the outcome', async () => {
      billing.changePlan.mockResolvedValue({ ok: true });
      show(monthly());
      fireEvent.click(screen.getByRole('button', { name: 'Switch to annual · save $80 a year' }));
      expect(billing.changePlan).not.toHaveBeenCalled();
      expect(screen.getByTestId('annual-switch-confirm')).toHaveTextContent('prorated difference');
      fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }));
      await waitFor(() => expect(billing.changePlan).toHaveBeenCalledWith({ to: 'pro', period: 'annual' }));
      await waitFor(() => expect(screen.getByTestId('annual-switch-done')).toBeInTheDocument());
      expect(trackEvent).toHaveBeenCalledWith('annual_switch_started', { placement: 'plan_page' });
      expect(trackEvent).toHaveBeenCalledWith('annual_switch_completed', { placement: 'plan_page' });
    });

    it('shows the failure and tracks it', async () => {
      billing.changePlan.mockRejectedValue(new Error('The plan change failed.'));
      show(monthly());
      fireEvent.click(screen.getByRole('button', { name: /Switch to annual/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm switch' }));
      await waitFor(() => expect(screen.getByText('The plan change failed.')).toBeVisible());
      expect(trackEvent).toHaveBeenCalledWith('annual_switch_failed', { placement: 'plan_page', code: undefined });
    });
  });
});
