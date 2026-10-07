import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import {
  DEVELOPER_ACTIVITY_CATEGORIES,
  FEATURE_FLAGS,
  type DebugCategory,
  type DeveloperActivity,
  type DeveloperActivityEvent,
} from '@talyn/shared';
import {
  developerRoutes,
  toBuckets,
  toUserDebugEvent,
  RATE_LIMIT_CACHE_MS,
  _resetDeveloperCaches,
} from '../../routes/developer.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { integrations as integrationsTable, workspaces as workspacesTable } from '../../db/schema.js';
import { debugBus } from '../../services/debugBus.js';
import { githubService } from '../../services/github.js';
import { githubRateGate } from '../../services/githubRateGate.js';
import { graphqlBudget } from '../../services/graphqlBudget.js';

const OTHER_USER_ID = 'user-other';

const ALL_CATEGORIES: DebugCategory[] = [
  'http',
  'db',
  'polling',
  'websocket',
  'event',
  'webhook',
  'error',
];

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/developer', requireAuth, developerRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const headersFor = (userId: string) => ({ ...internalProxyHeaders(userId) });

/** Record one event of every category for a workspace (or for the system). */
function recordEvery(tag: string, workspaceId?: string): void {
  for (const category of ALL_CATEGORIES) {
    const owner = workspaceId
      ? (debugBus as unknown as {
          resolveOwner: (id: string) => { ownerId: string | null; ownerLabel: string | null };
        }).resolveOwner(workspaceId)
      : { ownerId: null, ownerLabel: null };
    debugBus.record({
      category,
      service: `svc-${tag}`,
      action: 'x',
      ok: category !== 'error',
      summary: `${tag} ${category}`,
      ...owner,
    });
  }
}

describe('routes/developer', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  const originalEnv = { ...process.env };

  const get = async (path: string, userId: string | null = TEST_USER_ID) =>
    fetch(`${serverUrl}/api/v1/developer${path}`, {
      headers: userId ? headersFor(userId) : {},
    });

  const activity = async (query = '', userId: string = TEST_USER_ID): Promise<DeveloperActivity> => {
    const res = await get(`/activity${query}`, userId);
    expect(res.status).toBe(200);
    return (await res.json()).data as DeveloperActivity;
  };

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER_USER_ID });
    await db.insert(workspacesTable).values([
      { id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws1b', ownerId: TEST_USER_ID, name: 'mine too', settings: {} },
      { id: 'ws2', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
    ]);
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
    debugBus._reset();
    graphqlBudget._reset();
    githubRateGate._reset();
    _resetDeveloperCaches();
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
    debugBus._reset();
    debugBus.registerOwner('ws1', TEST_USER_ID, 'me@example.test');
    debugBus.registerOwner('ws1b', TEST_USER_ID, 'me@example.test');
    debugBus.registerOwner('ws2', OTHER_USER_ID, 'them@example.test');
  });

  afterEach(async () => {
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
    await closeServer();
    await cleanup();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    vi.useRealTimers();
    debugBus._reset();
  });

  describe('authentication', () => {
    it.each(['/activity', '/rate-limits?workspaceId=ws1', '/agents?workspaceId=ws1'])(
      'refuses an unauthenticated call to %s',
      async (path) => {
        const res = await get(path, null);
        expect(res.status).toBe(401);
      }
    );

    it.each(['/rate-limits', '/agents'])('400s %s without a workspaceId', async (path) => {
      const res = await get(path);
      expect(res.status).toBe(400);
    });

    it.each(['/rate-limits', '/agents'])(
      "404s %s for another user's workspace and calls nothing",
      async (path) => {
        const rate = vi.spyOn(githubService, 'getRateLimit');
        const res = await get(`${path}?workspaceId=ws2`);
        expect(res.status).toBe(404);
        expect(rate).not.toHaveBeenCalled();
      }
    );

    it.each(['/rate-limits', '/agents'])('404s %s for a workspace that does not exist', async (path) => {
      const res = await get(`${path}?workspaceId=nope`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /activity isolation', () => {
    beforeEach(() => {
      recordEvery('mine', 'ws1');
      recordEvery('mine-b', 'ws1b');
      recordEvery('theirs', 'ws2');
      recordEvery('system');
    });

    it("returns only the caller's events, from every workspace the caller owns", async () => {
      const data = await activity();
      const services = new Set(data.events.map((e) => e.service));
      expect(services).toEqual(new Set(['svc-mine', 'svc-mine-b']));
      expect(data.events).toHaveLength(2 * DEVELOPER_ACTIVITY_CATEGORIES.length);
    });

    it('gives the other user their events and none of ours', async () => {
      const data = await activity('', OTHER_USER_ID);
      expect(new Set(data.events.map((e) => e.service))).toEqual(new Set(['svc-theirs']));
    });

    it('never returns an event with no owner', async () => {
      const data = await activity();
      expect(data.events.some((e) => e.service === 'svc-system')).toBe(false);
    });

    it.each(ALL_CATEGORIES)('with no filter, category %s is returned only if allowlisted', async (category) => {
      const data = await activity();
      const present = data.events.some((e) => e.category === category);
      expect(present).toBe((DEVELOPER_ACTIVITY_CATEGORIES as readonly string[]).includes(category));
    });

    it.each(ALL_CATEGORIES)('?category=%s never returns a category outside the allowlist', async (category) => {
      const data = await activity(`?category=${category}`);
      const allowed = new Set<string>(DEVELOPER_ACTIVITY_CATEGORIES);
      expect(data.events.every((e) => allowed.has(e.category))).toBe(true);
      expect(data.events.every((e) => e.service.startsWith('svc-mine'))).toBe(true);
      if (category === 'error') {
        expect(data.events.length).toBeGreaterThan(0);
        expect(data.events.every((e) => !e.ok)).toBe(true);
      } else if (allowed.has(category)) {
        expect(data.events.length).toBeGreaterThan(0);
        expect(data.events.every((e) => e.category === category)).toBe(true);
      } else {
        // An unlisted value means "all of the allowlisted ones".
        expect(new Set(data.events.map((e) => e.category))).toEqual(allowed);
      }
    });

    it.each([
      `?owner=${OTHER_USER_ID}`,
      `?userId=${OTHER_USER_ID}`,
      `?ownerId=${OTHER_USER_ID}`,
      '?owner=all',
      '?owner=system',
      '?workspaceId=ws2',
    ])('ignores %s', async (query) => {
      const data = await activity(query);
      expect(data.events.length).toBeGreaterThan(0);
      expect(data.events.every((e) => e.service.startsWith('svc-mine'))).toBe(true);
    });

    it('never serializes owner fields', async () => {
      const res = await get('/activity');
      const text = await res.text();
      expect(text).not.toContain('ownerId');
      expect(text).not.toContain('ownerLabel');
      expect(text).not.toContain('example.test');
    });

    it('returns nothing for a user with no attributed workspace', async () => {
      await seedUser(db, { id: 'user-quiet' });
      const data = await activity('', 'user-quiet');
      expect(data.events).toEqual([]);
      expect(data.counts).toEqual({ total: 0, failed: 0, byService: {} });
    });
  });

  describe('GET /activity shape', () => {
    it('lists newest first and counts from the returned set', async () => {
      debugBus.recordHttp({ service: 'github', method: 'GET', url: 'https://api.github.com/a?x=1', status: 200, durationMs: 5, ok: true, workspaceId: 'ws1' });
      debugBus.recordHttp({ service: 'github', method: 'GET', url: 'https://api.github.com/b', status: 500, durationMs: 7, ok: false, error: new Error('boom'), workspaceId: 'ws1' });
      debugBus.recordEvent({ service: 'merge_queue', action: 'merged', summary: 'acme/w#1 merged', workspaceId: 'ws1' });
      const data = await activity();
      expect(data.events.map((e) => e.service)).toEqual(['merge_queue', 'github', 'github']);
      expect(data.counts).toEqual({ total: 3, failed: 1, byService: { merge_queue: 1, github: 2 } });
      expect(data.buffer.capacity).toBe(1000);
      expect(data.buffer.oldestAt).toBe(data.events[2]!.timestamp);
    });

    it('the error filter returns a failed request', async () => {
      debugBus.recordHttp({ service: 'github', method: 'GET', url: 'https://api.github.com/a', status: 200, durationMs: 5, ok: true, workspaceId: 'ws1' });
      debugBus.recordHttp({ service: 'github', method: 'GET', url: 'https://api.github.com/b', status: 500, durationMs: 7, ok: false, workspaceId: 'ws1' });
      const data = await activity('?category=error');
      expect(data.events).toHaveLength(1);
      expect(data.events[0]!.category).toBe('http');
      expect(data.events[0]!.ok).toBe(false);
    });

    it.each([
      ['', 200],
      ['?limit=3', 3],
      ['?limit=0', 200],
      ['?limit=-4', 200],
      ['?limit=abc', 200],
      ['?limit=2.9', 2],
      ['?limit=100000', 250],
    ])('limit %s returns %i of 250 events', async (query, expected) => {
      for (let i = 0; i < 250; i += 1) {
        debugBus.recordEvent({ service: 'tasks', action: 'n', summary: `e${i}`, workspaceId: 'ws1' });
      }
      const data = await activity(query);
      expect(data.events).toHaveLength(expected);
      expect(data.events[0]!.summary).toBe('e249');
      expect(data.counts.total).toBe(expected);
    });

    it('applies the limit after the owner filter', async () => {
      debugBus.recordEvent({ service: 'tasks', action: 'n', summary: 'mine', workspaceId: 'ws1' });
      for (let i = 0; i < 5; i += 1) {
        debugBus.recordEvent({ service: 'tasks', action: 'n', summary: 'theirs', workspaceId: 'ws2' });
      }
      const data = await activity('?limit=2');
      expect(data.events.map((e) => e.summary)).toEqual(['mine']);
    });
  });

  describe('toUserDebugEvent', () => {
    const base = {
      id: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      category: 'event' as const,
      service: 'github',
      action: 'a',
      ok: true,
      summary: 's',
    };

    it('drops owner fields and unknown top-level fields', () => {
      const out = toUserDebugEvent({
        ...base,
        ownerId: 'u',
        ownerLabel: 'u@example.test',
        ...({ secret: 'x' } as object),
      });
      expect(Object.keys(out).sort()).toEqual(
        ['action', 'category', 'id', 'ok', 'service', 'summary', 'timestamp'].sort()
      );
    });

    it.each([
      ['workspaceId', 'ws2'],
      ['accountKey', 'token:abc'],
      ['fingerprint', 'abcd'],
      ['replacedFingerprint', 'abcd'],
      ['login', 'octocat'],
      ['entryId', 'e1'],
      ['workflowId', 'w1'],
      ['runId', 'r1'],
      ['somethingNew', 'x'],
    ])('drops meta.%s', (key, value) => {
      const out = toUserDebugEvent({ ...base, meta: { [key]: value } });
      expect(out.meta).toBeUndefined();
    });

    it.each([
      ['status', 200],
      ['bytes', 12],
      ['error', 'boom'],
      ['actions', ['label:ok', 'comment:rate_gated']],
      ['problems', [{ owner: 'acme', state: 'not_installed' }]],
      ['headSha', 'abc123'],
    ])('keeps meta.%s', (key, value) => {
      const out = toUserDebugEvent({ ...base, meta: { [key]: value, workspaceId: 'ws1' } });
      expect(out.meta).toEqual({ [key]: value });
    });

    it('drops a nested object under an allowed key', () => {
      const out = toUserDebugEvent({
        ...base,
        meta: { reason: { deep: { token: 'x' } }, problems: [{ owner: 'a', nested: { token: 'x' } }] },
      });
      expect(out.meta).toEqual({ problems: [{ owner: 'a' }] });
    });

    it('keeps durationMs when present', () => {
      const out: DeveloperActivityEvent = toUserDebugEvent({ ...base, durationMs: 0 });
      expect(out.durationMs).toBe(0);
    });
  });

  describe('toBuckets', () => {
    const r = (n: number) => ({ limit: n, remaining: n - 1, used: 1, reset: 1_800_000_000 });

    it.each([
      [['graphql', 'core', 'search', 'code_search'], ['core', 'search', 'graphql', 'code_search']],
      [['search', 'core', 'graphql'], ['core', 'search', 'graphql']],
      [['code_search', 'scim', 'integration_manifest', 'core'], ['core', 'code_search']],
      [['scim'], []],
      [[], []],
    ])('maps %j to %j', (present, expected) => {
      const resources = Object.fromEntries(present.map((name, i) => [name, r(100 + i)]));
      expect(toBuckets({ resources }).map((b) => b.resource)).toEqual(expected);
    });

    it('converts the reset to ISO and carries the numbers', () => {
      expect(toBuckets({ resources: { core: { limit: 5000, remaining: 4000, used: 1000, reset: 1_800_000_000 } } })).toEqual([
        { resource: 'core', limit: 5000, remaining: 4000, used: 1000, resetAt: '2027-01-15T08:00:00.000Z' },
      ]);
    });

    it('survives a payload with no resources', () => {
      expect(toBuckets({} as never)).toEqual([]);
    });
  });

  describe('GET /rate-limits', () => {
    const payload = {
      resources: {
        graphql: { limit: 5000, remaining: 100, used: 4900, reset: 1_800_000_000 },
        core: { limit: 5000, remaining: 4999, used: 1, reset: 1_800_000_000 },
        search: { limit: 30, remaining: 30, used: 0, reset: 1_800_000_000 },
      },
    };

    it('returns connected=false with empty buckets and 200 when GitHub is not connected', async () => {
      const rate = vi.spyOn(githubService, 'getRateLimit');
      const res = await get('/rate-limits?workspaceId=ws1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({
        connected: false,
        login: null,
        scopes: [],
        github: [],
        graphqlBudget: null,
        secondaryGate: { restUntil: null, graphqlUntil: null },
        fetchedAt: null,
      });
      expect(rate).not.toHaveBeenCalled();
    });

    it('returns the buckets, scopes and no budget for a connected workspace', async () => {
      await githubService.storeToken('ws1', 'gho_test', 'bearer', 'repo read:user');
      vi.spyOn(githubService, 'getRateLimit').mockResolvedValue(payload);
      const res = await get('/rate-limits?workspaceId=ws1');
      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.connected).toBe(true);
      expect(data.scopes).toEqual(['repo', 'read:user']);
      expect(data.github.map((b: { resource: string }) => b.resource)).toEqual(['core', 'search', 'graphql']);
      expect(data.graphqlBudget).toBeNull();
      expect(data.secondaryGate).toEqual({ restUntil: null, graphqlUntil: null });
      expect(JSON.stringify(data)).not.toContain('gho_test');
    });

    it("returns only this workspace's GraphQL budget and gate, never another account's", async () => {
      await githubService.storeToken('ws1', 'gho_mine', 'bearer', 'repo');
      await githubService.storeToken('ws2', 'gho_theirs', 'bearer', 'repo');
      vi.spyOn(githubService, 'getRateLimit').mockResolvedValue(payload);
      const future = new Date(Date.now() + 30 * 60_000).toISOString();
      graphqlBudget.record(githubService.accountKeyFor('ws1'), { limit: 5000, remaining: 120, resetAt: future, cost: 3 });
      graphqlBudget.record(githubService.accountKeyFor('ws2'), { limit: 9999, remaining: 9000, resetAt: future, cost: 1 });
      const until = Date.now() + 60_000;
      githubRateGate.block(githubService.accountKeyFor('ws2'), until + 5_000, 'theirs');
      githubRateGate.block(githubService.accountKeyFor('ws1'), until, 'mine', 'graphql');

      const res = await get('/rate-limits?workspaceId=ws1');
      const text = await res.text();
      const { data } = JSON.parse(text);
      expect(data.graphqlBudget).toMatchObject({ limit: 5000, remaining: 120, lastCost: 3, deferring: true });
      expect(data.graphqlBudget).not.toHaveProperty('accountKey');
      expect(data.secondaryGate).toEqual({ restUntil: null, graphqlUntil: new Date(until).toISOString() });
      expect(text).not.toContain('9999');
      expect(text).not.toContain('token:');
    });

    it('reuses one GitHub answer for 10 seconds, per workspace', async () => {
      await githubService.storeToken('ws1', 'gho_a', 'bearer', 'repo');
      await githubService.storeToken('ws1b', 'gho_b', 'bearer', 'repo');
      const rate = vi.spyOn(githubService, 'getRateLimit').mockResolvedValue(payload);
      const now = vi.spyOn(Date, 'now');
      const t0 = 1_900_000_000_000;
      now.mockReturnValue(t0);
      await get('/rate-limits?workspaceId=ws1');
      await get('/rate-limits?workspaceId=ws1');
      expect(rate).toHaveBeenCalledTimes(1);
      await get('/rate-limits?workspaceId=ws1b');
      expect(rate).toHaveBeenCalledTimes(2);
      now.mockReturnValue(t0 + RATE_LIMIT_CACHE_MS - 1);
      await get('/rate-limits?workspaceId=ws1');
      expect(rate).toHaveBeenCalledTimes(2);
      now.mockReturnValue(t0 + RATE_LIMIT_CACHE_MS);
      const res = await get('/rate-limits?workspaceId=ws1');
      expect(rate).toHaveBeenCalledTimes(3);
      expect((await res.json()).data.fetchedAt).toBe(new Date(t0 + RATE_LIMIT_CACHE_MS).toISOString());
    });

    it('answers 502 with the message on a GitHub failure and does not cache it', async () => {
      await githubService.storeToken('ws1', 'gho_a', 'bearer', 'repo');
      const rate = vi
        .spyOn(githubService, 'getRateLimit')
        .mockRejectedValueOnce(new Error('GitHub is down'))
        .mockResolvedValue(payload);
      const failed = await get('/rate-limits?workspaceId=ws1');
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ success: false, error: 'GitHub is down' });
      const ok = await get('/rate-limits?workspaceId=ws1');
      expect(ok.status).toBe(200);
      expect(rate).toHaveBeenCalledTimes(2);
    });
  });

  describe('GET /agents', () => {
    const fleetEnv = FEATURE_FLAGS.fleet.envOverride!;

    async function connectFleet(workspaceId: string, config: Record<string, unknown>): Promise<void> {
      await db.insert(integrationsTable).values({
        id: `int-${workspaceId}`,
        workspaceId,
        type: 'selfhosted',
        enabled: true,
        config,
      });
    }

    const agents = async (workspaceId = 'ws1') => {
      const res = await get(`/agents?workspaceId=${workspaceId}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      return { text, agents: JSON.parse(text).data.agents };
    };

    it('returns an empty list when the workspace is outside the fleet audience', async () => {
      process.env[fleetEnv] = 'false';
      await connectFleet('ws1', { anthropicKeyEnc: { v: 1 } });
      expect((await agents()).agents).toEqual([]);
    });

    it('returns an empty list when nothing is connected', async () => {
      process.env[fleetEnv] = 'true';
      expect((await agents()).agents).toEqual([]);
    });

    it('reports ready, reauth and held agents, and no credential material', async () => {
      process.env[fleetEnv] = 'true';
      const at = new Date(Date.now() - 60_000).toISOString();
      // Sooner than Talyn's own re-probe, so the vendor's instant is the answer.
      const resetsAt = new Date(Date.now() + 2 * 60_000).toISOString();
      await connectFleet('ws1', {
        anthropicKeyEnc: { ciphertext: 'SECRET-CIPHERTEXT' },
        codexOAuth: { accessTokenEnc: { ciphertext: 'SECRET-CODEX' } },
        quotaExhausted: { codex: { at, resetsAt, detail: 'You have hit your usage limit.' } },
      });
      const out = await agents();
      expect(out.agents).toEqual([
        { agent: 'claude', state: 'ready' },
        {
          agent: 'codex',
          state: 'held',
          hold: { heldSince: at, retryAfter: resetsAt, detail: 'You have hit your usage limit.' },
        },
      ]);
      expect(out.text).not.toContain('SECRET');
      expect(out.text).not.toContain('Enc');
    });

    it('prefers reauth over a hold, and drops an expired hold', async () => {
      process.env[fleetEnv] = 'true';
      const longAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const recent = new Date(Date.now() - 60_000).toISOString();
      await connectFleet('ws1', {
        claudeOAuth: { reauthRequiredAt: recent },
        codexOAuth: {},
        quotaExhausted: { claude: { at: recent }, codex: { at: longAgo } },
      });
      expect((await agents()).agents).toEqual([
        { agent: 'claude', state: 'reauth' },
        { agent: 'codex', state: 'ready' },
      ]);
    });

    it('a hold with no vendor sentence has a null detail', async () => {
      process.env[fleetEnv] = 'true';
      const at = new Date(Date.now() - 60_000).toISOString();
      await connectFleet('ws1', { codexOAuth: {}, quotaExhausted: { codex: { at } } });
      const [agent] = (await agents()).agents;
      expect(agent.hold.detail).toBeNull();
      expect(new Date(agent.hold.retryAfter).getTime()).toBeGreaterThan(Date.now());
    });
  });
});
