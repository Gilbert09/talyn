import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { githubService } from '../services/github.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  integrations as integrationsTable,
} from '../db/schema.js';
import { isEncryptedEnvelope } from '../services/tokenCrypto.js';

/**
 * githubService talks to Supabase + github.com. We don't have either
 * in test, so we stub the global fetch and drive everything through
 * what it returns.
 */
type FetchInput = string | URL | Request;

function mockFetch(routes: Record<string, (req: RequestInit | undefined) => unknown>) {
  return vi.fn(async (input: FetchInput, init?: RequestInit) => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    for (const [pattern, handler] of Object.entries(routes)) {
      if (urlStr.includes(pattern)) {
        const body = handler(init);
        const status = typeof body === 'object' && body !== null && 'status' in body
          ? (body as { status?: number }).status ?? 200
          : 200;
        const payload = typeof body === 'object' && body !== null && 'payload' in body
          ? (body as { payload: unknown }).payload
          : body;
        return new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    throw new Error(`no fetch mock for ${urlStr}`);
  });
}

async function seedWorkspace(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await db.insert(workspacesTable).values({
    id: 'ws1',
    ownerId: TEST_USER_ID,
    name: 'mine',
    settings: {},
  });
}

describe('githubService', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    // Put the service in a known state: a 32-byte token key so
    // storeToken can encrypt, and known client id/secret so the
    // auth-URL + token-exchange URLs are deterministic.
    process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.GITHUB_CLIENT_ID = 'gh-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'gh-client-secret';

    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedWorkspace(db);

    // Reset the in-memory token cache between tests.
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

  describe('isConfigured', () => {
    it('returns a boolean (exact value depends on module-load env)', () => {
      // githubService captures GITHUB_CLIENT_ID + _SECRET at import
      // time, so the value depends on the env the test runner was
      // launched with. Just assert it's a boolean — meaningful
      // config-switching tests would need a fresh module import.
      expect(typeof githubService.isConfigured()).toBe('boolean');
    });
  });


  describe('storeToken + removeToken', () => {
    it('persists an encrypted envelope (not the plaintext access token)', async () => {
      await githubService.storeToken('ws1', 'gho_secret_1234', 'bearer', 'repo');

      const rows = await db
        .select({ config: integrationsTable.config })
        .from(integrationsTable)
        .where(eq(integrationsTable.workspaceId, 'ws1'));
      expect(rows).toHaveLength(1);
      const cfg = rows[0].config as Record<string, unknown>;
      expect(cfg.accessToken).toBeUndefined();
      expect(isEncryptedEnvelope(cfg.accessTokenEnc)).toBe(true);
      // Never serialise the raw string anywhere in the JSON.
      expect(JSON.stringify(cfg)).not.toContain('gho_secret_1234');
    });

    it('upserts over an existing row rather than duplicating', async () => {
      await githubService.storeToken('ws1', 'gho_v1', 'bearer', 'repo');
      await githubService.storeToken('ws1', 'gho_v2', 'bearer', 'repo');

      const rows = await db
        .select()
        .from(integrationsTable)
        .where(eq(integrationsTable.workspaceId, 'ws1'));
      expect(rows).toHaveLength(1);
    });

    it('flips isConnected after store and clears after remove', async () => {
      await githubService.storeToken('ws1', 'gho_test', 'bearer', 'repo');
      expect(githubService.isConnected('ws1')).toBe(true);
      expect(githubService.getConnectedWorkspaces()).toContain('ws1');

      await githubService.removeToken('ws1');
      expect(githubService.isConnected('ws1')).toBe(false);
    });

    it('emits a connected / disconnected event', async () => {
      const connected = vi.fn();
      const disconnected = vi.fn();
      githubService.on('connected', connected);
      githubService.on('disconnected', disconnected);

      try {
        await githubService.storeToken('ws1', 'gho_x', 'bearer', 'repo');
        await githubService.removeToken('ws1');

        expect(connected).toHaveBeenCalledWith('ws1');
        expect(disconnected).toHaveBeenCalledWith('ws1');
      } finally {
        githubService.off('connected', connected);
        githubService.off('disconnected', disconnected);
      }
    });
  });

  describe('getConnectionStatus', () => {
    it('returns connected=false when the workspace has no token', () => {
      expect(githubService.getConnectionStatus('ws1')).toEqual({ connected: false });
    });

    it('returns connected=true + parsed scopes after storeToken', async () => {
      await githubService.storeToken('ws1', 'gho', 'bearer', 'repo read:user');
      expect(githubService.getConnectionStatus('ws1')).toEqual({
        connected: true,
        scopes: ['repo', 'read:user'],
      });
    });
  });

  describe('apiRequest helpers', () => {
    beforeEach(async () => {
      await githubService.storeToken('ws1', 'gho_test', 'bearer', 'repo');
    });

    it('getUser hits /user with the bearer token', async () => {
      const fetchStub = mockFetch({
        '/user': () => ({ login: 'octocat', id: 1, name: 'Octo', avatar_url: 'x', email: null }),
      });
      vi.stubGlobal('fetch', fetchStub);

      const user = await githubService.getUser('ws1');
      expect(user.login).toBe('octocat');
      const [, init] = fetchStub.mock.calls[0];
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe('bearer gho_test');
      expect(headers['User-Agent']).toBe('FastOwl');
    });

    it('throws "GitHub not connected" when the workspace has no token', async () => {
      await githubService.removeToken('ws1');
      await expect(githubService.getUser('ws1')).rejects.toThrow(/not connected/);
    });

    it('clears the stored token on 401 only after check-token confirms it is dead (404)', async () => {
      // The budgeted call 401s; the app-authenticated check-token endpoint
      // returns 404, confirming the token really is revoked → it's removed.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: FetchInput) => {
          if (String(input).includes('/applications/')) {
            return new Response('', { status: 404, statusText: 'Not Found' });
          }
          return new Response('', { status: 401, statusText: 'Unauthorized' });
        })
      );
      await expect(githubService.getUser('ws1')).rejects.toThrow(/expired or revoked/);
      expect(githubService.isConnected('ws1')).toBe(false);
    });

    it('KEEPS the token on a phantom 401 when check-token says it is still valid', async () => {
      // The budgeted call 401s, but check-token (app-auth) returns 200 with the
      // token's metadata → a spurious 401. The token must survive.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: FetchInput) => {
          if (String(input).includes('/applications/')) {
            return new Response(
              JSON.stringify({
                created_at: '2026-06-12T09:16:38Z',
                expires_at: null,
                scopes: ['repo'],
                user: { login: 'octocat' },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response('', { status: 401, statusText: 'Unauthorized' });
        })
      );
      await expect(githubService.getUser('ws1')).rejects.toThrow(/expired or revoked/);
      // Still connected — the phantom 401 did not delete the working token.
      expect(githubService.isConnected('ws1')).toBe(true);
    });

    it('KEEPS the token when check-token itself errors (inconclusive)', async () => {
      // check-token returns a non-404 error (e.g. app-auth 401 / GitHub 500) →
      // we can't confirm the revocation, so the token is retained for re-check.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: FetchInput) => {
          if (String(input).includes('/applications/')) {
            return new Response('', { status: 500, statusText: 'Server Error' });
          }
          return new Response('', { status: 401, statusText: 'Unauthorized' });
        })
      );
      await expect(githubService.getUser('ws1')).rejects.toThrow(/expired or revoked/);
      expect(githubService.isConnected('ws1')).toBe(true);
    });

    it('surfaces GitHub\'s error message (not just "Forbidden") on a 403', async () => {
      const fetchStub = mockFetch({
        '/repos/acme/widgets/pulls/7/merge': () => ({
          status: 403,
          payload: { message: 'Resource not accessible by personal access token' },
        }),
      });
      vi.stubGlobal('fetch', fetchStub);

      await expect(
        githubService.mergePullRequest('ws1', 'acme', 'widgets', 7, { merge_method: 'squash' })
      ).rejects.toThrow(/403.*Resource not accessible by personal access token/);
    });

    it('appends sub-errors from the GitHub error body when present', async () => {
      const fetchStub = mockFetch({
        '/repos/acme/widgets/pulls/8/merge': () => ({
          status: 405,
          payload: {
            message: 'Pull Request is not mergeable',
            errors: [{ message: 'At least 1 approving review is required' }],
          },
        }),
      });
      vi.stubGlobal('fetch', fetchStub);

      await expect(
        githubService.mergePullRequest('ws1', 'acme', 'widgets', 8)
      ).rejects.toThrow(/not mergeable \(At least 1 approving review is required\)/);
    });

    it('falls back to the status line when the error body is not JSON', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('<html>nope</html>', { status: 403, statusText: 'Forbidden' }))
      );
      await expect(githubService.getUser('ws1')).rejects.toThrow(/GitHub API error 403 Forbidden/);
    });

    it('createPullRequest POSTs to /repos/:owner/:repo/pulls with body', async () => {
      const fetchStub = mockFetch({
        '/repos/acme/widgets/pulls': (init) => {
          expect((init as RequestInit).method).toBe('POST');
          return { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' };
        },
      });
      vi.stubGlobal('fetch', fetchStub);

      const pr = await githubService.createPullRequest('ws1', 'acme', 'widgets', {
        title: 'feat: test',
        head: 'fastowl/x',
        base: 'main',
        body: 'hello',
      });
      expect(pr.number).toBe(42);
      expect(pr.html_url).toBe('https://github.com/acme/widgets/pull/42');
    });

    it('listPullRequests builds query params (state + per_page) and hits the right URL', async () => {
      const fetchStub = mockFetch({
        '/repos/acme/widgets/pulls': () => [],
      });
      vi.stubGlobal('fetch', fetchStub);

      await githubService.listPullRequests('ws1', 'acme', 'widgets', {
        state: 'closed',
        per_page: 5,
      });
      const [url] = fetchStub.mock.calls[0];
      expect(String(url)).toContain('state=closed');
      expect(String(url)).toContain('per_page=5');
    });

    it('searchPullRequestNumbers paginates the search API and returns numbers', async () => {
      // Page 1 is a full page (100) so the loop continues; page 2 is
      // short (2) so it stops. Total = 102.
      const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
      const stub = vi.fn(async (input: FetchInput) => {
        const url = String(input);
        const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? '1');
        const items = page === 1 ? page1 : [{ number: 101 }, { number: 102 }];
        return new Response(JSON.stringify({ total_count: 102, items }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', stub);

      const numbers = await githubService.searchPullRequestNumbers(
        'ws1',
        'repo:acme/widgets is:pr is:open author:me'
      );
      expect(numbers).toHaveLength(102);
      expect(numbers[0]).toBe(1);
      expect(numbers[101]).toBe(102);
      expect(String(stub.mock.calls[0][0])).toContain('/search/issues?q=');
    });

    it('aborts a hung request after the timeout instead of hanging forever', async () => {
      vi.useFakeTimers();
      try {
        // fetch never resolves on its own — it only settles when the
        // AbortController fires, mimicking a stalled socket.
        const stub = vi.fn((_input: FetchInput, init?: RequestInit) => {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            );
          });
        });
        vi.stubGlobal('fetch', stub);

        const p = githubService.getUser('ws1');
        p.catch(() => {}); // avoid an unhandled rejection while time advances
        await vi.advanceTimersByTimeAsync(30_000);
        await expect(p).rejects.toThrow(/timed out after 30000ms/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('executeGraphql retries when a request throws (network error) before succeeding', async () => {
      let calls = 0;
      const stub = vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error('socket hang up');
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', stub);

      const data = await githubService.executeGraphql<{ ok: boolean }>('ws1', 'query{}');
      expect(data.ok).toBe(true);
      expect(calls).toBe(2);
    });

    it('executeGraphql retries a 504 and succeeds on the next attempt', async () => {
      let calls = 0;
      const stub = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return new Response('', { status: 504, statusText: 'Gateway Timeout' });
        }
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', stub);

      const data = await githubService.executeGraphql<{ ok: boolean }>('ws1', 'query{}');
      expect(data.ok).toBe(true);
      expect(calls).toBe(2);
    });

    it('getCheckRuns hits /repos/:owner/:repo/commits/:ref/check-runs', async () => {
      const fetchStub = mockFetch({
        'commits/abc123/check-runs': () => ({ check_runs: [] }),
      });
      vi.stubGlobal('fetch', fetchStub);

      await githubService.getCheckRuns('ws1', 'acme', 'widgets', 'abc123');
      expect(fetchStub).toHaveBeenCalled();
    });
  });

  describe('loadStoredTokens (init reload)', () => {
    it('hydrates the in-memory cache from integrations rows on init', async () => {
      // Seed a row directly, then init().
      await githubService.storeToken('ws1', 'gho_preexisting', 'bearer', 'repo');
      // init() is idempotent — calling it again forces a DB reload and
      // re-hydrates the in-memory cache from persisted integrations rows.
      await githubService.init();
      expect(githubService.isConnected('ws1')).toBe(true);
    });

    it('ignores rows that fail to decrypt (wrong key) without crashing init', async () => {
      // Insert a row with a garbage envelope directly.
      await db.insert(integrationsTable).values({
        id: 'int-broken',
        workspaceId: 'ws1',
        type: 'github',
        enabled: true,
        config: {
          accessTokenEnc: { v: 1, iv: 'Zm9v', ct: 'Zm9v', tag: 'Zm9v' }, // garbage
          tokenType: 'bearer',
          scope: 'repo',
          createdAt: new Date().toISOString(),
        },
      });
      await expect(githubService.init()).resolves.toBeUndefined();
      // No token gets cached for ws1 because decrypt failed.
      expect(githubService.isConnected('ws1')).toBe(false);
    });
  });
});
