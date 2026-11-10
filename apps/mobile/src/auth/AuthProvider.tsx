import Constants from 'expo-constants';
import { type Href, usePathname, useRouter } from 'expo-router';
import { createContext, type PropsWithChildren, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Linking, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, ui } from '../components/UI';
import { ShellScreen, useShellColors } from '../components/ShellScreen';
import { BackendHealthFrame } from '../components/BackendHealthBanner';
import { BootScreen } from '../components/BootScreen';
import { Status } from '../components/AuthControls';
import { identifyAnalyticsUser, registerSuperProperties, resetAnalyticsUser, setAnalyticsReachability, trackEvent } from '../lib/analytics';
import { rememberIntent } from '../navigation/intents';
import type { MobileConfig } from '../config';
import { listenForCallbacks, receiveCallback } from './callback';
import { createMobileRuntime, type MobileRuntime } from './runtime';
import { startFailure, type StartFailure } from './startFailure';

const RuntimeContext = createContext<MobileRuntime | null>(null);

function isAuthLink(url: string) {
  try {
    const value = new URL(url);
    return value.pathname === '/callback' || value.pathname === '/auth/callback' ||
      ['code', 'error', 'access_token', 'refresh_token'].some((key) => value.searchParams.has(key));
  } catch { return false; }
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [runtime, setRuntime] = useState<MobileRuntime | null>(null);
  const [failed, setFailed] = useState<StartFailure | null>(null);
  const [retry, setRetry] = useState(0);
  const config = Constants.expoConfig?.extra?.mobile as MobileConfig | null | undefined;
  useEffect(() => {
    if (!config) return;
    let disposed = false;
    const abort = new AbortController();
    let current: MobileRuntime | undefined;
    let unbind = () => {};
    const links = Linking.addEventListener('url', ({ url }) => { if (isAuthLink(url)) receiveCallback(url); });
    setFailed(null);
    void createMobileRuntime(config, abort.signal).then(async (created) => {
      current = created;
      if (disposed) { created.dispose(); return; }
      await created.start();
      if (disposed) { created.dispose(); return; }
      unbind = listenForCallbacks((url) => { void created.auth.handleCallback(url); });
      const initial = await Linking.getInitialURL();
      if (disposed) return;
      if (initial && isAuthLink(initial)) receiveCallback(initial);
      else if (initial) rememberIntent(initial);
      setRuntime(created);
    }).catch((error: unknown) => {
      if (__DEV__) console.warn('Talyn could not start', error);
      current?.dispose();
      if (!disposed) setFailed(startFailure(error));
    });
    return () => { disposed = true; abort.abort(); links.remove(); unbind(); current?.dispose(); };
  }, [config, retry]);

  if (!config) return <ShellScreen topInset centered title="Connect Talyn" description="Set the four public mobile configuration values in the mobile README, then restart the app." />;
  if (failed) return <ShellScreen topInset centered title={failed.title} description={failed.description}>
    <Button title="Try again" onPress={() => setRetry((value) => value + 1)} />
  </ShellScreen>;
  if (!runtime) return <BootScreen label="Restoring sign-in" />;
  return <RuntimeContext.Provider value={runtime}><AnalyticsBinding /><WorkspaceBinding /><NotificationBinding /><BackendHealthFrame health={runtime.health}>{children}</BackendHealthFrame></RuntimeContext.Provider>;
}

export function useMobileRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('Mobile runtime is not ready.');
  return runtime;
}
export function useAuth() {
  const { auth } = useMobileRuntime();
  return useSyncExternalStore(auth.subscribe, auth.getSnapshot, auth.getSnapshot);
}
export function useWorkspace() {
  const { workspace } = useMobileRuntime();
  return useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot);
}
export function useNetwork() {
  const { lifecycle } = useMobileRuntime();
  return useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot).reachability;
}
/**
 * Identity, sign-in events and context super properties, mirroring web's
 * `Analytics` component. Mounted inside the runtime provider.
 */
function AnalyticsBinding() {
  const auth = useAuth();
  const network = useNetwork();
  const workspaceId = useWorkspace().selected;
  const userId = auth.user?.id;
  const email = auth.user?.email;
  const githubLogin = auth.user?.githubLogin;
  // undefined: auth has not resolved yet; null: resolved to signed out.
  const previousUser = useRef<string | null | undefined>(undefined);
  const previousStatus = useRef(auth.status);

  useEffect(() => { setAnalyticsReachability(network); }, [network]);

  useEffect(() => {
    const before = previousStatus.current;
    previousStatus.current = auth.status;
    if (before === 'signingIn' && auth.status === 'signedOut' && auth.issue) {
      trackEvent('signin_failed', { stage: auth.issue === 'timeout' ? 'callback_timeout' : auth.issue });
    }
  }, [auth.status, auth.issue]);

  useEffect(() => {
    const before = previousUser.current;
    if (userId) {
      previousUser.current = userId;
      identifyAnalyticsUser(userId, { ...(email ? { email } : {}), ...(githubLogin ? { github_login: githubLogin } : {}) });
      // A restored session is not a sign-in.
      if (before === null) trackEvent('logged_in');
    } else if (auth.status === 'signedOut') {
      previousUser.current = null;
      if (before) {
        trackEvent('logged_out');
        // Only on a real sign-out: resetting on the first render would churn the anonymous id.
        resetAnalyticsUser();
      }
    }
  }, [userId, email, githubLogin, auth.status]);

  useEffect(() => { if (workspaceId) registerSuperProperties({ workspace_id: workspaceId }); }, [workspaceId]);

  return null;
}

function WorkspaceBinding() {
  const { workspace, context } = useMobileRuntime();
  const user = useAuth().user?.id;
  useEffect(() => { if (user) { void workspace.load(user); void context.load(user); } }, [user, workspace, context]);
  return null;
}
function NotificationBinding() {
  const { notifications } = useMobileRuntime();
  const router = useRouter();
  const pathname = usePathname();
  const colors = useShellColors();
  const insets = useSafeAreaInsets();
  const state = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot, notifications.getSnapshot);
  useEffect(() => { notifications.setNavigation((path) => router.push(path as Href), pathname); }, [notifications, router, pathname]);
  if (!state.tapIssue) return null;
  return <View style={{ paddingTop: insets.top, paddingHorizontal: 16, paddingBottom: 8, gap: 8, backgroundColor: colors.background }}>
    <Status message={state.tapIssue} tone="warning" /><View style={ui.wrap}>
    <Button variant="secondary" title="Try notification again" onPress={notifications.retryTap} />
    <Button variant="quiet" title="Dismiss notification message" onPress={notifications.clearTapIssue} /></View></View>;
}
