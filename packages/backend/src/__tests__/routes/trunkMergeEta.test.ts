import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { MergeEtaAnswer, TrunkIntegrationStatus } from '@talyn/shared';
import { trunkPullRequestRoutes, trunkRoutes } from '../../routes/trunk.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  integrations as integrationsTable,
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { resetFeatureFlagsForTests } from '../../services/featureFlags.js';
import { clearMergeEtaCache } from '../../services/trunk/mergeEta.js';
import { _resetExternalQueueState, noteIssueComment } from '../../services/externalQueueState.js';

/**
 * GET /pull-requests/:id/merge-eta and the Trunk token routes.
 *
 * What is pinned: the flag gates every route; no token and a PR Talyn already
 * knows is out of the queue cost no Trunk call; a minute of answers costs one
 * call; a 401 marks the token for reconnect and a later success clears it; the
 * token never comes back out of any route.
 */

const TOKEN = 'trunk-org-token-abc123';

const headers = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
  'x-talyn-client-version': '0.3.0-test',
};

const ETA = {
  status: 'available',
  computedAt: '2026-10-23T12:00:00.000Z',
  kind: 'merge',
  estimatedAt: '2026-10-23T12:20:00.000Z',
  estimatedAtState: 'on_track',
  confidence: 'high',
  pullRequestsAhead: 2,
  waitingForPullRequestNumbers: [],
  sampleSize: 40,
  startsTestingAt: '2026-10-23T12:05:00.000Z',
  startsTestingAtState: 'holding',
  testsFinishAt: '2026-10-23T12:15:00.000Z',
  testsFinishAtState: 'on_track',
  typicalTestDurationSeconds: 600,
};

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/pull-requests', requireAuth, wrapAsyncRoutes(trunkPullRequestRoutes()));
  app.use('/trunk', requireAuth, wrapAsyncRoutes(trunkRoutes()));
  app.use(apiErrorHandler);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((res) => {
        server.closeAllConnections();
        server.close(() => res());
      }),
  };
}

describe('Trunk merge ETAs', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let close: () => Promise<void>;
  let priorTokenKey: string | undefined;
  /** Every request the backend sent to Trunk. */
  let trunkCalls: Array<{ url: string; headers: Record<string, string>; body: unknown }>;
  /** What Trunk answers next. */
  let trunkAnswer: () => Response;
  const realFetch = globalThis.fetch;

  async function insertPr(over: Record<string, unknown> = {}): Promise<string> {
    const id = `pr-${Math.random().toString(36).slice(2, 9)}`;
    await db.insert(pullRequestsTable).values({
      id,
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      owner: 'PostHog',
      repo: 'posthog',
      number: Math.floor(Math.random() * 100000),
      state: 'open',
      lastPolledAt: new Date(),
      lastSummary: { baseBranch: 'master', labels: [] },
      ...over,
    });
    return id;
  }

  async function getEta(id: string): Promise<{ status: number; body: { data?: MergeEtaAnswer; code?: string } }> {
    const res = await realFetch(`${url}/pull-requests/${id}/merge-eta`, { headers });
    return { status: res.status, body: (await res.json()) as { data?: MergeEtaAnswer; code?: string } };
  }

  async function saveToken(token = TOKEN) {
    return realFetch(`${url}/trunk/token`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ workspaceId: 'ws1', token }),
    });
  }

  async function status(): Promise<TrunkIntegrationStatus> {
    const res = await realFetch(`${url}/trunk/status?workspaceId=ws1`, { headers });
    return ((await res.json()) as { data: TrunkIntegrationStatus }).data;
  }

  async function readConfig(): Promise<Record<string, unknown> | null> {
    const rows = await db
      .select({ config: integrationsTable.config })
      .from(integrationsTable)
      .where(and(eq(integrationsTable.workspaceId, 'ws1'), eq(integrationsTable.type, 'trunk')));
    return (rows[0]?.config as Record<string, unknown> | undefined) ?? null;
  }

  beforeEach(async () => {
    priorTokenKey = process.env.TALYN_TOKEN_KEY;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.TRUNK_MERGE_ETA_ENABLED = 'true';
    resetFeatureFlagsForTests();
    clearMergeEtaCache();
    _resetExternalQueueState();

    trunkCalls = [];
    trunkAnswer = () =>
      new Response(
        JSON.stringify({
          state: 'pending',
          stateChangedAt: '2026-10-23T11:58:00.000Z',
          isCurrentlySubmittedToQueue: true,
          estimatedTimeToMerge: ETA,
        }),
        { status: 200 }
      );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!target.startsWith('https://api.trunk.io/')) return realFetch(input, init);
      trunkCalls.push({
        url: target,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return trunkAnswer();
    });

    ({ db, cleanup } = await createTestDb());
    await seedUser(db);
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws1', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'repo1',
      workspaceId: 'ws1',
      name: 'PostHog/posthog',
      url: 'https://github.com/PostHog/posthog',
      defaultBranch: 'master',
    });
    ({ url, close } = await makeServer());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.TRUNK_MERGE_ETA_ENABLED;
    if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorTokenKey;
    resetFeatureFlagsForTests();
    await close();
    await cleanup();
  });

  describe('the flag', () => {
    it.each([
      ['GET merge-eta', async (id: string) => realFetch(`${url}/pull-requests/${id}/merge-eta`, { headers })],
      ['GET status', async () => realFetch(`${url}/trunk/status?workspaceId=ws1`, { headers })],
      ['PUT token', async () => saveToken()],
      [
        'DELETE token',
        async () => realFetch(`${url}/trunk/token?workspaceId=ws1`, { method: 'DELETE', headers }),
      ],
    ])('refuses %s when the flag is off', async (_name, call) => {
      const id = await insertPr();
      process.env.TRUNK_MERGE_ETA_ENABLED = 'false';
      resetFeatureFlagsForTests();
      const res = await call(id);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('trunk_merge_eta_unavailable');
      expect(trunkCalls).toHaveLength(0);
    });

    it('stays off with no PostHog and no override (the fallback is OFF)', async () => {
      delete process.env.TRUNK_MERGE_ETA_ENABLED;
      resetFeatureFlagsForTests();
      const { status: code } = await getEta(await insertPr());
      expect(code).toBe(403);
    });
  });

  describe('the token', () => {
    it('stores the token encrypted and never returns it', async () => {
      const res = await saveToken();
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(TOKEN);
      expect(JSON.parse(text).data).toMatchObject({ connected: true, needsReauth: false });

      const config = await readConfig();
      expect(JSON.stringify(config)).not.toContain(TOKEN);
      expect(config?.tokenEnc).toMatchObject({ v: 1 });

      const statusText = await (await realFetch(`${url}/trunk/status?workspaceId=ws1`, { headers })).text();
      expect(statusText).not.toContain(TOKEN);
    });

    it.each([
      ['empty', ''],
      ['blank', '   '],
      ['with a space inside', 'abc def'],
      ['with a newline', 'abc\ndef'],
      ['not a string', 42],
    ])('refuses a token that is %s', async (_name, token) => {
      const res = await realFetch(`${url}/trunk/token`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ workspaceId: 'ws1', token }),
      });
      expect(res.status).toBe(400);
      expect(await readConfig()).toBeNull();
    });

    it('trims the pasted token before storing it', async () => {
      await saveToken(`  ${TOKEN}\n`);
      await getEta(await insertPr());
      expect(trunkCalls[0].headers['x-api-token']).toBe(TOKEN);
    });

    it('removes the token', async () => {
      await saveToken();
      const res = await realFetch(`${url}/trunk/token?workspaceId=ws1`, { method: 'DELETE', headers });
      expect(res.status).toBe(200);
      expect(await readConfig()).toBeNull();
      expect(await status()).toEqual({ connected: false, needsReauth: false });
    });

    it('refuses a workspace the caller cannot access', async () => {
      const res = await realFetch(`${url}/trunk/status?workspaceId=someone-elses`, { headers });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /pull-requests/:id/merge-eta', () => {
    it('answers no_token without calling Trunk', async () => {
      const { status: code, body } = await getEta(await insertPr());
      expect(code).toBe(200);
      expect(body.data).toMatchObject({ eta: null, reason: 'no_token' });
      expect(trunkCalls).toHaveLength(0);
    });

    it('404s an unknown PR', async () => {
      await saveToken();
      expect((await getEta('missing')).status).toBe(404);
    });

    it('returns the parsed ETA and sends the spec’s request shape', async () => {
      await saveToken();
      const id = await insertPr({ number: 4242 });
      const { body } = await getEta(id);
      expect(body.data).toMatchObject({
        queueState: 'pending',
        stateChangedAt: '2026-10-23T11:58:00.000Z',
        eta: {
          estimatedAt: ETA.estimatedAt,
          startsTestingAt: ETA.startsTestingAt,
          testsFinishAt: ETA.testsFinishAt,
          pullRequestsAhead: 2,
          confidence: 'high',
          startsTestingAtState: 'holding',
        },
      });
      expect(body.data?.reason).toBeUndefined();
      expect(trunkCalls).toHaveLength(1);
      expect(trunkCalls[0].url).toBe('https://api.trunk.io/v1/getSubmittedPullRequest');
      expect(trunkCalls[0].headers['x-api-token']).toBe(TOKEN);
      expect(trunkCalls[0].body).toEqual({
        repo: { host: 'github.com', owner: 'PostHog', name: 'posthog' },
        pr: { number: 4242 },
        targetBranch: 'master',
        includeEstimatedTimeToMerge: true,
      });
    });

    it('asks Trunk about the stack’s base branch, not the rung below', async () => {
      await saveToken();
      const id = await insertPr({
        lastSummary: {
          baseBranch: 'feature-a',
          stack: { id: 's', number: 1, size: 2, position: 2, baseRefName: 'master' },
        },
      });
      await getEta(id);
      expect((trunkCalls[0].body as { targetBranch: string }).targetBranch).toBe('master');
    });

    it('serves a second ask within a minute from the cache', async () => {
      await saveToken();
      const id = await insertPr();
      const first = await getEta(id);
      const [second, third] = await Promise.all([getEta(id), getEta(id)]);
      expect(second.body.data).toEqual(first.body.data);
      expect(third.body.data).toEqual(first.body.data);
      expect(trunkCalls).toHaveLength(1);
    });

    it('asks again after a minute', async () => {
      await saveToken();
      const id = await insertPr();
      const realNow = Date.now();
      await getEta(id);
      vi.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
      await getEta(id);
      expect(trunkCalls).toHaveLength(2);
    });

    it('shares one Trunk call between concurrent asks', async () => {
      await saveToken();
      const id = await insertPr();
      await Promise.all([getEta(id), getEta(id), getEta(id)]);
      expect(trunkCalls).toHaveLength(1);
    });

    it('asks again with a new token rather than serving the old token’s answer', async () => {
      await saveToken();
      const id = await insertPr();
      await getEta(id);
      await saveToken('a-different-token');
      await getEta(id);
      expect(trunkCalls).toHaveLength(2);
      expect(trunkCalls[1].headers['x-api-token']).toBe('a-different-token');
    });

    it.each([
      ['a closed PR', { state: 'closed' }],
      ['a merged PR', { state: 'merged' }],
      ['a PR whose label says Trunk merged it', { lastSummary: { baseBranch: 'master', labels: ['trunk-merged'] } }],
      ['a PR whose label says Trunk failed it', { lastSummary: { baseBranch: 'master', labels: ['trunk-failed'] } }],
      ['a PR with no base branch', { lastSummary: {} }],
    ])('answers not_queued for %s without calling Trunk', async (_name, over) => {
      await saveToken();
      const { body } = await getEta(await insertPr(over));
      expect(body.data).toMatchObject({ eta: null, reason: 'not_queued' });
      expect(trunkCalls).toHaveLength(0);
    });

    it('answers not_queued from Trunk’s own comment without calling Trunk', async () => {
      await saveToken();
      const id = await insertPr({ number: 77 });
      noteIssueComment('PostHog', 'posthog', 77, {
        body: '😎 Merged successfully - [details](https://app.trunk.io/posthog/merge-queue/x/77)',
        user: { login: 'trunk-io[bot]' },
      });
      const { body } = await getEta(id);
      expect(body.data).toMatchObject({ eta: null, reason: 'not_queued' });
      expect(trunkCalls).toHaveLength(0);
    });

    it('still asks Trunk for a PR whose label says it is testing', async () => {
      await saveToken();
      await getEta(await insertPr({ lastSummary: { baseBranch: 'master', labels: ['trunk-testing'] } }));
      expect(trunkCalls).toHaveLength(1);
    });

    it.each([
      ['a 404', () => new Response('not found', { status: 404 }), 'not_queued'],
      [
        'a PR no longer submitted',
        () => new Response(JSON.stringify({ state: 'cancelled', isCurrentlySubmittedToQueue: false }), { status: 200 }),
        'not_queued',
      ],
      [
        'a merged PR',
        () => new Response(JSON.stringify({ state: 'merged', isCurrentlySubmittedToQueue: false }), { status: 200 }),
        'not_queued',
      ],
      [
        'no estimate block',
        () => new Response(JSON.stringify({ state: 'pending', isCurrentlySubmittedToQueue: true }), { status: 200 }),
        'no_estimate',
      ],
      [
        'an unavailable estimate',
        () =>
          new Response(
            JSON.stringify({
              state: 'not_ready',
              isCurrentlySubmittedToQueue: true,
              estimatedTimeToMerge: { status: 'unavailable' },
            }),
            { status: 200 }
          ),
        'no_estimate',
      ],
      ['a 500', () => new Response('boom', { status: 500 }), 'unavailable'],
      ['a body that is not JSON', () => new Response('<html>', { status: 200 }), 'unavailable'],
    ])('answers %s with eta null', async (_name, answerFn, reason) => {
      await saveToken();
      trunkAnswer = answerFn;
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { status: code, body } = await getEta(await insertPr());
      expect(code).toBe(200);
      expect(body.data).toMatchObject({ eta: null, reason });
    });

    it('answers a network failure as unavailable', async () => {
      await saveToken();
      trunkAnswer = () => {
        throw new TypeError('fetch failed');
      };
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { body } = await getEta(await insertPr());
      expect(body.data).toMatchObject({ eta: null, reason: 'unavailable' });
    });

    it.each([401, 403])('marks the token for reconnect on a %i, and a later success clears it', async (code) => {
      await saveToken();
      trunkAnswer = () => new Response('unauthorized', { status: code });
      const id = await insertPr();
      const { body } = await getEta(id);
      expect(body.data).toMatchObject({ eta: null, reason: 'reauth_required' });
      expect(await status()).toMatchObject({ connected: true, needsReauth: true });

      trunkAnswer = () =>
        new Response(
          JSON.stringify({ state: 'pending', isCurrentlySubmittedToQueue: true, estimatedTimeToMerge: ETA }),
          { status: 200 }
        );
      const other = await insertPr();
      const after = await getEta(other);
      expect(after.body.data?.eta).not.toBeNull();
      expect(await status()).toMatchObject({ connected: true, needsReauth: false });
    });

    it('clears the reconnect marker when a new token is saved', async () => {
      await saveToken();
      trunkAnswer = () => new Response('unauthorized', { status: 401 });
      await getEta(await insertPr());
      expect((await status()).needsReauth).toBe(true);
      await saveToken('a-new-token');
      expect((await status()).needsReauth).toBe(false);
    });
  });
});
