import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { githubService } from '../services/github.js';
import { githubRateGate } from '../services/githubRateGate.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';

/**
 * The Search API is GitHub's tightest budget (30/min) and the endpoint most
 * prone to *secondary* rate limits — concurrent searches for one user were the
 * main trigger for the 403s. githubService serializes searches per account, so
 * even fired concurrently they never overlap on the wire. This proves that
 * guarantee by counting how many search fetches are in flight at once.
 */

type FetchInput = string | URL | Request;

describe('searchPullRequestNumbers serialization', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({
      id: 'ws1',
      ownerId: TEST_USER_ID,
      name: 'mine',
      settings: {},
    });
    githubRateGate._reset();
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

  it('never runs two searches concurrently for one account', async () => {
    await githubService.storeToken('ws1', 'gho_test', 'bearer', 'repo');

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchStub = vi.fn(async (input: FetchInput) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      if (!urlStr.includes('/search/issues')) {
        throw new Error(`unexpected fetch: ${urlStr}`);
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Hold the request open briefly so a concurrent search would overlap.
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return new Response(JSON.stringify({ total_count: 0, items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchStub);

    // Fire three searches concurrently — the same fan-out the PR monitor does
    // per repo. The serializer must run them one at a time.
    await Promise.all([
      githubService.searchPullRequestNumbers('ws1', 'repo:a/b is:pr is:open author:me'),
      githubService.searchPullRequestNumbers('ws1', 'repo:a/b is:pr is:open review-requested:me'),
      githubService.searchPullRequestNumbers('ws1', 'repo:a/b is:pr is:open reviewed-by:me'),
    ]);

    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });
});
