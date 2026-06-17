import '@testing-library/jest-dom';
import { render, screen, cleanup } from '@testing-library/react';
import { SystemStatusBanner } from '../renderer/components/layout/SystemStatusBanner';
import { useWorkspaceStore, type WatchedRepo } from '../renderer/stores/workspace';
import type { GitHubStatus, GitHubInstallation } from '../renderer/lib/api';

function setState(currentWorkspaceId: string | null, githubStatus: GitHubStatus | null) {
  useWorkspaceStore.setState({
    currentWorkspaceId,
    githubStatus,
    githubInstallations: null,
    repositories: [],
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
});

describe('SystemStatusBanner', () => {
  it('renders nothing before GitHub status is known', () => {
    setState('ws1', null);
    const { container } = render(<SystemStatusBanner />);
    expect(container).toBeEmptyDOMElement();
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
    expect(screen.getByText(/isn't configured on the backend/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect GitHub/i })).not.toBeInTheDocument();
  });

  it('warns to install the app when a watched repo’s org has no installation', () => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      githubStatus: { configured: true, connected: true },
      githubInstallations: [install('acme')],
      repositories: [repo('acme', 'web'), repo('posthog', 'posthog')],
    });
    render(<SystemStatusBanner />);
    expect(screen.getByText(/isn't installed on @posthog/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Install app/i })).toBeInTheDocument();
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

  it('treats a suspended installation as not covered', () => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      githubStatus: { configured: true, connected: true },
      githubInstallations: [install('acme', true)],
      repositories: [repo('acme', 'web')],
    });
    render(<SystemStatusBanner />);
    expect(screen.getByText(/isn't installed on @acme/i)).toBeInTheDocument();
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
