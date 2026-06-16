import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { githubService } from '../services/github.js';
import { _resetInstallationTokenCache } from '../services/githubApp.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

/**
 * Hybrid-auth routing: an App-connected workspace (one with an installationId)
 * must send a freshly-minted INSTALLATION token on data-plane reads, and the
 * USER token only on viewer-identity endpoints (`/user`). A legacy workspace
 * with no installationId keeps sending the stored token everywhere.
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

function capturingFetch(
  captured: Captured[],
  routes: Record<string, unknown>,
) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers((init?.headers as HeadersInit) ?? {});
    captured.push({ url, authorization: headers.get('authorization') });
    for (const [pattern, payload] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`no fetch mock for ${url}`);
  });
}

describe('github hybrid-auth routing', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.GITHUB_APP_ID = '777';
    process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(privateKey).toString('base64');

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

  it('uses the installation token for data-plane reads and the user token for /user', async () => {
    await githubService.storeToken('ws1', 'ghu_usertoken', 'bearer', 'repo', {
      installationId: '555',
    });

    const captured: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      capturingFetch(captured, {
        '/app/installations/555/access_tokens': {
          token: 'ghs_installtoken',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        '/repos/acme/widget/pulls/7': { number: 7, title: 'PR' },
        '/user': { id: 1, login: 'octocat' },
      }),
    );

    await githubService.getPullRequest('ws1', 'acme', 'widget', 7);
    await githubService.getUser('ws1');

    const prCall = captured.find((c) => c.url.includes('/repos/acme/widget/pulls/7'));
    const userCall = captured.find((c) => c.url.endsWith('/user'));
    expect(prCall?.authorization).toBe('token ghs_installtoken');
    expect(userCall?.authorization).toBe('bearer ghu_usertoken');
  });

  it('falls back to the stored token everywhere for a workspace without an installation', async () => {
    await githubService.storeToken('ws1', 'gho_legacy', 'bearer', 'repo');

    const captured: Captured[] = [];
    vi.stubGlobal(
      'fetch',
      capturingFetch(captured, { '/repos/acme/widget/pulls/7': { number: 7 } }),
    );

    await githubService.getPullRequest('ws1', 'acme', 'widget', 7);
    const prCall = captured.find((c) => c.url.includes('/pulls/7'));
    // No installation minting happened — the only call is the data-plane read,
    // authed with the stored OAuth token.
    expect(captured.some((c) => c.url.includes('/access_tokens'))).toBe(false);
    expect(prCall?.authorization).toBe('bearer gho_legacy');
  });
});
