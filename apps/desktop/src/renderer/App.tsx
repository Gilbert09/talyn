import { useEffect, useState } from 'react';
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
  resetAnalyticsUser,
  trackEvent,
} from './lib/analytics';
import './App.css';

function StartingSpinner() {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-center">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
        <p className="text-sm text-muted-foreground">Starting…</p>
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
      {onboardingComplete ? <MainLayout /> : <OnboardingWizard />}
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

  if (!session) return <LoginScreen />;
  return <AuthedApp />;
}

/**
 * Renderless: syncs PostHog identity with the auth session and tracks panel
 * navigation as product-analytics events. Mounted inside AuthProvider.
 */
function Analytics() {
  const { user } = useAuth();
  const activePanel = useWorkspaceStore((s) => s.activePanel);
  const userId = user?.id;
  const email = user?.email;
  const githubLogin = user?.user_metadata?.user_name as string | undefined;

  useEffect(() => {
    if (userId) {
      identifyAnalyticsUser(userId, { email, github_login: githubLogin });
    } else {
      resetAnalyticsUser();
    }
  }, [userId, email, githubLogin]);

  useEffect(() => {
    if (activePanel) trackEvent('panel_viewed', { panel: activePanel });
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
