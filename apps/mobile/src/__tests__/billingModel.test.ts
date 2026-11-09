import type { BillingStatus, PlanTier } from '@talyn/shared';

import { purchaseModeOf } from '../config';
import { readPurchaseMode } from '../../app.config';
import {
  billingErrorCopy, billingReasonOf, canSwitchToAnnual, cardTiers, changedPlanMessage, creditLotLines, dollarsToMicros,
  maxNeedsPortal, orderAmount, planAction, planCards, planSummary, reasonNotice, refusesReturnTarget, showsPeriodSwitch,
  topupConfigFromDraft, topupSummary, type Period,
} from '../features/billing/model';
import {
  BillingReturnTracker, RETURN_POLL_DELAYS_MS, returnBanner, returnKindOf, returnLanded, returnResultOf,
} from '../features/billing/returnFlow';
import type { UsageView } from '../features/usage/model';

const MAX_PRICING = { proMonthlyMicros: 40e6, proAnnualMicros: 400e6, legacyProMonthlyMicros: 15e6, boxHourMicros: 220_000, maxMonthlyMicros: 100e6 };
const NO_MAX = { proMonthlyMicros: 40e6, proAnnualMicros: 400e6, legacyProMonthlyMicros: 15e6, boxHourMicros: 220_000 };

function status(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    billingEnabled: true, plan: 'free', planSource: 'default', cancelAtPeriodEnd: false,
    activeTasks: 0, activeTaskLimit: null, queuedPrs: 0, mergeQueueLimit: null, workflows: 0, workflowLimit: null,
    loops: 0, loopLimit: null, activeReviews: 0, activeReviewLimit: null,
    tier: 'free', usage: { periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', includedWsec: 36_000, usedWsec: 3_600, percent: 10, exhausted: false },
    pricing: MAX_PRICING,
    ...overrides,
  } as BillingStatus;
}
function view(overrides: Partial<BillingStatus> = {}): UsageView {
  const s = status(overrides);
  return { tier: s.tier as PlanTier, usage: s.usage!, status: s };
}
const paid = (tier: PlanTier, period: 'monthly' | 'annual' = 'monthly', extra: Partial<BillingStatus> = {}) =>
  view({ tier, planSource: 'subscription', period, subscriptionStatus: 'active', currentPeriodEnd: '2026-12-01T00:00:00Z', ...extra });

describe('purchase mode', () => {
  it.each([
    [undefined, 'external'], ['', 'external'], [' external ', 'external'], ['none', 'none'],
  ])('reads EXPO_PUBLIC_PURCHASE_MODE=%p as %s', (value, mode) => {
    expect(readPurchaseMode({ EXPO_PUBLIC_PURCHASE_MODE: value })).toBe(mode);
  });
  it.each(['None', 'store', 'off'])('refuses %s at build time', (value) => {
    expect(() => readPurchaseMode({ EXPO_PUBLIC_PURCHASE_MODE: value })).toThrow('must be external or none');
  });
  it.each([
    [undefined, 'external'], [{}, 'external'], [{ mobile: null }, 'external'], [{ mobile: {} }, 'external'],
    [{ mobile: { purchaseMode: 'external' } }, 'external'], [{ mobile: { purchaseMode: 'none' } }, 'none'],
    [{ mobile: { purchaseMode: 'surprise' } }, 'none'],
  ])('reads extra %j as %s at run time', (extra, mode) => {
    expect(purchaseModeOf(extra)).toBe(mode);
  });
});

describe('plan cards', () => {
  it.each([
    ['free with Max on offer', view(), ['free', 'pro', 'max']],
    ['free without Max', view({ pricing: NO_MAX }), ['free', 'pro']],
    ['Max holder without the offer', paid('max', 'monthly', { pricing: NO_MAX }), ['free', 'pro', 'max']],
    ['Legacy Pro', paid('legacy_pro'), ['free', 'legacy_pro', 'pro', 'max']],
  ])('compares the right tiers for %s', (_name, v, tiers) => {
    expect(cardTiers(v)).toEqual(tiers);
  });

  it('marks the current plan with its period', () => {
    const cards = planCards(paid('pro', 'annual'), 'monthly', 'external');
    expect(cards.find((card) => card.current)).toMatchObject({ tier: 'pro', badge: 'Your plan · Annual' });
  });

  it.each([
    ['monthly', '$40/mo', null],
    ['annual', '$400/yr', 'Save $80 a year'],
  ] as const)('prices Pro %s', (period, price, detail) => {
    expect(planCards(view(), period, 'external').find((card) => card.tier === 'pro')).toMatchObject({ price, priceDetail: detail });
  });

  it('sells Max monthly only', () => {
    const max = planCards(view(), 'annual', 'external').find((card) => card.tier === 'max')!;
    expect(max).toMatchObject({ price: '$100/mo', priceDetail: 'Monthly only' });
    expect(max.action).toEqual({ kind: 'checkout', plan: 'max', period: 'monthly', label: 'Upgrade to Max: $100/mo' });
  });

  it.each(['monthly', 'annual'] as const)('shows no action at all in purchase mode none (%s)', (period) => {
    for (const v of [view(), paid('pro'), paid('legacy_pro'), paid('max'), paid('pro', 'annual')]) {
      expect(planCards(v, period, 'none').every((card) => card.action === null && card.note === null)).toBe(true);
    }
    expect(showsPeriodSwitch(view(), 'none')).toBe(false);
  });
});

describe('plan actions', () => {
  type Row = [string, UsageView, string, Period, ReturnType<typeof planAction>];
  it.each<Row>([
    ['free buys Pro monthly', view(), 'pro', 'monthly', { kind: 'checkout', plan: 'pro', period: 'monthly', label: 'Upgrade to Pro: $40/mo' }],
    ['free buys Pro annual', view(), 'pro', 'annual', { kind: 'checkout', plan: 'pro', period: 'annual', label: 'Upgrade to Pro: $400/yr' }],
    ['free buys Max', view(), 'max', 'monthly', { kind: 'checkout', plan: 'max', period: 'monthly', label: 'Upgrade to Max: $100/mo' }],
    ['free has nothing on Free', view(), 'free', 'monthly', null],
    ['Pro monthly moves up to Max', paid('pro'), 'max', 'monthly', { kind: 'change', plan: 'max', period: 'monthly', label: 'Upgrade to Max: $100/mo' }],
    ['Pro annual reaches Max through the portal', paid('pro', 'annual'), 'max', 'monthly', { kind: 'portal', label: 'Manage subscription' }],
    ['Max moves down through the portal', paid('max'), 'pro', 'monthly', { kind: 'portal', label: 'Manage subscription' }],
    ['a subscriber cancels to Free in the portal', paid('pro'), 'free', 'monthly', { kind: 'portal', label: 'Manage subscription' }],
    ['Legacy Pro moves to Pro', paid('legacy_pro'), 'pro', 'monthly', { kind: 'change', plan: 'pro', period: 'monthly', label: 'Move to Pro: $40/mo' }],
    ['Legacy Pro upgrades to Max', paid('legacy_pro'), 'max', 'annual', { kind: 'change', plan: 'max', period: 'monthly', label: 'Upgrade to Max: $100/mo' }],
    ['the current monthly plan has nothing', paid('pro'), 'pro', 'monthly', null],
    ['a comped account buys nothing', view({ tier: 'pro', planSource: 'override' }), 'max', 'monthly', null],
    ['a team seat buys nothing', view({ tier: 'pro', planSource: 'team' }), 'max', 'monthly', null],
    ['Max is hidden without the offer', view({ pricing: NO_MAX }), 'max', 'monthly', null],
    ['a lapsed Pro without a subscription', view({ tier: 'pro', planSource: 'default' }), 'max', 'monthly', null],
  ])('%s', (_name, v, card, period, expected) => {
    expect(planAction(v, card as PlanTier, period, 'external')).toEqual(expected);
  });

  it('offers the annual switch on the current monthly Pro plan with a confirmation', () => {
    const action = planAction(paid('pro'), 'pro', 'annual', 'external');
    expect(action).toMatchObject({ kind: 'change', plan: 'pro', period: 'annual', label: 'Switch to annual · save $80 a year' });
    expect(action && 'confirm' in action ? action.confirm : '').toContain('$400/year');
  });

  it.each([
    ['monthly Pro', paid('pro'), true],
    ['annual Pro', paid('pro', 'annual'), false],
    ['monthly Max', paid('max'), false],
    ['cancelling Pro', paid('pro', 'monthly', { cancelAtPeriodEnd: true }), false],
    ['past due Pro', paid('pro', 'monthly', { subscriptionStatus: 'past_due' }), false],
    ['team Pro', view({ tier: 'pro', planSource: 'team', period: 'monthly' }), false],
  ])('annual switch for %s: %s', (_name, v, allowed) => {
    expect(canSwitchToAnnual(v.status)).toBe(allowed);
  });

  it.each([
    [paid('pro', 'annual'), true], [paid('pro'), false], [paid('pro', 'annual', { pricing: NO_MAX }), false], [paid('max'), false],
  ])('max needs the portal: %#', (v, expected) => {
    expect(maxNeedsPortal(v.status)).toBe(expected);
  });

  it.each([
    ['pro', 'monthly', 'legacy_pro', 'You are on Pro now. 200 box-hours a month start today.'],
    ['max', 'monthly', 'pro', 'You are on Max now. Your new box-hours are ready to use.'],
    ['pro', 'annual', 'pro', 'Switched to annual. Your plan updates in a moment.'],
  ] as const)('confirms a change to %s %s from %s', (plan, period, was, message) => {
    expect(changedPlanMessage(plan, period, was)).toBe(message);
  });
});

describe('plan summary', () => {
  it.each([
    ['active monthly Pro', paid('pro'), 'Active', 'muted', 'Renews 1 December 2026'],
    ['cancelling', paid('pro', 'monthly', { cancelAtPeriodEnd: true }), 'Cancels on 1 December 2026', 'warning', null],
    ['past due', paid('pro', 'monthly', { subscriptionStatus: 'past_due' }), 'Payment failed', 'destructive', 'Renews 1 December 2026'],
    ['free', view(), 'Active', 'muted', null],
  ])('%s', (_name, v, state, tone, renews) => {
    expect(planSummary(v)).toMatchObject({ state, stateTone: tone, renews });
  });
  it('names the plan period and what it includes', () => {
    expect(planSummary(paid('pro')).detail).toBe('Pro · Monthly · $40/month. 200 box-hours a month, every size, up to 100 at once.');
    expect(planSummary(view()).detail).toBe('10 box-hours a month, small and standard boxes, 2 at once.');
  });
  it.each([
    [paid('max'), 'To move to Pro, use Manage subscription. The change starts at your next renewal.'],
    [paid('pro', 'annual'), 'Max is monthly only. To move from annual Pro to Max, use Manage subscription.'],
    [view({ tier: 'pro', planSource: 'override' }), 'Complimentary plan. Nothing to pay.'],
    [view({ tier: 'pro', planSource: 'team', team: { id: 't', name: 'Acme', hasSeat: true } as BillingStatus['team'] }), 'Paid for by your team, Acme.'],
  ])('adds the note %#', (v, note) => {
    expect(planSummary(v).notes).toContain(note);
  });
});

describe('billing errors', () => {
  it.each([
    ['downgrade_via_portal', 'change', 'To move to a smaller plan, use Manage subscription.', true],
    ['annual_to_monthly_via_portal', 'change', 'To move from an annual plan to a monthly plan, use Manage subscription.', true],
    ['monthly_only', 'checkout', 'Max is monthly only. To move from annual Pro to Max, use Manage subscription.', true],
    ['max_plan_unavailable', 'checkout', 'Max is not available for this account.', false],
    ['already_subscribed', 'checkout', 'You already have a subscription. Use "Upgrade to Max" to change it.', false],
    ['no_subscription', 'change', 'There is no subscription to change. Buy Max instead.', false],
  ] as const)('maps %s', (code, action, message, portal) => {
    expect(billingErrorCopy({ code, message: 'raw' }, { action, plan: 'max' })).toEqual({ message, portal });
  });
  it.each([
    [{ message: 'Polar is down.' }, 'checkout', 'Polar is down.'],
    [{}, 'checkout', 'Could not start the checkout.'],
    [null, 'change', 'Could not change the plan.'],
    [{ message: '  ' }, 'portal', 'Could not open the billing portal.'],
  ] as const)('falls back to the server sentence or the default %#', (error, action, message) => {
    expect(billingErrorCopy(error, { action })).toEqual({ message, portal: false });
  });
  it.each([
    [{ status: 400, code: 'invalid_return_to' }, true],
    [{ status: 400 }, true],
    [{ status: 400, code: 'monthly_only' }, false],
    [{ status: 409, code: 'already_subscribed' }, false],
    [new Error('offline'), false],
    [null, false],
  ])('retries without the return target for %j: %s', (error, retry) => {
    expect(refusesReturnTarget(error)).toBe(retry);
  });
});

describe('refusal notices', () => {
  it.each([
    ['usage_exhausted', 'usage_exhausted'], ['size_requires_pro', 'size_requires_pro'], [['size_requires_pro'], 'size_requires_pro'],
    ['concurrent_box_limit_reached', null], [undefined, null],
  ])('reads reason %p', (value, reason) => {
    expect(billingReasonOf(value)).toBe(reason);
  });
  it.each([
    [{ reason: 'usage_exhausted' }, 'usage_exhausted'], [{ note: 'size_requires_pro' }, 'size_requires_pro'],
    [{ reason: 'size_requires_pro', note: 'usage_exhausted' }, 'size_requires_pro'], [{}, null],
  ])('reads the route params %j, with note as an alias of reason', (params: { reason?: string; note?: string }, reason) => {
    expect(billingReasonOf(params.reason ?? params.note)).toBe(reason);
  });
  it.each([
    ['usage_exhausted', view(), 'external', 'Out of box-hours', /Pro includes 200 box-hours/, false],
    ['usage_exhausted', view(), 'none', 'Out of box-hours', /They reset on 1 December 2026\.$/, false],
    ['usage_exhausted', paid('pro'), 'external', 'Out of box-hours', /Add credits or turn on auto top-up/, false],
    ['size_requires_pro', view(), 'external', 'This size needs Pro', /Pro runs every size\.$/, true],
    ['size_requires_pro', view(), 'none', 'This size needs Pro', /Choose a smaller size/, true],
  ] as const)('%s for %#', (reason, v, mode, title, body, sizeLink) => {
    const notice = reasonNotice(reason, v, mode);
    expect(notice.title).toBe(title);
    expect(notice.body).toMatch(body);
    expect(notice.sizeLink).toBe(sizeLink);
  });
  it('never pitches a purchase in purchase mode none', () => {
    for (const reason of ['usage_exhausted', 'size_requires_pro'] as const) {
      for (const v of [view(), paid('pro')]) expect(reasonNotice(reason, v, 'none').body).not.toMatch(/Pro includes|Add credits|auto top-up/);
    }
  });
});

describe('credits and auto top-up', () => {
  it.each([['5', 5e6], ['$5.50', 5_500_000], ['100', 100e6], ['5.555', null], ['abc', null], ['', null], ['-1', null]])('parses %p', (text, micros) => {
    expect(dollarsToMicros(text)).toBe(micros);
  });
  it.each([
    [{ enabled: true, trigger: '5', pack: '25', limit: '100' }, { config: { enabled: true, triggerMicros: 5e6, pack: '25', monthlyLimitMicros: 100e6 } }],
    [{ enabled: true, trigger: 'x', pack: '25', limit: '100' }, { errors: ['Enter the trigger balance in dollars, for example 5.'] }],
    [{ enabled: true, trigger: '5', pack: '25', limit: '' }, { errors: ['Enter the monthly limit in dollars, for example 100.'] }],
    [{ enabled: true, trigger: '5', pack: '100', limit: '50' }, { errors: ['The monthly limit must cover at least one top-up.'] }],
  ] as const)('checks the draft %#', (draft, result) => {
    expect(topupConfigFromDraft(draft)).toEqual(result);
  });
  it.each([
    [{ enabled: false, triggerMicros: 5e6, pack: '25', monthlyLimitMicros: 100e6 }, 'Off'],
    [{ enabled: true, triggerMicros: 5e6, pack: '25', monthlyLimitMicros: 100e6 }, 'On: buy $25 below $5, at most $100 a month'],
  ] as const)('summarises %#', (settings, line) => {
    expect(topupSummary(settings)).toBe(line);
  });
  it('lists live lots, soonest expiry first', () => {
    const s = status({ credits: { balanceMicros: 30e6, expiringSoonMicros: 0, lots: [
      { id: 'b', totalMicros: 25e6, remainingMicros: 20e6, expiresAt: '2027-06-01T00:00:00Z' },
      { id: 'a', totalMicros: 25e6, remainingMicros: 10e6, expiresAt: '2027-03-01T00:00:00Z' },
      { id: 'c', totalMicros: 25e6, remainingMicros: 0, expiresAt: '2027-01-01T00:00:00Z' },
    ] } as unknown as BillingStatus['credits'] });
    expect(creditLotLines(s)).toEqual([
      { id: 'a', amount: '$10.00 of $25.00', expires: 'Expires 1 March 2027' },
      { id: 'b', amount: '$20.00 of $25.00', expires: 'Expires 1 June 2027' },
    ]);
  });
  it.each([[4000, 'usd', '$40.00'], [4000, 'eur', '40.00 EUR']])('formats an order of %s %s', (amount, currency, text) => {
    expect(orderAmount(amount, currency)).toBe(text);
  });
});

describe('billing return', () => {
  it.each([['credits', 'credits'], ['portal', 'portal'], ['checkout', 'checkout'], ['other', 'checkout'], [undefined, 'checkout']])('reads kind %p', (value, kind) => {
    expect(returnKindOf(value)).toBe(kind);
  });
  it.each([['success', 'success'], ['cancel', 'cancel'], [['cancel'], 'cancel'], ['x', 'unknown'], [undefined, 'unknown']])('reads result %p', (value, result) => {
    expect(returnResultOf(value)).toBe(result);
  });
  it('polls for about 20 seconds', () => {
    expect(RETURN_POLL_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)).toBe(20_000);
  });
  it.each([
    ['checkout', status(), status({ tier: 'pro' }), true],
    ['checkout', status({ tier: 'pro', period: 'monthly' }), status({ tier: 'pro', period: 'annual' }), true],
    ['checkout', status(), status(), false],
    ['checkout', null, status({ tier: 'pro' }), true],
    ['checkout', null, status(), false],
    ['credits', status({ credits: { balanceMicros: 1, expiringSoonMicros: 0, lots: [] } }), status({ credits: { balanceMicros: 26, expiringSoonMicros: 0, lots: [] } }), true],
    ['credits', status(), status(), false],
    ['portal', status(), status(), true],
  ] as const)('a %s return landed %#', (kind, before, after, landed) => {
    expect(returnLanded(kind, before, after)).toBe(landed);
  });
  it.each([
    ['checkout', 'cancel', false, null, { tone: 'information', message: 'Checkout was canceled. Nothing was charged.' }],
    ['credits', 'cancel', false, null, { tone: 'information', message: 'The credit purchase was canceled. Nothing was charged.' }],
    ['checkout', 'success', true, status({ tier: 'max' }), { tone: 'success', message: 'You are on Max now.' }],
    ['credits', 'success', true, status({ credits: { balanceMicros: 25e6, expiringSoonMicros: 0, lots: [] } }), { tone: 'success', message: 'Credits added. Your balance is $25.00.' }],
    ['checkout', 'success', false, status(), { tone: 'warning', message: 'Your plan has not updated yet. It can take a minute. Pull down to refresh.' }],
    ['checkout', 'unknown', false, status(), null],
    ['portal', 'success', true, status(), null],
  ] as const)('banner for %s %s %#', (kind, result, landed, after, banner) => {
    expect(returnBanner(kind, result, landed, after)).toEqual(banner);
  });

  it('stops polling once the plan lands', async () => {
    const tracker = new BillingReturnTracker(() => 0, async () => {});
    tracker.remember(status());
    const read = jest.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status()).mockResolvedValue(status({ tier: 'pro' }));
    await expect(tracker.start('checkout', 'success', read)).resolves.toEqual({ tone: 'success', message: 'You are on Pro now.' });
    expect(read).toHaveBeenCalledTimes(3);
    expect(tracker.getSnapshot().phase).toBe('done');
  });

  it('gives up after every try and survives failed reads', async () => {
    const tracker = new BillingReturnTracker(() => 0, async () => {});
    tracker.remember(status());
    const read = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(status());
    await expect(tracker.start('checkout', 'success', read)).resolves.toMatchObject({ tone: 'warning' });
    expect(read).toHaveBeenCalledTimes(RETURN_POLL_DELAYS_MS.length + 1);
  });

  it('reads once for a cancel', async () => {
    const tracker = new BillingReturnTracker(() => 0, async () => {});
    const read = jest.fn().mockResolvedValue(status());
    await tracker.start('checkout', 'cancel', read);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('joins a return that is already running, as when the app link and the browser both report it', async () => {
    let release: () => void = () => {};
    const tracker = new BillingReturnTracker(() => 0, () => new Promise<void>((resolve) => { release = resolve; }));
    tracker.remember(status());
    const read = jest.fn().mockResolvedValueOnce(status()).mockResolvedValue(status({ tier: 'pro' }));
    const first = tracker.start('checkout', 'success', read);
    await Promise.resolve();
    expect(tracker.active('checkout')).toBe(true);
    const second = tracker.start('checkout', 'unknown', read);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await expect(first).resolves.toMatchObject({ tone: 'success' });
    await expect(second).resolves.toMatchObject({ tone: 'success' });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
