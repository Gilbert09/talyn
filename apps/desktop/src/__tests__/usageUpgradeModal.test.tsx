/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UpgradeModal } from '../renderer/components/modals/UpgradeModal';
import { useBillingStore, type UpgradeReason } from '../renderer/stores/billing';
import { captureAnalyticsException, trackEvent } from '../renderer/lib/analytics';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import type { BoxNotice } from '../renderer/lib/usageBilling';
import { oldStatus, usageStatus } from '../testing/billingStatus';

const checkout = jest.fn();
const changePlan = jest.fn();
const creditCheckout = jest.fn();
const portal = jest.fn();
const statusFetch = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: {
    billing: {
      status: (...a: unknown[]) => statusFetch(...a),
      checkout: (...a: unknown[]) => checkout(...a),
      changePlan: (...a: unknown[]) => changePlan(...a),
      creditCheckout: (...a: unknown[]) => creditCheckout(...a),
      portal: (...a: unknown[]) => portal(...a),
    },
  },
  ApiError: class ApiError extends Error {},
}));
const openExternal = jest.fn();
jest.mock('../renderer/lib/openExternal', () => ({ openExternal: (...a: unknown[]) => openExternal(...a) }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

const openSettings = jest.fn();

function open(status: ReturnType<typeof usageStatus>, reason: UpgradeReason | null = null, notice: BoxNotice | null = null) {
  useBillingStore.setState({ status, upgradeModalOpen: true, upgradeReason: reason, upgradeNotice: notice });
  return render(<UpgradeModal open onOpenChange={(next) => useBillingStore.getState().setUpgradeModalOpen(next)} />);
}

describe('UpgradeModal with usage billing', () => {
  beforeEach(() => {
    [checkout, changePlan, creditCheckout, portal, openExternal, openSettings, statusFetch].forEach((m) => m.mockReset());
    statusFetch.mockReturnValue(new Promise(() => undefined));
    useWorkspaceStore.setState({ openSettings, features: null } as never);
    useBillingStore.getState().stopCheckoutPollBurst();
  });
  afterEach(() => {
    useBillingStore.getState().stopCheckoutPollBurst();
    cleanup();
  });

  it('keeps the old Unlimited pitch on an older backend', () => {
    useBillingStore.setState({ status: oldStatus({ activeTasks: 3 }), upgradeModalOpen: true, upgradeReason: 'task_limit' });
    render(<UpgradeModal open onOpenChange={() => undefined} />);
    expect(screen.getByText('Upgrade to Unlimited')).toBeInTheDocument();
    expect(screen.getByText(/runs up to 3 tasks at once/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upgrade — \$15\/mo/ })).toBeInTheDocument();
  });

  it('sells Pro to Free with prices from the status', async () => {
    checkout.mockResolvedValue({ url: 'https://polar.test/checkout' });
    open(usageStatus('free'));
    expect(screen.getByText('Upgrade to Pro')).toBeInTheDocument();
    expect(screen.getByText('$400/yr')).toBeInTheDocument();
    expect(screen.getByText('$40/mo')).toBeInTheDocument();
    expect(screen.getByText(/^\s*200 box-hours a month\s*$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro: $40/mo' }));
    await waitFor(() => expect(checkout).toHaveBeenCalledWith({ period: 'monthly', plan: 'pro' }));
    expect(openExternal).toHaveBeenCalledWith('https://polar.test/checkout');
    expect(await screen.findByText(/Finish in your browser/)).toBeInTheDocument();
  });

  it('charges the annual price when annual is picked', async () => {
    checkout.mockResolvedValue({ url: 'u' });
    open(usageStatus('free'));
    fireEvent.click(screen.getByRole('button', { name: /Annual/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro: $400/yr' }));
    await waitFor(() => expect(checkout).toHaveBeenCalledWith({ period: 'annual', plan: 'pro' }));
  });

  it('compare plans marks the current plan with its period and offers the switch', async () => {
    changePlan.mockResolvedValue({ ok: true });
    open(usageStatus('pro', { overrides: { period: 'monthly' } }), 'compare_plans');
    const card = screen.getByTestId('compare-plan-pro');
    expect(card).toHaveTextContent('Your plan · Monthly');
    fireEvent.click(within(card).getByRole('button', { name: 'Switch to annual · save $80 a year' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Confirm switch' }));
    await waitFor(() => expect(changePlan).toHaveBeenCalledWith({ to: 'pro', period: 'annual' }));
    expect(trackEvent).toHaveBeenCalledWith('annual_switch_started', { placement: 'compare_plans' });
  });

  it('compare plans shows no switch for an annual subscriber', () => {
    open(usageStatus('pro', { overrides: { period: 'annual' } }), 'compare_plans');
    expect(screen.getByTestId('compare-plan-pro')).toHaveTextContent('Your plan · Annual');
    expect(screen.queryByRole('button', { name: /Switch to annual/ })).toBeNull();
  });

  it('compares plans for Pro without credit packs', () => {
    open(usageStatus('pro'), 'compare_plans');
    expect(screen.getByText('Compare plans')).toBeInTheDocument();
    expect(within(screen.getByTestId('compare-plan-pro')).getByText('Your plan')).toBeInTheDocument();
    expect(screen.getByTestId('compare-plan-free')).toHaveTextContent('10 box-hours per month');
    expect(screen.getByTestId('compare-plan-team')).toHaveTextContent('per seat');
    expect(screen.queryByTestId('compare-plan-legacy_pro')).toBeNull();
    expect(screen.queryByTestId('credit-packs')).toBeNull();
    expect(screen.queryByRole('button', { name: '$25' })).toBeNull();
  });

  it('offers Pro checkout from the Free comparison', async () => {
    checkout.mockResolvedValue({ url: 'https://polar.test/checkout' });
    open(usageStatus('free'), 'compare_plans');
    expect(within(screen.getByTestId('compare-plan-free')).getByText('Your plan')).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('compare-plan-pro')).getByRole('button', { name: 'Upgrade to Pro' }));
    await waitFor(() => expect(checkout).toHaveBeenCalledWith({ period: 'monthly', plan: 'pro' }));
  });

  it('marks Legacy Pro as current in the comparison', () => {
    open(usageStatus('legacy_pro'), 'compare_plans');
    expect(within(screen.getByTestId('compare-plan-legacy_pro')).getByText('Your plan')).toBeInTheDocument();
    expect(screen.getByTestId('compare-plan-legacy_pro')).toHaveTextContent('50 box-hours per month');
    expect(within(screen.getByTestId('compare-plan-pro')).getByRole('button', { name: 'Move to Pro' })).toBeInTheDocument();
    expect(screen.queryByTestId('credit-packs')).toBeNull();
  });

  it.each([
    ['usage_exhausted', { message: 'You have used all 10 box-hours of this period.' }, 'You are out of box-hours', 'You have used all 10 box-hours of this period.'],
    ['size_requires_pro', null, 'Larger boxes need Pro', /small and standard boxes/],
    ['concurrent_box_limit', { limit: 2, active: 2 }, 'All your boxes are busy', /runs 2 boxes at the same time/],
    ['credits_require_paid_plan', null, 'Credits come with Pro', /keep boxes running after your included hours/],
  ] as const)('explains %s on Free', (reason, notice, title, body) => {
    open(usageStatus('free'), reason, notice);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upgrade to Pro/ })).toBeInTheDocument();
  });

  it('offers Legacy Pro the move to Pro with what changes, and Add credits', async () => {
    changePlan.mockResolvedValue({ ok: true });
    open(usageStatus('legacy_pro', { usedHours: 50, exhausted: true }), 'usage_exhausted');
    const changes = screen.getByTestId('legacy-changes');
    expect(changes).toHaveTextContent('50 box-hours a month becomes 200 box-hours');
    expect(changes).toHaveTextContent('$15 a month becomes $40 a month');
    fireEvent.click(screen.getByRole('button', { name: /Annual/ }));
    expect(changes).toHaveTextContent('$15 a month becomes $400 a year');
    fireEvent.click(screen.getByRole('button', { name: 'Move to Pro' }));
    await waitFor(() => expect(changePlan).toHaveBeenCalledWith({ to: 'pro', period: 'annual' }));
    expect(checkout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    expect(openSettings).toHaveBeenCalledWith('billing');
  });

  it('sells credits to Pro, and points at auto top-up', async () => {
    creditCheckout.mockResolvedValue({ url: 'https://polar.test/credits' });
    open(usageStatus('pro', { usedHours: 200, exhausted: true }), 'usage_exhausted');
    expect(screen.getByText('You are out of box-hours')).toBeInTheDocument();
    const packs = screen.getByTestId('credit-packs');
    expect(packs).toHaveTextContent('$25');
    expect(packs).toHaveTextContent('$100 (+5% bonus)');
    expect(packs).toHaveTextContent('$500 (+10% bonus)');
    fireEvent.click(screen.getByRole('button', { name: '$100 (+5% bonus)' }));
    await waitFor(() => expect(creditCheckout).toHaveBeenCalledWith({ pack: '100' }));
    expect(openExternal).toHaveBeenCalledWith('https://polar.test/credits');
    expect(await screen.findByText(/Finish in your browser/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on auto top-up' }));
    expect(openSettings).toHaveBeenCalledWith('billing');
  });

  it('sells nothing for a full box cap on Pro', () => {
    open(usageStatus('pro'), 'concurrent_box_limit', { limit: 100, active: 100 });
    expect(screen.getByText('All your boxes are busy')).toBeInTheDocument();
    expect(screen.queryByTestId('credit-packs')).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('shows the error when checkout fails', async () => {
    const err = new Error('Polar is down');
    checkout.mockRejectedValue(err);
    open(usageStatus('free'));
    fireEvent.click(screen.getByRole('button', { name: /Upgrade to Pro:/ }));
    expect(await screen.findByText('Polar is down')).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('checkout_failed', { stage: 'create_checkout', code: undefined, status: undefined });
    expect(captureAnalyticsException).toHaveBeenCalledWith(err, { stage: 'create_checkout', code: undefined, status: undefined });
  });

  it('flips to a success state when the plan becomes Pro', () => {
    open(usageStatus('free'));
    act(() => {
      useBillingStore.setState({ status: usageStatus('pro') });
    });
    expect(screen.getByText('You are on Pro')).toBeInTheDocument();
  });

  it('flips to a success state when credits land', () => {
    open(usageStatus('pro', { balanceMicros: 0 }), 'usage_exhausted');
    act(() => {
      useBillingStore.setState({ status: usageStatus('pro', { balanceMicros: 25_000_000 }) });
    });
    expect(screen.getByText('Credits added')).toBeInTheDocument();
    expect(screen.getByText(/\$25\.00/)).toBeInTheDocument();
  });

  describe('Max', () => {
    it('is hidden when the pricing has no Max prices', () => {
      open(usageStatus('free'));
      expect(screen.queryByTestId('plan-picker')).toBeNull();
      expect(screen.queryByText(/Max/)).toBeNull();
      cleanup();
      open(usageStatus('pro', { overrides: { period: 'monthly' } }), 'upgrade');
      expect(screen.queryByText(/Max/)).toBeNull();
      expect(screen.getByTestId('credit-packs')).toBeInTheDocument();
      cleanup();
      open(usageStatus('legacy_pro'), 'compare_plans');
      expect(screen.queryByTestId('compare-plan-max')).toBeNull();
    });

    it('lets Free pick Max and check out at the chosen period', async () => {
      checkout.mockResolvedValue({ url: 'https://polar.test/max' });
      open(usageStatus('free', { maxOffered: true }));
      const picker = screen.getByTestId('plan-picker');
      expect(picker).toHaveTextContent('1,000 box-hours a month');
      expect(screen.getByRole('button', { name: 'Upgrade to Pro: $40/mo' })).toBeInTheDocument();
      fireEvent.click(within(picker).getByRole('button', { name: /^Max/ }));
      // The picker's hint and the first line of the feature list.
      expect(screen.getAllByText(/^\s*1,000 box-hours a month\s*$/)).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: /Annual/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Max: $1,000/yr' }));
      await waitFor(() => expect(checkout).toHaveBeenCalledWith({ period: 'annual', plan: 'max' }));
      expect(openExternal).toHaveBeenCalledWith('https://polar.test/max');
    });

    it('moves Pro to Max in place, with what changes', async () => {
      changePlan.mockResolvedValue({ ok: true });
      open(usageStatus('pro', { maxOffered: true, overrides: { period: 'monthly' } }), 'upgrade');
      expect(screen.getByText('Upgrade to Max', { selector: 'h2' })).toBeInTheDocument();
      const changes = screen.getByTestId('max-changes');
      expect(changes).toHaveTextContent('200 box-hours a month becomes 1,000 box-hours');
      expect(changes).toHaveTextContent('$40 a month becomes $100 a month');
      expect(screen.queryByTestId('credit-packs')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Max: $100/mo' }));
      await waitFor(() => expect(changePlan).toHaveBeenCalledWith({ to: 'max', period: 'monthly' }));
      expect(checkout).not.toHaveBeenCalled();
    });

    it('keeps an annual Pro subscriber on annual when moving to Max', async () => {
      changePlan.mockResolvedValue({ ok: true });
      open(usageStatus('pro', { maxOffered: true, overrides: { period: 'annual' } }), 'upgrade');
      expect(screen.getByRole('button', { name: /Monthly/ })).toBeDisabled();
      expect(screen.getByTestId('max-changes')).toHaveTextContent('$400 a year becomes $1,000 a year');
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Max: $1,000/yr' }));
      await waitFor(() => expect(changePlan).toHaveBeenCalledWith({ to: 'max', period: 'annual' }));
    });

    it('does not sell Max to a Pro team seat', () => {
      open(usageStatus('pro', { maxOffered: true, overrides: { planSource: 'team' } }), 'upgrade');
      expect(screen.queryByRole('button', { name: /Upgrade to Max/ })).toBeNull();
      expect(screen.getByTestId('credit-packs')).toBeInTheDocument();
    });

    it('lets Legacy Pro pick Max in place', async () => {
      changePlan.mockResolvedValue({ ok: true });
      open(usageStatus('legacy_pro', { maxOffered: true }), 'usage_alert');
      fireEvent.click(within(screen.getByTestId('plan-picker')).getByRole('button', { name: /^Max/ }));
      const changes = screen.getByTestId('legacy-changes');
      expect(changes).toHaveTextContent('What changes when you move to Max');
      expect(changes).toHaveTextContent('50 box-hours a month becomes 1,000 box-hours');
      expect(changes).toHaveTextContent('$15 a month becomes $100 a month');
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Max' }));
      await waitFor(() => expect(changePlan).toHaveBeenCalledWith({ to: 'max', period: 'monthly' }));
    });

    it('compares Max next to Pro and sells it to Free', async () => {
      checkout.mockResolvedValue({ url: 'u' });
      open(usageStatus('free', { maxOffered: true }), 'compare_plans');
      const card = screen.getByTestId('compare-plan-max');
      expect(card).toHaveTextContent('$100/mo');
      expect(card).toHaveTextContent('$1,000/yr · Save $200/yr');
      expect(card).toHaveTextContent('1,000 box-hours per month');
      fireEvent.click(within(card).getByRole('button', { name: 'Upgrade to Max' }));
      await waitFor(() => expect(checkout).toHaveBeenCalledWith({ period: 'monthly', plan: 'max' }));
    });

    it('compares plans for Pro with the Max upgrade', async () => {
      changePlan.mockResolvedValue({ ok: true });
      open(usageStatus('pro', { maxOffered: true, overrides: { period: 'monthly' } }), 'compare_plans');
      fireEvent.click(within(screen.getByTestId('compare-plan-max')).getByRole('button', { name: 'Upgrade to Max' }));
      await waitFor(() => expect(changePlan).toHaveBeenCalledWith({ to: 'max', period: 'monthly' }));
    });

    it('marks Max as current and sends a move to Pro to the portal', async () => {
      portal.mockResolvedValue({ url: 'https://polar.test/portal' });
      open(usageStatus('max', { overrides: { period: 'monthly' } }), 'compare_plans');
      expect(screen.getByTestId('compare-plan-max')).toHaveTextContent('Your plan · Monthly');
      const pro = screen.getByTestId('compare-plan-pro');
      expect(pro).toHaveTextContent('To move to Pro, use Manage billing.');
      expect(within(pro).queryByRole('button', { name: /Move to Pro|Upgrade to Pro/ })).toBeNull();
      fireEvent.click(within(pro).getByRole('button', { name: 'Manage billing' }));
      await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://polar.test/portal'));
      expect(changePlan).not.toHaveBeenCalled();
    });

    it('sells credits to Max', () => {
      open(usageStatus('max', { usedHours: 1000, exhausted: true }), 'usage_exhausted');
      expect(screen.getByTestId('credit-packs')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Upgrade/ })).toBeNull();
    });

    it('flips to a success state when the plan becomes Max', () => {
      open(usageStatus('pro', { maxOffered: true }), 'upgrade');
      act(() => {
        useBillingStore.setState({ status: usageStatus('max') });
      });
      expect(screen.getByText('You are on Max')).toBeInTheDocument();
      expect(screen.getByText('You have 1,000 box-hours a month and every box size.')).toBeInTheDocument();
    });
  });
});
