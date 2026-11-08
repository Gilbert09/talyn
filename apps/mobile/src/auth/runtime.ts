import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { createClient } from '@supabase/supabase-js';
import { configureApiClient, users, workspaces, wsClient } from '@talyn/client/native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { AppState } from 'react-native';

import type { MobileConfig } from '../config';
import { createNativeLifecycle } from '../native/lifecycle';
import { WorkspaceController } from '../workspaces/controller';
import { AccountActions } from './account';
import { installAuthCrypto } from './crypto';
import { AuthController } from './controller';
import { SecureSessionStorage } from './storage';
import { createAuthFetch } from './transport';

let previousStorageDrain: Promise<unknown> = Promise.resolve();

export async function createMobileRuntime(config: MobileConfig, signal?: AbortSignal) {
  const assertCurrent = () => { if (signal?.aborted) throw new Error('Authentication setup stopped.'); };
  await previousStorageDrain;
  assertCurrent();
  const namespace = `talyn.${await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,
    JSON.stringify([config.environment, config.apiOrigin, config.supabaseUrl, config.callbackUrl]))}`;
  const driver = {
    getItemAsync: (key: string) => SecureStore.getItemAsync(key),
    setItemAsync: (key: string, value: string) => SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
    deleteItemAsync: (key: string) => SecureStore.deleteItemAsync(key),
  };
  const storage = new SecureSessionStorage(driver, namespace, Crypto.randomUUID);
  if (!await SecureStore.isAvailableAsync()) throw new Error('Secure storage is not available.');
  await storage.checkAvailable();
  assertCurrent();
  const previous = await SecureStore.getItemAsync('talyn-active-environment');
  assertCurrent();
  if (previous && previous !== namespace) {
    if (!/^talyn\.[a-f0-9]{64}$/.test(previous)) throw new Error('Stored environment is not valid.');
    const oldStorage = new SecureSessionStorage(driver, previous, Crypto.randomUUID);
    const raw = await oldStorage.getItem('session');
    const oldUser = raw ? (JSON.parse(raw) as { user?: { id?: string } }).user?.id : null;
    wsClient.reset();
    await oldStorage.clearAuth();
    if (oldUser) await AsyncStorage.removeItem(`talyn.workspace.${previous}.${encodeURIComponent(oldUser)}`);
  }
  assertCurrent();
  await SecureStore.setItemAsync('talyn-active-environment', namespace, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  assertCurrent();
  const lifecycle = createNativeLifecycle(AppState, NetInfo);
  const workspace = new WorkspaceController(AsyncStorage, namespace, () => workspaces.list());
  let rejectRefresh = () => {};
  installAuthCrypto();
  const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
    auth: {
      storage, storageKey: 'session', flowType: 'pkce', persistSession: true,
      autoRefreshToken: true, detectSessionInUrl: false,
    },
    global: { fetch: createAuthFetch(globalThis.fetch, () => rejectRefresh()) },
  });
  const initialized = supabase.auth.initialize();
  const bindClient = () => configureApiClient({
    baseUrl: config.apiOrigin, clientVersion: 'mobile/0.1.0', runtime: { lifecycle },
    getAccessToken: () => auth.getAccessToken(), recoverSession: () => auth.recoverSession(),
  });
  const auth = new AuthController({
    getSession: () => supabase.auth.getSession(),
    refreshSession: () => supabase.auth.refreshSession(),
    signInWithOAuth: (options) => supabase.auth.signInWithOAuth(options),
    exchangeCodeForSession: (code) => supabase.auth.exchangeCodeForSession(code),
    signOut: (options) => supabase.auth.signOut(options),
    startAutoRefresh: async () => { await initialized; await supabase.auth.startAutoRefresh(); },
    stopAutoRefresh: async () => { await initialized; await supabase.auth.stopAutoRefresh(); },
  }, storage, {
    open: (url, callback) => WebBrowser.openAuthSessionAsync(url, callback, { preferEphemeralSession: true, preferUniversalLinks: callback.startsWith('https:') }),
    dismiss: () => { try { WebBrowser.dismissAuthSession(); } catch { /* No active browser session. */ } },
  }, config.callbackUrl, (priorUser) => {
    wsClient.reset();
    bindClient();
    return workspace.clear(priorUser);
  });
  rejectRefresh = () => { void auth.signOut(); };
  bindClient();
  const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
    auth.authEvent(event, session);
  });
  const active = () => {
    const state = lifecycle.getSnapshot();
    auth.setActive(state.activity === 'active' && state.reachability !== 'offline');
  };
  const unbind = lifecycle.subscribe(active);
  active();
  return {
    auth, workspace, lifecycle, account: new AccountActions(auth, users.wipeMe),
    async start() { await auth.restore(); active(); },
    dispose() {
      previousStorageDrain = storage.seal();
      auth.dispose();
      subscription.subscription.unsubscribe();
      unbind(); lifecycle.dispose(); workspace.dispose(); wsClient.reset();
      // Rebinding also invalidates REST requests from the previous runtime.
      configureApiClient({ baseUrl: config.apiOrigin, clientVersion: 'mobile/0.1.0',
        getAccessToken: async () => null, recoverSession: async () => false,
        runtime: { lifecycle: { getSnapshot: () => ({ activity: 'suspended', reachability: 'unknown' }), subscribe: () => () => {} } },
      });
    },
  };
}
export type MobileRuntime = Awaited<ReturnType<typeof createMobileRuntime>>;
