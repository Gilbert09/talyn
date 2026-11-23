import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useBillingLive, USAGE_POLL_MS } from '../hooks/useBillingLive';
import { useBillingStore } from '../stores/billing';
import { useToastStore } from '../stores/toast';
import { _resetUsageAlerts } from '../lib/usageAlerts';
import { oldStatus, usageStatus } from './usageBillingFixtures';

const { handlers, status } = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  status: vi.fn(),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('@talyn/client')>('@talyn/client');
  return {
    ...actual,
    api: { billing: { status } },
    wsClient: {
      on: (type: string, handler: (payload: unknown) => void) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    },
  };
});
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

let seenUrl = '';
function Probe() {
  useBillingLive();
  const location = useLocation();
  seenUrl = `${location.pathname}${location.search}`;
  return null;
}

function mount(url = '/') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Probe />
    </MemoryRouter>
  );
}

describe('useBillingLive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers.clear();
    status.mockReset();
    status.mockResolvedValue(usageStatus('pro'));
    _resetUsageAlerts();
    useToastStore.setState({ toasts: [] });
    useBillingStore.setState({ status: null, upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  });
  afterEach(() => {
    cleanup();
    useBillingStore.getState().stopCheckoutPollBurst();
    vi.useRealTimers();
  });

  it.each([
    ['plan', 'Your new plan can take a few seconds to show.'],
    ['credits', 'Your credits can take a few seconds to show.'],
  ])('handles the return from a %s checkout once and cleans the URL', async (kind, description) => {
    mount(`/settings/billing?checkout=success&kind=${kind}&tab=x`);
    expect(seenUrl).toBe('/settings/billing?tab=x');
    expect(status).toHaveBeenCalled();
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ variant: 'success', title: 'Payment received', description });
  });

  it('handles the return from a usage reset checkout', () => {
    mount('/settings/billing?checkout=success&kind=reset&tab=x');
    expect(seenUrl).toBe('/settings/billing?tab=x');
    expect(status).toHaveBeenCalled();
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ variant: 'success', title: 'Usage reset', description: 'Your box-hours are back.' });
  });

  it('does nothing without a checkout return', () => {
    mount('/settings/billing');
    expect(status).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('refreshes and alerts on the usage events', async () => {
    useBillingStore.setState({ status: usageStatus('free') });
    mount();
    await act(async () => {
      handlers.get('billing:usage_alert')!({ thresholdPct: 80, usedWsec: 28_800, includedWsec: 36_000, tier: 'free', periodEnd: '2026-11-30T00:00:00Z' });
    });
    expect(status).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts[0].title).toBe('You have used 80% of your box-hours');
    await act(async () => {
      handlers.get('billing:exhausted')!({ tier: 'free', periodEnd: '2026-11-30T00:00:00Z', creditsAllowed: false });
    });
    expect(status).toHaveBeenCalledTimes(2);
    expect(useToastStore.getState().toasts[1].title).toBe('Out of hours: new boxes paused');
  });

  it('polls while visible on a backend with usage billing', async () => {
    useBillingStore.setState({ status: usageStatus('pro') });
    mount();
    await act(async () => {
      vi.advanceTimersByTime(USAGE_POLL_MS);
    });
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('does not poll while the tab is hidden', async () => {
    useBillingStore.setState({ status: usageStatus('pro') });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    mount();
    await act(async () => {
      vi.advanceTimersByTime(USAGE_POLL_MS * 3);
    });
    expect(status).not.toHaveBeenCalled();
    visibility.mockRestore();
  });

  it('does not poll an old backend', async () => {
    useBillingStore.setState({ status: oldStatus() });
    mount();
    await act(async () => {
      vi.advanceTimersByTime(USAGE_POLL_MS * 3);
    });
    expect(status).not.toHaveBeenCalled();
  });
});
