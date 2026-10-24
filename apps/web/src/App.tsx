import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Analytics } from './components/Analytics';
import { AuthProvider, useAuth } from './components/auth/AuthProvider';
import { LoginScreen } from './components/auth/LoginScreen';
import { AppShell } from './components/layout/AppShell';
import { OnboardingWizard } from './components/onboarding/OnboardingWizard';
import { StartingSpinner } from './components/StartingSpinner';
import { Toaster } from './components/ui/toaster';
import { useApiConnection, useInitialDataLoad } from './hooks/useApi';
import { useClosePopupAfterGithub } from './hooks/useClosePopupAfterGithub';
import { useWorkspaceStore } from './stores/workspace';
import { AuthCallback } from './routes/AuthCallback';
import { McpCallback } from './routes/McpCallback';

export default function App() {
  // Before anything else: if this window is the GitHub-connect popup coming
  // back from the callback, close it rather than booting a second app inside
  // it. Outside the router — it depends only on the URL.
  useClosePopupAfterGithub();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/mcp/callback" element={<McpCallback />} />
        <Route path="/*" element={<SessionRoutes />} />
      </Routes>
    </BrowserRouter>
  );
}

function SessionRoutes() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginScreen />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/*" element={<RequireAuth />} />
      </Routes>
      <Toaster />
      <Analytics />
    </AuthProvider>
  );
}

function RequireAuth() {
  const { session, loading } = useAuth();
  if (loading) return <StartingSpinner />;
  if (!session) return <Navigate to="/login" replace />;
  return <AuthedApp />;
}

function AuthedApp() {
  useApiConnection();
  const { loaded } = useInitialDataLoad();
  const onboardingComplete = useWorkspaceStore((s) => s.onboardingComplete);

  // Wait for the first data load to settle before deciding. Otherwise a
  // returning user on fresh localStorage (flag still false) would briefly
  // flash the wizard before the migration in useInitialDataLoad flips it.
  if (!loaded) return <StartingSpinner />;
  if (!onboardingComplete) return <OnboardingWizard />;

  return <AppShell />;
}
