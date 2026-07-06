/**
 * @jest-environment jsdom
 */
import type { BillingStatus } from '@talyn/shared';
import { TASK_LIMIT_ERROR_CODE } from '@talyn/shared';
import { ApiError } from '../renderer/lib/api';
import { maybeHandleTaskLimit, useBillingStore } from '../renderer/stores/billing';

jest.mock('../renderer/lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  getSupabase: () => {
    throw new Error('getSupabase should not be called when unconfigured');
  },
}));

function status(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return {
    billingEnabled: true,
    plan: 'free',
    planSource: 'default',
    cancelAtPeriodEnd: false,
    activeTasks: 0,
    activeTaskLimit: 3,
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
    jest.useFakeTimers();
  });

  afterEach(() => {
    useBillingStore.getState().stopCheckoutPollBurst();
    jest.useRealTimers();
  });

  describe('maybeHandleTaskLimit', () => {
    beforeEach(() => {
      mockStatusFetch(status({ activeTasks: 3 }));
    });

    it('opens the upgrade modal for the task-limit ApiError', () => {
      const err = new ApiError('Free plan is limited…', 402, TASK_LIMIT_ERROR_CODE);
      expect(maybeHandleTaskLimit(err)).toBe(true);
      expect(useBillingStore.getState().upgradeModalOpen).toBe(true);
    });

    it.each([
      { label: 'a different code', err: new ApiError('Nope', 403, 'forbidden') },
      { label: 'no code', err: new ApiError('Request failed', 500) },
      { label: 'a plain Error', err: new Error('boom') },
      { label: 'a non-error', err: 'string' },
    ])('ignores $label', ({ err }) => {
      expect(maybeHandleTaskLimit(err)).toBe(false);
      expect(useBillingStore.getState().upgradeModalOpen).toBe(false);
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
