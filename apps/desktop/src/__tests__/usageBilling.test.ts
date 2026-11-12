/**
 * @jest-environment jsdom
 */
import {
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_EXHAUSTED_ERROR_CODE,
  sizePriceTable,
} from '@talyn/shared';
import type { CloudProviderInfo } from '@talyn/client';
import {
  _resetUsageAlertGuard,
  claimUsageAlert,
  codeForDeferredReason,
  formatLeftPercent,
  gaugeAction,
  gaugeTone,
  hasUsageBilling,
  includedHoursText,
  leftPercent,
  maxPricesOf,
  noticeFromDetails,
  pricingOf,
  usageAlertKey,
  usageReasonForCode,
  type UsageBillingStatus,
} from '../renderer/lib/usageBilling';
import { refusalActionLabel, refusalCode } from '../renderer/components/billing/BoxRefusalAction';
import { usageUpgradeCopy } from '../renderer/components/modals/UsageUpgradeModal';
import { sizeOptionLabel } from '../renderer/components/widgets/RepoSandboxSize';
import { agentWarnings } from '../renderer/components/layout/UsageGauge';
import { oldStatus, usageStatus } from '../testing/billingStatus';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));

describe('hasUsageBilling', () => {
  it.each([
    ['null', null, false],
    ['an old backend status', oldStatus(), false],
    ['an old Unlimited status', oldStatus({ plan: 'unlimited' }), false],
    ['billing turned off', usageStatus('free', { overrides: { billingEnabled: false } }), false],
    ['a tier with no usage', { ...oldStatus(), tier: 'free' as const }, false],
    ['a free usage status', usageStatus('free'), true],
    ['a pro usage status', usageStatus('pro'), true],
    ['a legacy usage status', usageStatus('legacy_pro'), true],
  ])('%s → %s', (_label, status, expected) => {
    expect(hasUsageBilling(status)).toBe(expected);
  });
});

describe('gaugeTone', () => {
  it.each([
    [0, false, 'ok'],
    [49, false, 'ok'],
    [50, false, 'notice'],
    [79, false, 'notice'],
    [80, false, 'warning'],
    [99, false, 'warning'],
    [100, false, 'danger'],
    [10, true, 'danger'],
  ])('%i%% exhausted=%s → %s', (percent, exhausted, tone) => {
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
  ])('used=%s exhausted=%s gives %s and %s', (percent, exhausted, left, text) => {
    expect(leftPercent(percent, exhausted)).toBeCloseTo(left);
    expect(formatLeftPercent(percent, exhausted)).toBe(text);
  });
});

describe('gaugeAction', () => {
  const status = (tier: 'free' | 'pro' | 'max' | 'legacy_pro', usedHours: number, exhausted = false) =>
    usageStatus(tier, { usedHours, exhausted }) as UsageBillingStatus;

  it.each([
    ['free with hours left', status('free', 1), 'upgrade'],
    ['free nearly out', status('free', 9), 'upgrade'],
    ['free exhausted', status('free', 10, true), 'upgrade'],
    ['pro with hours left', status('pro', 10), null],
    ['pro with 15% left', status('pro', 170), null],
    ['pro with 5% left', status('pro', 190), null],
    ['pro with 4.5% left', status('pro', 191), 'add_credits'],
    ['pro exhausted', status('pro', 200, true), 'add_credits'],
    ['max with hours left', status('max', 500), null],
    ['max with 4.9% left', status('max', 951), 'add_credits'],
    ['max exhausted', status('max', 1000, true), 'add_credits'],
    ['legacy with 20% left', status('legacy_pro', 40), 'upgrade'],
    ['legacy with 4% left', status('legacy_pro', 48), 'add_credits'],
    ['legacy exhausted', status('legacy_pro', 50, true), 'add_credits'],
  ])('%s → %s', (_label, s, action) => {
    expect(gaugeAction(s)).toBe(action);
  });
});

describe('noticeFromDetails', () => {
  it.each([
    ['no details', undefined, null],
    ['no notice', { code: 'x' }, null],
    ['a string notice', { notice: 'nope' }, null],
    ['an array notice', { notice: [] }, null],
  ])('%s → null', (_label, details, expected) => {
    expect(noticeFromDetails(details as Record<string, unknown> | undefined)).toBe(expected);
  });

  it('returns the notice object', () => {
    const notice = { code: USAGE_EXHAUSTED_ERROR_CODE, message: 'Out.', tier: 'free' };
    expect(noticeFromDetails({ notice })).toEqual(notice);
  });
});

describe('code mapping', () => {
  it.each([
    [USAGE_EXHAUSTED_ERROR_CODE, 'usage_exhausted'],
    [SIZE_REQUIRES_PRO_ERROR_CODE, 'size_requires_pro'],
    [CONCURRENT_BOX_LIMIT_ERROR_CODE, 'concurrent_box_limit'],
    ['credits_require_paid_plan', 'credits_require_paid_plan'],
    ['task_limit_reached', null],
    ['', null],
  ])('usageReasonForCode(%s) → %s', (code, reason) => {
    expect(usageReasonForCode(code)).toBe(reason);
  });

  it.each([
    ['usage_exhausted', USAGE_EXHAUSTED_ERROR_CODE],
    ['box_limit_reached', CONCURRENT_BOX_LIMIT_ERROR_CODE],
    ['size_requires_pro', SIZE_REQUIRES_PRO_ERROR_CODE],
    [null, null],
    [undefined, null],
    ['something_else', null],
  ])('codeForDeferredReason(%s) → %s', (reason, code) => {
    expect(codeForDeferredReason(reason)).toBe(code);
  });

  it.each([
    ['exhausted', USAGE_EXHAUSTED_ERROR_CODE],
    ['usage_exhausted', USAGE_EXHAUSTED_ERROR_CODE],
    ['box_limit', CONCURRENT_BOX_LIMIT_ERROR_CODE],
    ['box_limit_reached', CONCURRENT_BOX_LIMIT_ERROR_CODE],
    [CONCURRENT_BOX_LIMIT_ERROR_CODE, CONCURRENT_BOX_LIMIT_ERROR_CODE],
    [SIZE_REQUIRES_PRO_ERROR_CODE, SIZE_REQUIRES_PRO_ERROR_CODE],
    ['stderr', null],
    [null, null],
  ])('refusalCode(%s) → %s', (input, code) => {
    expect(refusalCode(input)).toBe(code);
  });

  it.each([
    [USAGE_EXHAUSTED_ERROR_CODE, 'free', 'Upgrade'],
    [USAGE_EXHAUSTED_ERROR_CODE, 'pro', 'Add credits'],
    [USAGE_EXHAUSTED_ERROR_CODE, 'legacy_pro', 'Add credits'],
    [USAGE_EXHAUSTED_ERROR_CODE, 'max', 'Add credits'],
    [CONCURRENT_BOX_LIMIT_ERROR_CODE, 'max', null],
    [SIZE_REQUIRES_PRO_ERROR_CODE, 'max', null],
    [USAGE_EXHAUSTED_ERROR_CODE, null, 'Upgrade'],
    [CONCURRENT_BOX_LIMIT_ERROR_CODE, 'free', 'Upgrade'],
    [CONCURRENT_BOX_LIMIT_ERROR_CODE, 'pro', null],
    [SIZE_REQUIRES_PRO_ERROR_CODE, 'free', 'Upgrade'],
    [SIZE_REQUIRES_PRO_ERROR_CODE, 'legacy_pro', null],
    [null, 'free', null],
  ] as const)('refusalActionLabel(%s, %s) → %s', (code, tier, label) => {
    expect(refusalActionLabel(code, tier)).toBe(label);
  });
});

describe('claimUsageAlert', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetUsageAlertGuard();
  });

  it('claims each threshold of a period once', () => {
    const key = usageAlertKey('2026-12-01T00:00:00.000Z', 80);
    expect(claimUsageAlert(key)).toBe(true);
    expect(claimUsageAlert(key)).toBe(false);
  });

  it('remembers a claim across launches', () => {
    const key = usageAlertKey('2026-12-01T00:00:00.000Z', 50);
    expect(claimUsageAlert(key)).toBe(true);
    _resetUsageAlertGuard();
    expect(claimUsageAlert(key)).toBe(false);
  });

  it('treats another threshold and another period as new', () => {
    expect(claimUsageAlert(usageAlertKey('2026-12-01T00:00:00.000Z', 50))).toBe(true);
    expect(claimUsageAlert(usageAlertKey('2026-12-01T00:00:00.000Z', 80))).toBe(true);
    expect(claimUsageAlert(usageAlertKey('2027-01-01T00:00:00.000Z', 50))).toBe(true);
    expect(claimUsageAlert(usageAlertKey('2027-01-01T00:00:00.000Z', 'exhausted'))).toBe(true);
  });

  it('still says it once a launch when storage throws', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const key = usageAlertKey('2026-12-01T00:00:00.000Z', 100);
    expect(claimUsageAlert(key)).toBe(true);
    expect(claimUsageAlert(key)).toBe(false);
    spy.mockRestore();
  });
});

describe('usageUpgradeCopy', () => {
  const periodEnd = '2026-12-01T00:00:00.000Z';

  it('prefers the notice sentence when there is one', () => {
    expect(
      usageUpgradeCopy({ tier: 'free', reason: 'usage_exhausted', notice: { message: 'The server says so.' }, periodEnd }),
    ).toEqual({ title: 'You are out of box-hours', body: 'The server says so.' });
  });

  it.each([
    ['free', 'usage_exhausted', 'You are out of box-hours', /10 box-hours.*Pro includes 200 box-hours/],
    ['pro', 'usage_exhausted', 'You are out of box-hours', /Add credits or turn on auto top-up/],
    ['legacy_pro', 'usage_exhausted', 'You are out of box-hours', /Add credits or turn on auto top-up/],
    ['free', 'size_requires_pro', 'Larger boxes need Pro', /small and standard/],
    ['free', 'concurrent_box_limit', 'All your boxes are busy', /runs 2 boxes.*Pro runs up to 100/],
    ['pro', 'concurrent_box_limit', 'All your boxes are busy', /runs 100 boxes/],
    ['free', 'credits_require_paid_plan', 'Credits come with Pro', /come with Pro/],
    ['free', 'auto_keep_default', 'Keep every new PR mergeable', /Pro feature/],
    ['free', 'auto_review', 'Review every new pull request', /Pro feature/],
    ['free', 'task_deferred', 'A fix run is waiting', /could not start a box/],
    ['free', null, 'Upgrade to Pro', /200 box-hours a month/],
    ['legacy_pro', null, 'Move to Pro', /200 box-hours a month instead of 50 box-hours/],
    ['pro', null, 'Add credits', /Credits keep/],
    ['legacy_pro', 'usage_alert', 'Move to Pro', /instead of 50/],
    ['pro', 'upgrade', 'Add credits', /Credits keep/],
    ['max', null, 'Add credits', /Credits keep/],
    ['max', 'usage_exhausted', 'You are out of box-hours', /Add credits or turn on auto top-up/],
  ] as const)('%s / %s → %s', (tier, reason, title, body) => {
    const copy = usageUpgradeCopy({ tier, reason, notice: null, periodEnd });
    expect(copy.title).toBe(title);
    expect(copy.body).toMatch(body);
    expect(copy.body).not.toMatch(/—/);
  });

  it.each([
    ['pro', 'upgrade', true, 'Upgrade to Max', 'Max includes 1,000 box-hours a month instead of 200 box-hours.'],
    ['pro', 'upgrade', false, 'Add credits', 'Credits keep your boxes running after your included box-hours.'],
    ['max', 'upgrade', true, 'Add credits', 'Credits keep your boxes running after your included box-hours.'],
    ['free', null, true, 'Upgrade to Pro', 'Pro includes 200 box-hours a month, every box size and up to 100 boxes at once.'],
  ] as const)('%s / %s with maxOffered=%s → %s', (tier, reason, maxOffered, title, body) => {
    expect(usageUpgradeCopy({ tier, reason, notice: null, periodEnd, maxOffered })).toEqual({ title, body });
  });

  it('uses the notice limit for a box cap', () => {
    expect(usageUpgradeCopy({ tier: 'free', reason: 'concurrent_box_limit', notice: { limit: 7 } }).body).toMatch(
      /runs 7 boxes/,
    );
  });
});

describe('sizeOptionLabel', () => {
  it('keeps the old label and hint without usage billing', () => {
    expect(sizeOptionLabel('standard', undefined)).toBe('Standard · 4 GB — Most repos');
  });

  it.each([
    ['free', 'small', 'Small · 2 vCPU: $0.11/h, 0.5x box-hours'],
    ['free', 'standard', 'Standard · 4 GB: $0.22/h, 1x box-hours'],
    ['free', 'medium', 'Medium · 8 GB (Pro)'],
    ['free', 'large', 'Large · 12 GB (Pro)'],
    ['free', 'xlarge', 'X-Large · 16 GB (Pro)'],
    ['pro', 'medium', 'Medium · 8 GB: $0.275/h, 1.25x box-hours'],
    ['pro', 'large', 'Large · 12 GB: $0.44/h, 2x box-hours'],
    ['legacy_pro', 'xlarge', 'X-Large · 16 GB: $0.55/h, 2.5x box-hours'],
  ] as const)('%s %s → %s', (tier, size, label) => {
    const price = sizePriceTable(tier).find((p) => p.size === size);
    expect(sizeOptionLabel(size, price)).toBe(label);
  });
});

describe('agentWarnings', () => {
  const provider = (over: Partial<CloudProviderInfo>): CloudProviderInfo => ({
    type: 'selfhosted',
    displayName: 'Talyn Fleet',
    connected: true,
    ...over,
  });

  it.each([
    ['no providers', null, []],
    ['an empty list', [], []],
    ['a healthy fleet', [provider({ connectedAgents: ['claude'] })], []],
    [
      'a healthy fleet beside an unconnected PostHog Code',
      [provider({ connectedAgents: ['claude'] }), provider({ type: 'posthog_code', displayName: 'PostHog Code', connected: false })],
      [],
    ],
    [
      'a fleet agent that needs reconnecting',
      [provider({ connectedAgents: ['claude', 'codex'], reauthAgents: ['claude'] })],
      ['Claude needs reconnecting'],
    ],
    [
      'a provider that needs reconnecting with no agent named',
      [provider({ type: 'posthog_code', displayName: 'PostHog Code', needsReconnect: true })],
      ['PostHog Code needs reconnecting'],
    ],
    [
      'nothing connected at all',
      [provider({ connected: false }), provider({ type: 'posthog_code', displayName: 'PostHog Code', connected: false })],
      ['No agent is connected'],
    ],
  ])('%s', (_label, providers, expected) => {
    expect(agentWarnings(providers as CloudProviderInfo[] | null)).toEqual(expected);
  });

  it('reads the PostHog re-auth flag', () => {
    expect(agentWarnings([provider({ type: 'posthog_code', displayName: 'PostHog Code' })], true)).toEqual([
      'PostHog Code needs reconnecting',
    ]);
  });
});

describe('Max pricing', () => {
  it.each([
    ['no status', null, null],
    ['pricing without Max', usageStatus('pro'), null],
    ['pricing with Max', usageStatus('pro', { maxOffered: true }), { monthlyMicros: 100_000_000, annualMicros: null }],
    ['a Max holder', usageStatus('max'), { monthlyMicros: 100_000_000, annualMicros: null }],
  ] as const)('maxPricesOf: %s', (_label, status, prices) => {
    expect(maxPricesOf(status)).toEqual(prices);
  });

  it('never invents Max prices when the status has none', () => {
    expect(pricingOf(null).maxMonthlyMicros).toBeUndefined();
    expect(pricingOf(usageStatus('pro')).maxMonthlyMicros).toBeUndefined();
    expect(pricingOf(usageStatus('pro', { maxOffered: true })).maxMonthlyMicros).toBe(100_000_000);
  });

  it.each([
    ['free', '10 box-hours'],
    ['pro', '200 box-hours'],
    ['max', '1,000 box-hours'],
    ['legacy_pro', '50 box-hours'],
  ] as const)('includedHoursText(%s) → %s', (tier, text) => {
    expect(includedHoursText(tier)).toBe(text);
  });
});
