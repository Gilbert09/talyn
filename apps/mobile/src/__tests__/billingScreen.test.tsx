import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { BillingStatus } from '@talyn/shared';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { BillingScreen } from '../features/billing/BillingScreen';
import { BillingReturnScreen } from '../features/billing/ReturnScreen';
import { billingReturn } from '../features/billing/returnFlow';

let mockStatus: BillingStatus | undefined;
let mockMode: 'external' | 'none' = 'external';
const mockRefresh = jest.fn(async () => {});
const mockCheckout = jest.fn(async (_plan: string, _period: string) => ({ url: 'https://polar.example/checkout' }));
const mockCreditCheckout = jest.fn(async (_pack: string) => ({ url: 'https://polar.example/credits' }));
const mockUsageReset = jest.fn(async () => ({ url: 'https://polar.example/reset' }));
const mockPortal = jest.fn(async () => ({ url: 'https://polar.example/portal' }));
const mockHosted = jest.fn(async (_url: string, _status: unknown) => 'dismissed' as 'dismissed' | 'returned');
const mockChangePlan = jest.fn(async (_body: unknown) => ({ ok: true }));
const mockBillingStatus = jest.fn(async () => mockStatus!);
const mockPush = jest.fn();
const mockDismissTo = jest.fn();

jest.mock('../features/billing/data', () => ({
  useBillingStatus: () => ({ status: mockStatus ? 'ready' : 'loading', data: mockStatus, stale: false, refreshing: false, refresh: mockRefresh, mutate: jest.fn() }),
  useOrders: () => ({ status: 'ready', data: [], stale: false, refreshing: false, refresh: jest.fn(async () => {}), mutate: jest.fn() }),
  appPurchaseMode: () => mockMode,
  requestCheckout: (plan: string, period: string) => mockCheckout(plan, period),
  requestCreditCheckout: (pack: string) => mockCreditCheckout(pack),
  requestPortal: () => mockPortal(),
  requestUsageResetCheckout: () => mockUsageReset(),
  runHostedFlow: (url: string, held: unknown) => mockHosted(url, held),
}));
jest.mock('@talyn/client/native', () => ({
  billing: { changePlan: (body: unknown) => mockChangePlan(body), status: () => mockBillingStatus(), autoTopup: { update: jest.fn() } },
}));
jest.mock('expo-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), dismissTo: mockDismissTo, canGoBack: () => true }) }));
jest.mock('../auth/AuthProvider', () => ({ useNetwork: () => 'online' }));

const usage = { periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', includedWsec: 36_000, usedWsec: 3_600, percent: 10, exhausted: false };
const pricing = { proMonthlyMicros: 40e6, proAnnualMicros: 400e6, legacyProMonthlyMicros: 15e6, boxHourMicros: 220_000, maxMonthlyMicros: 100e6 };
function status(overrides: Partial<BillingStatus> = {}): BillingStatus {
  return { billingEnabled: true, plan: 'free', planSource: 'default', cancelAtPeriodEnd: false, activeTasks: 0, activeTaskLimit: null,
    queuedPrs: 0, mergeQueueLimit: null, workflows: 0, workflowLimit: null, loops: 0, loopLimit: null, activeReviews: 0,
    activeReviewLimit: null, tier: 'free', usage, pricing, concurrentBoxes: { used: 1, limit: 2 }, ...overrides } as BillingStatus;
}
const proStatus = (overrides: Partial<BillingStatus> = {}) => status({ tier: 'pro', planSource: 'subscription', period: 'monthly',
  subscriptionStatus: 'active', currentPeriodEnd: '2026-12-01T00:00:00Z',
  usage: { ...usage, includedWsec: 720_000 }, credits: { balanceMicros: 12e6, expiringSoonMicros: 0, lots: [] },
  autoTopup: { enabled: false, triggerMicros: 5e6, pack: '25', monthlyLimitMicros: 100e6, monthSpentMicros: 0, lastFailure: null, lastFailureAt: null },
  ...overrides });

const insets = { frame: { x: 0, y: 0, width: 400, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const draw = (node: React.ReactElement) => render(<SafeAreaProvider initialMetrics={insets}>{node}</SafeAreaProvider>);

beforeEach(() => {
  mockStatus = status();
  mockMode = 'external';
  billingReturn.clear();
});

describe('plan and billing screen', () => {
  it('upgrades a free account through checkout in the browser', async () => {
    await draw(<BillingScreen />);
    expect(screen.getByText('90% left')).toBeVisible();
    await act(async () => { fireEvent.press(screen.getByRole('tab', { name: 'Annual' })); });
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Upgrade to Pro: $400/yr' })); });
    expect(mockCheckout).toHaveBeenCalledWith('pro', 'annual');
    expect(mockHosted).toHaveBeenCalledWith('https://polar.example/checkout', mockStatus);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('opens the return screen when the browser comes back through the app link', async () => {
    jest.useFakeTimers();
    mockHosted.mockResolvedValueOnce('returned');
    await draw(<BillingScreen />);
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Upgrade to Max: $100/mo' })); });
    expect(mockCheckout).toHaveBeenCalledWith('max', 'monthly');
    await act(async () => { jest.advanceTimersByTime(500); });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/billing/return', params: { kind: 'checkout' } });
    jest.useRealTimers();
  });

  it('moves a monthly Pro subscriber up to Max in place', async () => {
    mockStatus = proStatus();
    await draw(<BillingScreen />);
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Upgrade to Max: $100/mo' })); });
    expect(mockChangePlan).toHaveBeenCalledWith({ to: 'max', period: 'monthly' });
    expect(mockCheckout).not.toHaveBeenCalled();
    expect(await screen.findByText('You are on Max now. Your new box-hours are ready to use.')).toBeVisible();
  });

  it('offers the portal when the server says a change must go there', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockStatus = proStatus();
    mockChangePlan.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 409, code: 'downgrade_via_portal' }));
    await draw(<BillingScreen />);
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Upgrade to Max: $100/mo' })); });
    expect(alert).toHaveBeenCalledWith('Could not change the plan', 'To move to a smaller plan, use Manage subscription.', expect.any(Array));
    const buttons = alert.mock.calls[0][2]!;
    expect(buttons.map((button) => button.text)).toEqual(['Close', 'Manage subscription']);
    await act(async () => { buttons[1].onPress?.(); });
    expect(mockPortal).toHaveBeenCalled();
    alert.mockRestore();
  });

  it('sells credit packs on a paid plan', async () => {
    mockStatus = proStatus();
    await draw(<BillingScreen />);
    expect(screen.getByText('$12.00')).toBeVisible();
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: /Buy \$100 of credits/ })); });
    expect(mockCreditCheckout).toHaveBeenCalledWith('100');
  });

  it('hides the usage reset without an offer', async () => {
    mockStatus = proStatus();
    await draw(<BillingScreen />);
    expect(screen.queryByText(/Reset usage/)).toBeNull();
    expect(screen.queryByText(/times? this period/)).toBeNull();
  });

  it('shows the usage reset price and opens the checkout', async () => {
    mockStatus = proStatus({ usageReset: { tier: 'pro', priceMicros: 40e6, includedWsec: 720_000 }, usage: { ...usage, includedWsec: 720_000, resets: 2 } });
    await draw(<BillingScreen />);
    expect(screen.getByText(/Pay your plan's monthly price once to get all 200 box-hours back now. Your period still ends on 1 December 2026/)).toBeVisible();
    expect(screen.getByText('Reset 2 times this period')).toBeVisible();
    await act(async () => { fireEvent.press(screen.getByText('Reset usage: $40')); });
    expect(mockUsageReset).toHaveBeenCalled();
    expect(mockHosted).toHaveBeenCalledWith('https://polar.example/reset', mockStatus);
  });

  it('says it when the usage reset is refused', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockStatus = proStatus({ usageReset: { tier: 'pro', priceMicros: 40e6, includedWsec: 720_000 } });
    mockUsageReset.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 409, code: 'nothing_to_reset' }));
    await draw(<BillingScreen />);
    await act(async () => { fireEvent.press(screen.getByText('Reset usage: $40')); });
    expect(alert.mock.calls[0][1]).toBe('You have not used any box-hours yet. There is nothing to reset.');
    alert.mockRestore();
  });

  it('shows the plan read-only with no purchase links in purchase mode none', async () => {
    mockMode = 'none';
    mockStatus = proStatus();
    await draw(<BillingScreen reason="usage_exhausted" />);
    expect(screen.getByLabelText('Pro plan, your plan')).toBeVisible();
    expect(screen.getByText('$12.00')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Upgrade|Move to|Switch to annual|Buy \$/ })).toBeNull();
    expect(screen.queryByText('Manage subscription')).toBeNull();
    expect(screen.queryByRole('tablist', { name: 'Billing period' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save auto top-up' })).toBeNull();
    expect(screen.queryByText(/Add credits or turn on auto top-up/)).toBeNull();
    expect(screen.getByText('Off')).toBeVisible();
  });

  it.each([
    ['usage_exhausted', /Out of box-hours\. You have used all 10 box-hours/],
    ['size_requires_pro', /This size needs Pro\. This box size needs the Pro plan/],
  ] as const)('explains a %s refusal', async (reason, text) => {
    await draw(<BillingScreen reason={reason} />);
    expect(screen.getByText(text)).toBeVisible();
    if (reason === 'size_requires_pro') expect(screen.getByRole('link', { name: 'Change the box size' })).toBeVisible();
  });

  it('says when billing is not enabled', async () => {
    mockStatus = status({ billingEnabled: false });
    await draw(<BillingScreen />);
    expect(screen.getByText('Billing is not enabled')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Upgrade/ })).toBeNull();
  });
});

describe('billing return screen', () => {
  it('waits for the plan, then goes back to the plan page with a banner', async () => {
    billingReturn.remember(status());
    mockBillingStatus.mockResolvedValueOnce(status({ tier: 'pro' }));
    await draw(<BillingReturnScreen kind="checkout" result="success" />);
    expect(screen.getByRole('header', { name: 'Finishing your upgrade…' })).toBeVisible();
    await act(async () => { await Promise.resolve(); });
    expect(mockDismissTo).toHaveBeenCalledWith('/billing');
    expect(billingReturn.getSnapshot().banner).toEqual({ tone: 'success', message: 'You are on Pro now.' });
    mockStatus = status({ tier: 'pro', planSource: 'subscription', period: 'monthly' });
    await draw(<BillingScreen />);
    expect(screen.getByText('You are on Pro now.')).toBeVisible();
  });
});
