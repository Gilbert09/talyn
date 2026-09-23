import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The sign-in screen, which used to report nothing at all.
 *
 * Eighteen people in a month launched the desktop app, fired exactly one
 * `app_opened`, hit no exception, produced no session recording, and were
 * never seen again. Two readings fit that evidence — they quit in seconds, or
 * the window never drew — and nothing in the product could tell them apart,
 * because the login screen captured no events and `exchangeCodeForSession`
 * failures went to a console that a packaged app does not have.
 *
 * So: `login_screen_viewed` proves the screen painted, `signin_clicked` proves
 * it was acted on, and every way the round trip can fail now says so, on the
 * screen and in an event.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

interface Recorder {
  events: Array<[string, Record<string, unknown> | undefined]>;
  /** The deep-link handler the provider registers, captured for the tests. */
  callback: ((url: string) => void | Promise<void>) | null;
  oauthError: string | null;
  exchangeError: string | null;
}

// Function declarations + globalThis: the runner hoists mock factories above
// every import, so anything a factory touches must survive being reached first.
function rec(): Recorder {
  const g = globalThis as unknown as { __talynSignin?: Recorder };
  g.__talynSignin ??= { events: [], callback: null, oauthError: null, exchangeError: null };
  return g.__talynSignin;
}

jest.mock('../renderer/lib/analytics', () => ({
  trackEvent: (event: string, props?: Record<string, unknown>) => {
    rec().events.push([event, props]);
  },
}));
jest.mock('../renderer/lib/logoutReason', () => ({ setLogoutReason: () => {} }));
jest.mock('../renderer/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signInWithOAuth: async () => ({
        data: rec().oauthError ? { url: null } : { url: 'https://github.com/login/oauth' },
        error: rec().oauthError ? { message: rec().oauthError } : null,
      }),
      exchangeCodeForSession: async () => ({
        error: rec().exchangeError ? { message: rec().exchangeError } : null,
      }),
      signOut: async () => {},
    },
  }),
}));
jest.mock('../renderer/components/widgets/BlinkingOwl', () => ({ BlinkingOwl: () => null }));

import { AuthProvider, parseCallbackUrl } from '../renderer/components/auth/AuthProvider';
import { LoginScreen } from '../renderer/components/auth/LoginScreen';

const names = () => rec().events.map(([name]) => name);
const propsOf = (name: string) => rec().events.find(([n]) => n === name)?.[1];

beforeEach(() => {
  Object.assign(rec(), { events: [], callback: null, oauthError: null, exchangeError: null });
  (window as unknown as { electron: unknown }).electron = {
    auth: {
      getRedirectUrl: async () => 'fastowl://auth-callback',
      openExternal: async () => {},
      onCallback: (fn: (url: string) => void) => {
        rec().callback = fn;
        return () => {};
      },
    },
  };
});

function mount() {
  return render(
    <AuthProvider>
      <LoginScreen />
    </AuthProvider>
  );
}

describe('the sign-in screen reports itself', () => {
  it('says the screen was drawn, which app_opened cannot', async () => {
    mount();
    await waitFor(() => expect(names()).toContain('login_screen_viewed'));
    expect(propsOf('login_screen_viewed')).toEqual({ configured: true });
    // Nothing else yet: a launch that stops here is now visibly a launch that
    // was looked at, not one that may never have rendered.
    expect(names()).not.toContain('signin_clicked');
  });

  it('records the click and the hand-off to the browser', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /sign in with github/i }));
    await waitFor(() => expect(names()).toContain('signin_browser_opened'));
    expect(names()).toEqual(['login_screen_viewed', 'signin_clicked', 'signin_browser_opened']);
  });

  it('reports a flow that could not even start', async () => {
    rec().oauthError = 'provider is down';
    mount();
    fireEvent.click(screen.getByRole('button', { name: /sign in with github/i }));
    await waitFor(() => expect(names()).toContain('signin_failed'));
    expect(propsOf('signin_failed')).toEqual({ stage: 'oauth_start', error: 'provider is down' });
    expect(await screen.findByText('provider is down')).toBeInTheDocument();
  });
});

describe('the half that lands after the click returns', () => {
  it('shows a denied authorization instead of an unchanged screen', async () => {
    mount();
    await waitFor(() => expect(rec().callback).not.toBeNull());
    await act(async () => rec().callback!('fastowl://auth-callback?error=access_denied'));
    expect(await screen.findByText('access_denied')).toBeInTheDocument();
    expect(propsOf('signin_callback_received')).toEqual({ has_code: false, denied: true });
    expect(propsOf('signin_failed')).toEqual({ stage: 'callback_denied', error: 'access_denied' });
  });

  it('shows a failed code exchange, which used to be a console line', async () => {
    rec().exchangeError = 'invalid request: code verifier should be non-empty';
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mount();
    await waitFor(() => expect(rec().callback).not.toBeNull());
    await act(async () => rec().callback!('fastowl://auth-callback?code=abc123'));
    expect(
      await screen.findByText('invalid request: code verifier should be non-empty')
    ).toBeInTheDocument();
    expect(propsOf('signin_callback_received')).toEqual({ has_code: true, denied: false });
    expect(propsOf('signin_failed')).toEqual({
      stage: 'callback_exchange',
      error: 'invalid request: code verifier should be non-empty',
    });
  });

  it('reports a callback carrying neither a code nor an error', async () => {
    mount();
    await waitFor(() => expect(rec().callback).not.toBeNull());
    await act(async () => rec().callback!('fastowl://auth-callback'));
    await waitFor(() => expect(names()).toContain('signin_failed'));
    expect(propsOf('signin_failed')).toEqual({ stage: 'callback_empty' });
  });
});

describe('parseCallbackUrl', () => {
  it.each([
    ['fastowl://auth-callback?code=abc', 'abc', null],
    ['fastowl://auth-callback?error=access_denied', null, 'access_denied'],
    // A description is the human-readable half — prefer it when both are sent.
    ['fastowl://auth-callback?error=server_error&error_description=GitHub+said+no', null, 'GitHub said no'],
    ['fastowl://auth-callback', null, null],
    ['not a url', null, null],
  ])('reads %s', (url, code, error) => {
    expect(parseCallbackUrl(url)).toEqual({ code, error });
  });
});
