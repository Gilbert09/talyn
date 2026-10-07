import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import type {
  DeveloperActivity,
  DeveloperActivityEvent,
  DeveloperRateLimits,
} from '@talyn/shared';
import {
  DeveloperInternals,
  DEVELOPER_POLL_MS,
  resetsIn,
} from '../renderer/components/panels/DeveloperInternals';

const mockRateLimits = jest.fn();
const mockAgents = jest.fn();
const mockActivity = jest.fn();
const mockAccess = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: {
    developer: {
      rateLimits: (...args: unknown[]) => mockRateLimits(...args),
      agents: (...args: unknown[]) => mockAgents(...args),
      activity: (...args: unknown[]) => mockActivity(...args),
    },
    debug: { getAccess: () => mockAccess() },
  },
}));

const state: { workspaceId: string | null } = { workspaceId: 'ws1' };
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ currentWorkspaceId: state.workspaceId }),
}));

const FAKE = jest;

const now = Date.now();
const inMinutes = (m: number) => new Date(now + m * 60_000).toISOString();

function limits(overrides: Partial<DeveloperRateLimits> = {}): DeveloperRateLimits {
  return {
    connected: true,
    login: 'octocat',
    scopes: ['repo', 'read:user'],
    github: [
      { resource: 'core', limit: 5000, remaining: 4000, used: 1000, resetAt: inMinutes(12) },
      { resource: 'search', limit: 30, remaining: 30, used: 0, resetAt: inMinutes(1) },
      { resource: 'graphql', limit: 5000, remaining: 499, used: 4501, resetAt: inMinutes(30) },
    ],
    graphqlBudget: null,
    secondaryGate: { restUntil: null, graphqlUntil: null },
    fetchedAt: new Date(now).toISOString(),
    ...overrides,
  };
}

function activityOf(events: DeveloperActivityEvent[]): DeveloperActivity {
  const byService: Record<string, number> = {};
  for (const e of events) byService[e.service] = (byService[e.service] ?? 0) + 1;
  return {
    events,
    counts: { total: events.length, failed: events.filter((e) => !e.ok).length, byService },
    buffer: { capacity: 1000, oldestAt: events.length ? inMinutes(-7) : null },
  };
}

const EVENTS: DeveloperActivityEvent[] = [
  {
    id: 2,
    timestamp: new Date(now).toISOString(),
    category: 'http',
    service: 'github',
    action: 'request',
    ok: false,
    summary: 'GET https://api.github.com/user → 500 12ms',
    durationMs: 12,
    meta: { status: 500, error: 'boom' },
  },
  {
    id: 1,
    timestamp: new Date(now).toISOString(),
    category: 'event',
    service: 'merge_queue',
    action: 'merged',
    ok: true,
    summary: 'acme/widgets#7 merged',
  },
];

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  state.workspaceId = 'ws1';
  mockRateLimits.mockResolvedValue(limits());
  mockAgents.mockResolvedValue({ agents: [] });
  mockActivity.mockResolvedValue(activityOf(EVENTS));
  mockAccess.mockResolvedValue({ admin: false });
});

afterEach(() => {
  cleanup();
  FAKE.useRealTimers();
  FAKE.clearAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

describe('resetsIn', () => {
  it.each([
    [-5_000, 'resets now'],
    [0, 'resets now'],
    [45_000, 'resets in 45 s'],
    [60_000, 'resets in 1 min'],
    [12 * 60_000, 'resets in 12 min'],
    [59 * 60_000, 'resets in 59 min'],
    [3 * 3_600_000, 'resets in 3 h'],
  ])('%i ms from now reads "%s"', (delta, expected) => {
    expect(resetsIn(new Date(1_900_000_000_000 + delta).toISOString(), 1_900_000_000_000)).toBe(expected);
  });

  it('reads "resets now" for a bad date', () => {
    expect(resetsIn('not a date', 0)).toBe('resets now');
  });
});

describe('DeveloperInternals', () => {
  it('loads with the current workspace and no owner argument', async () => {
    render(<DeveloperInternals />);
    await flush();
    expect(mockRateLimits).toHaveBeenCalledWith('ws1');
    expect(mockAgents).toHaveBeenCalledWith('ws1');
    expect(mockActivity).toHaveBeenCalledWith({});
  });

  it('renders one card per bucket and warns only under 10% remaining', async () => {
    render(<DeveloperInternals />);
    await flush();
    expect(screen.getByTestId('bucket-core').getAttribute('data-low')).toBe('false');
    expect(screen.getByTestId('bucket-search').getAttribute('data-low')).toBe('false');
    const graphql = screen.getByTestId('bucket-graphql');
    expect(graphql.getAttribute('data-low')).toBe('true');
    expect(within(graphql).getByText('Low')).toBeTruthy();
    expect(within(graphql).getByText('499 / 5,000')).toBeTruthy();
    expect(within(screen.getByTestId('bucket-core')).getByText('resets in 12 min')).toBeTruthy();
    expect(screen.getByText(/Connected as @octocat/)).toBeTruthy();
    expect(screen.getByText(/Scopes: repo, read:user/)).toBeTruthy();
  });

  it.each([
    [500, 5000, 'false'],
    [499, 5000, 'true'],
    [0, 5000, 'true'],
    [0, 0, 'true'],
    [3, 30, 'false'],
    [2, 30, 'true'],
  ])('remaining %i of %i sets data-low=%s', async (remaining, limit, low) => {
    mockRateLimits.mockResolvedValue(
      limits({ github: [{ resource: 'core', limit, remaining, used: limit - remaining, resetAt: inMinutes(5) }] })
    );
    render(<DeveloperInternals />);
    await flush();
    expect(screen.getByTestId('bucket-core').getAttribute('data-low')).toBe(low);
  });

  it('says when Talyn defers background refreshes', async () => {
    mockRateLimits.mockResolvedValue(
      limits({
        graphqlBudget: {
          limit: 5000,
          remaining: 100,
          resetAt: inMinutes(20),
          lastCost: 3,
          observedAt: inMinutes(0),
          deferring: true,
        },
      })
    );
    render(<DeveloperInternals />);
    await flush();
    expect(screen.getByText(/Talyn is deferring background refreshes/)).toBeTruthy();
  });

  it('does not show the deferring line when nothing is deferred', async () => {
    render(<DeveloperInternals />);
    await flush();
    expect(screen.queryByText(/Talyn is deferring/)).toBeNull();
    expect(screen.queryByText(/rate-limited this account/)).toBeNull();
  });

  it('shows one sentence and no cards when GitHub is not connected', async () => {
    mockRateLimits.mockResolvedValue(
      limits({ connected: false, login: null, scopes: [], github: [], fetchedAt: null })
    );
    render(<DeveloperInternals />);
    await flush();
    expect(screen.getByText('GitHub is not connected for this workspace.')).toBeTruthy();
    expect(screen.queryByTestId('bucket-core')).toBeNull();
    expect(screen.queryByText(/Scopes/)).toBeNull();
  });

  it('hides the Agents section when the list is empty', async () => {
    render(<DeveloperInternals />);
    await flush();
    expect(screen.queryByText('Agents')).toBeNull();
  });

  it('renders ready, reconnect and held agents', async () => {
    mockAgents.mockResolvedValue({
      agents: [
        { agent: 'claude', state: 'reauth' },
        {
          agent: 'codex',
          state: 'held',
          hold: { heldSince: inMinutes(-1), retryAfter: inMinutes(60), detail: 'You have hit your usage limit.' },
        },
      ],
    });
    render(<DeveloperInternals />);
    await flush();
    expect(screen.getByText('Agents')).toBeTruthy();
    expect(within(screen.getByTestId('agent-claude')).getByText('Reconnect needed')).toBeTruthy();
    const codex = screen.getByTestId('agent-codex');
    expect(within(codex).getByText(/Usage limit reached, Talyn tries it again at/)).toBeTruthy();
    expect(within(codex).getByText('You have hit your usage limit.')).toBeTruthy();
  });

  it('renders a ready agent', async () => {
    mockAgents.mockResolvedValue({ agents: [{ agent: 'claude', state: 'ready' }] });
    render(<DeveloperInternals />);
    await flush();
    expect(within(screen.getByTestId('agent-claude')).getByText('Ready')).toBeTruthy();
  });

  it('lists activity with a count line and marks failed rows', async () => {
    render(<DeveloperInternals />);
    await flush();
    expect(screen.getByText(/2 events, 1 failed/)).toBeTruthy();
    const rows = screen.getAllByTestId('activity-row');
    expect(rows.map((r) => r.getAttribute('data-ok'))).toEqual(['false', 'true']);
    expect(rows[0].className).toContain('text-destructive');
    expect(within(rows[0]).getByText('Failed')).toBeTruthy();
    expect(within(rows[0]).getByText('12 ms')).toBeTruthy();
  });

  it('expands a row to show meta as JSON, and only when meta is present', async () => {
    render(<DeveloperInternals />);
    await flush();
    const [withMeta, withoutMeta] = screen.getAllByTestId('activity-row');
    fireEvent.click(within(withMeta).getByRole('button'));
    expect(withMeta.querySelector('pre')?.textContent).toBe(
      JSON.stringify({ status: 500, error: 'boom' }, null, 2)
    );
    fireEvent.click(within(withoutMeta).getByRole('button'));
    expect(withoutMeta.querySelector('pre')).toBeNull();
  });

  it('shows the empty state when the account has no events', async () => {
    mockActivity.mockResolvedValue(activityOf([]));
    render(<DeveloperInternals />);
    await flush();
    expect(
      screen.getByText(
        'No recent activity for your account. Talyn keeps a short rolling window for all accounts.'
      )
    ).toBeTruthy();
  });

  it.each([
    ['Requests', { category: 'http' }],
    ['Webhooks', { category: 'webhook' }],
    ['Events', { category: 'event' }],
    ['Errors', { category: 'error' }],
  ])('the %s chip sends %j', async (label, expected) => {
    render(<DeveloperInternals />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await flush();
    expect(mockActivity).toHaveBeenLastCalledWith(expected);
    expect(screen.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await flush();
    expect(mockActivity).toHaveBeenLastCalledWith({});
  });

  it('keeps the last data and shows an inline error when a refresh fails', async () => {
    render(<DeveloperInternals />);
    await flush();
    mockRateLimits.mockRejectedValue(new Error('GitHub is down'));
    mockActivity.mockRejectedValue(new Error('GitHub is down'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('GitHub is down');
    expect(screen.getByTestId('bucket-core')).toBeTruthy();
    expect(screen.getAllByTestId('activity-row')).toHaveLength(2);

    mockRateLimits.mockResolvedValue(limits());
    mockActivity.mockResolvedValue(activityOf(EVENTS));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('polls every 10 seconds and stops on unmount', async () => {
    FAKE.useFakeTimers();
    const view = render(<DeveloperInternals />);
    await flush();
    expect(mockActivity).toHaveBeenCalledTimes(1);
    act(() => {
      FAKE.advanceTimersByTime(DEVELOPER_POLL_MS - 1);
    });
    expect(mockActivity).toHaveBeenCalledTimes(1);
    act(() => {
      FAKE.advanceTimersByTime(1);
    });
    await flush();
    expect(mockActivity).toHaveBeenCalledTimes(2);
    expect(mockRateLimits).toHaveBeenCalledTimes(2);
    view.unmount();
    act(() => {
      FAKE.advanceTimersByTime(DEVELOPER_POLL_MS * 5);
    });
    expect(mockActivity).toHaveBeenCalledTimes(2);
  });

  it('does not poll while the document is hidden, and refreshes when it returns', async () => {
    FAKE.useFakeTimers();
    render(<DeveloperInternals />);
    await flush();
    setVisibility('hidden');
    act(() => {
      FAKE.advanceTimersByTime(DEVELOPER_POLL_MS * 3);
    });
    await flush();
    expect(mockActivity).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    await flush();
    expect(mockActivity).toHaveBeenCalledTimes(2);
  });

  it('shows the admin note only to an admin', async () => {
    const first = render(<DeveloperInternals />);
    await flush();
    expect(screen.queryByText('Cross-account tooling is on admin.talyn.dev.')).toBeNull();
    first.unmount();
    mockAccess.mockResolvedValue({ admin: true });
    render(<DeveloperInternals />);
    await flush();
    expect(screen.getByText('Cross-account tooling is on admin.talyn.dev.')).toBeTruthy();
  });

  it('drops the admin note when the access check fails', async () => {
    mockAccess.mockRejectedValue(new Error('nope'));
    render(<DeveloperInternals />);
    await flush();
    expect(screen.queryByText('Cross-account tooling is on admin.talyn.dev.')).toBeNull();
  });

  it('asks only for activity when there is no workspace', async () => {
    state.workspaceId = null;
    render(<DeveloperInternals />);
    await flush();
    expect(mockRateLimits).not.toHaveBeenCalled();
    expect(mockAgents).not.toHaveBeenCalled();
    expect(mockActivity).toHaveBeenCalledTimes(1);
  });
});
