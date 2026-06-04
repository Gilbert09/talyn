import '@testing-library/jest-dom';
import { render, screen, cleanup } from '@testing-library/react';
import { SystemStatusBanner } from '../renderer/components/layout/SystemStatusBanner';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import type { GitHubStatus } from '../renderer/lib/api';

function setState(currentWorkspaceId: string | null, githubStatus: GitHubStatus | null) {
  useWorkspaceStore.setState({ currentWorkspaceId, githubStatus });
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
});
