import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';

const mocks = vi.hoisted(() => ({ complete: vi.fn(), session: vi.fn(), analytics: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { mcpServers: { complete: mocks.complete } } }));
vi.mock('../components/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: mocks.session,
}));
vi.mock('../components/Analytics', () => ({ Analytics: mocks.analytics }));
vi.mock('../components/auth/LoginScreen', () => ({ LoginScreen: () => <div>Log in</div> }));
vi.mock('../components/layout/MainLayout', () => ({ MainLayout: () => null }));
vi.mock('../components/onboarding/OnboardingWizard', () => ({ OnboardingWizard: () => null }));
vi.mock('../components/StartingSpinner', () => ({ StartingSpinner: () => <div>Waiting</div> }));
vi.mock('../components/ui/toaster', () => ({ Toaster: () => null }));
vi.mock('../hooks/useApi', () => ({ useApiConnection: vi.fn(), useInitialDataLoad: () => ({ loaded: true }) }));
vi.mock('../hooks/useClosePopupAfterGithub', () => ({ useClosePopupAfterGithub: vi.fn() }));
vi.mock('../stores/workspace', () => ({ useWorkspaceStore: () => true }));
vi.mock('../routes/AuthCallback', () => ({ AuthCallback: () => null }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockReturnValue({ session: null, loading: false });
  mocks.complete.mockResolvedValue(null);
});
afterEach(cleanup);

describe('MCP browser callback', () => {
  it('finishes a desktop flow without login, onboarding, or analytics', async () => {
    window.history.replaceState({}, '', '/mcp/callback?state=flow-state&code=auth-code');
    render(<StrictMode><App /></StrictMode>);
    await screen.findByText('MCP server connected');
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith('flow-state', 'auth-code');
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.analytics).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/mcp/callback');
  });
  it('reports denial to the waiting desktop', async () => {
    window.history.replaceState({}, '', '/mcp/callback?state=flow-state&error=access_denied');
    render(<App />);
    await screen.findByText('access_denied');
    expect(mocks.complete).toHaveBeenCalledWith('flow-state', '', 'access_denied');
  });
  it('does not exchange an incomplete callback', async () => {
    window.history.replaceState({}, '', '/mcp/callback?state=flow-state');
    render(<App />);
    await screen.findByText('That sign-in did not come back with anything to finish.');
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('keeps ordinary app pages behind login', async () => {
    window.history.replaceState({}, '', '/');
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
