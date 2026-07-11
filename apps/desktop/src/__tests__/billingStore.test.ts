/**
 * @jest-environment jsdom
 */
import type { BillingStatus } from '@talyn/shared';
import { MERGE_QUEUE_LIMIT_ERROR_CODE, TASK_LIMIT_ERROR_CODE } from '@talyn/shared';
import { ApiError } from '../renderer/lib/api';
import { maybeHandleBillingLimit, useBillingStore } from '../renderer/stores/billing';
import { trackEvent } from '../renderer/lib/analytics';

jest.mock('../renderer/lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  getSupabase: () => {
    throw new Error('getSupabase should not be called when unconfigured');
  },
}));

jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
const trackEventMock = trackEvent as jest.Mock;

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
  useBillingStore.setState({ status: null, upgradeModalOpen: false });
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
  });

  describe('maybeHandleBillingLimit', () => {
    beforeEach(() => {
      mockStatusFetch(status({ activeTasks: 3 }));
    });

    it.each([
      { label: 'task-limit', code: TASK_LIMIT_ERROR_CODE, reason: 'task_limit' },
      { label: 'merge-queue-limit', code: MERGE_QUEUE_LIMIT_ERROR_CODE, reason: 'merge_queue_limit' },
    ])('opens the upgrade modal for the $label ApiError', ({ code }) => {
      const err = new ApiError('Free plan is limited…', 402, code);
      expect(maybeHandleBillingLimit(err)).toBe(true);
      expect(useBillingStore.getState().upgradeModalOpen).toBe(true);
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
      await useBillingStore.getState().refresh();
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
