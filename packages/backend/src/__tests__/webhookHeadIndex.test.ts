import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
} from '../db/schema.js';

/**
 * The head-SHA index lets the receiver drop CI checks for commits that are not
 * any tracked open PR's head. These exercise the real reseed SQL (the
 * `last_summary ->> 'headSha'` projection) against pglite, plus the
 * drop/fail-open decision and the brand-new-PR `recent` escape hatch — over an
 * in-memory fake Redis (no redis-mock infra exists in this repo).
 */

// Minimal ioredis stand-in with real SET semantics for the ops we use. `eval`
// reproduces LOOKUP_LUA over the same backing store.
const { fakeRedis } = vi.hoisted(() => {
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, string>();
  const exists = (k: string) => (sets.has(k) || strings.has(k) ? 1 : 0);
  const sismember = (k: string, m: string) => (sets.get(k)?.has(m) ? 1 : 0);
  const addAll = (k: string, members: string[]) => {
    let s = sets.get(k);
    if (!s) {
      s = new Set();
      sets.set(k, s);
    }
    for (const m of members) s.add(m);
  };
  const redis = {
    async sadd(k: string, ...members: string[]) {
      addAll(k, members);
      return members.length;
    },
    async expire() {
      return 1;
    },
    async eval(_s: string, _n: number, ready: string, main: string, recent: string, sha: string) {
      if (!exists(ready)) return -1;
      if (sismember(main, sha)) return 1;
      if (sismember(recent, sha)) return 1;
      return 0;
    },
    multi() {
      const ops: Array<() => void> = [];
      const chain = {
        del: (k: string) => {
          ops.push(() => {
            sets.delete(k);
            strings.delete(k);
          });
          return chain;
        },
        sadd: (k: string, ...m: string[]) => {
          ops.push(() => addAll(k, m));
          return chain;
        },
        expire: () => {
          ops.push(() => undefined);
          return chain;
        },
        set: (k: string, v: string) => {
          ops.push(() => strings.set(k, v));
          return chain;
        },
        async exec() {
          for (const op of ops) op();
          return [];
        },
      };
      return chain;
    },
    _reset() {
      sets.clear();
      strings.clear();
    },
  };
  return { fakeRedis: redis };
});

vi.mock('../services/redis.js', () => ({
  isRedisEnabled: () => true,
  getRedis: () => fakeRedis,
  createRedisConnection: () => null,
  redisUrl: () => 'redis://fake',
  closeRedis: async () => undefined,
}));

const { shouldDropByHeadSha, noteHeadSha, reseedHeadShas } = await import(
  '../services/webhookHeadIndex.js'
);
const { refreshWebhookIndex, _resetWebhookIndex } = await import('../services/webhookIndex.js');

describe('webhookHeadIndex', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'wsA', ownerId: TEST_USER_ID, name: 'A', settings: {} });
    await db.insert(repositoriesTable).values([
      { id: 'rW', workspaceId: 'wsA', name: 'acme/widget', url: 'https://github.com/acme/widget', defaultBranch: 'main', createdAt: new Date() },
      // A watched repo with ZERO open PRs — must still become authoritative.
      { id: 'rE', workspaceId: 'wsA', name: 'acme/empty', url: 'https://github.com/acme/empty', defaultBranch: 'main', createdAt: new Date() },
    ]);
    // One open PR on `sha-keep`, plus a CLOSED PR whose head must NOT be tracked.
    await db.insert(pullRequestsTable).values([
      { id: 'pr-open', workspaceId: 'wsA', repositoryId: 'rW', owner: 'acme', repo: 'widget', number: 7, state: 'open', lastSummary: { headSha: 'sha-keep' } },
      { id: 'pr-closed', workspaceId: 'wsA', repositoryId: 'rW', owner: 'acme', repo: 'widget', number: 6, state: 'closed', lastSummary: { headSha: 'sha-closed' } },
    ]);
    _resetWebhookIndex();
    await refreshWebhookIndex();
    fakeRedis._reset();
  });

  afterEach(async () => {
    _resetWebhookIndex();
    fakeRedis._reset();
    await cleanup();
  });

  it('after reseed: forwards a tracked open-PR head, drops everything else', async () => {
    const { repos, heads } = await reseedHeadShas();
    expect(heads).toBe(1); // only the open PR's head
    expect(repos).toBeGreaterThanOrEqual(2); // widget + empty (both watched)

    expect(await shouldDropByHeadSha('acme/widget', 'sha-keep')).toBe(false); // tracked → keep
    expect(await shouldDropByHeadSha('acme/widget', 'sha-keep'.toUpperCase())).toBe(false); // case-insensitive
    expect(await shouldDropByHeadSha('acme/widget', 'sha-merge-commit')).toBe(true); // absent → drop
    expect(await shouldDropByHeadSha('acme/widget', 'sha-closed')).toBe(true); // closed PR's head → drop
  });

  it('drops ALL checks for a watched repo with zero open PRs', async () => {
    await reseedHeadShas();
    expect(await shouldDropByHeadSha('acme/empty', 'anything')).toBe(true);
  });

  it('fails OPEN for an unseeded repo, a missing head, or no reseed yet', async () => {
    // No reseed has run → nothing is authoritative.
    expect(await shouldDropByHeadSha('acme/widget', 'sha-keep')).toBe(false);
    await reseedHeadShas();
    // Seeded repo, but no head sha on the payload.
    expect(await shouldDropByHeadSha('acme/widget', undefined)).toBe(false);
    // A repo we don't watch at all.
    expect(await shouldDropByHeadSha('acme/unknown', 'x')).toBe(false);
  });

  it('noteHeadSha closes the brand-new-PR race before the next reseed', async () => {
    await reseedHeadShas();
    // A just-opened PR's head the reseed hasn't folded in yet would be dropped…
    expect(await shouldDropByHeadSha('acme/widget', 'sha-fresh')).toBe(true);
    // …until the receiver notes it off the live pull_request event.
    await noteHeadSha('acme/widget', 'sha-fresh');
    expect(await shouldDropByHeadSha('acme/widget', 'sha-fresh')).toBe(false);
  });
});
