import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import {
  signAppJwt,
  isGitHubAppConfigured,
  getAppPrivateKey,
  getInstallationToken,
  exchangeUserCode,
  buildInstallUrl,
  InstallationUnavailableError,
  _resetInstallationTokenCache,
} from '../services/githubApp.js';

/**
 * GitHub App auth: JWT signing (verified against the real public key), the
 * installation-token cache (mint / reuse / refresh / coalesce / suspension),
 * the install-redirect user-code exchange, and config gating. HTTP is mocked at
 * global.fetch (the layer fetchWithTimeout sits on).
 */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const ENV_KEYS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_SLUG',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function mockFetchOnce(body: unknown, init: { status?: number; ok?: boolean } = {}) {
  const status = init.status ?? 200;
  return {
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    ok: init.ok ?? (status >= 200 && status < 300),
    headers: new Headers(),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.GITHUB_APP_ID = '123456';
  process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(privateKey).toString('base64');
  process.env.GITHUB_APP_CLIENT_ID = 'Iv1.appclient';
  process.env.GITHUB_APP_CLIENT_SECRET = 'appsecret';
  process.env.GITHUB_APP_SLUG = 'fastowl-test';
  _resetInstallationTokenCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe('config + private key', () => {
  it('reports configured when app id + key are present', () => {
    expect(isGitHubAppConfigured()).toBe(true);
  });

  it('decodes a base64 PEM and accepts a raw PEM', () => {
    expect(getAppPrivateKey()).toContain('PRIVATE KEY');
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey; // raw PEM
    expect(getAppPrivateKey()).toContain('PRIVATE KEY');
  });

  it('is not configured when the key is missing', () => {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    expect(isGitHubAppConfigured()).toBe(false);
  });
});

describe('signAppJwt', () => {
  it('produces an RS256 JWT that verifies against the public key', () => {
    const now = 1_700_000_000;
    const jwt = signAppJwt(now);
    const [header, payload, signature] = jwt.split('.');
    expect(header && payload && signature).toBeTruthy();

    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString());
    expect(decodedHeader).toEqual({ alg: 'RS256', typ: 'JWT' });

    const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(decodedPayload.iss).toBe('123456');
    expect(decodedPayload.iat).toBe(now - 60);
    expect(decodedPayload.exp).toBe(now + 9 * 60);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    const sigBuf = Buffer.from(signature, 'base64url');
    expect(verifier.verify(publicKey, sigBuf)).toBe(true);
  });

  it('throws when the app is not configured', () => {
    delete process.env.GITHUB_APP_ID;
    expect(() => signAppJwt()).toThrow(/not configured/);
  });
});

describe('getInstallationToken', () => {
  it('mints, caches, and reuses a token within its validity window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchOnce({
        token: 'ghs_install_token',
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
    );

    const t1 = await getInstallationToken('999');
    const t2 = await getInstallationToken('999');
    expect(t1).toBe('ghs_install_token');
    expect(t2).toBe('ghs_install_token');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // cached on second call
  });

  it('refreshes when the cached token is within the expiry skew', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockFetchOnce({ token: 'first', expires_at: new Date(Date.now() + 60_000).toISOString() }),
      )
      .mockResolvedValueOnce(
        mockFetchOnce({
          token: 'second',
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        }),
      );

    const first = await getInstallationToken('999'); // expires in 60s → inside 5m skew
    const second = await getInstallationToken('999'); // must re-mint
    expect(first).toBe('first');
    expect(second).toBe('second');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent mints into a single HTTP call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchOnce({
        token: 'shared',
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      }),
    );
    const [a, b, c] = await Promise.all([
      getInstallationToken('42'),
      getInstallationToken('42'),
      getInstallationToken('42'),
    ]);
    expect([a, b, c]).toEqual(['shared', 'shared', 'shared']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws InstallationUnavailableError on 404 (suspended/removed)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockFetchOnce({}, { status: 404, ok: false }));
    await expect(getInstallationToken('404inst')).rejects.toBeInstanceOf(
      InstallationUnavailableError,
    );
  });
});

describe('exchangeUserCode', () => {
  it('returns the user-to-server token on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchOnce({ access_token: 'ghu_user', token_type: 'bearer', scope: 'repo' }),
    );
    const res = await exchangeUserCode('the-code');
    expect(res.access_token).toBe('ghu_user');
    expect(res.token_type).toBe('bearer');
  });

  it('throws when GitHub returns an OAuth error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      mockFetchOnce({ error: 'bad_verification_code', error_description: 'expired' }),
    );
    await expect(exchangeUserCode('stale')).rejects.toThrow(/expired/);
  });
});

describe('buildInstallUrl', () => {
  it('embeds the slug and url-encoded state', () => {
    const url = buildInstallUrl('ws-1:nonce');
    expect(url).toContain('/apps/fastowl-test/installations/new');
    expect(url).toContain('state=ws-1%3Anonce');
  });
});
