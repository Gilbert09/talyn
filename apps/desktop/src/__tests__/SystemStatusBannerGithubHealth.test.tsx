import '@testing-library/jest-dom';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import type { GithubHealth, GithubStatusIncident } from '@talyn/shared';
import { SystemStatusBanner } from '../renderer/components/layout/SystemStatusBanner';
import { useWorkspaceStore, type WatchedRepo } from '../renderer/stores/workspace';
import { useGithubHealth } from '../renderer/hooks/useGithubHealth';
import { api, type GitHubOwnerCoverageState } from '../renderer/lib/api';
import * as githubInstall from '../renderer/lib/githubInstall';

const mock = jest;

const T0 = '2026-10-07T03:00:00.000Z';

function health(overrides: Partial<GithubHealth> = {}): GithubHealth {
  const idle = { requests: 0, serverFailures: 0, state: 'unknown' as const };
  return {
    state: 'operational',
    source: null,
    traffic: { rest: idle, graphql: idle, state: 'unknown', windowMs: 600_000 },
    statusPage: null,
    since: null,
    updatedAt: T0,
    ...overrides,
  };
}

function incident(name: string, url: string | null = 'https://stspg.io/abc123', relevant = true): GithubStatusIncident {
  return { name, url, impact: 'major', startedAt: T0, relevant };
}

function statusPage(
  state: GithubHealth['state'],
  incidents: GithubStatusIncident[] = [],
): NonNullable<GithubHealth['statusPage']> {
  return { indicator: 'major', components: [], incidents, fetchedAt: T0, state };
}

const DOWN_COPY =
  'Pull request updates, merges and agent runs that need GitHub will fail or wait until it is back. Talyn retries by itself.';
const DEGRADED_COPY = 'Pull request updates and merges may be slow or fail. Talyn retries by itself.';

function reset() {
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    githubStatus: { configured: true, connected: true },
    githubInstallations: null,
    githubCoverage: null,
    repositories: [],
    backendHealth: null,
    githubHealth: null,
  });
}

function repo(owner: string, name: string): WatchedRepo {
  return { id: `${owner}/${name}`, workspaceId: 'ws1', owner, repo: name, fullName: `${owner}/${name}` };
}

beforeEach(() => {
  reset();
  mock.spyOn(api.github, 'coverage').mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  reset();
  useWorkspaceStore.setState({ currentWorkspaceId: null, githubStatus: null });
  window.localStorage.clear();
  mock.restoreAllMocks();
});

describe('SystemStatusBanner: GitHub health', () => {
  it.each([
    ['not loaded', null],
    ['operational', health()],
    ['unknown', health({ state: 'unknown' })],
    [
      'operational with an unrelated incident',
      health({ statusPage: statusPage('operational', [incident('Copilot is slow', null, false)]) }),
    ],
  ] as const)('shows nothing when GitHub health is %s', (_name, value) => {
    useWorkspaceStore.setState({ githubHealth: value });
    const { container } = render(<SystemStatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('down, from the status page with no incident named', () => {
    useWorkspaceStore.setState({
      githubHealth: health({ state: 'down', source: 'status_page', since: T0, statusPage: statusPage('down') }),
    });
    render(<SystemStatusBanner />);
    expect(screen.getByText(`GitHub is having an outage. ${DOWN_COPY}`)).toBeInTheDocument();
  });

  it('degraded, from the status page with no incident named', () => {
    useWorkspaceStore.setState({
      githubHealth: health({ state: 'degraded', source: 'status_page', since: T0, statusPage: statusPage('degraded') }),
    });
    render(<SystemStatusBanner />);
    expect(screen.getByText(`GitHub is having problems. ${DEGRADED_COPY}`)).toBeInTheDocument();
  });

  it.each([
    ['down', 'status_page', `GitHub is having an outage. GitHub reports: Disruption with Pull Requests. ${DOWN_COPY}`],
    ['down', 'both', `GitHub is having an outage. GitHub reports: Disruption with Pull Requests. ${DOWN_COPY}`],
    ['degraded', 'status_page', `GitHub is having problems. GitHub reports: Disruption with Pull Requests. ${DEGRADED_COPY}`],
    ['degraded', 'both', `GitHub is having problems. GitHub reports: Disruption with Pull Requests. ${DEGRADED_COPY}`],
  ] as const)('%s from %s names the incident', (state, source, text) => {
    useWorkspaceStore.setState({
      githubHealth: health({
        state,
        source,
        since: T0,
        statusPage: statusPage(state, [incident('Disruption with Pull Requests')]),
      }),
    });
    render(<SystemStatusBanner />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it.each([
    ['down', null, DOWN_COPY],
    ['down', statusPage('operational'), DOWN_COPY],
    ['down', statusPage('unknown', [incident('A stale incident')]), DOWN_COPY],
    ['degraded', null, DEGRADED_COPY],
    ['degraded', statusPage('operational', [incident('Copilot is slow', null, false)]), DEGRADED_COPY],
  ] as const)('%s from our own traffic only says so honestly', (state, page, consequence) => {
    useWorkspaceStore.setState({
      githubHealth: health({ state, source: 'traffic', since: T0, statusPage: page }),
    });
    render(<SystemStatusBanner />);
    expect(
      screen.getByText(
        `GitHub is answering Talyn's requests with errors. GitHub has not reported an incident yet. ${consequence}`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/having an outage|having problems|GitHub reports/)).not.toBeInTheDocument();
  });

  it('names the first incident that touches Talyn, not an unrelated one listed before it', () => {
    useWorkspaceStore.setState({
      githubHealth: health({
        state: 'degraded',
        source: 'status_page',
        since: T0,
        statusPage: statusPage('degraded', [
          incident('Copilot is slow', 'https://stspg.io/copilot', false),
          incident('Actions is slow', 'https://stspg.io/actions'),
        ]),
      }),
    });
    const open = mock.spyOn(githubInstall, 'openGithubExternalUrl').mockResolvedValue();
    render(<SystemStatusBanner />);
    expect(screen.getByText(/GitHub reports: Actions is slow\./)).toBeInTheDocument();
    expect(screen.queryByText(/Copilot/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'GitHub status' }));
    expect(open).toHaveBeenCalledWith('https://stspg.io/actions');
  });

  describe('the GitHub status link', () => {
    it.each([
      ['https://stspg.io/abc123', 'https://stspg.io/abc123'],
      ['https://www.githubstatus.com/incidents/xyz', 'https://www.githubstatus.com/incidents/xyz'],
      ['http://www.githubstatus.com/incidents/xyz', 'https://www.githubstatus.com'],
      ['https://www.githubstatus.com.evil.example/incidents/xyz', 'https://www.githubstatus.com'],
      ['https://evil.example/https://stspg.io/abc', 'https://www.githubstatus.com'],
      ['https://stspg.io.evil.example/abc', 'https://www.githubstatus.com'],
      ['javascript:alert(1)', 'https://www.githubstatus.com'],
      ['file:///etc/passwd', 'https://www.githubstatus.com'],
      ['', 'https://www.githubstatus.com'],
      [null, 'https://www.githubstatus.com'],
    ])('an incident link of %j opens %s', (url, opened) => {
      useWorkspaceStore.setState({
        githubHealth: health({
          state: 'down',
          source: 'status_page',
          since: T0,
          statusPage: statusPage('down', [incident('API is down', url)]),
        }),
      });
      const open = mock.spyOn(githubInstall, 'openGithubExternalUrl').mockResolvedValue();
      render(<SystemStatusBanner />);
      fireEvent.click(screen.getByRole('button', { name: 'GitHub status' }));
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(opened);
    });

    it('with no incident it opens the status site', () => {
      useWorkspaceStore.setState({ githubHealth: health({ state: 'down', source: 'traffic', since: T0 }) });
      const open = mock.spyOn(githubInstall, 'openGithubExternalUrl').mockResolvedValue();
      render(<SystemStatusBanner />);
      fireEvent.click(screen.getByRole('button', { name: 'GitHub status' }));
      expect(open).toHaveBeenCalledWith('https://www.githubstatus.com');
    });

    it('a link that fails to open does not break the banner', async () => {
      useWorkspaceStore.setState({ githubHealth: health({ state: 'down', source: 'traffic', since: T0 }) });
      mock.spyOn(githubInstall, 'openGithubExternalUrl').mockRejectedValue(new Error('blocked'));
      render(<SystemStatusBanner />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'GitHub status' }));
      });
      expect(screen.getByText(/answering Talyn's requests with errors/)).toBeInTheDocument();
    });
  });

  describe('with no workspace selected', () => {
    it('still shows the outage: it is not about a workspace', () => {
      useWorkspaceStore.setState({
        currentWorkspaceId: null,
        githubStatus: null,
        githubHealth: health({ state: 'down', source: 'traffic', since: T0 }),
      });
      render(<SystemStatusBanner />);
      expect(screen.getByText(/answering Talyn's requests with errors/)).toBeInTheDocument();
    });
  });

  describe('the backend wins', () => {
    it.each([
      ['degraded', /having trouble on our side/],
      ['offline', /Can't reach Talyn|You're offline/],
    ] as const)('backend %s shows only its own row', (backendHealth, message) => {
      useWorkspaceStore.setState({
        backendHealth,
        githubHealth: health({
          state: 'down',
          source: 'both',
          since: T0,
          statusPage: statusPage('down', [incident('API is down')]),
        }),
      });
      render(<SystemStatusBanner />);
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.queryByText(/GitHub is having|GitHub is answering/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'GitHub status' })).not.toBeInTheDocument();
    });
  });

  describe('dismissal', () => {
    const degraded = (overrides: Partial<GithubHealth> = {}) =>
      health({
        state: 'degraded',
        source: 'status_page',
        since: T0,
        statusPage: statusPage('degraded', [incident('Actions is slow')]),
        ...overrides,
      });

    it('down cannot be dismissed', () => {
      useWorkspaceStore.setState({ githubHealth: health({ state: 'down', source: 'traffic', since: T0 }) });
      render(<SystemStatusBanner />);
      expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    });

    it('degraded can be dismissed, and stays dismissed on an identical update', () => {
      useWorkspaceStore.setState({ githubHealth: degraded() });
      render(<SystemStatusBanner />);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByText(/GitHub is having problems/)).not.toBeInTheDocument();
      // The same incident, a later tick.
      act(() => {
        useWorkspaceStore.setState({ githubHealth: degraded({ updatedAt: '2026-10-07T03:05:00.000Z' }) });
      });
      expect(screen.queryByText(/GitHub is having problems/)).not.toBeInTheDocument();
    });

    it('comes back when a new incident is listed', () => {
      useWorkspaceStore.setState({ githubHealth: degraded() });
      render(<SystemStatusBanner />);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      act(() => {
        useWorkspaceStore.setState({
          githubHealth: degraded({
            statusPage: statusPage('degraded', [incident('Actions is slow'), incident('Webhooks are late')]),
          }),
        });
      });
      expect(screen.getByText(/GitHub is having problems/)).toBeInTheDocument();
    });

    it('comes back when the state gets worse', () => {
      useWorkspaceStore.setState({ githubHealth: degraded() });
      render(<SystemStatusBanner />);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      act(() => {
        useWorkspaceStore.setState({
          githubHealth: degraded({ state: 'down', statusPage: statusPage('down', [incident('Actions is slow')]) }),
        });
      });
      expect(screen.getByText(/GitHub is having an outage/)).toBeInTheDocument();
    });

    it('comes back for the next incident after a recovery', () => {
      useWorkspaceStore.setState({ githubHealth: degraded() });
      render(<SystemStatusBanner />);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      act(() => {
        useWorkspaceStore.setState({ githubHealth: health() });
      });
      act(() => {
        useWorkspaceStore.setState({ githubHealth: degraded({ since: '2026-10-07T05:00:00.000Z' }) });
      });
      expect(screen.getByText(/GitHub is having problems/)).toBeInTheDocument();
    });

    it('is not written to storage', () => {
      useWorkspaceStore.setState({ githubHealth: degraded() });
      render(<SystemStatusBanner />);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(window.localStorage.length).toBe(0);
    });
  });

  describe('beside the other GitHub rows', () => {
    const down = health({ state: 'down', source: 'traffic', since: T0 });
    const degradedHealth = health({ state: 'degraded', source: 'traffic', since: T0 });

    function watch(state: GitHubOwnerCoverageState) {
      useWorkspaceStore.setState({ githubInstallations: [], repositories: [repo('PostHog', 'posthog')] });
      mock.mocked(api.github.coverage).mockResolvedValue([{ owner: 'PostHog', state }]);
    }

    // A stored token survives a 5xx, so a disconnect is real during an outage.
    it('keeps "GitHub isn\'t connected" while GitHub is down, under the outage row', () => {
      useWorkspaceStore.setState({ githubStatus: { configured: true, connected: false }, githubHealth: down });
      const { container } = render(<SystemStatusBanner />);
      expect(screen.getByText(/GitHub isn't connected/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Connect GitHub/ })).toBeInTheDocument();
      const text = container.textContent ?? '';
      expect(text.indexOf('answering Talyn')).toBeLessThan(text.indexOf("GitHub isn't connected"));
    });

    it.each<[GitHubOwnerCoverageState, RegExp]>([
      ['not_installed', /isn't installed on @PostHog/],
      ['unknown', /isn't installed on @PostHog/],
      ['not_accessible', /your GitHub account can't reach it/],
    ])('hides the %s coverage row while GitHub is down', async (state, message) => {
      watch(state);
      useWorkspaceStore.setState({ githubHealth: down });
      await act(async () => { render(<SystemStatusBanner />); });
      expect(screen.getByText(/answering Talyn's requests with errors/)).toBeInTheDocument();
      expect(screen.queryByText(message)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Install app|Reconnect GitHub/ })).not.toBeInTheDocument();
    });

    it('hides the fallback coverage row of a failed diagnosis while GitHub is down', async () => {
      watch('not_installed');
      mock.mocked(api.github.coverage).mockRejectedValue(new Error('502'));
      useWorkspaceStore.setState({ githubHealth: down });
      await act(async () => { render(<SystemStatusBanner />); });
      expect(screen.queryByText(/isn't installed on @PostHog/)).not.toBeInTheDocument();
    });

    it.each<[GitHubOwnerCoverageState, RegExp]>([
      ['suspended', /is suspended on @PostHog/],
      ['sso_required', /uses single sign-on/],
    ])('keeps the %s coverage row while GitHub is down: GitHub gave that answer', async (state, message) => {
      watch(state);
      useWorkspaceStore.setState({ githubHealth: down });
      await act(async () => { render(<SystemStatusBanner />); });
      expect(screen.getByText(message)).toBeInTheDocument();
    });

    it.each<[GitHubOwnerCoverageState, RegExp]>([
      ['not_installed', /isn't installed on @PostHog/],
      ['unknown', /isn't installed on @PostHog/],
      ['not_accessible', /your GitHub account can't reach it/],
    ])('keeps the %s coverage row while GitHub is only degraded', async (state, message) => {
      watch(state);
      useWorkspaceStore.setState({ githubHealth: degradedHealth });
      await act(async () => { render(<SystemStatusBanner />); });
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.getByText(/answering Talyn's requests with errors/)).toBeInTheDocument();
    });

    it('shows the coverage row again when GitHub is back', async () => {
      watch('not_installed');
      useWorkspaceStore.setState({ githubHealth: down });
      await act(async () => { render(<SystemStatusBanner />); });
      expect(screen.queryByText(/isn't installed on @PostHog/)).not.toBeInTheDocument();
      act(() => {
        useWorkspaceStore.setState({ githubHealth: health() });
      });
      expect(screen.getByText(/isn't installed on @PostHog/)).toBeInTheDocument();
      expect(screen.queryByText(/answering Talyn/)).not.toBeInTheDocument();
    });
  });
});

describe('useGithubHealth', () => {
  function Probe() {
    useGithubHealth();
    return <SystemStatusBanner />;
  }

  let wsHandlers: Map<string, Set<(payload: unknown) => void>>;
  const emit = (event: string, payload: unknown) => {
    for (const handler of wsHandlers.get(event) ?? []) handler(payload);
  };

  beforeEach(() => {
    wsHandlers = new Map();
    mock.spyOn(api.ws, 'on').mockImplementation(((event: string, handler: (payload: unknown) => void) => {
      if (!wsHandlers.has(event)) wsHandlers.set(event, new Set());
      wsHandlers.get(event)!.add(handler);
      return () => wsHandlers.get(event)?.delete(handler);
    }) as typeof api.ws.on);
  });

  it('loads the health once on mount and shows the row', async () => {
    const load = mock
      .spyOn(api.system, 'githubHealth')
      .mockResolvedValue(health({ state: 'down', source: 'traffic', since: T0 }));
    render(<Probe />);
    expect(await screen.findByText(/answering Talyn's requests with errors/)).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('follows the github:health WebSocket event in both directions', async () => {
    mock.spyOn(api.system, 'githubHealth').mockResolvedValue(health());
    const { container } = render(<Probe />);
    await waitFor(() => expect(useWorkspaceStore.getState().githubHealth?.state).toBe('operational'));
    expect(container).toBeEmptyDOMElement();

    act(() => {
      emit(
        'github:health',
        health({
          state: 'down',
          source: 'status_page',
          since: T0,
          statusPage: statusPage('down', [incident('API is down')]),
        }),
      );
    });
    expect(screen.getByText(/GitHub is having an outage\. GitHub reports: API is down\./)).toBeInTheDocument();

    act(() => {
      emit('github:health', health());
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('loads again when the window regains focus', async () => {
    const load = mock.spyOn(api.system, 'githubHealth').mockResolvedValue(health());
    render(<Probe />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    load.mockResolvedValue(health({ state: 'degraded', source: 'traffic', since: T0 }));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/answering Talyn's requests with errors/)).toBeInTheDocument();
  });

  it('loads again after a WebSocket reconnect, and not on the first connect', async () => {
    const load = mock.spyOn(api.system, 'githubHealth').mockResolvedValue(health());
    render(<Probe />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(async () => {
      emit('connection:status', { connected: true });
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      emit('connection:status', { connected: false });
      emit('connection:status', { connected: true });
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a failed load keeps the last known value', async () => {
    const load = mock
      .spyOn(api.system, 'githubHealth')
      .mockResolvedValue(health({ state: 'down', source: 'traffic', since: T0 }));
    render(<Probe />);
    expect(await screen.findByText(/answering Talyn/)).toBeInTheDocument();
    load.mockRejectedValue(new Error('500'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByText(/answering Talyn/)).toBeInTheDocument();
  });

  it('stops listening on unmount', async () => {
    mock.spyOn(api.system, 'githubHealth').mockResolvedValue(health());
    const { unmount } = render(<Probe />);
    await waitFor(() => expect(wsHandlers.get('github:health')?.size).toBe(1));
    unmount();
    expect(wsHandlers.get('github:health')?.size).toBe(0);
  });
});
