import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { fetchWithTimeout, githubService } from '../services/github.js';
import { githubRateGate } from '../services/githubRateGate.js';
import { githubTraffic } from '../services/githubHealth.js';
import { fetchUserInstallations } from '../services/githubApp.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

/**
 * The outage detector is fed inside `fetchWithTimeout`, the one transport
 * under `apiRequest`, `executeGraphql` and the App calls in githubApp.ts.
 * These tests go through the public callers, so a funnel that stops using
 * that transport fails here.
 */

type Reply = { status: number; headers?: Record<string, string>; body?: string } | Error;

function stubGithub(reply: Reply): ReturnType<typeof vi.fn> {
  const stub = vi.fn(async () => {
    if (reply instanceof Error) throw reply;
    return new Response(reply.status === 204 ? null : (reply.body ?? '{}'), {
      status: reply.status,
      headers: reply.headers,
    });
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

describe('GitHub request funnels feed the outage detector', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    githubRateGate._reset();
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
    await githubService.storeToken('ws1', 'gho_test', 'bearer', 'repo');
    githubTraffic._reset();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
    await cleanup();
    process.env = { ...originalEnv };
    githubRateGate._reset();
    githubTraffic._reset();
    vi.restoreAllMocks();
  });

  describe('apiRequest (REST)', () => {
    it.each([500, 502, 503, 504])('counts a %i as a server failure', async (status) => {
      stubGithub({ status, body: 'Internal Server Error' });
      await expect(githubService.getRateLimit('ws1')).rejects.toThrow();
      expect(githubTraffic.read().rest).toMatchObject({ requests: 1, serverFailures: 1 });
      expect(githubTraffic.read().graphql.requests).toBe(0);
    });

    it('counts a network error as a server failure', async () => {
      stubGithub(new Error('ECONNRESET'));
      await expect(githubService.getRateLimit('ws1')).rejects.toThrow('ECONNRESET');
      expect(githubTraffic.read().rest).toMatchObject({ requests: 1, serverFailures: 1 });
    });

    it('counts a 200 as a good call', async () => {
      stubGithub({ status: 200, body: '{"resources":{}}' });
      await githubService.getRateLimit('ws1');
      expect(githubTraffic.read().rest).toMatchObject({ requests: 1, serverFailures: 0 });
    });

    it.each([403, 404, 409, 422])('a %i is a call GitHub answered, not a failure', async (status) => {
      stubGithub({ status, body: '{"message":"no"}' });
      await expect(githubService.getRateLimit('ws1')).rejects.toThrow();
      expect(githubTraffic.read().rest).toMatchObject({ requests: 1, serverFailures: 0 });
    });

    it.each([
      ['429', { status: 429, headers: { 'retry-after': '1' } }],
      ['403 with retry-after', { status: 403, headers: { 'retry-after': '1' } }],
      ['403 with no budget left', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }],
      ['403 secondary limit', { status: 403, body: '{"message":"You have exceeded a secondary rate limit"}' }],
    ] as const)('a rate limit (%s) does not count', async (_name, reply) => {
      stubGithub(reply);
      await expect(githubService.getRateLimit('ws1')).rejects.toThrow();
      expect(githubTraffic.read().rest).toMatchObject({ requests: 1, serverFailures: 0 });
    });

    it('four 502s in a row read as down', async () => {
      stubGithub({ status: 502, body: 'Bad Gateway' });
      for (let i = 0; i < 4; i += 1) {
        await expect(githubService.getRateLimit('ws1')).rejects.toThrow();
      }
      expect(githubTraffic.read().rest.state).toBe('down');
      expect(githubTraffic.read().state).toBe('down');
    });
  });

  describe('executeGraphql', () => {
    // One query tries three times, so one failed query is three failures.
    it('counts every attempt of a 502 on the GraphQL window', async () => {
      const stub = stubGithub({ status: 502, body: 'Bad Gateway' });
      await expect(githubService.executeGraphql('ws1', '{ viewer { login } }')).rejects.toThrow();
      expect(stub).toHaveBeenCalledTimes(3);
      expect(githubTraffic.read().graphql).toMatchObject({ requests: 3, serverFailures: 3 });
      expect(githubTraffic.read().rest.requests).toBe(0);
      // Three failures are one unlucky query. Not an outage.
      expect(githubTraffic.read().state).toBe('unknown');
    }, 15_000);

    it('counts a 200 as a good call', async () => {
      stubGithub({ status: 200, body: '{"data":{"viewer":{"login":"me"}}}' });
      await githubService.executeGraphql('ws1', '{ viewer { login } }');
      expect(githubTraffic.read().graphql).toMatchObject({ requests: 1, serverFailures: 0 });
    });

    it('a GraphQL error in a 200 body is GitHub answering', async () => {
      stubGithub({ status: 200, body: '{"errors":[{"message":"Field does not exist"}]}' });
      await expect(githubService.executeGraphql('ws1', '{ nope }')).rejects.toThrow();
      expect(githubTraffic.read().graphql).toMatchObject({ requests: 1, serverFailures: 0 });
    });

    it('a secondary rate limit does not count', async () => {
      stubGithub({ status: 403, headers: { 'retry-after': '1' } });
      await expect(githubService.executeGraphql('ws1', '{ viewer { login } }')).rejects.toThrow();
      expect(githubTraffic.read().graphql).toMatchObject({ requests: 1, serverFailures: 0 });
    });

    it('a 404 does not count', async () => {
      stubGithub({ status: 404, body: '{"message":"Not Found"}' });
      await expect(githubService.executeGraphql('ws1', '{ viewer { login } }')).rejects.toThrow();
      expect(githubTraffic.read().graphql).toMatchObject({ requests: 1, serverFailures: 0 });
    });
  });

  describe('App calls in githubApp.ts', () => {
    it('counts a 503 on the REST window', async () => {
      stubGithub({ status: 503, body: 'Service Unavailable' });
      await fetchUserInstallations('ghu_test').catch(() => undefined);
      expect(githubTraffic.read().rest).toMatchObject({ requests: 1, serverFailures: 1 });
    });
  });

  describe('fetchWithTimeout', () => {
    it('counts its own timeout as a server failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('This operation was aborted', 'AbortError')),
              );
            }),
        ),
      );
      await expect(fetchWithTimeout('https://api.github.com/graphql', {}, 20)).rejects.toThrow(/timed out/);
      expect(githubTraffic.read().graphql).toMatchObject({ requests: 1, serverFailures: 1 });
    });
  });
});
