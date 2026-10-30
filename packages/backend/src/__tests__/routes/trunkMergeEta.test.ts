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
import { encryptString } from '../../services/tokenCrypto.js';

/**
 * GET /pull-requests/:id/merge-eta and the Trunk token routes.
 *
 * What is pinned: the flag gates every route; no token and a PR Talyn already
 * knows is out of the queue cost no Trunk call; a minute of answers costs one
 * round of v2 reads; a 401 marks the key for reconnect and a later success
 * clears it; a stored v1 token is never sent; the key never comes back out of
 * any route.
 */

const TOKEN = 'trunk_v2_abc123';

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
  estimatedAtState: 'onTrack',
  confidence: 'high',
  pullRequestsAhead: 2,
  waitingForPullRequestNumbers: [],
  sampleSize: 40,
  startsTestingAt: '2026-10-23T12:05:00.000Z',
  startsTestingAtState: 'holding',
  testsFinishAt: '2026-10-23T12:15:00.000Z',
  testsFinishAtState: 'onTrack',
  typicalTestDurationSeconds: 600,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const trunkError = (status: number, code: string) =>
  json({ error: { code, message: code } }, status);

function prRecord(number: number, queueEntry: Record<string, unknown> | null = {}) {
  return {
    id: `trunk-pr-${number}`,
    repositoryId: 'trunk-repo',
    number,
    isCurrentlySubmittedToQueue: queueEntry !== null,
    ...(queueEntry === null
      ? {}
      : { queueEntry: { id: 'entry', state: 'pending', stateChangedAt: '2026-10-23T11:58:00.000Z', ...queueEntry } }),
  };
}

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
  let trunkCalls: Array<{ url: URL; headers: Record<string, string> }>;
  /** What Trunk answers next, per endpoint. */
  let repositoryAnswer: () => Response;
  let pullRequestAnswer: (number: number) => Response;
  let estimateAnswer: () => Response;

  const callsTo = (kind: 'repositories' | 'lookup' | 'estimate') =>
    trunkCalls.filter(({ url: u }) =>
      kind === 'repositories'
        ? u.pathname === '/v2/repositories'
        : kind === 'lookup'
          ? u.pathname === '/v2/pull-requests'
          : u.pathname.endsWith('/queue-entry-estimate')
    );

  function answerEverything(fn: () => Response) {
    repositoryAnswer = fn;
    pullRequestAnswer = fn;
    estimateAnswer = fn;
  }
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
    repositoryAnswer = () => json({ data: [{ id: 'trunk-repo', path: 'PostHog/posthog' }] });
    pullRequestAnswer = (number) => json({ data: [prRecord(number)] });
    estimateAnswer = () => json(ETA);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!target.startsWith('https://api.trunk.io/')) return realFetch(input, init);
      const u = new URL(target);
      trunkCalls.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
      if (u.pathname === '/v2/repositories') return repositoryAnswer();
      if (u.pathname === '/v2/pull-requests') return pullRequestAnswer(Number(u.searchParams.get('number')));
      if (u.pathname.endsWith('/queue-entry-estimate')) return estimateAnswer();
      return new Response('unexpected', { status: 500 });
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
      ['a v1 organization token', 'trunk-org-token-abc123'],
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
      expect(trunkCalls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
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

    it('reports a stored v1 token as needing a reconnect, and never sends it', async () => {
      const now = new Date();
      await db.insert(integrationsTable).values({
        id: 'trunk-v1',
        workspaceId: 'ws1',
        type: 'trunk',
        enabled: true,
        config: { tokenEnc: encryptString('trunk-org-token-abc123'), connectedAt: now.toISOString() },
        createdAt: now,
        updatedAt: now,
      });
      expect(await status()).toMatchObject({
        connected: true,
        needsReauth: true,
        reauthReason: expect.stringContaining('v1'),
      });
      const { body } = await getEta(await insertPr());
      expect(body.data).toMatchObject({ eta: null, reason: 'reauth_required' });
      expect(trunkCalls).toHaveLength(0);

      await saveToken();
      expect((await status()).needsReauth).toBe(false);
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

    it('returns the parsed ETA and sends the v2 reads', async () => {
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
          estimatedAtState: 'on_track',
          startsTestingAtState: 'holding',
        },
      });
      expect(body.data?.reason).toBeUndefined();
      expect(trunkCalls.map((c) => c.url.href)).toEqual([
        'https://api.trunk.io/v2/repositories?providerUrl=https%3A%2F%2Fgithub.com%2FPostHog%2Fposthog',
        'https://api.trunk.io/v2/pull-requests?repositoryId=trunk-repo&number=4242',
        'https://api.trunk.io/v2/pull-requests/trunk-pr-4242/queue-entry-estimate',
      ]);
      for (const call of trunkCalls) {
        expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
        expect(call.headers['x-api-token']).toBeUndefined();
      }
    });

    it('resolves the repository once, not once per PR', async () => {
      await saveToken();
      await getEta(await insertPr());
      await getEta(await insertPr());
      expect(callsTo('repositories')).toHaveLength(1);
      expect(callsTo('lookup')).toHaveLength(2);
    });

    it('serves a second ask within a minute from the cache', async () => {
      await saveToken();
      const id = await insertPr();
      const first = await getEta(id);
      const [second, third] = await Promise.all([getEta(id), getEta(id)]);
      expect(second.body.data).toEqual(first.body.data);
      expect(third.body.data).toEqual(first.body.data);
      expect(callsTo('lookup')).toHaveLength(1);
      expect(callsTo('estimate')).toHaveLength(1);
    });

    it('asks again after a minute', async () => {
      await saveToken();
      const id = await insertPr();
      const realNow = Date.now();
      await getEta(id);
      vi.spyOn(Date, 'now').mockReturnValue(realNow + 61_000);
      await getEta(id);
      expect(callsTo('lookup')).toHaveLength(2);
      expect(callsTo('repositories')).toHaveLength(1);
    });

    it('shares one Trunk call between concurrent asks', async () => {
      await saveToken();
      const id = await insertPr();
      await Promise.all([getEta(id), getEta(id), getEta(id)]);
      expect(callsTo('lookup')).toHaveLength(1);
    });

    it('asks again with a new token rather than serving the old token’s answer', async () => {
      await saveToken();
      const id = await insertPr();
      await getEta(id);
      await saveToken('trunk_v2_different');
      await getEta(id);
      expect(callsTo('lookup')).toHaveLength(2);
      expect(callsTo('lookup')[1].headers.authorization).toBe('Bearer trunk_v2_different');
      expect(callsTo('repositories')).toHaveLength(2);
    });

    it.each([
      ['a closed PR', { state: 'closed' }],
      ['a merged PR', { state: 'merged' }],
      ['a PR whose label says Trunk merged it', { lastSummary: { baseBranch: 'master', labels: ['trunk-merged'] } }],
      ['a PR whose label says Trunk failed it', { lastSummary: { baseBranch: 'master', labels: ['trunk-failed'] } }],
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
      expect(callsTo('estimate')).toHaveLength(1);
    });

    it.each([
      [
        'a repository Trunk does not know',
        () => (repositoryAnswer = () => trunkError(404, 'PROVIDER_URL_NOT_FOUND')),
        'not_queued',
      ],
      ['a PR Trunk has not indexed', () => (pullRequestAnswer = () => json({ data: [] })), 'not_queued'],
      [
        'a PR never submitted',
        () => (pullRequestAnswer = (n) => json({ data: [prRecord(n, null)] })),
        'not_queued',
      ],
      [
        'a cancelled entry',
        () => (pullRequestAnswer = (n) => json({ data: [{ ...prRecord(n, { state: 'cancelled' }), isCurrentlySubmittedToQueue: false }] })),
        'not_queued',
      ],
      [
        'a merged entry',
        () => (pullRequestAnswer = (n) => json({ data: [prRecord(n, { state: 'merged' })] })),
        'not_queued',
      ],
      [
        'a queue that serves no estimates',
        () => (estimateAnswer = () => trunkError(404, 'ESTIMATE_NOT_ENABLED')),
        'no_estimate',
      ],
      [
        'an entry that concluded between the reads',
        () => (estimateAnswer = () => trunkError(409, 'PR_NOT_IN_ACTIVE_STATE')),
        'not_queued',
      ],
      [
        'an unavailable estimate',
        () => (estimateAnswer = () => json({ status: 'unavailable', computedAt: ETA.computedAt, reason: 'notInQueue' })),
        'no_estimate',
      ],
      ['a 429', () => (estimateAnswer = () => new Response('slow down', { status: 429 })), 'unavailable'],
      ['a 500', () => answerEverything(() => new Response('boom', { status: 500 })), 'unavailable'],
      ['a body that is not JSON', () => (pullRequestAnswer = () => new Response('<html>', { status: 200 })), 'unavailable'],
    ])('answers %s with eta null', async (_name, arrange, reason) => {
      await saveToken();
      arrange();
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { status: code, body } = await getEta(await insertPr());
      expect(code).toBe(200);
      expect(body.data).toMatchObject({ eta: null, reason });
    });

    it('does not ask for an estimate for a PR that is out of the queue', async () => {
      await saveToken();
      pullRequestAnswer = (n) => json({ data: [prRecord(n, null)] });
      await getEta(await insertPr());
      expect(callsTo('estimate')).toHaveLength(0);
    });

    it('answers a network failure as unavailable', async () => {
      await saveToken();
      answerEverything(() => {
        throw new TypeError('fetch failed');
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { body } = await getEta(await insertPr());
      expect(body.data).toMatchObject({ eta: null, reason: 'unavailable' });
    });

    it.each([401, 403])('marks the token for reconnect on a %i, and a later success clears it', async (code) => {
      await saveToken();
      answerEverything(() => new Response('unauthorized', { status: code }));
      const id = await insertPr();
      const { body } = await getEta(id);
      expect(body.data).toMatchObject({ eta: null, reason: 'reauth_required' });
      expect(await status()).toMatchObject({ connected: true, needsReauth: true });

      repositoryAnswer = () => json({ data: [{ id: 'trunk-repo' }] });
      pullRequestAnswer = (n) => json({ data: [prRecord(n)] });
      estimateAnswer = () => json(ETA);
      const other = await insertPr();
      const after = await getEta(other);
      expect(after.body.data?.eta).not.toBeNull();
      expect(await status()).toMatchObject({ connected: true, needsReauth: false });
    });

    it('clears the reconnect marker when a new token is saved', async () => {
      await saveToken();
      answerEverything(() => new Response('unauthorized', { status: 401 }));
      await getEta(await insertPr());
      expect((await status()).needsReauth).toBe(true);
      await saveToken('trunk_v2_new');
      expect((await status()).needsReauth).toBe(false);
    });
  });
});
