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
  ] as const)('%s, reason %s', (_label, status, reason, notice, title, body, offers) => {
    const copy = usageModalCopy(reason, notice, { tier: status.tier!, status });
    expect(copy.title).toBe(title);
    if (typeof body === 'string') expect(copy.body).toBe(body);
    else expect(copy.body).toMatch(body);
    expect(copy.offers).toEqual(offers);
  });

  it('never uses an em dash', () => {
    for (const tier of ['free', 'pro', 'legacy_pro'] as const) {
      const status = usageStatus(tier);
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
