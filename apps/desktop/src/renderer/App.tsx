import { useEffect, useRef, useState } from 'react';
import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import { MainLayout } from './components/layout/MainLayout';
import { OnboardingWizard } from './components/onboarding/OnboardingWizard';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { LoginScreen } from './components/auth/LoginScreen';
import { useApiConnection, useInitialDataLoad } from './hooks/useApi';
import { useWorkspaceStore } from './stores/workspace';
import { Toaster } from './components/ui/toaster';
import {
  identifyAnalyticsUser,
  registerSuperProperties,
  resetAnalyticsUser,
  trackEvent,
} from './lib/analytics';
import { isMacDesktop } from './lib/utils';
import './App.css';

/**
 * On macOS the window is frameless, so screens without their own chrome need
 * an invisible top strip to drag the window by. MainLayout doesn't use this —
 * its sidebar reserves an in-flow drag region instead (an overlay here would
 * swallow clicks on panel-header controls near the top edge).
 */
function MacDragOverlay() {
  if (!isMacDesktop) return null;
  return (
    <div aria-hidden className="app-region-drag fixed inset-x-0 top-0 z-50 h-9" />
  );
}

// Cosmetic techy "boot log" cycled under the owl while the app starts.
const OWL_BOOT_LINES = [
  'waking the owl',
  'ruffling feathers',
  'scanning the perch',
  'syncing pull requests',
  'sharpening talons',
  'engaging night vision',
];

// The owl, drawn so only the eyes line swaps on a blink (same character
// width, so the ASCII never jitters). `O   O` open → `-   -` shut.
function owlArt(eyes: string): string {
  return [
    '  .-"""-.',
    ` ( ${eyes} )`,
    ' (   v   )',
    "  ) '-' (",
    ' (_/   \\_)',
  ].join('\n');
}

/** Owls blink in quick bursts, then hold their gaze — mimic that, leak-free. */
function useOwlBlink(): boolean {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    const timers: number[] = [];
    let alive = true;
    const wink = (then: () => void) => {
      setBlinking(true);
      timers.push(
        window.setTimeout(() => {
          setBlinking(false);
          timers.push(window.setTimeout(then, 110));
        }, 130)
      );
    };
    const loop = () => {
      if (!alive) return;
      const hold = 1700 + Math.floor(Math.random() * 2200);
      timers.push(
        window.setTimeout(() => {
          // Every so often a double blink — owls do it, and it reads as alive.
          if (Math.random() < 0.35) wink(() => wink(loop));
          else wink(loop);
        }, hold)
      );
    };
    loop();
    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, []);
  return blinking;
}

function StartingSpinner() {
  const blinking = useOwlBlink();
  const [line, setLine] = useState(0);
  const [dots, setDots] = useState(0);

  useEffect(() => {
    const dotId = window.setInterval(() => setDots((d) => (d + 1) % 4), 420);
    const lineId = window.setInterval(
      () => setLine((l) => (l + 1) % OWL_BOOT_LINES.length),
      1600
    );
    return () => {
      window.clearInterval(dotId);
      window.clearInterval(lineId);
    };
  }, []);

  return (
    <div className="flex items-center justify-center h-screen">
      <MacDragOverlay />
      <div className="flex flex-col items-center select-none">
        <pre
          aria-hidden
          className="owl-glow font-mono text-primary leading-[1.1] text-[15px] sm:text-base"
        >
          {owlArt(blinking ? '-   -' : 'O   O')}
        </pre>

        {/* Sweeping scan bar — the "techy" tell. */}
        <div className="mt-4 h-px w-44 overflow-hidden rounded-full bg-border/60">
          <div className="owl-scan-bar h-full w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent" />
        </div>

        <p
          aria-label="Starting"
          className="mt-3 font-mono text-xs text-muted-foreground"
        >
          <span className="text-primary">&gt;</span>{' '}
          {OWL_BOOT_LINES[line]}
          <span className="text-primary">{'.'.repeat(dots)}</span>
          <span className="owl-caret ml-0.5 text-primary">▋</span>
        </p>
      </div>
    </div>
  );
}

const API_BASE = process.env.FASTOWL_API_URL || 'http://localhost:4747';

async function checkBackend(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    const data = await response.json();
    return data.status === 'ok';
  } catch {
    return false;
  }
}

function AuthedApp() {
  useApiConnection();
  const { loaded } = useInitialDataLoad();
  const onboardingComplete = useWorkspaceStore((s) => s.onboardingComplete);

  // Wait for the first data load to settle before deciding. Otherwise a
  // returning user on fresh localStorage (flag still false) would briefly
  // flash the wizard before the migration in useInitialDataLoad flips it.
  if (!loaded) return <StartingSpinner />;

  return (
    <>
      {onboardingComplete ? (
        <MainLayout />
      ) : (
        <>
          <MacDragOverlay />
          <OnboardingWizard />
        </>
      )}
      <Toaster />
    </>
  );
}

function AppBody() {
  const { session, loading: authLoading } = useAuth();
  const [backendAvailable, setBackendAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    checkBackend().then(setBackendAvailable);
  }, []);

  if (authLoading || backendAvailable === null) {
    return <StartingSpinner />;
  }

  if (!backendAvailable) {
    return (
      <div className="flex items-center justify-center h-screen">
        <MacDragOverlay />
        <div className="max-w-md text-center space-y-2">
          <p className="text-sm">Backend is unreachable.</p>
          <p className="text-xs text-muted-foreground">
            Expected at <code>{API_BASE}</code>. Start it with <code>npm run dev</code> in
            <code>packages/backend</code>.
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <>
        <MacDragOverlay />
        <LoginScreen />
      </>
    );
  }
  return <AuthedApp />;
}

/**
 * Renderless: syncs PostHog identity with the auth session and tracks panel
 * navigation as product-analytics events. Mounted inside AuthProvider.
 */
function Analytics() {
  const { user } = useAuth();
  const activePanel = useWorkspaceStore((s) => s.activePanel);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const userId = user?.id;
  const email = user?.email;
  const githubLogin = user?.user_metadata?.user_name as string | undefined;
  // First identify of a mount is session restore, not a fresh login — only
  // track logged_in when the user id appears after being absent.
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  const previousPanelRef = useRef<string | null>(null);

  useEffect(() => {
    const prevUserId = prevUserIdRef.current;
    prevUserIdRef.current = userId;
    if (userId) {
      identifyAnalyticsUser(userId, { email, github_login: githubLogin });
      if (prevUserId === null) trackEvent('logged_in');
    } else {
      // Distinguish "no session yet" (undefined) from "session ended"
      // by recording null once auth has resolved to signed-out.
      prevUserIdRef.current = null;
      if (prevUserId) trackEvent('logged_out');
      resetAnalyticsUser();
    }
  }, [userId, email, githubLogin]);

  // Active workspace as a super property — every event (incl. autocapture)
  // carries it, instead of threading it through each call site.
  useEffect(() => {
    if (currentWorkspaceId) {
      registerSuperProperties({ workspace_id: currentWorkspaceId });
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    if (activePanel) {
      trackEvent('panel_viewed', {
        panel: activePanel,
        previous_panel: previousPanelRef.current,
      });
      previousPanelRef.current = activePanel;
    }
  }, [activePanel]);

  return null;
}

export default function App() {
  return (
    <AuthProvider>
      <Analytics />
      <Router>
        <Routes>
          <Route path="/" element={<AppBody />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}
