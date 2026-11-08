import Constants from 'expo-constants';
import { createContext, type PropsWithChildren, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Linking } from 'react-native';

import { ShellScreen } from '../components/ShellScreen';
import { Status } from '../components/AuthControls';
import { rememberIntent } from '../navigation/intents';
import type { MobileConfig } from '../config';
import { listenForCallbacks, receiveCallback } from './callback';
import { createMobileRuntime, type MobileRuntime } from './runtime';

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
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const config = Constants.expoConfig?.extra?.mobile as MobileConfig | null | undefined;
  useEffect(() => {
    if (!config) return;
    let disposed = false;
    const abort = new AbortController();
    let current: MobileRuntime | undefined;
    let unbind = () => {};
    const links = Linking.addEventListener('url', ({ url }) => { if (isAuthLink(url)) receiveCallback(url); });
    setFailed(false);
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
    }).catch(() => {
      current?.dispose();
      if (!disposed) setFailed(true);
    });
    return () => { disposed = true; abort.abort(); links.remove(); unbind(); current?.dispose(); };
  }, [config, retry]);

  if (!config) return <ShellScreen title="Connect Talyn" description="Set the four public mobile configuration values in the mobile README, then restart the app." />;
  if (failed) return <ShellScreen title="Unlock this device" description="Secure sign-in is not available. Unlock this device and try again.">
    <Button title="Try again" onPress={() => setRetry((value) => value + 1)} />
  </ShellScreen>;
  if (!runtime) return <ShellScreen title="Opening Talyn" description="Restoring your account securely."><Status message="Restoring sign-in" loading /></ShellScreen>;
  return <RuntimeContext.Provider value={runtime}><WorkspaceBinding />{children}</RuntimeContext.Provider>;
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
function WorkspaceBinding() {
  const { workspace } = useMobileRuntime();
  const user = useAuth().user?.id;
  useEffect(() => { if (user) void workspace.load(user); }, [user, workspace]);
  return null;
}
