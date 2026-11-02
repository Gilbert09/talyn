import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { BillingStatus } from '@talyn/shared';
import { useDeferredRuns, _resetDeferredRunsGuard } from '../hooks/useDeferredRuns';
import { useBillingStore } from '../stores/billing';
import { usePullRequestStore } from '../stores/pullRequests';
import type { PRRow } from '../lib/api';
import { oldStatus, usageStatus } from './usageBillingFixtures';

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

function row(autoMergeState: Record<string, unknown>): PRRow {
  return { id: 'pr1', autoKeepMergeable: true, autoMergeState } as unknown as PRRow;
}

function run(status: BillingStatus, rows: PRRow[]) {
  useBillingStore.setState({ status, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  usePullRequestStore.setState({ rows } as never);
  renderHook(() => useDeferredRuns());
  return useBillingStore.getState();
}

describe('useDeferredRuns with usage billing', () => {
  beforeEach(() => {
    _resetDeferredRunsGuard();
    localStorage.removeItem('talyn-deferred-runs-last-shown');
  });
  afterEach(cleanup);

  it('keeps the old free-plan reason on a backend without usage billing', () => {
    const state = run(oldStatus(), [row({ deferredSince: '2026-11-01T00:00:00Z' })]);
    expect(state).toMatchObject({ upgradeModalOpen: true, upgradeReason: 'task_deferred', upgradeNotice: null });
  });

  it('says nothing to an old Unlimited account', () => {
    const state = run(oldStatus({ plan: 'unlimited' }), [row({ deferredSince: '2026-11-01T00:00:00Z' })]);
    expect(state.upgradeModalOpen).toBe(false);
  });

  it.each([
    ['free', 'box_limit_reached', 'concurrent_box_limit', 'concurrent_box_limit_reached'],
    ['pro', 'usage_exhausted', 'usage_exhausted', 'usage_exhausted'],
    ['legacy_pro', 'usage_exhausted', 'usage_exhausted', 'usage_exhausted'],
  ] as const)('on %s reads the row reason %s', (tier, deferredReason, reason, code) => {
    const state = run(usageStatus(tier), [
      row({ deferredSince: '2026-11-01T00:00:00Z', deferredReason, deferredMessage: 'The plan says why.' }),
    ]);
    expect(state.upgradeModalOpen).toBe(true);
    expect(state.upgradeReason).toBe(reason);
    expect(state.upgradeNotice).toMatchObject({ code, message: 'The plan says why.' });
  });

  it('says nothing when no run is waiting', () => {
    const state = run(usageStatus('pro'), [row({ deferredSince: null })]);
    expect(state.upgradeModalOpen).toBe(false);
  });
});
