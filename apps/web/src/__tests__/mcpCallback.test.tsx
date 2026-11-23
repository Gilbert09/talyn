import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';

const mocks = vi.hoisted(() => ({ complete: vi.fn(), session: vi.fn(), analytics: vi.fn(), openApp: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { mcpServers: { complete: mocks.complete } } }));
vi.mock('../lib/appReturn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/appReturn')>()),
  openAppReturn: mocks.openApp,
}));
vi.mock('../components/auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: mocks.session,
}));
vi.mock('../components/Analytics', () => ({ Analytics: mocks.analytics }));
vi.mock('../components/auth/LoginScreen', () => ({ LoginScreen: () => <div>Log in</div> }));
vi.mock('../components/layout/AppShell', () => ({ AppShell: () => null }));
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
  it('does not open an app when the answer has no app return', async () => {
    window.history.replaceState({}, '', '/mcp/callback?state=flow-state&code=auth-code');
    render(<App />);
    await screen.findByText('MCP server connected');
    expect(mocks.openApp).not.toHaveBeenCalled();
  });
});

const APP_CONNECTED = 'talyn-mobile://mcp/callback?mcp=connected';
const APP_ERROR = 'talyn-mobile://mcp/callback?mcp=error';

describe('MCP browser callback — mobile app return', () => {
  it('sends a finished mobile flow back to the app, without a session', async () => {
    mocks.complete.mockResolvedValue({ appReturnUrl: APP_CONNECTED });
    window.history.replaceState({}, '', '/mcp/callback?state=flow-state&code=auth-code');
    render(<StrictMode><App /></StrictMode>);
    await waitFor(() => expect(mocks.openApp).toHaveBeenCalledWith(APP_CONNECTED));
    expect(mocks.openApp).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(screen.queryByText('MCP server connected')).toBeNull();
  });

  it('sends a denied mobile flow back to the app', async () => {
    mocks.complete.mockResolvedValue({ appReturnUrl: APP_ERROR });
    window.history.replaceState({}, '', '/mcp/callback?state=flow-state&error=access_denied');
    render(<App />);
    await waitFor(() => expect(mocks.openApp).toHaveBeenCalledWith(APP_ERROR));
    expect(mocks.complete).toHaveBeenCalledWith('flow-state', '', 'access_denied');
  });

  it('sends a failed exchange back to the app from the error body', async () => {
    mocks.complete.mockRejectedValue(
      Object.assign(new Error('invalid_grant'), {
        status: 409,
        details: { success: false, error: 'invalid_grant', appReturnUrl: APP_ERROR },
      })
    );
    window.history.replaceState({}, '', '/mcp/callback?state=flow-state&code=auth-code');
    render(<App />);
    await waitFor(() => expect(mocks.openApp).toHaveBeenCalledWith(APP_ERROR));
    expect(screen.queryByText('invalid_grant')).toBeNull();
  });

  it('shows the error page for a failed exchange with no app return', async () => {
    mocks.complete.mockRejectedValue(Object.assign(new Error('invalid_grant'), { status: 409, details: { success: false } }));
    window.history.replaceState({}, '', '/mcp/callback?state=flow-state&code=auth-code');
    render(<App />);
    await screen.findByText('invalid_grant');
    expect(mocks.openApp).not.toHaveBeenCalled();
  });

  it.each([
    ['an https page', 'https://evil.com/mcp/callback'],
    ['script', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,hi'],
    ['a relative path', '/mcp/callback'],
    ['a non-string', 42],
  ])('never opens %s', async (_label, appReturnUrl) => {
    mocks.complete.mockResolvedValue({ appReturnUrl });
    window.history.replaceState({}, '', '/mcp/callback?state=flow-state&code=auth-code');
    render(<App />);
    await screen.findByText('MCP server connected');
    expect(mocks.openApp).not.toHaveBeenCalled();
  });
});
