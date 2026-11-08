import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { waitFor } from '@testing-library/react-native';
import { createClient } from '@supabase/supabase-js';
import { configureApiClient, wsClient } from '@talyn/client/native';
import * as SecureStore from 'expo-secure-store';
import { AppState, type AppStateStatus } from 'react-native';

import type { MobileConfig } from '../config';
import { createMobileRuntime } from '../auth/runtime';

const mockSecure = new Map<string, string>();
const mockPreferences = new Map<string, string>();
const mockAuth = {
  initialize: jest.fn(async () => ({ error: null })),
  getSession: jest.fn(async () => ({ data: { session: null }, error: null })),
  refreshSession: jest.fn(async () => ({ data: { session: null }, error: null })),
  signInWithOAuth: jest.fn(), exchangeCodeForSession: jest.fn(),
  signOut: jest.fn(async () => ({ error: null })), startAutoRefresh: jest.fn(), stopAutoRefresh: jest.fn(),
  onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: mockUnsubscribe } } })),
};
const mockUnsubscribe = jest.fn();
const mockRemoveApp = jest.fn(); const mockRemoveNet = jest.fn();
let mockAppListener: (state: AppStateStatus) => void;
let mockNetworkListener: (state: { isConnected: boolean; isInternetReachable: boolean }) => void;
let mockRevision = 0;
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockPreferences.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => { mockPreferences.set(key, value); }),
  removeItem: jest.fn(async (key: string) => { mockPreferences.delete(key); }),
}));
jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn((listener) => { mockNetworkListener = listener; return mockRemoveNet; }),
}));
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked-device-only',
  isAvailableAsync: jest.fn(async () => true),
  getItemAsync: jest.fn(async (key: string) => mockSecure.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockSecure.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockSecure.delete(key); }),
}));
jest.mock('expo-crypto', () => {
  const crypto = require('node:crypto');
  return {
    digestStringAsync: async (_algorithm: string, value: string) => crypto.createHash('sha256').update(value).digest('hex'),
    randomUUID: () => `revision-${++mockRevision}`,
    getRandomValues: (data: Uint32Array) => crypto.webcrypto.getRandomValues(data),
    digest: async (algorithm: string, data: BufferSource) => crypto.webcrypto.subtle.digest(algorithm, data),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  };
});
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn(), dismissAuthSession: jest.fn() }));
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({ auth: mockAuth })) }));
jest.mock('@talyn/client/native', () => ({
  configureApiClient: jest.fn(), wsClient: { reset: jest.fn() },
  users: { wipeMe: jest.fn() }, workspaces: { list: jest.fn(async () => [{ id: 'one', name: 'One' }]) },
}));
const config: MobileConfig = {
  environment: 'development', apiOrigin: 'https://api.example.test', supabaseUrl: 'https://auth.example.test',
  supabaseKey: 'public-key', callbackUrl: 'talyn-mobile-development://auth/callback',
};

beforeEach(() => {
  mockSecure.clear(); mockPreferences.clear();
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { mockAppListener = listener; return { remove: mockRemoveApp }; });
});
afterEach(() => { jest.restoreAllMocks(); });

describe('mobile runtime binding', () => {
  it('creates Supabase only after secure storage works', async () => {
    jest.mocked(SecureStore.isAvailableAsync).mockResolvedValueOnce(false);
    await expect(createMobileRuntime(config)).rejects.toThrow(); expect(createClient).not.toHaveBeenCalled();
    expect(NetInfo.addEventListener).not.toHaveBeenCalled();
  });
  it('configures PKCE, secure persistence, and the native API', async () => {
    const runtime = await createMobileRuntime(config); await runtime.start();
    const options = jest.mocked(createClient).mock.calls[0][2]!;
    expect(options.auth).toMatchObject({ storageKey: 'session', flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(expect.any(String), expect.any(String), { keychainAccessible: 'unlocked-device-only' });
    const api = jest.mocked(configureApiClient).mock.calls.at(-1)![0];
    expect(api.baseUrl).toBe(config.apiOrigin); expect(await api.getAccessToken()).toBeNull();
    expect(api.runtime?.lifecycle).toBe(runtime.lifecycle);
    runtime.dispose(); expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockRemoveApp).toHaveBeenCalledTimes(1); expect(mockRemoveNet).toHaveBeenCalledTimes(1);
    expect(wsClient.reset).toHaveBeenCalled();
    const disposed = jest.mocked(configureApiClient).mock.calls.at(-1)![0];
    expect(await disposed.getAccessToken()).toBeNull(); expect(disposed.runtime?.lifecycle?.getSnapshot().activity).toBe('suspended');
  });
  it('starts refresh only while active and reachable, with no duplicate resume sequence', async () => {
    const restored = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer',
      user: { id: 'alice', aud: 'authenticated', created_at: '', app_metadata: {}, user_metadata: {} } };
    jest.mocked(mockAuth.getSession).mockResolvedValueOnce({ data: { session: restored }, error: null } as unknown as Awaited<ReturnType<typeof mockAuth.getSession>>);
    const runtime = await createMobileRuntime(config); await runtime.start();
    mockAuth.startAutoRefresh.mockClear(); mockAuth.stopAutoRefresh.mockClear();
    mockAppListener('background'); mockAppListener('background');
    await waitFor(() => expect(mockAuth.stopAutoRefresh).toHaveBeenCalledTimes(1));
    mockNetworkListener({ isConnected: false, isInternetReachable: false });
    mockAppListener('active'); expect(mockAuth.startAutoRefresh).not.toHaveBeenCalled();
    mockNetworkListener({ isConnected: true, isInternetReachable: true });
    mockNetworkListener({ isConnected: true, isInternetReachable: true });
    await waitFor(() => expect(mockAuth.startAutoRefresh).toHaveBeenCalledTimes(1)); runtime.dispose();
  });
  it('does not bind a runtime after setup was cancelled', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(createMobileRuntime(config, abort.signal)).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled(); expect(NetInfo.addEventListener).not.toHaveBeenCalled();
  });
  it('clears old secure data and workspace preferences when the environment changes', async () => {
    const runtime = await createMobileRuntime(config);
    const storage = jest.mocked(createClient).mock.calls[0][2]!.auth!.storage!;
    await storage.setItem('session', JSON.stringify({ user: { id: 'alice' }, refresh_token: 'secret' }));
    const previous = mockSecure.get('talyn-active-environment')!;
    const key = `talyn.workspace.${previous}.alice`; await AsyncStorage.setItem(key, 'one'); runtime.dispose();
    const next = await createMobileRuntime({ ...config, apiOrigin: 'https://preview.example.test' });
    expect([...mockSecure.keys()].some((item) => item.startsWith(`${previous}.`))).toBe(false);
    expect(mockPreferences.has(key)).toBe(false); expect(wsClient.reset).toHaveBeenCalled(); next.dispose();
  });
});
