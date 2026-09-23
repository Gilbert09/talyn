import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from '../../lib/supabase';
import { setLogoutReason } from '../../lib/logoutReason';
import { trackEvent } from '../../lib/analytics';

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  loading: boolean;
  /**
   * The reason the LAST sign-in attempt did not finish, or null.
   *
   * Distinct from the error `signInWithGitHub` returns: that one is about
   * STARTING the flow and arrives while the user is still looking at the
   * button. This is about the half that lands minutes later, in the deep-link
   * callback, long after the click returned cleanly — a denied authorization
   * or a failed code exchange. It used to be a `console.error` in a packaged
   * app with no console, so the flow ended as a login screen that had simply
   * not changed.
   */
  authError: string | null;
  signInWithGitHub: () => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Bootstraps the Supabase auth session and listens for changes. The deep-link
 * handler (`window.electron.auth.onCallback`) feeds access/refresh tokens in
 * when the system browser redirects back to fastowl://auth-callback.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      // LoginScreen renders its own visible warning when this is false —
      // no need to yell in the console (which the test runner flags).
      setLoading(false);
      return;
    }
    const supabase = getSupabase();

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next ?? null);
    });

    // Bridge: main process forwards `fastowl://auth-callback?...` here.
    // With flowType: 'pkce', Supabase returns a short-lived `code` that
    // we exchange for a session using the verifier it stashed during
    // signInWithOAuth — this verifies the callback came from a flow
    // we actually started and can't be replayed with stolen tokens.
    const off = window.electron?.auth?.onCallback(async (url: string) => {
      const { code, error: providerError } = parseCallbackUrl(url);
      // The callback came back, whatever it says. This is the event that
      // separates "never left the login screen" from "went to GitHub and
      // something went wrong on the way home" — the two look identical from
      // the outside, and the second one is the one we can fix.
      trackEvent('signin_callback_received', {
        has_code: Boolean(code),
        denied: Boolean(providerError),
      });
      if (providerError) {
        setAuthError(providerError);
        trackEvent('signin_failed', { stage: 'callback_denied', error: providerError });
        return;
      }
      if (!code) {
        setAuthError('That sign-in did not come back with anything to finish.');
        trackEvent('signin_failed', { stage: 'callback_empty' });
        return;
      }
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.error('auth: exchangeCodeForSession failed:', error.message);
        setAuthError(error.message);
        trackEvent('signin_failed', { stage: 'callback_exchange', error: error.message });
        return;
      }
      setAuthError(null);
    });

    return () => {
      listener.subscription.unsubscribe();
      off?.();
    };
  }, []);

  async function signInWithGitHub(): Promise<{ error: string | null }> {
    // A retry starts from a clean slate: the previous attempt's failure is
    // about a round trip that is over.
    setAuthError(null);
    if (!isSupabaseConfigured()) {
      trackEvent('signin_failed', { stage: 'unconfigured' });
      return { error: 'Supabase is not configured' };
    }
    const supabase = getSupabase();
    // Scheme-matched to this build (fastowl:// prod, fastowl-dev:// dev) so the
    // OAuth callback reopens THIS app — not a separately-installed one. Falls
    // back to the prod scheme if the bridge is somehow unavailable.
    const redirectTo =
      (await window.electron?.auth?.getRedirectUrl()) ?? 'fastowl://auth-callback';
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });
    if (error) {
      trackEvent('signin_failed', { stage: 'oauth_start', error: error.message });
      return { error: error.message };
    }
    if (!data.url) {
      trackEvent('signin_failed', { stage: 'oauth_start', error: 'no_url' });
      return { error: 'No OAuth URL returned' };
    }
    // Hand the URL off to the main process, which opens it in the user's
    // default browser. We can't `window.open` — Electron would render it
    // in-process and Supabase/GitHub's cookies wouldn't be available there.
    await window.electron?.auth?.openExternal(data.url);
    // The browser has the flow now. Everything after this point happens out
    // of our process, so this is the last thing we can say for certain until
    // the deep link comes back — which is exactly why it is an event.
    trackEvent('signin_browser_opened');
    return { error: null };
  }

  async function signOut(): Promise<void> {
    if (!isSupabaseConfigured()) return;
    setLogoutReason('manual');
    await getSupabase().auth.signOut();
  }

  const value: AuthContextValue = {
    session,
    user: session?.user ?? null,
    loading,
    authError,
    signInWithGitHub,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Read the PKCE callback: `?code=…` on success, `?error=…` when the user (or
 * GitHub) said no. Both halves matter — a callback carrying neither is a
 * third case, and the old reader returned null for all three.
 */
export function parseCallbackUrl(url: string): { code: string | null; error: string | null } {
  try {
    // fastowl://auth-callback?code=... — URL parses custom schemes fine.
    const u = new URL(url);
    return {
      code: u.searchParams.get('code'),
      error: u.searchParams.get('error_description') || u.searchParams.get('error'),
    };
  } catch {
    return { code: null, error: null };
  }
}
