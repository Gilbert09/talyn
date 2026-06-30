import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { githubService } from '../services/github.js';
import { _resetInstallationTokenCache } from '../services/githubApp.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable, integrations as integrationsTable } from '../db/schema.js';

/**
 * Expiring user-token rotation. When the App has "Expire user authorization
 * tokens" on, the stored user token carries a refresh token + expiry; a call
 * made within the refresh window must rotate it (new access + refresh pair),
 * use the fresh token, and persist the rotation. A dead refresh token fails
 * closed (the user must reconnect).
 */

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

interface Captured {
  url: string;
  authorization: string | null;
}

function capturingFetch(captured: Captured[], routes: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers((init?.headers as HeadersInit) ?? {});
    captured.push({ url, authorization: headers.get('authorization') });
    for (const [pattern, payload] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        const status = (payload as { __status?: number }).__status ?? 200;
        return new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`no fetch mock for ${url}`);
  });
}

describe('github expiring user-token rotation', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.GITHUB_APP_ID = '777';
    process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(privateKey).toString('base64');
    process.env.GITHUB_APP_CLIENT_ID = 'Iv1.app';
    process.env.GITHUB_APP_CLIENT_SECRET = 'secret';

    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} });

    _resetInstallationTokenCache();
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
  });

  afterEach(async () => {
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
    await cleanup();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('rotates a near-expiry user token, uses the fresh one, and persists it', async () => {
    await githubService.storeToken('ws1', 'ghu_old', 'bearer', 'repo', {
      installationId: '555',
      refreshToken: 'ghr_old',
      accessTokenExpiresAt: Date.now() + 60_000, // 1 min → inside the 5 min skew
      refreshTokenExpiresAt: Date.now() + 15_897_600_000,
    });

    const captured: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      capturingFetch(captured, {
        'login/oauth/access_token': {
          access_token: 'ghu_rotated',
          token_type: 'bearer',
          scope: 'repo',
          expires_in: 28800,
          refresh_token: 'ghr_rotated',
          refresh_token_expires_in: 15897600,
        },
        '/user': { id: 1, login: 'octocat' },
      }),
    );

    const user = await githubService.getUser('ws1');
    expect(user.login).toBe('octocat');

    // The refresh endpoint was hit, and /user carried the rotated token.
    expect(captured.some((c) => c.url.includes('login/oauth/access_token'))).toBe(true);
    const userCall = captured.find((c) => c.url.endsWith('/user'));
    expect(userCall?.authorization).toBe('bearer ghu_rotated');

    // In-memory token is the rotated one.
    expect(githubService.getAccessToken('ws1')).toBe('ghu_rotated');

    // Persisted: the integration config's expiry is pushed ~8h out.
    const rows = await db
      .select({ config: integrationsTable.config })
      .from(integrationsTable)
      .where(and(eq(integrationsTable.workspaceId, 'ws1'), eq(integrationsTable.type, 'github')))
      .limit(1);
    const cfg = rows[0].config as { accessTokenExpiresAt?: string };
    expect(new Date(cfg.accessTokenExpiresAt!).getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  it('does not refresh a token that is still comfortably valid', async () => {
    await githubService.storeToken('ws1', 'ghu_fresh', 'bearer', 'repo', {
      installationId: '555',
      refreshToken: 'ghr_fresh',
      accessTokenExpiresAt: Date.now() + 60 * 60_000, // 1h out → no refresh
    });
    const captured: Captured[] = [];
    vi.stubGlobal('fetch', capturingFetch(captured, { '/user': { id: 1, login: 'octocat' } }));

    await githubService.getUser('ws1');
    expect(captured.some((c) => c.url.includes('login/oauth/access_token'))).toBe(false);
    expect(captured.find((c) => c.url.endsWith('/user'))?.authorization).toBe('bearer ghu_fresh');
  });

  it('fails closed when the refresh token is dead', async () => {
    await githubService.storeToken('ws1', 'ghu_old', 'bearer', 'repo', {
      installationId: '555',
      refreshToken: 'ghr_dead',
      accessTokenExpiresAt: Date.now() + 60_000,
    });
    vi.stubGlobal(
      'fetch',
      capturingFetch([], {
        'login/oauth/access_token': { error: 'bad_refresh_token', error_description: 'expired' },
      }),
    );
    // The user-token path can't produce a token → the call surfaces as not-connected.
    await expect(githubService.getUser('ws1')).rejects.toThrow();
  });

  it('leaves a non-expiring (classic OAuth) token untouched', async () => {
    await githubService.storeToken('ws1', 'gho_classic', 'bearer', 'repo'); // no expiry/refresh
    const captured: Captured[] = [];
    vi.stubGlobal('fetch', capturingFetch(captured, { '/user': { id: 1, login: 'octocat' } }));

    await githubService.getUser('ws1');
    expect(captured.some((c) => c.url.includes('login/oauth/access_token'))).toBe(false);
    expect(captured.find((c) => c.url.endsWith('/user'))?.authorization).toBe('bearer gho_classic');
  });
});
