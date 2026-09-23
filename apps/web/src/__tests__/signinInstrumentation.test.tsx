import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The sign-in screen, which used to report nothing at all.
 *
 * Same gap as the desktop's, and the same fix: `app_opened` says the client
 * started, `login_screen_viewed` says the screen was drawn, `signin_clicked`
 * says it was acted on. Without the middle one, an abandoned launch and one
 * that never painted are the same single event.
 *
 * The web half differs in where it can fail. The OAuth leg is a full-page
 * navigation, so only a failure to START returns to us; the return leg lands
 * on /auth/callback, where `detectSessionInUrl` swallows its own failures
 * into a console warning — which is why a silent one has to be reported as
 * the timeout it becomes.
 *
 * Duplicated in apps/desktop on purpose: the renderer is a deliberate fork.
 */

const track = vi.fn();
let oauthError: string | null = null;

vi.mock('../lib/analytics', () => ({ trackEvent: (...a: unknown[]) => track(...a) }));
vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signInWithOAuth: async () => ({ error: oauthError ? { message: oauthError } : null }),
      signOut: async () => {},
    },
  }),
}));
vi.mock('../components/widgets/BlinkingOwl', () => ({ BlinkingOwl: () => null }));
vi.mock('../components/StartingSpinner', () => ({ StartingSpinner: () => <div>Starting</div> }));

const { AuthProvider } = await import('../components/auth/AuthProvider');
const { LoginScreen } = await import('../components/auth/LoginScreen');
const { AuthCallback } = await import('../routes/AuthCallback');

const names = () => track.mock.calls.map((c) => c[0] as string);
const propsOf = (name: string) =>
  track.mock.calls.find((c) => c[0] === name)?.[1] as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  oauthError = null;
  sessionStorage.clear();
  window.history.replaceState({}, '', '/login');
});
afterEach(cleanup);

function mountLogin() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <LoginScreen />
      </AuthProvider>
    </MemoryRouter>
  );
}

describe('the sign-in screen reports itself', () => {
  it('says the screen was drawn', async () => {
    mountLogin();
    await waitFor(() => expect(names()).toContain('login_screen_viewed'));
    expect(propsOf('login_screen_viewed')).toEqual({ configured: true });
    expect(names()).not.toContain('signin_clicked');
  });

  it('records the click', async () => {
    mountLogin();
    fireEvent.click(screen.getByRole('button', { name: /sign in with github/i }));
    await waitFor(() => expect(names()).toContain('signin_clicked'));
  });

  it('reports a flow that could not start, and says so on screen', async () => {
    oauthError = 'provider is down';
    mountLogin();
    fireEvent.click(screen.getByRole('button', { name: /sign in with github/i }));
    await waitFor(() => expect(names()).toContain('signin_failed'));
    expect(propsOf('signin_failed')).toEqual({ stage: 'oauth_start', error: 'provider is down' });
    expect(await screen.findByText('provider is down')).toBeTruthy();
  });
});

describe('the return leg', () => {
  function mountCallback(search: string) {
    window.history.replaceState({}, '', `/auth/callback${search}`);
    return render(
      <MemoryRouter initialEntries={[`/auth/callback${search}`]}>
        <AuthProvider>
          <AuthCallback />
        </AuthProvider>
      </MemoryRouter>
    );
  }

  it('records a callback that came back with a code', async () => {
    mountCallback('?code=abc123');
    await waitFor(() => expect(names()).toContain('signin_callback_received'));
    expect(propsOf('signin_callback_received')).toEqual({ has_code: true, denied: false });
    expect(names()).not.toContain('signin_failed');
  });

  it('records a denial, and keeps showing it', async () => {
    mountCallback('?error=access_denied');
    await waitFor(() => expect(names()).toContain('signin_failed'));
    expect(propsOf('signin_callback_received')).toEqual({ has_code: false, denied: true });
    expect(propsOf('signin_failed')).toEqual({ stage: 'callback_denied', error: 'access_denied' });
    expect(await screen.findByText('access_denied')).toBeTruthy();
  });

  it('reports the exchange that never finished', async () => {
    vi.useFakeTimers();
    mountCallback('?code=abc123');
    // detectSessionInUrl fails into a console warning, so the 15s ceiling is
    // the only signal a silent failure ever produces.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(propsOf('signin_failed')).toEqual({ stage: 'callback_timeout' });
    vi.useRealTimers();
  });
});
