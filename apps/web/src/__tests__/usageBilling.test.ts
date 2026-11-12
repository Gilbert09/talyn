import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiError } from '@talyn/client';
import { sizePriceTable } from '@talyn/shared';
import {
  boxRefusalFromError,
  boxRefusalFromPayload,
  deferralNotice,
  deferralTitle,
  formatLeftPercent,
  gaugeAction,
  gaugeSummary,
  gaugeTone,
  leftPercent,
  MAX_INCLUDED_TEXT,
  maxPricesOf,
  refusalSentence,
  refusalTitle,
  upgradeReasonForCode,
  usageBillingOf,
} from '../lib/usageBilling';
import { wakeRefusal } from '../lib/wakeWorkbench';
import { loopRunReason } from '../components/panels/loops/LoopRunsList';
import { configFromDraft, dollarsToMicros } from '../components/settings/sections/AutoTopupForm';
import { sizeOptionLabel } from '../components/widgets/RepoSandboxSize';
import { oldStatus, usageStatus } from './usageBillingFixtures';

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

describe('usageBillingOf', () => {
  it.each([
    ['null status', null, false],
    ['an old backend', oldStatus(), false],
    ['an old backend with plan unlimited', oldStatus({ plan: 'unlimited' }), false],
    ['billing turned off', { ...usageStatus('pro'), billingEnabled: false }, false],
    ['a tier without usage', { ...usageStatus('free'), usage: undefined }, false],
    ['an unknown tier', { ...usageStatus('free'), tier: 'enterprise' as never }, false],
    ['free with usage', usageStatus('free'), true],
    ['pro with usage', usageStatus('pro'), true],
    ['legacy pro with usage', usageStatus('legacy_pro'), true],
  ])('%s', (_label, status, expected) => {
    expect(usageBillingOf(status) !== null).toBe(expected);
  });
});

describe('gaugeTone', () => {
  it.each([
    [0, false, 'ok'],
    [49, false, 'ok'],
    [50, false, 'half'],
    [79, false, 'half'],
    [80, false, 'high'],
    [99, false, 'high'],
    [100, false, 'full'],
    [10, true, 'full'],
  ] as const)('%i%% exhausted=%s is %s', (percent, exhausted, tone) => {
    expect(gaugeTone({ percent, exhausted })).toBe(tone);
  });
});

describe('leftPercent and formatLeftPercent', () => {
  it.each([
    [0, false, 100, '100% left'],
    [0.25, false, 99.75, '100% left'],
    [4.5, false, 95.5, '96% left'],
    [13.2, false, 86.8, '87% left'],
    [95.5, false, 4.5, '4.5% left'],
    [92, false, 8, '8% left'],
    [90.04, false, 9.96, '10% left'],
    [99, false, 1, '1% left'],
    [99.75, false, 0.25, 'Less than 1% left'],
    [100, false, 0, '0% left'],
    [120, false, 0, '0% left'],
    [13.2, true, 0, '0% left'],
  ] as const)('used=%s exhausted=%s gives %s and %s', (percent, exhausted, left, text) => {
    expect(leftPercent(percent, exhausted)).toBeCloseTo(left);
    expect(formatLeftPercent(percent, exhausted)).toBe(text);
  });
});

describe('gaugeAction', () => {
  it.each([
    ['free', 1, false, 'upgrade'],
    ['free', 9, false, 'upgrade'],
    ['free', 10, true, 'upgrade'],
    ['pro', 10, false, null],
    ['pro', 170, false, null],
    ['pro', 190, false, null],
    ['pro', 191, false, 'add_credits'],
    ['pro', 200, true, 'add_credits'],
    ['max', 500, false, null],
    ['max', 951, false, 'add_credits'],
    ['max', 1000, true, 'add_credits'],
    ['legacy_pro', 40, false, 'upgrade'],
    ['legacy_pro', 48, false, 'add_credits'],
    ['legacy_pro', 50, true, 'add_credits'],
  ] as const)('%s with %i hours used and exhausted=%s offers %s', (tier, usedHours, exhausted, action) => {
    const view = usageBillingOf(usageStatus(tier, { usedHours, exhausted }))!;
    expect(gaugeAction(view)).toBe(action);
  });

  it.each([
    ['pro', 191, false, null],
    ['pro', 200, true, null],
    ['max', 951, false, null],
    ['max', 1000, true, null],
    ['legacy_pro', 48, false, 'upgrade'],
    ['legacy_pro', 50, true, 'upgrade'],
    ['free', 10, true, 'upgrade'],
  ] as const)('%s with %i hours used, exhausted=%s and credits left offers %s', (tier, usedHours, exhausted, action) => {
    const view = usageBillingOf(usageStatus(tier, { usedHours, exhausted, balanceMicros: 100_000_000 }))!;
    expect(gaugeAction(view)).toBe(action);
  });
});

describe('gaugeSummary', () => {
  it('says the tier, the hours, the reset and the credits', () => {
    const view = usageBillingOf(usageStatus('pro', { usedHours: 37.5, balanceMicros: 12_500_000 }))!;
    const summary = gaugeSummary(view);
    expect(summary.tierLabel).toBe('Pro');
    expect(summary.leftText).toBe('82% left');
    expect(summary.usageText).toBe('82% left (37.5 of 200 box-hours used)');
    expect(summary.resetText).toMatch(/^Resets /);
    expect(summary.creditsText).toBe('$12.50 credits');
    expect(summary.exhaustedText).toBeNull();
  });

  it('leaves the credits out at zero and says when the hours are out', () => {
    const view = usageBillingOf(usageStatus('free', { usedHours: 10, exhausted: true }))!;
    const summary = gaugeSummary(view);
    expect(summary.leftText).toBe('0% left');
    expect(summary.usageText).toBe('0% left (10 of 10 box-hours used)');
    expect(summary.creditsText).toBeNull();
    expect(summary.exhaustedText).toBe('Out of hours: new boxes paused');
  });
});

describe('boxRefusalFromError', () => {
  it('reads the notice of a usage-billing 402', () => {
    const notice = { code: 'usage_exhausted', message: 'Out.', tier: 'free', periodEnd: '2026-11-30T00:00:00Z', creditsAllowed: false };
    const err = new ApiError('Out.', 402, 'usage_exhausted', { notice });
    expect(boxRefusalFromError(err)).toEqual(notice);
  });

  it('falls back to the error message when the notice is missing', () => {
    const err = new ApiError('Busy.', 402, 'concurrent_box_limit_reached');
    expect(boxRefusalFromError(err)).toEqual({ code: 'concurrent_box_limit_reached', message: 'Busy.' });
  });

  it.each([
    ['an old count code', new ApiError('x', 402, 'task_limit_reached')],
    ['no code', new ApiError('x', 500)],
    ['a plain error', new Error('x')],
    ['not an error', 'x'],
  ])('ignores %s', (_label, err) => {
    expect(boxRefusalFromError(err)).toBeNull();
  });
});

describe('boxRefusalFromPayload and wakeRefusal', () => {
  it('reads a wake answer that the plan refused', () => {
    const answer = { status: 'box_limit', code: 'concurrent_box_limit_reached', notice: { message: 'All busy.', limit: 2, active: 2 } };
    expect(wakeRefusal(answer)).toEqual({ code: 'concurrent_box_limit_reached', message: 'All busy.', limit: 2, active: 2 });
  });

  it.each([
    ['a box that woke', { status: 'awake' }],
    ['a box that is resuming', { status: 'resuming' }],
    ['an old backend', { status: 'skipped' }],
    ['nothing', undefined],
  ])('is null for %s', (_label, answer) => {
    expect(wakeRefusal(answer)).toBeNull();
  });

  it('takes the code from the notice when the top level has none', () => {
    expect(boxRefusalFromPayload({ notice: { code: 'usage_exhausted', message: 'Out.' } })?.code).toBe('usage_exhausted');
  });

  it('is null for a code it does not know', () => {
    expect(boxRefusalFromPayload({ code: 'task_limit_reached' })).toBeNull();
  });
});

describe('refusalSentence and refusalTitle', () => {
  it('prefers the backend sentence', () => {
    expect(refusalSentence({ code: 'usage_exhausted', message: 'Backend says.' })).toBe('Backend says.');
  });

  it.each([
    [{ code: 'usage_exhausted', message: '', creditsAllowed: true }, /Add credits/],
    [{ code: 'usage_exhausted', message: '', creditsAllowed: false, periodEnd: '2026-11-30T00:00:00Z' }, /reset on/],
    [{ code: 'concurrent_box_limit_reached', message: '', limit: 2 }, /runs 2 boxes/],
    [{ code: 'size_requires_pro', message: '', size: 'large' }, /^Large boxes need the Pro plan/],
    [{ code: 'size_requires_pro', message: '' }, /^This box size needs/],
  ] as const)('writes a fallback for %o', (notice, pattern) => {
    expect(refusalSentence(notice)).toMatch(pattern);
  });

  it.each([
    ['usage_exhausted', 'Out of box-hours'],
    ['concurrent_box_limit_reached', 'All your boxes are busy'],
    ['size_requires_pro', 'This size needs Pro'],
  ] as const)('titles %s', (code, title) => {
    expect(refusalTitle(code)).toBe(title);
  });
});

describe('deferralNotice', () => {
  it.each([
    ['usage_exhausted', 'usage_exhausted', 'usage_exhausted'],
    ['box_limit_reached', 'concurrent_box_limit_reached', 'concurrent_box_limit'],
    ['size_requires_pro', 'size_requires_pro', 'size_requires_pro'],
  ] as const)('maps %s to %s', (reason, code, upgradeReason) => {
    const notice = deferralNotice({ deferredReason: reason, deferredMessage: 'Why.', deferredRetryAt: '2026-11-30T09:00:00Z' });
    expect(notice).toEqual({ code, message: 'Why.', retryAt: '2026-11-30T09:00:00Z' });
    expect(upgradeReasonForCode(notice!.code)).toBe(upgradeReason);
  });

  it.each([
    ['an old backend row', { deferredSince: '2026-11-01T00:00:00Z' }],
    ['a null reason', { deferredReason: null }],
    ['no state', null],
  ])('is null for %s', (_label, state) => {
    expect(deferralNotice(state as never)).toBeNull();
  });

  it('says when the watcher looks again', () => {
    const title = deferralTitle({ code: 'usage_exhausted', message: 'Out.', retryAt: '2026-11-30T09:00:00Z' });
    expect(title).toMatch(/^Out\. Talyn looks again at /);
  });
});

describe('loopRunReason', () => {
  it.each([
    [{ failureCode: null, error: 'boom' }, 'boom'],
    [{ failureCode: null, error: null }, null],
    [{ failureCode: 'overlap', error: 'ignored' }, 'The previous run was still going'],
    [{ failureCode: 'usage_exhausted', error: 'You have used all 10 box-hours.' }, 'Waiting for box-hours or credits. You have used all 10 box-hours.'],
    [{ failureCode: 'box_limit_reached', error: null }, 'Waiting for a free box'],
    [{ failureCode: 'box_limit_reached', error: 'Waiting for a free box' }, 'Waiting for a free box'],
  ] as const)('%o reads %s', (run, expected) => {
    expect(loopRunReason(run)).toBe(expected);
  });
});

describe('auto top-up draft', () => {
  it.each([
    ['5', 5_000_000],
    ['$25', 25_000_000],
    ['12.5', 12_500_000],
    ['0.01', 10_000],
    ['0', 0],
    ['', null],
    ['-5', null],
    ['abc', null],
    ['1.234', null],
  ])('reads %s as %s micros', (text, micros) => {
    expect(dollarsToMicros(text)).toBe(micros);
  });

  it('builds a config from a valid draft', () => {
    expect(configFromDraft({ enabled: true, trigger: '5', pack: '100', limit: '200' })).toEqual({
      config: { enabled: true, triggerMicros: 5_000_000, pack: '100', monthlyLimitMicros: 200_000_000 },
    });
  });

  it('refuses amounts that are not dollars', () => {
    const result = configFromDraft({ enabled: true, trigger: 'x', pack: '25', limit: 'y' });
    expect(result).toEqual({
      errors: ['Enter the trigger balance in dollars, for example 5.', 'Enter the monthly limit in dollars, for example 100.'],
    });
  });

  it('refuses a monthly limit below one top-up', () => {
    const result = configFromDraft({ enabled: true, trigger: '5', pack: '500', limit: '100' });
    expect(result).toEqual({ errors: ['The monthly limit must cover at least one top-up.'] });
  });
});

describe('sizeOptionLabel', () => {
  const free = new Map(sizePriceTable('free').map((row) => [row.size, row]));
  const pro = new Map(sizePriceTable('pro').map((row) => [row.size, row]));
  it.each([
    ['small', null, 'Small · 2 vCPU — Docs, scripts and unattended runs'],
    ['small', free.get('small'), 'Small · 2 vCPU — Docs, scripts and unattended runs · 0.5 box-hours/h · $0.11/h'],
    ['standard', free.get('standard'), 'Standard · 4 GB — Most repos · 1 box-hour/h · $0.22/h'],
    ['medium', free.get('medium'), 'Medium · 8 GB — Big builds, one database · 1.25 box-hours/h · $0.275/h · Pro'],
    ['large', free.get('large'), 'Large · 12 GB — Full test stacks · 2 box-hours/h · $0.44/h · Pro'],
    ['large', pro.get('large'), 'Large · 12 GB — Full test stacks · 2 box-hours/h · $0.44/h'],
    ['xlarge', free.get('xlarge'), 'X-Large · 16 GB — The heaviest stacks · 2.5 box-hours/h · $0.55/h · Pro'],
  ] as const)('%s', (size, price, label) => {
    expect(sizeOptionLabel(size, price ?? null)).toBe(label);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('maxPricesOf', () => {
  it.each([
    ['no status', null, null],
    ['no pricing', { pricing: undefined }, null],
    ['pricing without Max', usageStatus('pro'), null],
    ['pricing with Max', usageStatus('pro', { maxOffered: true }), { monthlyMicros: 100_000_000, annualMicros: null }],
    ['a Max holder', usageStatus('max'), { monthlyMicros: 100_000_000, annualMicros: null }],
  ] as const)('%s', (_label, status, prices) => {
    expect(maxPricesOf(status)).toEqual(prices);
  });

  it('formats the Max hours with a separator', () => {
    expect(MAX_INCLUDED_TEXT).toBe('1,000 box-hours');
  });
});
