import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { BillingStatus, TeamDetail } from '@talyn/shared';
import { BillingTeamNotice, TeamBilling } from '../components/panels/TeamBilling';

const { team, state, refresh } = vi.hoisted(() => ({
  team: {
    get: vi.fn(),
    pricing: vi.fn(),
    orders: vi.fn(),
    create: vi.fn(),
    leave: vi.fn(),
    assignSeats: vi.fn(),
    assignSelfSeat: vi.fn(),
    setSeatAdmin: vi.fn(),
    removeSeat: vi.fn(),
    removeAdmin: vi.fn(),
    searchGithubUsers: vi.fn(),
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
  soleAdmin: false,
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
        isAdmin: false,
        createdAt: '2026-09-29T00:00:00.000Z',
      },
    ],
    admins: [{ userId: 'u1', githubUsername: 'buyer', email: 'b@example.test', hasSeat: false }],
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
    expect(screen.getByText(/Your team pays for your Unlimited plan. The team’s admins manage its billing/)).toBeTruthy();
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

  it('shows an admin the seats, and turns a pasted list into chips', async () => {
    team.get.mockResolvedValue(detail({ seatsPurchased: 5 }));
    team.assignSeats.mockResolvedValue({
      assigned: [],
      failed: [{ login: 'ghost', reason: 'No GitHub user has this username.' }],
    });
    render(<TeamBilling status={status({ ...MEMBERSHIP, isAdmin: true })} />);

    expect(await screen.findByText('1 of 5 seats used')).toBeTruthy();
    expect(screen.getByText('@octocat')).toBeTruthy();
    expect(screen.getByText('Not signed in yet')).toBeTruthy();

    fireEvent.paste(screen.getByLabelText('Search GitHub users'), {
      clipboardData: { getData: () => 'alice, @bob\nghost  carol' },
    });
    for (const login of ['alice', 'bob', 'ghost', 'carol']) {
      expect(screen.getByText(`@${login}`)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add 4 people' }));
    await waitFor(() =>
      expect(team.assignSeats).toHaveBeenCalledWith('team-1', {
        logins: ['alice', 'bob', 'ghost', 'carol'],
      })
    );
    expect(await screen.findByText(/@ghost: No GitHub user has this username/)).toBeTruthy();
  });

  it('never picks more people than there are free seats', async () => {
    team.get.mockResolvedValue(detail({ seatsPurchased: 3, seatsUsed: 1 }));
    render(<TeamBilling status={status({ ...MEMBERSHIP, isAdmin: true })} />);
    fireEvent.paste(await screen.findByLabelText('Search GitHub users'), {
      clipboardData: { getData: () => 'alice bob carol' },
    });
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.getByText('@bob')).toBeTruthy();
    expect(screen.queryByText('@carol')).toBeNull();
    expect((screen.getByLabelText('Search GitHub users') as HTMLInputElement).disabled).toBe(true);
  });

  it('suggests GitHub accounts as you type, and picks one', async () => {
    team.get.mockResolvedValue(detail());
    team.searchGithubUsers.mockResolvedValue([
      { id: 1, login: 'octocat', avatarUrl: null },
      { id: 9, login: 'dana', avatarUrl: null },
    ]);
    team.assignSeats.mockResolvedValue({ assigned: [], failed: [] });
    render(<TeamBilling status={status({ ...MEMBERSHIP, isAdmin: true })} />);

    fireEvent.change(await screen.findByLabelText('Search GitHub users'), { target: { value: 'da' } });
    const option = await screen.findByRole('option', {}, { timeout: 2000 });
    // octocat already holds a seat, so only dana is offered.
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(team.searchGithubUsers).toHaveBeenCalledWith('team-1', 'da');
    fireEvent.click(option.querySelector('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(team.assignSeats).toHaveBeenCalledWith('team-1', { logins: ['dana'] })
    );
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

describe('admins on seats', () => {
  const seat = (over: Partial<TeamDetail['seats'][number]>) => ({
    id: 'seat-x',
    githubUserId: 7,
    githubLogin: 'x',
    avatarUrl: null,
    source: 'named' as const,
    signedUp: true,
    isAdmin: false,
    createdAt: '2026-09-29T00:00:00.000Z',
    ...over,
  });

  it('badges the admin, offers Make admin to a signed-in member, and locks the last admin', async () => {
    team.get.mockResolvedValue(
      detail({
        seatsUsed: 3,
        seats: [
          seat({ id: 's-admin', githubLogin: 'boss', isAdmin: true }),
          seat({ id: 's-member', githubLogin: 'dev' }),
          seat({ id: 's-new', githubLogin: 'newbie', signedUp: false }),
        ],
        admins: [{ userId: 'u1', githubUsername: 'boss', email: 'b@example.test', hasSeat: true }],
      })
    );
    team.setSeatAdmin.mockResolvedValue(detail());
    render(<TeamBilling status={status({ ...MEMBERSHIP, isAdmin: true, soleAdmin: true })} />);

    expect(await screen.findByText('Admin')).toBeTruthy();
    const removeAdmin = screen.getByRole('button', { name: 'Remove admin' }) as HTMLButtonElement;
    expect(removeAdmin.disabled).toBe(true);
    expect(removeAdmin.title).toMatch(/at least one admin/);
    // Only the signed-in member can be made an admin.
    const makeAdmin = screen.getAllByRole('button', { name: 'Make admin' });
    expect(makeAdmin).toHaveLength(1);
    fireEvent.click(makeAdmin[0]!);
    await waitFor(() => expect(team.setSeatAdmin).toHaveBeenCalledWith('team-1', 's-member', true));
  });
});

describe('BillingTeamNotice', () => {
  it('does not let the only admin leave, and says why', () => {
    render(<BillingTeamNotice status={status({ ...MEMBERSHIP, isAdmin: true, soleAdmin: true })} />);
    expect((screen.getByRole('button', { name: 'Leave team' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/You are the team’s only admin, so you cannot leave it/)).toBeTruthy();
  });

  it('tells an admin who can leave that they also stop being an admin', () => {
    render(<BillingTeamNotice status={status({ ...MEMBERSHIP, isAdmin: true, soleAdmin: false })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave team' }));
    expect(screen.getByText(/You also stop being an admin of the team/)).toBeTruthy();
  });

  it('tells a seated member the team controls their billing, and confirms before leaving', () => {
    render(<BillingTeamNotice status={status(MEMBERSHIP)} />);
    expect(screen.getByText(/The team’s admins manage its billing/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave team' }));
    // Leaving is confirmed first, and the dialog says what is lost.
    expect(screen.getByText(/You lose the team’s Unlimited plan straight away/)).toBeTruthy();
    expect(team.leave).not.toHaveBeenCalled();
  });

  it('points an admin without a seat at the Team section', () => {
    render(<BillingTeamNotice status={status({ ...MEMBERSHIP, isAdmin: true, hasSeat: false })} />);
    expect(screen.getByText(/You manage the team Acme/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open team settings' })).toBeTruthy();
  });

  it('offers a team to others only behind the flag', () => {
    const { rerender } = render(<BillingTeamNotice status={status()} />);
    expect(screen.getByRole('button', { name: 'Set up a team' })).toBeTruthy();
    state.teamsOffered = false;
    rerender(<BillingTeamNotice status={status()} />);
    expect(screen.queryByRole('button', { name: 'Set up a team' })).toBeNull();
  });
});
