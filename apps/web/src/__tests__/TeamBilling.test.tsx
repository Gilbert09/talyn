import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { BillingStatus, TeamDetail } from '@talyn/shared';
import { TeamBilling } from '../components/panels/TeamBilling';

const { team, state, refresh } = vi.hoisted(() => ({
  team: {
    get: vi.fn(),
    pricing: vi.fn(),
    orders: vi.fn(),
    create: vi.fn(),
    leave: vi.fn(),
    assignSeats: vi.fn(),
    checkout: vi.fn(),
  },
  state: { teamsOffered: true },
  refresh: vi.fn(),
}));
vi.mock('../lib/api', () => ({ api: { billing: { team } } }));
vi.mock('../lib/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ features: { teams: state.teamsOffered } }),
}));
vi.mock('../stores/billing', () => ({
  useBillingStore: (selector: (s: unknown) => unknown) =>
    selector({ status: null, refresh, startCheckoutPollBurst: vi.fn() }),
}));

function status(teamField?: BillingStatus['team']): BillingStatus {
  return {
    billingEnabled: true,
    plan: teamField?.hasSeat && teamField.active ? 'unlimited' : 'free',
    planSource: teamField?.hasSeat && teamField.active ? 'team' : 'default',
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
    ...(teamField ? { team: teamField } : {}),
  };
}

const MEMBERSHIP = {
  id: 'team-1',
  name: 'Acme',
  isAdmin: false,
  hasSeat: true,
  active: true,
  paidPersonallyToo: false,
} as const;

function detail(overrides: Partial<TeamDetail> = {}): TeamDetail {
  return {
    id: 'team-1',
    name: 'Acme',
    active: true,
    planSource: 'subscription',
    seatsPurchased: 3,
    seatsUsed: 1,
    overAllocated: false,
    cancelAtPeriodEnd: false,
    seats: [
      {
        id: 'seat-1',
        githubUserId: 1,
        githubLogin: 'octocat',
        avatarUrl: null,
        source: 'named',
        signedUp: false,
        createdAt: '2026-09-29T00:00:00.000Z',
      },
    ],
    admins: [{ userId: 'u1', githubUsername: 'buyer', email: 'b@example.test' }],
    ...overrides,
  };
}

beforeEach(() => {
  state.teamsOffered = true;
  team.pricing.mockResolvedValue({ monthly: null, annual: null });
  team.orders.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TeamBilling', () => {
  it('tells a seated member who pays, even with the teams flag off', () => {
    state.teamsOffered = false;
    render(<TeamBilling status={status(MEMBERSHIP)} />);
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText('Your team pays for your Unlimited plan.')).toBeTruthy();
  });

  it('warns a member who is also paying for themselves', () => {
    render(<TeamBilling status={status({ ...MEMBERSHIP, paidPersonallyToo: true })} />);
    expect(screen.getByText(/You also pay for Unlimited yourself/)).toBeTruthy();
  });

  it('says so when the team has stopped paying', () => {
    render(<TeamBilling status={status({ ...MEMBERSHIP, active: false })} />);
    expect(screen.getByText(/not paying for seats at the moment/)).toBeTruthy();
  });

  it('offers to start a team only behind the flag', () => {
    const { rerender } = render(<TeamBilling status={status()} />);
    expect(screen.getByText('Buying for a team?')).toBeTruthy();
    state.teamsOffered = false;
    rerender(<TeamBilling status={status()} />);
    expect(screen.queryByText('Buying for a team?')).toBeNull();
  });

  it('creates a team and refreshes the billing status', async () => {
    team.create.mockResolvedValue(detail());
    render(<TeamBilling status={status()} />);
    fireEvent.change(screen.getByPlaceholderText(/Team name/), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: /Start a team/ }));
    await waitFor(() => expect(team.create).toHaveBeenCalledWith({ name: 'Acme' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('shows an admin the seats, and splits pasted usernames on commas, spaces and lines', async () => {
    team.get.mockResolvedValue(detail());
    team.assignSeats.mockResolvedValue({
      assigned: [],
      failed: [{ login: 'ghost', reason: 'No GitHub user has this username.' }],
    });
    render(<TeamBilling status={status({ ...MEMBERSHIP, isAdmin: true, hasSeat: false })} />);

    expect(await screen.findByText('1 of 3 seats used')).toBeTruthy();
    expect(screen.getByText('@octocat')).toBeTruthy();
    expect(screen.getByText('Not signed in yet')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/GitHub usernames/), {
      target: { value: 'alice, bob\nghost  carol' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
    await waitFor(() =>
      expect(team.assignSeats).toHaveBeenCalledWith('team-1', {
        logins: ['alice', 'bob', 'ghost', 'carol'],
      })
    );
    expect(await screen.findByText(/@ghost: No GitHub user has this username/)).toBeTruthy();
  });

  it('blocks adding when every seat is taken', async () => {
    team.get.mockResolvedValue(detail({ seatsPurchased: 1, seatsUsed: 1 }));
    render(<TeamBilling status={status({ ...MEMBERSHIP, isAdmin: true })} />);
    expect(await screen.findByText(/Every seat is taken/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Add$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the over-allocation gap', async () => {
    team.get.mockResolvedValue(detail({ seatsPurchased: 2, seatsUsed: 3, overAllocated: true }));
    render(<TeamBilling status={status({ ...MEMBERSHIP, isAdmin: true })} />);
    expect(await screen.findByText(/Remove 1 or add seats/)).toBeTruthy();
  });

  it('offers to buy seats, with live tier prices, before the team pays', async () => {
    team.get.mockResolvedValue(detail({ active: false, planSource: 'none', seatsPurchased: 0, seatsUsed: 0, seats: [] }));
    team.pricing.mockResolvedValue({
      monthly: {
        currency: 'usd',
        tierType: 'volume',
        minimumSeats: 2,
        maximumSeats: null,
        tiers: [{ minSeats: 2, maxSeats: null, pricePerSeat: 1200 }],
      },
      annual: null,
    });
    render(<TeamBilling status={status({ ...MEMBERSHIP, isAdmin: true, hasSeat: false, active: false })} />);
    expect(await screen.findByRole('button', { name: /Buy 3 seats/ })).toBeTruthy();
    // Matched loosely: the currency symbol depends on the runner's locale.
    expect(await screen.findByText(/36\.00/)).toBeTruthy();
    // No annual price is sold here, so no annual option is drawn.
    expect(screen.queryByRole('button', { name: 'Annual' })).toBeNull();
  });

  function pricedAt(minimumSeats: number) {
    team.get.mockResolvedValue(detail({ active: false, planSource: 'none', seatsPurchased: 0, seatsUsed: 0, seats: [] }));
    team.pricing.mockResolvedValue({
      monthly: {
        currency: 'usd',
        tierType: 'volume',
        minimumSeats,
        maximumSeats: null,
        tiers: [{ minSeats: 1, maxSeats: null, pricePerSeat: 1500 }],
      },
      annual: null,
    });
  }

  it('sells a one-seat team', async () => {
    pricedAt(1);
    render(<TeamBilling status={status({ ...MEMBERSHIP, isAdmin: true, hasSeat: false, active: false })} />);
    fireEvent.change(await screen.findByLabelText('Seats'), { target: { value: '1' } });
    // One seat: the total and the per-seat price are the same $15.00.
    expect((await screen.findAllByText(/15\.00/)).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Buy 1 seat' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('holds to the Polar product minimum when it is the higher floor', async () => {
    pricedAt(3);
    render(<TeamBilling status={status({ ...MEMBERSHIP, isAdmin: true, hasSeat: false, active: false })} />);
    fireEvent.change(await screen.findByLabelText('Seats'), { target: { value: '2' } });
    expect(await screen.findByText(/Choose at least 3 seats/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Buy 2 seats' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
