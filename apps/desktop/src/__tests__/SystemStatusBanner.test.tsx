import '@testing-library/jest-dom';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { SystemStatusBanner } from '../renderer/components/layout/SystemStatusBanner';
import { useWorkspaceStore, type WatchedRepo } from '../renderer/stores/workspace';
import { api, type GitHubStatus, type GitHubInstallation, type GitHubOwnerCoverageState } from '../renderer/lib/api';
import * as githubInstall from '../renderer/lib/githubInstall';

beforeEach(() => {
  jest.spyOn(api.github, 'coverage').mockImplementation(() => new Promise(() => {}));
});

function setState(currentWorkspaceId: string | null, githubStatus: GitHubStatus | null) {
  useWorkspaceStore.setState({
    currentWorkspaceId,
    githubStatus,
    githubInstallations: null,
    repositories: [],
    backendHealth: null,
  });
}

function repo(owner: string, name: string): WatchedRepo {
  return { id: `${owner}/${name}`, workspaceId: 'ws1', owner, repo: name, fullName: `${owner}/${name}` };
}

function install(accountLogin: string, suspended = false): GitHubInstallation {
  return { accountLogin, accountType: 'Organization', suspended, repositorySelection: 'all' };
}

afterEach(() => {
  cleanup();
  setState(null, null);
  useWorkspaceStore.setState({ githubCoverage: null });
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe('SystemStatusBanner', () => {
  it('renders nothing before GitHub status is known', () => {
    setState('ws1', null);
    const { container } = render(<SystemStatusBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(api.github.coverage).not.toHaveBeenCalled();
  });

  it('renders nothing when GitHub is connected', () => {
    setState('ws1', { configured: true, connected: true });
    const { container } = render(<SystemStatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there is no current workspace', () => {
    setState(null, { configured: true, connected: false });
    const { container } = render(<SystemStatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('warns with a Connect action when GitHub is configured but disconnected', () => {
    setState('ws1', { configured: true, connected: false });
    render(<SystemStatusBanner />);
    expect(screen.getByText(/GitHub isn't connected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect GitHub/i })).toBeInTheDocument();
  });

  it('warns without a Connect action when GitHub OAuth is not configured', () => {
    setState('ws1', { configured: false, connected: false });
    render(<SystemStatusBanner />);
    expect(screen.getByText(/isn't set up on this Talyn server/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect GitHub/i })).not.toBeInTheDocument();
  });

  // A wedged backend 500s every request. It must read as the backend being
  // unwell, never as GitHub being unconfigured (2026-09-30).
  it.each([
    ['degraded', /having trouble on our side/],
    ['offline', /Can't reach Talyn|You're offline/],
  ] as const)('shows only the %s row, and no GitHub rows', (health, message) => {
    setState('ws1', { configured: false, connected: false });
    useWorkspaceStore.setState({ backendHealth: health });
    render(<SystemStatusBanner />);
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/GITHUB_CLIENT_ID|isn't set up|GitHub isn't connected/i)).not.toBeInTheDocument();
  });

  it('warns to install the app when a watched repo’s org has no installation', async () => {
    jest.spyOn(api.github, 'coverage').mockResolvedValue([{ owner: 'posthog', state: 'not_installed' }]);
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      githubStatus: { configured: true, connected: true },
      githubInstallations: [install('acme')],
      repositories: [repo('acme', 'web'), repo('posthog', 'posthog')],
    });
    render(<SystemStatusBanner />);
    expect(await screen.findByText(/isn't installed on @posthog/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install app/i })).toBeInTheDocument();
  });

  it('shows no coverage row while the diagnosis is loading', () => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      githubStatus: { configured: true, connected: true },
      githubInstallations: [],
      repositories: [repo('posthog', 'posthog')],
    });
    const { container } = render(<SystemStatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when every watched repo’s org is covered', () => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      githubStatus: { configured: true, connected: true },
      githubInstallations: [install('acme')],
      repositories: [repo('acme', 'web')],
    });
    const { container } = render(<SystemStatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('treats a suspended installation as not covered', async () => {
    jest.spyOn(api.github, 'coverage').mockResolvedValue([{ owner: 'acme', state: 'not_installed' }]);
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      githubStatus: { configured: true, connected: true },
      githubInstallations: [install('acme', true)],
      repositories: [repo('acme', 'web')],
    });
    render(<SystemStatusBanner />);
    expect(await screen.findByText(/isn't installed on @acme/i)).toBeInTheDocument();
  });

  it('does not flag coverage before installations have loaded', () => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      githubStatus: { configured: true, connected: true },
      githubInstallations: null,
      repositories: [repo('posthog', 'posthog')],
    });
    const { container } = render(<SystemStatusBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('owner coverage diagnosis', () => {
  beforeEach(() => {
    setState('ws1', { configured: true, connected: true });
    useWorkspaceStore.setState({
      githubInstallations: [],
      repositories: [repo('PostHog', 'posthog')],
    });
  });

  it.each<[GitHubOwnerCoverageState, RegExp, string]>([
    ['not_installed', /isn't installed on @PostHog/, 'Install app'],
    ['unknown', /isn't installed on @PostHog/, 'Install app'],
    ['suspended', /is suspended on @PostHog.*An owner of @PostHog must unsuspend it/, 'GitHub settings'],
    ['sso_required', /@PostHog uses single sign-on.*authorize it and reconnect GitHub/, 'Reconnect GitHub'],
    ['not_accessible', /is installed on @PostHog, but your GitHub account can't reach it.*give you access/, 'Reconnect GitHub'],
  ])('shows the %s message and action', async (state, message, button) => {
    jest.mocked(api.github.coverage).mockResolvedValue([{ owner: 'PostHog', state }]);
    await act(async () => { render(<SystemStatusBanner />); });
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: button })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Authorize SSO' })).not.toBeInTheDocument();
    if (state === 'suspended' || state === 'sso_required' || state === 'not_accessible') {
      expect(screen.queryByRole('button', { name: 'Install app' })).not.toBeInTheDocument();
    }
  });

  it('opens the SSO URL and reconnects through the existing flow', async () => {
    const ssoUrl = 'https://github.com/orgs/PostHog/sso';
    jest.mocked(api.github.coverage).mockResolvedValue([{ owner: 'PostHog', state: 'sso_required', ssoUrl }]);
    const open = jest.spyOn(githubInstall, 'openGithubExternalUrl').mockResolvedValue();
    const connect = jest.spyOn(githubInstall, 'openGithubAppFlow').mockResolvedValue();
    await act(async () => { render(<SystemStatusBanner />); });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize SSO' }));
    expect(open).toHaveBeenCalledWith(ssoUrl);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reconnect GitHub' })); });
    expect(connect).toHaveBeenCalledWith('ws1', 'connect');
  });

  it('omits the authorize action when SSO has no URL', async () => {
    jest.mocked(api.github.coverage).mockResolvedValue([{ owner: 'PostHog', state: 'sso_required', ssoUrl: null }]);
    await act(async () => { render(<SystemStatusBanner />); });
    expect(screen.getByText(/uses single sign-on/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Authorize SSO' })).not.toBeInTheDocument();
  });

  it('falls back to the install message when coverage fails', async () => {
    jest.mocked(api.github.coverage).mockRejectedValue(new Error('offline'));
    await act(async () => { render(<SystemStatusBanner />); });
    expect(screen.getByText(/isn't installed on @PostHog/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install app' })).toBeInTheDocument();
  });

  it('groups owners by state and retains every SSO link', async () => {
    useWorkspaceStore.setState({ repositories: ['PostHog', 'Acme', 'Other', 'Last'].map((owner) => repo(owner, 'web')) });
    jest.mocked(api.github.coverage).mockResolvedValue([
      { owner: 'PostHog', state: 'sso_required', ssoUrl: 'https://github.com/orgs/PostHog/sso' },
      { owner: 'Acme', state: 'sso_required', ssoUrl: 'https://github.com/orgs/Acme/sso' },
      { owner: 'Other', state: 'suspended' },
      { owner: 'Last', state: 'not_accessible' },
    ]);
    await act(async () => { render(<SystemStatusBanner />); });
    expect(screen.getByText(/@PostHog and @Acme uses single sign-on/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Authorize SSO' })).toHaveLength(2);
    expect(screen.getByText(/is suspended on @Other/)).toBeInTheDocument();
    expect(screen.getByText(/is installed on @Last/)).toBeInTheDocument();
  });

  it('refreshes on focus and when the uncovered owners change', async () => {
    jest.mocked(api.github.coverage).mockResolvedValue([{ owner: 'PostHog', state: 'suspended' }]);
    await act(async () => { render(<SystemStatusBanner />); });
    expect(api.github.coverage).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent(window, new Event('focus')); });
    expect(api.github.coverage).toHaveBeenCalledTimes(2);
    await act(async () => { useWorkspaceStore.setState({ repositories: [repo('Acme', 'web')] }); });
    expect(api.github.coverage).toHaveBeenCalledTimes(3);
  });

  it('makes no coverage request when every owner is covered', async () => {
    useWorkspaceStore.setState({ githubInstallations: [install('posthog')] });
    await act(async () => { render(<SystemStatusBanner />); });
    expect(api.github.coverage).not.toHaveBeenCalled();
  });

  it('removes the warning when the diagnosis reports no problems', async () => {
    jest.mocked(api.github.coverage).mockResolvedValue([]);
    let container: HTMLElement;
    await act(async () => { ({ container } = render(<SystemStatusBanner />)); });
    expect(container!).toBeEmptyDOMElement();
  });

  it('ignores a late response from a previous workspace', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof api.github.coverage>>) => void;
    jest.mocked(api.github.coverage).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(<SystemStatusBanner />);
    await act(async () => { useWorkspaceStore.setState({ currentWorkspaceId: 'ws2' }); });
    await act(async () => { resolve([{ owner: 'PostHog', state: 'suspended' }]); });
    expect(screen.queryByText(/is suspended/)).not.toBeInTheDocument();
    await waitFor(() => expect(api.github.coverage).toHaveBeenLastCalledWith('ws2'));
  });
});

describe('polling notice for owners without the App', () => {
  beforeEach(() => {
    setState('ws1', { configured: true, connected: true });
    useWorkspaceStore.setState({
      githubInstallations: [],
      repositories: [repo('ClickHouse', 'ClickHouse')],
    });
  });

  it('says the repos are polled, not live, and offers the install', async () => {
    jest.mocked(api.github.coverage).mockResolvedValue([{ owner: 'ClickHouse', state: 'not_installed' }]);
    await act(async () => { render(<SystemStatusBanner />); });
    expect(screen.getByText(/polled every few minutes, not updated live/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install app' })).toBeInTheDocument();
  });

  it('publishes the diagnosis to the store for the PR rows', async () => {
    const coverage = [{ owner: 'ClickHouse', state: 'not_installed' as const }];
    jest.mocked(api.github.coverage).mockResolvedValue(coverage);
    await act(async () => { render(<SystemStatusBanner />); });
    expect(useWorkspaceStore.getState().githubCoverage).toEqual(coverage);
  });

  it('stays dismissed for that owner, and still shows for a new one', async () => {
    jest.mocked(api.github.coverage).mockResolvedValue([{ owner: 'ClickHouse', state: 'not_installed' }]);
    await act(async () => { render(<SystemStatusBanner />); });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/polled every few minutes/)).not.toBeInTheDocument();

    cleanup();
    await act(async () => { render(<SystemStatusBanner />); });
    expect(screen.queryByText(/polled every few minutes/)).not.toBeInTheDocument();

    jest.mocked(api.github.coverage).mockResolvedValue([
      { owner: 'ClickHouse', state: 'not_installed' },
      { owner: 'Other', state: 'not_installed' },
    ]);
    await act(async () => {
      useWorkspaceStore.setState({ repositories: [repo('ClickHouse', 'ClickHouse'), repo('Other', 'x')] });
    });
    expect(await screen.findByText(/isn't installed on @Other, so/)).toBeInTheDocument();
    expect(screen.queryByText(/@ClickHouse/)).not.toBeInTheDocument();
  });

  it('never hides the suspended warning behind a dismissal', async () => {
    window.localStorage.setItem('talyn.pollingNotice.dismissed.ws1', JSON.stringify(['clickhouse']));
    jest.mocked(api.github.coverage).mockResolvedValue([{ owner: 'ClickHouse', state: 'suspended' }]);
    await act(async () => { render(<SystemStatusBanner />); });
    expect(screen.getByText(/is suspended on @ClickHouse/)).toBeInTheDocument();
  });

  it('survives unreadable storage', async () => {
    window.localStorage.setItem('talyn.pollingNotice.dismissed.ws1', '{not json');
    jest.mocked(api.github.coverage).mockResolvedValue([{ owner: 'ClickHouse', state: 'not_installed' }]);
    await act(async () => { render(<SystemStatusBanner />); });
    expect(screen.getByText(/polled every few minutes/)).toBeInTheDocument();
  });
});
