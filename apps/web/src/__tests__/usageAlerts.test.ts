import { describe, it, expect, vi, beforeEach } from 'vitest';
import { announceExhausted, announceUsageAlert, _resetUsageAlerts } from '../lib/usageAlerts';
import { useToastStore } from '../stores/toast';
import { useBillingStore } from '../stores/billing';

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

const PERIOD = '2026-11-30T00:00:00.000Z';

function toasts() {
  return useToastStore.getState().toasts;
}

describe('usage alerts', () => {
  beforeEach(() => {
    _resetUsageAlerts();
    useToastStore.setState({ toasts: [] });
    useBillingStore.setState({ upgradeModalOpen: false, upgradeReason: null, upgradeNotice: null });
  });

  it.each([
    [50, 'free', 'info', 'You have used 50% of your box-hours', 'Upgrade'],
    [80, 'free', 'info', 'You have used 80% of your box-hours', 'Upgrade'],
    [100, 'free', 'error', 'You have used all your included box-hours', 'Upgrade'],
    [80, 'pro', 'info', 'You have used 80% of your box-hours', 'Add credits'],
    [100, 'pro', 'error', 'You have used all your included box-hours', 'Add credits'],
    [100, 'legacy_pro', 'error', 'You have used all your included box-hours', 'Add credits'],
  ] as const)('%i%% on %s is a %s toast titled %s with %s', (thresholdPct, tier, variant, title, action) => {
    const included = tier === 'free' ? 36_000 : 720_000;
    announceUsageAlert({ thresholdPct, usedWsec: (included * thresholdPct) / 100, includedWsec: included, tier, periodEnd: PERIOD });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ variant, title, action: { label: action } });
    expect(toasts()[0].description).not.toContain('—');
  });

  it('shows each threshold once per period', () => {
    const event = { thresholdPct: 50, usedWsec: 18_000, includedWsec: 36_000, tier: 'free', periodEnd: PERIOD } as const;
    announceUsageAlert(event);
    announceUsageAlert(event);
    announceUsageAlert({ ...event, thresholdPct: 80, usedWsec: 28_800 });
    announceUsageAlert({ ...event, periodEnd: '2026-12-31T00:00:00.000Z' });
    expect(toasts().map((t) => t.title)).toEqual([
      'You have used 50% of your box-hours',
      'You have used 80% of your box-hours',
      'You have used 50% of your box-hours',
    ]);
  });

  it('remembers a shown alert across a reload', () => {
    const event = { thresholdPct: 80, usedWsec: 1, includedWsec: 1, tier: 'pro', periodEnd: PERIOD } as const;
    announceUsageAlert(event);
    // A reload forgets the in-memory set, not the stored one.
    const stored = localStorage.getItem('talyn-usage-alerts-seen');
    _resetUsageAlerts();
    localStorage.setItem('talyn-usage-alerts-seen', stored!);
    useToastStore.setState({ toasts: [] });
    announceUsageAlert(event);
    expect(toasts()).toHaveLength(0);
  });

  it.each([
    [true, 'Add credits', 'add_credits'],
    [false, 'Upgrade', 'upgrade'],
  ])('says the boxes are paused when the hours run out (credits %s)', (creditsAllowed, label, reason) => {
    announceExhausted({ tier: creditsAllowed ? 'pro' : 'free', periodEnd: PERIOD, creditsAllowed });
    announceExhausted({ tier: creditsAllowed ? 'pro' : 'free', periodEnd: PERIOD, creditsAllowed });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({ variant: 'error', title: 'Out of hours: new boxes paused', action: { label } });
    toasts()[0].action!.onClick();
    expect(useBillingStore.getState()).toMatchObject({ upgradeModalOpen: true, upgradeReason: reason });
  });
});
