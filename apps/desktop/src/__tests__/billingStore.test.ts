/**
 * @jest-environment jsdom
 */
import type { BillingStatus } from '@talyn/shared';
import {
  MERGE_QUEUE_LIMIT_ERROR_CODE,
  TASK_LIMIT_ERROR_CODE,
  WORKFLOW_LIMIT_ERROR_CODE,
} from '@talyn/shared';
import {
  CONCURRENT_BOX_LIMIT_ERROR_CODE,
  SIZE_REQUIRES_PRO_ERROR_CODE,
  USAGE_EXHAUSTED_ERROR_CODE,
} from '@talyn/shared';
import { api, ApiError } from '../renderer/lib/api';
import { maybeHandleBillingLimit, trackBillingFailure, useBillingStore } from '../renderer/stores/billing';
import { captureAnalyticsException, trackEvent } from '../renderer/lib/analytics';
import { toast } from '../renderer/stores/toast';
import { _resetUsageAlertGuard } from '../renderer/lib/usageBilling';
import { applyWakeAnswer } from '../renderer/lib/wakeWorkbench';
import { usageStatus } from '../testing/billingStatus';

jest.mock('../renderer/lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  getSupabase: () => {
    throw new Error('getSupabase should not be called when unconfigured');
  },
}));

jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/stores/toast', () => ({ toast: { success: jest.fn(), info: jest.fn(), error: jest.fn() } }));
const trackEventMock = trackEvent as jest.Mock;
const captureExceptionMock = captureAnalyticsException as jest.Mock;
const toastMock = toast as unknown as { success: jest.Mock; info: jest.Mock; error: jest.Mock };

function status(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    billingEnabled: true,
    plan: 'free',
    planSource: 'default',
    cancelAtPeriodEnd: false,
    activeTasks: 0,
    activeTaskLimit: 3,
    queuedPrs: 0,
    mergeQueueLimit: 3,
    workflows: 0,
    workflowLimit: 3,
    loops: 0,
    loopLimit: 3,
    activeReviews: 0,
    activeReviewLimit: 1,
    ...overrides,
  };
}

function mockStatusFetch(payload: BillingStatus) {
  (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ success: true, data: payload })),
  });
}

function reset() {
  useBillingStore.getState().stopCheckoutPollBurst();
  useBillingStore.getState().clearPlanChange();
  useBillingStore.setState({ status: null, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null, sessionRefusals: {} });
}

describe('billing store', () => {
  beforeEach(() => {
    reset();
    trackEventMock.mockClear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    useBillingStore.getState().stopCheckoutPollBurst();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('maybeHandleBillingLimit', () => {
    beforeEach(() => {
      mockStatusFetch(status({ activeTasks: 3 }));
    });

    it.each([
      { label: 'task-limit', code: TASK_LIMIT_ERROR_CODE, reason: 'task_limit' },
      { label: 'merge-queue-limit', code: MERGE_QUEUE_LIMIT_ERROR_CODE, reason: 'merge_queue_limit' },
      { label: 'workflow-limit', code: WORKFLOW_LIMIT_ERROR_CODE, reason: 'workflow_limit' },
    ])('opens the upgrade modal for the $label ApiError with reason $reason', ({ code, reason }) => {
      const err = new ApiError('Free plan is limited…', 402, code);
      expect(maybeHandleBillingLimit(err)).toBe(true);
      expect(useBillingStore.getState().upgradeModalOpen).toBe(true);
      expect(useBillingStore.getState().upgradeReason).toBe(reason);
    });

    it('captures paywall_shown with the reason and trigger', () => {
      useBillingStore.getState().setStatus(status({ activeTasks: 3 }));
      trackEventMock.mockClear();
      maybeHandleBillingLimit(new ApiError('nope', 402, TASK_LIMIT_ERROR_CODE), 'task_create');
      expect(trackEventMock).toHaveBeenCalledWith(
        'paywall_shown',
        expect.objectContaining({
          reason: 'task_limit',
          trigger: 'task_create',
          active_tasks: 3,
          active_task_limit: 3,
        }),
      );
    });

    it('reports the workflow count on a workflow-limit refusal', () => {
      useBillingStore.getState().setStatus(status({ workflows: 3 }));
      trackEventMock.mockClear();
      maybeHandleBillingLimit(
        new ApiError('nope', 402, WORKFLOW_LIMIT_ERROR_CODE),
        'workflow_create',
      );
      expect(trackEventMock).toHaveBeenCalledWith(
        'paywall_shown',
        expect.objectContaining({
          reason: 'workflow_limit',
          trigger: 'workflow_create',
          workflows: 3,
          workflow_limit: 3,
        }),
      );
    });

    it('tags the merge-queue reason and defaults an absent trigger to unknown', () => {
      maybeHandleBillingLimit(new ApiError('nope', 402, MERGE_QUEUE_LIMIT_ERROR_CODE));
      expect(trackEventMock).toHaveBeenCalledWith(
        'paywall_shown',
        expect.objectContaining({ reason: 'merge_queue_limit', trigger: 'unknown' }),
      );
    });

    it.each([
      { label: 'a different code', err: new ApiError('Nope', 403, 'forbidden') },
      { label: 'no code', err: new ApiError('Request failed', 500) },
      { label: 'a plain Error', err: new Error('boom') },
      { label: 'a non-error', err: 'string' },
    ])('ignores $label (no modal, no event)', ({ err }) => {
      expect(maybeHandleBillingLimit(err)).toBe(false);
      expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
      expect(trackEventMock).not.toHaveBeenCalledWith('paywall_shown', expect.anything());
    });
  });

  describe('upgrade_completed', () => {
    it('fires once on a free→paid transition within the session', () => {
      useBillingStore.getState().setStatus(status({ plan: 'free' }));
      trackEventMock.mockClear();
      useBillingStore
        .getState()
        .setStatus(status({ plan: 'unlimited', planSource: 'subscription', activeTaskLimit: null }));
      expect(trackEventMock).toHaveBeenCalledWith('upgrade_completed', {
        plan_source: 'subscription',
      });
    });

    it('does not fire when an already-paid account loads on startup', () => {
      // prev status is null (fresh store) → loading paid is not a conversion.
      useBillingStore
        .getState()
        .setStatus(status({ plan: 'unlimited', planSource: 'subscription', activeTaskLimit: null }));
      expect(trackEventMock).not.toHaveBeenCalledWith('upgrade_completed', expect.anything());
    });
  });

  it.each(['purchase', 'auto_topup'] as const)('captures one credit_purchase_completed for a new %s lot', (source) => {
    const lot = { id: 'lot-1', totalMicros: 105_000_000, remainingMicros: 105_000_000, source, purchasedAt: '2026-11-04', expiresAt: '2027-11-04' };
    useBillingStore.getState().setStatus(usageStatus('pro'));
    useBillingStore.getState().setStatus(usageStatus('pro', { balanceMicros: 105_000_000, lots: [lot] }));
    useBillingStore.getState().setStatus(usageStatus('pro', { balanceMicros: 105_000_000, lots: [lot] }));
    expect(trackEventMock.mock.calls.filter(([event]) => event === 'credit_purchase_completed')).toEqual([
      ['credit_purchase_completed', { pack: '100', amount_micros: 100_000_000, source: source === 'purchase' ? 'manual' : 'auto_topup' }],
    ]);
  });

  it('captures plan_changed once after a started change lands', () => {
    useBillingStore.getState().setStatus(usageStatus('legacy_pro'));
    useBillingStore.getState().markPlanChangeStarted('annual');
    useBillingStore.getState().setStatus(usageStatus('pro'));
    useBillingStore.getState().setStatus(usageStatus('pro'));
    expect(trackEventMock.mock.calls.filter(([event]) => event === 'plan_changed')).toEqual([
      ['plan_changed', { from: 'legacy_pro', to: 'pro', period: 'annual' }],
    ]);
  });

  it.each(['checkout_failed', 'plan_change_failed', 'credit_checkout_failed', 'team_checkout_failed'] as const)('captures %s and its exception', (event) => {
    const err = new ApiError('No', 402, 'no_subscription');
    trackBillingFailure(event, 'create_checkout', err);
    expect(trackEventMock).toHaveBeenCalledWith(event, { stage: 'create_checkout', code: 'no_subscription', status: 402 });
    expect(captureExceptionMock).toHaveBeenCalledWith(err, { stage: 'create_checkout', code: 'no_subscription', status: 402 });
  });

  it('captures one return-stage failure during a credit refresh', async () => {
    const err = new ApiError('Unavailable', 503, 'unavailable');
    jest.spyOn(api.billing, 'status').mockRejectedValue(err);
    useBillingStore.getState().setStatus(usageStatus('pro'));
    useBillingStore.getState().startCheckoutPollBurst('credits');
    await useBillingStore.getState().refresh();
    await useBillingStore.getState().refresh();
    expect(trackEventMock.mock.calls.filter(([event]) => event === 'credit_checkout_failed')).toEqual([
      ['credit_checkout_failed', { stage: 'return', code: 'unavailable', status: 503 }],
    ]);
  });

  describe('checkout poll burst', () => {
    it('polls every 3s and stops once the plan is no longer free', async () => {
      mockStatusFetch(status({ activeTasks: 3 }));
      useBillingStore.getState().startCheckoutPollBurst();

      await jest.advanceTimersByTimeAsync(3_000);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // Plan flips (as the WS push would do) → burst ends.
      useBillingStore
        .getState()
        .setStatus(status({ plan: 'unlimited', planSource: 'subscription', activeTaskLimit: null }));
      await jest.advanceTimersByTimeAsync(15_000);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('gives up after the 2-minute deadline', async () => {
      mockStatusFetch(status());
      useBillingStore.getState().startCheckoutPollBurst();

      await jest.advanceTimersByTimeAsync(2 * 60_000 + 3_000);
      const callsAtDeadline = (global.fetch as jest.Mock).mock.calls.length;
      await jest.advanceTimersByTimeAsync(30_000);
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsAtDeadline);
    });

    it('keeps the last snapshot when a refresh fails', async () => {
      useBillingStore.getState().setStatus(status({ activeTasks: 2 }));
      (global.fetch as jest.Mock) = jest.fn().mockRejectedValue(new TypeError('offline'));
      const refresh = useBillingStore.getState().refresh();
      // The GET retries once after a delay, and the timers here are fake.
      await jest.runAllTimersAsync();
      await refresh;
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(useBillingStore.getState().status?.activeTasks).toBe(2);
    });
  });
});

describe('ApiError code propagation through request()', () => {
  it('carries status + code from the ApiResponse envelope', async () => {
    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
      status: 402,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            success: false,
            error: 'Free plan is limited to 3 active tasks',
            code: TASK_LIMIT_ERROR_CODE,
          })
        ),
    });
    const { tasks } = await import('../renderer/lib/api');
    await expect(
      tasks.create({ workspaceId: 'ws1', type: 'code_writing', title: 't', description: 'd' })
    ).rejects.toMatchObject({
      name: 'ApiError',
      status: 402,
      code: TASK_LIMIT_ERROR_CODE,
      message: 'Free plan is limited to 3 active tasks',
    });
  });

  it('still throws a code-less ApiError for legacy error bodies', async () => {
    (global.fetch as jest.Mock) = jest.fn().mockResolvedValue({
      status: 400,
      text: () => Promise.resolve(JSON.stringify({ success: false, error: 'Bad request' })),
    });
    const { workspaces } = await import('../renderer/lib/api');
    await expect(workspaces.list()).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: undefined,
    });
  });
});

describe('usage billing in the billing store', () => {
  const realRefresh = useBillingStore.getState().refresh;
  beforeEach(() => {
    reset();
    trackEventMock.mockClear();
    Object.values(toastMock).forEach((m) => m.mockClear());
    localStorage.clear();
    _resetUsageAlertGuard();
    mockStatusFetch(usageStatus('free'));
  });
  afterEach(() => {
    useBillingStore.getState().stopCheckoutPollBurst();
    useBillingStore.setState({ refresh: realRefresh });
    jest.useRealTimers();
  });

  it.each([
    { code: USAGE_EXHAUSTED_ERROR_CODE, reason: 'usage_exhausted' },
    { code: SIZE_REQUIRES_PRO_ERROR_CODE, reason: 'size_requires_pro' },
    { code: CONCURRENT_BOX_LIMIT_ERROR_CODE, reason: 'concurrent_box_limit' },
    { code: 'credits_require_paid_plan', reason: 'credits_require_paid_plan' },
  ])('opens the modal for $code with the notice from the 402 body', ({ code, reason }) => {
    const notice = { code, message: 'The plan says no.', tier: 'free', limit: 2, active: 2 };
    const err = new ApiError('The plan says no.', 402, code, { success: false, code, notice });
    expect(maybeHandleBillingLimit(err, 'workbench_send')).toBe(true);
    const state = useBillingStore.getState();
    expect(state.upgradeModalOpen).toBe(true);
    expect(state.upgradeReason).toBe(reason);
    expect(state.upgradeNotice).toEqual(notice);
    expect(trackEventMock).toHaveBeenCalledWith('paywall_shown', expect.objectContaining({ reason, trigger: 'workbench_send' }));
  });

  it('falls back to the error message when the body has no notice', () => {
    maybeHandleBillingLimit(new ApiError('Out of hours.', 402, USAGE_EXHAUSTED_ERROR_CODE));
    expect(useBillingStore.getState().upgradeNotice).toEqual({ code: USAGE_EXHAUSTED_ERROR_CODE, message: 'Out of hours.' });
  });

  it('clears the notice when the modal closes', () => {
    useBillingStore.getState().setUpgradeModalOpen(true, 'usage_exhausted', { message: 'x' });
    useBillingStore.getState().setUpgradeModalOpen(false);
    expect(useBillingStore.getState().upgradeNotice).toBeNull();
    expect(useBillingStore.getState().upgradeReason).toBeNull();
  });

  describe('alerts', () => {
    const alert = (thresholdPct: 50 | 80 | 100, tier: 'free' | 'pro' | 'legacy_pro' = 'free', periodEnd = '2026-12-01T00:00:00.000Z') => ({
      thresholdPct,
      usedWsec: (thresholdPct / 100) * 36_000,
      includedWsec: 36_000,
      tier,
      periodEnd,
    });

    it('toasts each threshold once per period and refreshes every time', () => {
      const refresh = jest.fn().mockResolvedValue(undefined);
      useBillingStore.setState({ refresh });
      useBillingStore.getState().handleUsageAlert(alert(50));
      useBillingStore.getState().handleUsageAlert(alert(50));
      expect(toastMock.info).toHaveBeenCalledTimes(1);
      expect(toastMock.info).toHaveBeenCalledWith('50% of your box-hours used', expect.stringContaining('5 of 10 box-hours'), expect.objectContaining({ label: 'Upgrade' }));
      expect(refresh).toHaveBeenCalledTimes(2);
      useBillingStore.getState().handleUsageAlert(alert(80));
      useBillingStore.getState().handleUsageAlert(alert(50, 'free', '2027-01-01T00:00:00.000Z'));
      expect(toastMock.info).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['free', 80, 'Upgrade'],
      ['legacy_pro', 50, 'Move to Pro'],
      ['legacy_pro', 80, 'Add credits'],
      ['pro', 50, 'Add credits'],
    ] as const)('offers %s at %i%%: %s', (tier, pct, label) => {
      useBillingStore.getState().handleUsageAlert(alert(pct, tier));
      expect(toastMock.info).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ label }));
    });

    it.each([
      ['free', /New boxes start again on/],
      ['pro', /Boxes now use your credits until/],
    ] as const)('words the 100%% alert for %s', (tier, body) => {
      useBillingStore.getState().handleUsageAlert(alert(100, tier));
      expect(toastMock.info).toHaveBeenCalledWith('You have used your included box-hours', expect.stringMatching(body), expect.anything());
    });

    it('says once per period that new boxes are paused', () => {
      const event = { tier: 'pro' as const, periodEnd: '2026-12-01T00:00:00.000Z', creditsAllowed: true };
      useBillingStore.getState().handleExhausted(event);
      useBillingStore.getState().handleExhausted(event);
      expect(toastMock.info).toHaveBeenCalledTimes(1);
      expect(toastMock.info).toHaveBeenCalledWith(
        'Out of hours: new boxes paused',
        expect.stringContaining('Add credits or turn on auto top-up'),
        expect.objectContaining({ label: 'Add credits' }),
      );
    });

    it('points Free at the reset or Pro when paused', () => {
      useBillingStore.getState().handleExhausted({ tier: 'free', periodEnd: '2026-12-01T00:00:00.000Z', creditsAllowed: false });
      expect(toastMock.info).toHaveBeenCalledWith(
        'Out of hours: new boxes paused',
        expect.stringContaining('upgrade to Pro'),
        expect.objectContaining({ label: 'Upgrade' }),
      );
    });
  });

  describe('checkout poll burst', () => {
    it('waits for credits to land, then announces them', () => {
      jest.useFakeTimers();
      useBillingStore.getState().setStatus(usageStatus('pro', { balanceMicros: 1_000_000 }));
      useBillingStore.getState().startCheckoutPollBurst('credits');
      // A refresh with the same balance keeps polling.
      useBillingStore.getState().setStatus(usageStatus('pro', { balanceMicros: 1_000_000 }));
      expect(toastMock.success).not.toHaveBeenCalled();
      useBillingStore.getState().setStatus(usageStatus('pro', { balanceMicros: 26_000_000 }));
      expect(toastMock.success).toHaveBeenCalledWith('Credits added', 'Your balance is $26.00.');
      (global.fetch as jest.Mock).mockClear();
      jest.advanceTimersByTime(10_000);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('waits for a usage reset to land, then announces it', () => {
      jest.useFakeTimers();
      const withResets = (resets: number) => {
        const next = usageStatus('pro', { usedHours: 50 });
        next.usage = { ...next.usage!, resets };
        return next;
      };
      useBillingStore.getState().setStatus(withResets(0));
      useBillingStore.getState().startCheckoutPollBurst('reset');
      useBillingStore.getState().setStatus(withResets(0));
      expect(toastMock.success).not.toHaveBeenCalled();
      useBillingStore.getState().setStatus(withResets(1));
      expect(toastMock.success).toHaveBeenCalledWith('Usage reset', 'Your box-hours are back.');
    });

    it('waits for Legacy Pro to become Pro, not merely for a paid plan', () => {
      useBillingStore.getState().setStatus(usageStatus('legacy_pro'));
      useBillingStore.getState().startCheckoutPollBurst('plan');
      useBillingStore.getState().setStatus(usageStatus('legacy_pro'));
      expect(toastMock.success).not.toHaveBeenCalled();
      useBillingStore.getState().setStatus(usageStatus('pro'));
      expect(toastMock.success).toHaveBeenCalledWith('You are on Pro', expect.any(String));
    });

    it('announces nothing when no burst is running', () => {
      useBillingStore.getState().setStatus(usageStatus('free'));
      useBillingStore.getState().setStatus(usageStatus('pro', { balanceMicros: 5_000_000 }));
      expect(toastMock.success).not.toHaveBeenCalled();
    });
  });

  describe('session wake refusals', () => {
    it.each([
      ['exhausted', { code: USAGE_EXHAUSTED_ERROR_CODE, message: 'Out.' }],
      ['box_limit', { code: CONCURRENT_BOX_LIMIT_ERROR_CODE, message: 'Busy.' }],
    ] as const)('records a %s wake and clears it on the next good one', (wake, notice) => {
      applyWakeAnswer('wb1', { status: wake, code: notice.code, notice });
      expect(useBillingStore.getState().sessionRefusals.wb1).toEqual({ status: wake, notice });
      applyWakeAnswer('wb1', { status: 'resuming' });
      expect(useBillingStore.getState().sessionRefusals.wb1).toBeUndefined();
    });

    it.each(['skipped', 'moving', 'awake'] as const)('records nothing for %s', (wake) => {
      applyWakeAnswer('wb1', { status: wake });
      expect(useBillingStore.getState().sessionRefusals).toEqual({});
    });

    it('drops an exhausted refusal once hours are back, and keeps a box-limit one', () => {
      applyWakeAnswer('a', { status: 'exhausted' });
      applyWakeAnswer('b', { status: 'box_limit' });
      useBillingStore.getState().setStatus(usageStatus('pro', { usedHours: 10 }));
      expect(Object.keys(useBillingStore.getState().sessionRefusals)).toEqual(['b']);
    });
  });
});
