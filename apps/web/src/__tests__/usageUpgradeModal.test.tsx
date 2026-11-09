import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { ApiError } from '@talyn/client';
import type { BillingStatus } from '@talyn/shared';
import { UpgradeModal } from '../components/modals/UpgradeModal';
import { usageModalCopy } from '../components/modals/UsageUpgradeModal';
import { maybeHandleBillingLimit, useBillingStore, type UpgradeReason } from '../stores/billing';
import { captureAnalyticsException } from '../lib/analytics';
import type { BoxRefusalNotice } from '../lib/usageBilling';
import { oldStatus, usageStatus } from './usageBillingFixtures';

const { billing, trackEvent, goToHostedPage } = vi.hoisted(() => ({
  billing: {
    status: vi.fn(),
    checkout: vi.fn(),
    changePlan: vi.fn(),
    creditCheckout: vi.fn(),
    portal: vi.fn(),
  },
  trackEvent: vi.fn(),
  goToHostedPage: vi.fn(),
}));

vi.mock('@talyn/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@talyn/client')>();
  return { ...actual, api: { ...actual.api, billing } };
});
vi.mock('../lib/analytics', () => ({ trackEvent, captureAnalyticsException: vi.fn() }));
vi.mock('../lib/usageBilling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/usageBilling')>()),
  goToHostedPage,
}));

function open(status: BillingStatus, reason: UpgradeReason | null, notice: BoxRefusalNotice | null = null) {
  useBillingStore.setState({ status, upgradeModalOpen: true, upgradeReason: reason, upgradeNotice: notice });
  return render(<UpgradeModal open onOpenChange={() => {}} />);
}

const EXHAUSTED: BoxRefusalNotice = { code: 'usage_exhausted', message: 'You have used all 10 box-hours of this period.' };
const SIZE: BoxRefusalNotice = { code: 'size_requires_pro', message: 'Large boxes need the Pro plan.', size: 'large' };
const BUSY: BoxRefusalNotice = { code: 'concurrent_box_limit_reached', message: 'The Free plan runs 2 boxes at the same time (2 in use).' };

describe('usageModalCopy', () => {
  const free = usageStatus('free');
  const pro = usageStatus('pro');
  const legacy = usageStatus('legacy_pro');
  const legacyTeam = usageStatus('legacy_pro', { planSource: 'team' });
  const proTopUpOn = usageStatus('pro');
  proTopUpOn.autoTopup = { ...proTopUpOn.autoTopup!, enabled: true };
  const freeMax = usageStatus('free', { maxOffered: true });
  const proMax = usageStatus('pro', { maxOffered: true });
  const proTeamMax = usageStatus('pro', { maxOffered: true, planSource: 'team' });
  const legacyMax = usageStatus('legacy_pro', { maxOffered: true });
  const legacyTeamMax = usageStatus('legacy_pro', { maxOffered: true, planSource: 'team' });
  const max = usageStatus('max');

  it.each([
    ['free', free, 'usage_exhausted', EXHAUSTED, 'Out of box-hours', EXHAUSTED.message, ['pro_checkout']],
    ['free', free, 'size_requires_pro', SIZE, 'This size needs Pro', /Large boxes need the Pro plan\. Free runs small and standard boxes/, ['pro_checkout']],
    ['free', free, 'concurrent_box_limit', BUSY, 'All your boxes are busy', BUSY.message, ['pro_checkout']],
    ['free', free, 'credits_require_paid_plan', null, 'Credits need Pro', /does not include credits/, ['pro_checkout']],
    ['free', free, 'add_credits', null, 'Credits need Pro', /does not include credits/, ['pro_checkout']],
    ['free', free, 'auto_keep_default', null, 'Keep every new PR green with Pro', /Pro feature/, ['pro_checkout']],
    ['free', free, 'auto_review', null, 'Review every new PR with Pro', /Pro feature/, ['pro_checkout']],
    ['free', free, 'task_deferred', null, 'A fix run is waiting', /could not start a box/, ['pro_checkout']],
    ['free', free, 'upgrade', null, 'Upgrade to Pro', /200 box-hours a month/, ['pro_checkout']],
    ['free', free, null, null, 'Upgrade to Pro', /200 box-hours a month/, ['pro_checkout']],
    ['legacy', legacy, 'upgrade', null, 'Move to Pro', /200 box-hours a month instead of 50, for \$40 a month instead of \$15/, ['move_to_pro', 'credits']],
    ['legacy', legacy, 'usage_exhausted', EXHAUSTED, 'Out of box-hours', /used all 10 box-hours.*Or move to Pro/, ['credits', 'auto_topup', 'move_to_pro']],
    ['legacy', legacy, 'add_credits', null, 'Add credits', /Credits keep new boxes starting/, ['credits', 'auto_topup', 'move_to_pro']],
    ['legacy team seat', legacyTeam, 'upgrade', null, 'Move to Pro', /200 box-hours/, ['credits']],
    ['legacy team seat', legacyTeam, 'usage_exhausted', EXHAUSTED, 'Out of box-hours', EXHAUSTED.message, ['credits', 'auto_topup']],
    ['legacy', legacy, 'concurrent_box_limit', BUSY, 'All your boxes are busy', BUSY.message, []],
    ['pro', pro, 'usage_exhausted', EXHAUSTED, 'Out of box-hours', EXHAUSTED.message, ['credits', 'auto_topup']],
    ['pro', pro, 'usage_exhausted', null, 'Out of box-hours', /Add credits or turn on auto top-up/, ['credits', 'auto_topup']],
    ['pro', pro, 'add_credits', null, 'Add credits', /last 12 months/, ['credits', 'auto_topup']],
    ['pro with auto top-up on', proTopUpOn, 'add_credits', null, 'Add credits', /last 12 months/, ['credits']],
    ['pro', pro, 'concurrent_box_limit', BUSY, 'All your boxes are busy', BUSY.message, []],
    ['pro without Max offered', pro, 'upgrade', null, 'Add credits', /last 12 months/, ['credits', 'auto_topup']],
    ['free with Max offered', freeMax, 'upgrade', null, 'Upgrade to Pro', /200 box-hours a month/, ['pro_checkout', 'max_checkout']],
    ['free with Max offered', freeMax, 'usage_exhausted', EXHAUSTED, 'Out of box-hours', EXHAUSTED.message, ['pro_checkout', 'max_checkout']],
    ['legacy with Max offered', legacyMax, 'upgrade', null, 'Move to Pro', /200 box-hours/, ['move_to_pro', 'move_to_max', 'credits']],
    ['legacy with Max offered', legacyMax, 'usage_exhausted', EXHAUSTED, 'Out of box-hours', /Or move to Pro/, ['credits', 'auto_topup', 'move_to_pro', 'move_to_max']],
    ['legacy team seat with Max offered', legacyTeamMax, 'upgrade', null, 'Move to Pro', /200 box-hours/, ['credits']],
    ['pro with Max offered', proMax, 'upgrade', null, 'Upgrade to Max', 'Max gives you 1,000 box-hours a month instead of 200 box-hours, for $100 a month.', ['move_to_max', 'credits']],
    ['pro with Max offered', proMax, 'usage_exhausted', EXHAUSTED, 'Out of box-hours', EXHAUSTED.message, ['credits', 'auto_topup']],
    ['pro team seat with Max offered', proTeamMax, 'upgrade', null, 'Add credits', /last 12 months/, ['credits', 'auto_topup']],
    ['max', max, 'upgrade', null, 'Add credits', /last 12 months/, ['credits', 'auto_topup']],
    ['max', max, 'usage_exhausted', EXHAUSTED, 'Out of box-hours', EXHAUSTED.message, ['credits', 'auto_topup']],
    ['max', max, 'concurrent_box_limit', BUSY, 'All your boxes are busy', BUSY.message, []],
  ] as const)('%s, reason %s', (_label, status, reason, notice, title, body, offers) => {
    const copy = usageModalCopy(reason, notice, { tier: status.tier!, status });
    expect(copy.title).toBe(title);
    if (typeof body === 'string') expect(copy.body).toBe(body);
    else expect(copy.body).toMatch(body);
    expect(copy.offers).toEqual(offers);
  });

  it('never uses an em dash', () => {
    for (const tier of ['free', 'pro', 'max', 'legacy_pro'] as const) {
      const status = usageStatus(tier, { maxOffered: true });
      for (const reason of ['usage_exhausted', 'size_requires_pro', 'concurrent_box_limit', 'credits_require_paid_plan', 'auto_keep_default', 'auto_review', 'task_deferred', 'upgrade', 'add_credits'] as const) {
        const copy = usageModalCopy(reason, null, { tier, status });
        expect(`${copy.title} ${copy.body}`).not.toContain('—');
      }
    }
  });
});

describe('UpgradeModal', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('keeps the old Unlimited pitch on a backend without usage billing', () => {
    open(oldStatus({ activeTasks: 3 }), 'task_limit');
    expect(screen.getByText('Upgrade to Unlimited')).toBeInTheDocument();
    expect(screen.getByText(/you're using all 3/)).toBeInTheDocument();
  });

  it('pitches Pro to Free with the refusal sentence and goes to checkout', async () => {
    billing.checkout.mockResolvedValue({ url: 'https://polar.test/pro' });
    open(usageStatus('free'), 'usage_exhausted', EXHAUSTED);
    expect(screen.getByText('Out of box-hours')).toBeInTheDocument();
    expect(screen.getByText(EXHAUSTED.message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro: $40/mo' }));
    await waitFor(() => expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/pro'));
  });

  it('compare plans marks the current plan with its period and offers the switch', async () => {
    billing.changePlan.mockResolvedValue({ ok: true });
    open(usageStatus('pro', {}, { period: 'monthly' }), 'compare_plans');
    const card = screen.getByTestId('compare-plan-pro');
    expect(card).toHaveTextContent('Your plan · Monthly');
    fireEvent.click(within(card).getByRole('button', { name: 'Switch to annual · save $80 a year' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Confirm switch' }));
    await waitFor(() => expect(billing.changePlan).toHaveBeenCalledWith({ to: 'pro', period: 'annual' }));
    expect(trackEvent).toHaveBeenCalledWith('annual_switch_started', { placement: 'compare_plans' });
  });

  it('compare plans shows no switch for an annual subscriber', () => {
    open(usageStatus('pro', {}, { period: 'annual' }), 'compare_plans');
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
    expect(document.querySelector('[data-attr^="credit-pack-"]')).toBeNull();
  });

  it('offers Pro checkout from the Free comparison', async () => {
    billing.checkout.mockResolvedValue({ url: 'https://polar.test/pro' });
    open(usageStatus('free'), 'compare_plans');
    expect(within(screen.getByTestId('compare-plan-free')).getByText('Your plan')).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('compare-plan-pro')).getByRole('button', { name: 'Upgrade to Pro: $40/mo' }));
    await waitFor(() => expect(billing.checkout).toHaveBeenCalledWith({ period: 'monthly', plan: 'pro' }));
  });

  it('marks Legacy Pro as current in the comparison', () => {
    open(usageStatus('legacy_pro'), 'compare_plans');
    expect(within(screen.getByTestId('compare-plan-legacy_pro')).getByText('Your plan')).toBeInTheDocument();
    expect(screen.getByTestId('compare-plan-legacy_pro')).toHaveTextContent('50 box-hours per month');
    expect(within(screen.getByTestId('compare-plan-pro')).getByRole('button', { name: 'Move to Pro: $40/mo' })).toBeInTheDocument();
    expect(document.querySelector('[data-attr^="credit-pack-"]')).toBeNull();
  });

  it('moves Legacy Pro to Pro in place and offers credits', async () => {
    billing.changePlan.mockResolvedValue({ ok: true });
    billing.status.mockResolvedValue(usageStatus('pro'));
    open(usageStatus('legacy_pro'), 'upgrade');
    expect(document.querySelector('[data-attr="credit-pack-25"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Pro: $40/mo' }));
    await waitFor(() => expect(billing.changePlan).toHaveBeenCalledWith({ to: 'pro', period: 'monthly' }));
  });

  it('offers Pro the credit packs and auto top-up', async () => {
    billing.creditCheckout.mockResolvedValue({ url: 'https://polar.test/credits' });
    open(usageStatus('pro'), 'usage_exhausted', EXHAUSTED);
    expect(screen.getByRole('button', { name: 'turn on auto top-up' })).toBeInTheDocument();
    fireEvent.click(document.querySelector('[data-attr="credit-pack-500"]') as HTMLElement);
    await waitFor(() => expect(billing.creditCheckout).toHaveBeenCalledWith({ pack: '500' }));
    expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/credits');
  });

  describe('Max', () => {
    it('is hidden when the pricing has no Max prices', () => {
      open(usageStatus('free'), 'upgrade');
      expect(screen.getByRole('button', { name: 'Upgrade to Pro: $40/mo' })).toBeInTheDocument();
      expect(screen.queryByText(/Max/)).toBeNull();
      cleanup();
      open(usageStatus('pro', {}, { period: 'monthly' }), 'compare_plans');
      expect(screen.queryByTestId('compare-plan-max')).toBeNull();
      expect(screen.getByTestId('compare-plan-team')).toBeInTheDocument();
    });

    it('lets Free buy Max monthly, with no annual option', async () => {
      billing.checkout.mockResolvedValue({ url: 'https://polar.test/max' });
      open(usageStatus('free', { maxOffered: true }), 'upgrade');
      const offer = screen.getByTestId('offer-max_checkout');
      expect(offer).toHaveTextContent('Max · 1,000 box-hours a month');
      expect(within(offer).queryByRole('button', { name: /Annual|Monthly/ })).toBeNull();
      expect(offer).not.toHaveTextContent(/\/yr|\$1,000/);
      fireEvent.click(within(offer).getByRole('button', { name: 'Upgrade to Max: $100/mo' }));
      await waitFor(() => expect(billing.checkout).toHaveBeenCalledWith({ period: 'monthly', plan: 'max' }));
      expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/max');
      expect(trackEvent).toHaveBeenCalledWith('checkout_started', { period: 'monthly', plan: 'max', placement: 'upgrade_modal' });
    });

    it('keeps the annual option for Pro next to Max', async () => {
      billing.checkout.mockResolvedValue({ url: 'https://polar.test/pro' });
      open(usageStatus('free', { maxOffered: true }), 'upgrade');
      fireEvent.click(screen.getByRole('button', { name: /Annual/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro: $400/yr' }));
      await waitFor(() => expect(billing.checkout).toHaveBeenCalledWith({ period: 'annual', plan: 'pro' }));
    });

    it('moves Pro to Max in place, with no checkout', async () => {
      billing.changePlan.mockResolvedValue({ ok: true });
      billing.status.mockResolvedValue(usageStatus('max'));
      open(usageStatus('pro', { maxOffered: true }, { period: 'monthly' }), 'upgrade');
      expect(screen.getByRole('heading', { level: 2, name: 'Upgrade to Max' })).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Max: $100/mo' }));
      await waitFor(() => expect(billing.changePlan).toHaveBeenCalledWith({ to: 'max', period: 'monthly' }));
      expect(billing.checkout).not.toHaveBeenCalled();
    });

    it('sends an annual Pro subscriber to Manage billing for Max', async () => {
      billing.portal.mockResolvedValue({ url: 'https://polar.test/portal' });
      open(usageStatus('pro', { maxOffered: true }, { period: 'annual' }), 'upgrade');
      const offer = screen.getByTestId('offer-move_to_max');
      expect(within(offer).getByTestId('max-via-portal')).toHaveTextContent(
        'Max is monthly only. To move from annual Pro to Max, use Manage billing.'
      );
      expect(within(offer).queryByRole('button', { name: /Upgrade to Max|Annual|Monthly/ })).toBeNull();
      fireEvent.click(within(offer).getByRole('button', { name: 'Manage billing' }));
      await waitFor(() => expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/portal'));
      expect(billing.changePlan).not.toHaveBeenCalled();
    });

    it('shows the portal refusal when an annual-to-monthly change slips through', async () => {
      billing.changePlan.mockRejectedValue(
        new ApiError('Switch from annual to monthly in the billing portal.', 409, 'annual_to_monthly_via_portal')
      );
      open(usageStatus('pro', { maxOffered: true }, { period: 'monthly' }), 'upgrade');
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Max: $100/mo' }));
      expect(await screen.findByText('To move from an annual plan to a monthly plan, use Manage billing.')).toBeInTheDocument();
    });

    it('shows the refusal when Max is not available', async () => {
      billing.changePlan.mockRejectedValue(new ApiError('The Max plan is not available.', 403, 'max_plan_unavailable'));
      open(usageStatus('pro', { maxOffered: true }), 'upgrade');
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Max: $100/mo' }));
      expect(await screen.findByText('Max is not available for this account.')).toBeInTheDocument();
    });

    it('offers Legacy Pro both Pro and Max', async () => {
      billing.changePlan.mockResolvedValue({ ok: true });
      billing.status.mockResolvedValue(usageStatus('max'));
      open(usageStatus('legacy_pro', { maxOffered: true }), 'upgrade');
      expect(screen.getByRole('button', { name: 'Move to Pro: $40/mo' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Max: $100/mo' }));
      await waitFor(() => expect(billing.changePlan).toHaveBeenCalledWith({ to: 'max', period: 'monthly' }));
    });

    it('compares Max next to Pro and sells it to Free', async () => {
      billing.checkout.mockResolvedValue({ url: 'https://polar.test/max' });
      open(usageStatus('free', { maxOffered: true }), 'compare_plans');
      const card = screen.getByTestId('compare-plan-max');
      expect(card).toHaveTextContent('$100/mo');
      expect(card).not.toHaveTextContent(/\/yr|Save/);
      expect(card).toHaveTextContent('1,000 box-hours per month');
      fireEvent.click(within(card).getByRole('button', { name: 'Upgrade to Max: $100/mo' }));
      await waitFor(() => expect(billing.checkout).toHaveBeenCalledWith({ period: 'monthly', plan: 'max' }));
    });

    it('compares plans for monthly Pro with the Max upgrade', async () => {
      billing.changePlan.mockResolvedValue({ ok: true });
      billing.status.mockResolvedValue(usageStatus('max'));
      open(usageStatus('pro', { maxOffered: true }, { period: 'monthly' }), 'compare_plans');
      expect(within(screen.getByTestId('compare-plan-pro')).getByText('Your plan · Monthly')).toBeInTheDocument();
      const card = screen.getByTestId('compare-plan-max');
      expect(within(card).queryByRole('button', { name: /Annual|Monthly/ })).toBeNull();
      fireEvent.click(within(card).getByRole('button', { name: 'Upgrade to Max: $100/mo' }));
      await waitFor(() => expect(billing.changePlan).toHaveBeenCalledWith({ to: 'max', period: 'monthly' }));
    });

    it('compares plans for annual Pro with Max through Manage billing', () => {
      open(usageStatus('pro', { maxOffered: true }, { period: 'annual' }), 'compare_plans');
      expect(within(screen.getByTestId('compare-plan-pro')).getByText('Your plan · Annual')).toBeInTheDocument();
      const card = screen.getByTestId('compare-plan-max');
      expect(within(card).getByTestId('max-via-portal')).toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: /Upgrade to Max/ })).toBeNull();
      expect(within(card).getByRole('button', { name: 'Manage billing' })).toBeInTheDocument();
    });

    it('marks Max as current and sends a move to Pro to the portal', async () => {
      billing.portal.mockResolvedValue({ url: 'https://polar.test/portal' });
      open(usageStatus('max', {}, { period: 'monthly' }), 'compare_plans');
      expect(within(screen.getByTestId('compare-plan-max')).getByText('Your plan · Monthly')).toBeInTheDocument();
      const pro = screen.getByTestId('compare-plan-pro');
      expect(within(pro).queryByRole('button', { name: /Move to Pro|Upgrade to Pro/ })).toBeNull();
      expect(pro).toHaveTextContent('To move to Pro, use Manage billing.');
      fireEvent.click(within(pro).getByRole('button', { name: 'Manage billing' }));
      await waitFor(() => expect(goToHostedPage).toHaveBeenCalledWith('https://polar.test/portal'));
      expect(billing.changePlan).not.toHaveBeenCalled();
    });

    it('offers a monthly Max subscriber no annual switch', () => {
      open(usageStatus('max', {}, { period: 'monthly' }), 'compare_plans');
      const card = screen.getByTestId('compare-plan-max');
      expect(within(card).queryByRole('button', { name: /Switch to annual/ })).toBeNull();
      expect(card).not.toHaveTextContent(/\/yr/);
    });
  });

  it('shows a credit checkout refusal in the modal', async () => {
    const err = new ApiError('Credits need a paid plan.', 402, 'credits_require_paid_plan');
    billing.creditCheckout.mockRejectedValue(err);
    open(usageStatus('pro'), 'add_credits');
    fireEvent.click(document.querySelector('[data-attr="credit-pack-25"]') as HTMLElement);
    expect(await screen.findByText('Credits need a paid plan.')).toBeInTheDocument();
    expect(trackEvent).toHaveBeenCalledWith('credit_checkout_failed', { stage: 'create_checkout', code: 'credits_require_paid_plan', status: 402 });
    expect(captureAnalyticsException).toHaveBeenCalledWith(err, { stage: 'create_checkout', code: 'credits_require_paid_plan', status: 402 });
  });
});

describe('maybeHandleBillingLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    billing.status.mockResolvedValue(usageStatus('free'));
    useBillingStore.setState({ status: usageStatus('free'), upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  });

  it.each([
    ['usage_exhausted', 'usage_exhausted'],
    ['size_requires_pro', 'size_requires_pro'],
    ['concurrent_box_limit_reached', 'concurrent_box_limit'],
    ['credits_require_paid_plan', 'credits_require_paid_plan'],
    ['task_limit_reached', 'task_limit'],
    ['merge_queue_limit_reached', 'merge_queue_limit'],
    ['workflow_limit_reached', 'workflow_limit'],
    ['loop_limit_reached', 'loop_limit'],
    ['code_review_limit_reached', 'code_review_limit'],
    ['auto_keep_default_requires_unlimited', 'auto_keep_default'],
    ['auto_review_requires_unlimited', 'auto_review'],
  ])('opens the modal for %s with reason %s', (code, reason) => {
    const notice = { code, message: 'Why.', limit: 2 };
    expect(maybeHandleBillingLimit(new ApiError('Why.', 402, code, { notice }), 'test')).toBe(true);
    const state = useBillingStore.getState();
    expect(state.upgradeModalOpen).toBe(true);
    expect(state.upgradeReason).toBe(reason);
    expect(trackEvent).toHaveBeenCalledWith('paywall_shown', expect.objectContaining({ reason, trigger: 'test', tier: 'free' }));
  });

  it('carries the notice of a usage refusal to the modal', () => {
    const notice = { code: 'concurrent_box_limit_reached', message: 'All busy.', limit: 2, active: 2 };
    maybeHandleBillingLimit(new ApiError('All busy.', 402, 'concurrent_box_limit_reached', { notice }));
    expect(useBillingStore.getState().upgradeNotice).toEqual(notice);
  });

  it.each([
    ['a plain error', new Error('boom')],
    ['a 500', new ApiError('boom', 500)],
    ['a 402 with another code', new ApiError('boom', 402, 'something_else')],
    ['an object with a billing code that is not an ApiError', { code: 'usage_exhausted' }],
    ['nothing', undefined],
  ])('leaves %s to the caller', (_label, err) => {
    expect(maybeHandleBillingLimit(err)).toBe(false);
    expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
  });

  it('clears the reason and the notice on close', () => {
    maybeHandleBillingLimit(new ApiError('x', 402, 'usage_exhausted', { notice: { message: 'x' } }));
    useBillingStore.getState().setUpgradeModalOpen(false);
    expect(useBillingStore.getState()).toMatchObject({ upgradeReason: null, upgradeNotice: null });
  });
});
