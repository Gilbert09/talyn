import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BillingStatus, TeamDetail } from '@talyn/shared';
import { TeamBilling } from '../renderer/components/panels/TeamBilling';
import { oldStatus } from '../testing/billingStatus';

const get = jest.fn();
const pricing = jest.fn();
const orders = jest.fn();
const changePlan = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { billing: { team: {
    get: (...args: unknown[]) => get(...args),
    pricing: (...args: unknown[]) => pricing(...args),
    orders: (...args: unknown[]) => orders(...args),
    changePlan: (...args: unknown[]) => changePlan(...args),
  } } },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({ features: { teams: true } }),
}));
jest.mock('../renderer/stores/billing', () => ({
  useBillingStore: (selector: (state: unknown) => unknown) => selector({
    status: null,
    refresh: jest.fn(),
    startCheckoutPollBurst: jest.fn(),
  }),
}));

const membership = {
  id: 'team-1', name: 'Acme', isAdmin: true, hasSeat: true, active: true,
  paidPersonallyToo: false, soleAdmin: true,
} as const;

function detail(overrides: Partial<TeamDetail> = {}): TeamDetail {
  return {
    id: 'team-1', name: 'Acme', active: true, tier: 'legacy_pro', planSource: 'subscription',
    seatsPurchased: 3, seatsUsed: 0, overAllocated: false, cancelAtPeriodEnd: false,
    seats: [], admins: [], ...overrides,
  };
}

function show() {
  const status: BillingStatus = { ...oldStatus(), team: membership };
  return render(<TeamBilling status={status} />);
}

describe('TeamBilling plan change', () => {
  beforeEach(() => {
    pricing.mockResolvedValue({ monthly: null, annual: null });
    orders.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    jest.clearAllMocks();
  });

  it.each([
    ['Legacy Pro subscription', {}, true],
    ['Pro', { tier: 'pro' as const }, false],
    ['override', { planSource: 'override' as const }, false],
  ])('shows the card for %s only when eligible', async (_name, overrides, visible) => {
    get.mockResolvedValue(detail(overrides));
    show();
    await screen.findByText('0 of 3 seats used');
    expect(screen.queryByTestId('team-move-to-pro') !== null).toBe(visible);
  });

  it('calls the client with the chosen period', async () => {
    get.mockResolvedValue(detail());
    changePlan.mockResolvedValue(undefined);
    show();
    await screen.findByTestId('team-move-to-pro');
    fireEvent.click(screen.getByRole('button', { name: 'Annual' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to Pro' }));
    await waitFor(() => expect(changePlan).toHaveBeenCalledWith('team-1', { period: 'annual' }));
    expect(await screen.findByText('Moving to Pro. Seats change as soon as Polar confirms.')).toBeInTheDocument();
  });
});
