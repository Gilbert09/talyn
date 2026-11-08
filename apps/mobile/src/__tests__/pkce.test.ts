import { createHash } from 'node:crypto';

import { createClient } from '@supabase/supabase-js';
import { waitFor } from '@testing-library/react-native';

import { AuthController } from '../auth/controller';
import { installAuthCrypto, type AuthCryptoHost } from '../auth/crypto';
import { SecureSessionStorage } from '../auth/storage';

jest.mock('expo-crypto', () => {
  const crypto = require('node:crypto');
  return {
    getRandomValues: (data: Uint32Array) => crypto.webcrypto.getRandomValues(data),
    digest: async (algorithm: string, data: BufferSource) => crypto.webcrypto.subtle.digest(algorithm, data),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  };
});

it('uses native secure randomness and S256 for a real Supabase PKCE exchange', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  installAuthCrypto();
  const values = new Map<string, string>(); let revision = 0;
  const storage = new SecureSessionStorage({
    getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value); },
    deleteItemAsync: async (key) => { values.delete(key); },
  }, 'integration', () => `revision-${++revision}`);
  await storage.checkAvailable();
  const fetcher = jest.fn(async () => new Response(JSON.stringify({
    access_token: 'access', refresh_token: 'refresh', token_type: 'bearer', expires_in: 3600,
    user: { id: 'alice', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '' },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const client = createClient('https://auth.example.test', 'public-key', {
    auth: { storage, storageKey: 'session', flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: fetcher },
  });
  let complete!: (value: { type: string; url: string }) => void;
  const browser = { open: jest.fn((_url: string, _callback: string) => new Promise<{ type: string; url: string }>((resolve) => { complete = resolve; })), dismiss: jest.fn() };
  const callback = 'talyn-mobile-development://auth/callback';
  const auth = new AuthController(client.auth, storage, browser, callback, async () => {});
  try {
    await auth.restore(); const login = auth.signIn();
    await waitFor(() => expect(browser.open).toHaveBeenCalledTimes(1));
    const url = new URL(browser.open.mock.calls[0][0]);
    const verifier = JSON.parse((await storage.getItem('session-code-verifier'))!) as string;
    expect(url.searchParams.get('redirect_to')).toBe(callback);
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
    complete({ type: 'success', url: `${callback}?code=one-code` }); await login;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(request[1].body as string)).toMatchObject({ auth_code: 'one-code', code_verifier: verifier });
    expect(auth.getSnapshot().status).toBe('signedIn');
    await auth.signOut(); expect(values.size).toBe(0);
  } finally {
    auth.dispose(); client.auth.stopAutoRefresh();
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

it('preserves an existing platform crypto implementation', () => {
  const getRandomValues = jest.fn(); const digest = jest.fn();
  const host = { crypto: { getRandomValues, subtle: { digest } } } as AuthCryptoHost;
  installAuthCrypto(host); expect(host.crypto?.getRandomValues).toBe(getRandomValues); expect(host.crypto?.subtle?.digest).toBe(digest);
});
