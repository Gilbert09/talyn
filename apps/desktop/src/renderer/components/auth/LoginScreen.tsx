import { useEffect, useState } from 'react';
import { useAuth } from './AuthProvider';
import { isSupabaseConfigured } from '../../lib/supabase';
import { trackEvent } from '../../lib/analytics';
import { BlinkingOwl } from '../widgets/BlinkingOwl';

export function LoginScreen() {
  const { signInWithGitHub, authError } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = isSupabaseConfigured();

  /**
   * The app's first PAINTED screen, as opposed to `app_opened`, which fires
   * from the renderer entry point before React has rendered anything.
   *
   * The two together are the whole question this screen could not answer: a
   * launch with `app_opened` and no `login_screen_viewed` never drew, and one
   * with both and no `signin_clicked` was read and walked away from. Before
   * this, both looked like a single `app_opened` and nothing else — 18 of them
   * in a month, indistinguishable from each other.
   */
  useEffect(() => {
    trackEvent('login_screen_viewed', { configured });
  }, [configured]);

  async function onClick() {
    setError(null);
    setBusy(true);
    trackEvent('signin_clicked');
    const res = await signInWithGitHub();
    if (res.error) setError(res.error);
    setBusy(false);
  }

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="w-full max-w-sm p-8 space-y-6 rounded-lg border bg-card shadow-sm">
        <div className="text-center space-y-2">
          <div className="flex justify-center pb-1">
            <BlinkingOwl />
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Talyn</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to continue. Your tasks, workspaces, and connections stay on your account.
          </p>
        </div>

        {!configured && (
          <div className="p-3 rounded-md border border-destructive/50 bg-destructive/10 text-sm text-destructive">
            Supabase isn't configured in this build. Set <code>TALYN_SUPABASE_URL</code> and
            <code>TALYN_SUPABASE_ANON_KEY</code> then rebuild the desktop app.
          </div>
        )}

        <button
          type="button"
          className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onClick}
          disabled={busy || !configured}
        >
          {busy ? 'Opening browser…' : 'Sign in with GitHub'}
        </button>

        {/* `error` is this click failing; `authError` is the callback failing
            minutes later, after the click returned cleanly. The second used to
            be a console line in an app with no console, which left a screen
            that simply never changed. */}
        {(error || authError) && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            <p className="font-medium">Sign-in didn't finish</p>
            <p className="mt-1 break-words">{error ?? authError}</p>
            <p className="mt-2 text-xs opacity-80">Try again, or sign in at app.talyn.dev.</p>
          </div>
        )}

        <p className="text-xs text-muted-foreground text-center">
          A browser window will open to authenticate you. You'll be returned to Talyn automatically.
        </p>
      </div>
    </div>
  );
}
