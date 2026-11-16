import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Workbench, WorkflowAction } from '@talyn/shared';
import { POSTHOG_INBOX_READY_EVENT, validateWorkflow } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  inboundConnections,
  inboundDeliveries,
  integrations,
  posthogInboxPollers,
  repositories,
  workflowRuns,
  workspaces,
} from '../db/schema.js';
import type { CreateWorkbenchServiceInput } from '../services/workbenches/create.js';
import { FakePostHog as SharedFakePostHog, type FakeReport } from './helpers/fakePostHogInbox.js';

/**
 * The PostHog Inbox push end to end: PostHog's webhook destination posts
 * `$signals_report_ready` to the workspace's URL, the receiver checks the URL
 * token and the optional secret, and processing reads the report from a fake
 * PostHog by id. Covers the refusals, the flag, unknown and malformed reports,
 * duplicates, the dedupe between a push and a poll, rotation, and the
 * poller's switch to a 30-minute reconcile and back. The session create is
 * stubbed.
 */

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
  broadcastToUser: () => undefined,
}));

const created: Array<{ input: CreateWorkbenchServiceInput }> = [];
vi.mock('../services/workbenches/create.js', () => ({
  createWorkbench: async (input: CreateWorkbenchServiceInput) => {
    created.push({ input });
    const { insertWorkbench, rowToWorkbench } = await import('../services/workbenches/store.js');
    const id = `wb-${created.length}`;
    const row = await insertWorkbench({
      id,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      repoFullName: 'acme/web-app',
      name: id,
      branch: id,
      baseBranch: 'main',
      runtime: 'sandbox',
      agent: input.agent,
      model: input.model ?? null,
      status: 'provisioning',
      source: input.source ?? null,
    });
    return rowToWorkbench(row) as Workbench;
  },
}));

const { encryptString } = await import('../services/tokenCrypto.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { resetWebAppUrlCacheForTests } = await import('../services/webApp.js');
const { _resetWorkflowStore, createWorkflow } = await import('../services/workflows/store.js');
const { mountInboundWebhooks } = await import('../services/inbound/receiver.js');
const { processInboundDelivery } = await import('../services/inbound/process.js');
const store = await import('../services/inbound/store.js');
const { posthogInboxPoller, recordPostHogInboxPush, POSTHOG_INBOX_POLL_INTERVAL_MS, POSTHOG_INBOX_RECONCILE_INTERVAL_MS } =
  await import('../services/posthogInbox/poller.js');
const { posthogInboxStatus } = await import('../services/posthogInbox/preview.js');
const { debugBus } = await import('../services/debugBus.js');
const { _resetClaimGatesForTests } = await import('../services/posthogInbox/claims.js');

const MODEL = 'claude-sonnet-4-5';
const HOST = 'https://us.posthog.com';
const realFetch = globalThis.fetch;

const R1 = '0194f0c2-7d1e-7c55-9e41-000000000001';
const R2 = '0194f0c2-7d1e-7c55-9e41-000000000002';
const UNKNOWN = '0194f0c2-7d1e-7c55-9e41-00000000dead';

/**
 * PostHog's signals reports API for project 2, with the claim route
 * (`helpers/fakePostHogInbox.ts`). Pushes carry a newer `updated_at` by
 * default, and `reads` counts single-report reads.
 */
class FakePostHog extends SharedFakePostHog {
  override put(id: string, overrides: Partial<FakeReport> = {}): FakeReport {
    return super.put(id, {
      updated_at: new Date(Date.now() + 60_000).toISOString().replace('Z', '123+00:00'),
      ...overrides,
    });
  }

  reads(id: string): number {
    return this.requests.filter((r) => r === `/api/projects/2/signals/reports/${id}/`).length;
  }
}

/** PostHog's default webhook body for one report-ready event. */
function pushBody(reportId: string, over: { uuid?: string | null; updatedAt?: string; properties?: Record<string, unknown> } = {}) {
  return JSON.stringify({
    event: {
      ...(over.uuid === null ? {} : { uuid: over.uuid ?? `evt-${reportId.slice(-4)}-${Math.random().toString(36).slice(2, 8)}` }),
      event: POSTHOG_INBOX_READY_EVENT,
      elements_chain: '',
      distinct_id: 'random-distinct-id',
      properties: {
        report_id: reportId,
        report_url: `${HOST}/project/2/inbox/${reportId}`,
        priority: 'P0',
        actionability: 'immediately_actionable',
        source_products: ['error_tracking'],
        source_products_text: 'error_tracking',
        updated_at: over.updatedAt ?? '2026-11-16T12:00:00.000000+00:00',
        ...over.properties,
      },
      timestamp: new Date().toISOString(),
      captured_at: null,
      url: '',
    },
    person: null,
  });
}

describe('PostHog Inbox push', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let posthog: FakePostHog;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('POSTHOG_INBOX_RULES_ENABLED', 'true');
    vi.stubEnv('WEB_APP_URL', 'https://app.talyn.test');
    resetFeatureFlagsForTests();
    resetWebAppUrlCacheForTests();
    _resetWorkflowStore();
    _resetClaimGatesForTests();
    created.length = 0;

    posthog = new FakePostHog();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin === HOST) return posthog.handle(url, init);
      return realFetch(input, init);
    });

    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'u1', email: 'owner@example.test' });
    await testDb.db.insert(workspaces).values({ id: 'ws1', ownerId: 'u1', name: 'One' });
    await testDb.db
      .insert(repositories)
      .values({ id: 'r-web', workspaceId: 'ws1', name: 'acme/web-app', url: 'https://github.com/acme/web-app' });
    await connectPostHog('2');

    const app = express();
    mountInboundWebhooks(app);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/webhooks/in`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    _resetWorkflowStore();
    resetFeatureFlagsForTests();
    await testDb?.cleanup();
  });

  async function connectPostHog(projectId: string): Promise<void> {
    await testDb.db.delete(integrations).where(eq(integrations.workspaceId, 'ws1'));
    await testDb.db.insert(integrations).values({
      id: 'int-1',
      workspaceId: 'ws1',
      type: 'posthog',
      enabled: true,
      config: { apiKeyEnc: encryptString('phx_test'), projectId, host: HOST, authMethod: 'personal_api_key' },
    });
  }

  async function rule() {
    const action: WorkflowAction = { type: 'start_session', repositoryId: null, prompt: 'Fix the report.', model: MODEL };
    return createWorkflow(
      'ws1',
      validateWorkflow({ integration: 'posthog_inbox', name: 'Fix ready reports', events: ['report_ready'], actions: [action] })
    );
  }

  async function makeUrl(requireSecret = true) {
    return store.rotatePostHogInboxPushConnection('ws1', '2', { requireSecret, createdBy: 'u1' });
  }

  async function send(path: string, body: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /** Send with the URL's own token and secret. */
  async function push(url: Awaited<ReturnType<typeof makeUrl>>, body: string) {
    return send(`${url.connectionId}/${url.token}`, body, url.secret ? { 'x-talyn-secret': url.secret } : {});
  }

  /** Store a delivery as the receiver would, without processing it. */
  async function storeOnly(connectionId: string, body: string): Promise<string> {
    const { id } = await store.insertDelivery({
      connectionId,
      deliveryId: `evt-${Math.random().toString(36).slice(2)}`,
      eventType: POSTHOG_INBOX_READY_EVENT,
      payload: JSON.parse(body) as unknown,
      headers: {},
      payloadBytes: body.length,
    });
    return id;
  }

  async function settled(id: string) {
    for (let i = 0; i < 300; i++) {
      const [row] = await testDb.db.select().from(inboundDeliveries).where(eq(inboundDeliveries.id, id));
      if (row?.processedAt) return row;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`delivery ${id} was not processed`);
  }

  const deliveries = () => testDb.db.select().from(inboundDeliveries).orderBy(inboundDeliveries.receivedAt);
  const runs = () => testDb.db.select().from(workflowRuns).orderBy(workflowRuns.createdAt);
  const poller = async () => (await testDb.db.select().from(posthogInboxPollers).where(eq(posthogInboxPollers.integrationId, 'int-1')))[0];

  // ---- Verification -----------------------------------------------------------

  describe('verification', () => {
    it.each<[string, (u: Awaited<ReturnType<typeof makeUrl>>) => { path: string; headers: Record<string, string> }, number]>([
      ['no token in the URL', (u) => ({ path: u.connectionId, headers: { 'x-talyn-secret': u.secret ?? '' } }), 401],
      ['a wrong token', (u) => ({ path: `${u.connectionId}/wrong-token`, headers: { 'x-talyn-secret': u.secret ?? '' } }), 401],
      ['the right token and no secret', (u) => ({ path: `${u.connectionId}/${u.token}`, headers: {} }), 401],
      ['the right token and a wrong secret', (u) => ({ path: `${u.connectionId}/${u.token}`, headers: { 'x-talyn-secret': 'whsec_wrong' } }), 401],
      ['the right token and the secret as a bearer token', (u) => ({ path: `${u.connectionId}/${u.token}`, headers: { authorization: `Bearer ${u.secret}` } }), 401],
      ['an unknown connection id', (u) => ({ path: `00000000-0000-0000-0000-000000000000/${u.token}`, headers: { 'x-talyn-secret': u.secret ?? '' } }), 404],
      ['a connection id that is not a uuid', (u) => ({ path: `int-1/${u.token}`, headers: { 'x-talyn-secret': u.secret ?? '' } }), 404],
      ['the right token and secret', (u) => ({ path: `${u.connectionId}/${u.token}`, headers: { 'x-talyn-secret': u.secret ?? '' } }), 200],
    ])('%s', async (_name, request, expected) => {
      const url = await makeUrl(true);
      posthog.put(R1);
      const { path, headers } = request(url);
      const res = await send(path, pushBody(R1), headers);
      expect(res.status).toBe(expected);
      expect(await deliveries()).toHaveLength(expected === 200 ? 1 : 0);
      if (expected !== 200) expect(posthog.requests).toEqual([]);
    });

    it('takes the token alone when the URL was made without a secret', async () => {
      const url = await makeUrl(false);
      expect(url.secret).toBeNull();
      posthog.put(R1);
      expect((await send(`${url.connectionId}/${url.token}`, pushBody(R1))).status).toBe(200);
      expect((await send(`${url.connectionId}/wrong`, pushBody(R1))).status).toBe(401);
    });

    it('refuses every request when the stored secret no longer decrypts', async () => {
      const url = await makeUrl(true);
      vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
      const res = await push(url, pushBody(R1));
      expect(res.status).toBe(401);
      expect(await deliveries()).toHaveLength(0);
    });

    it('answers 404 and stores nothing when the flag is off for the owner', async () => {
      const url = await makeUrl(true);
      vi.stubEnv('POSTHOG_INBOX_RULES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await push(url, pushBody(R1));
      expect(res.status).toBe(404);
      expect(await deliveries()).toHaveLength(0);
    });

    it('stops the old URL and secret at once after a rotate, and keeps the connection id', async () => {
      const first = await makeUrl(true);
      const second = await makeUrl(true);
      expect(second.connectionId).toBe(first.connectionId);
      expect(second.created).toBe(false);
      expect(second.token).not.toBe(first.token);
      expect((await send(`${first.connectionId}/${first.token}`, pushBody(R1), { 'x-talyn-secret': first.secret ?? '' })).status).toBe(401);
      expect((await send(`${second.connectionId}/${second.token}`, pushBody(R1), { 'x-talyn-secret': first.secret ?? '' })).status).toBe(401);
      expect((await push(second, pushBody(R1))).status).toBe(200);
    });

    it('stores only the hash of the token and the secret encrypted', async () => {
      const url = await makeUrl(true);
      const [row] = await testDb.db.select().from(inboundConnections).where(eq(inboundConnections.id, url.connectionId));
      expect(row).toMatchObject({ kind: 'posthog_inbox', externalAccountId: '2', ruleId: null });
      expect(JSON.stringify(row)).not.toContain(url.token);
      expect(JSON.stringify(row)).not.toContain(url.secret);
      expect(row.secretEnc).not.toBeNull();
    });

    it('deletes the URL of another project when it makes one for the current project', async () => {
      const old = await makeUrl(true);
      await connectPostHog('3');
      const next = await store.rotatePostHogInboxPushConnection('ws1', '3', { requireSecret: true, createdBy: 'u1' });
      expect(next.connectionId).not.toBe(old.connectionId);
      expect((await push(old, pushBody(R1))).status).toBe(404);
      const rows = await testDb.db.select().from(inboundConnections).where(eq(inboundConnections.workspaceId, 'ws1'));
      expect(rows.map((r) => r.externalAccountId)).toEqual(['3']);
    });
  });

  // ---- Processing ---------------------------------------------------------------

  describe('processing', () => {
    it('reads the report by id and starts a session, using nothing else from the push', async () => {
      await rule();
      const report = posthog.put(R1, { priority: 'P3', updated_at: '2026-11-16T13:00:00.654321+00:00' });
      const url = await makeUrl(true);
      const res = await push(url, pushBody(R1, { updatedAt: '2020-01-01T00:00:00+00:00', properties: { priority: 'P0', report_url: 'https://evil.test' } }));
      expect(res.status).toBe(200);
      const row = await settled(String(res.json.id));
      expect(row).toMatchObject({ outcome: 'handled', error: null, eventType: POSTHOG_INBOX_READY_EVENT });
      expect(posthog.reads(R1)).toBe(1);
      expect(created).toHaveLength(1);
      expect(created[0].input.prompt).not.toContain('evil.test');
      const [run] = await runs();
      // The run key is the version PostHog served, not the one the push named.
      expect(run.deliveryId).toBe(`posthog_inbox:${R1}:${report.updated_at}`);
      expect(run.facts).toMatchObject({ priority: 'P3' });
      expect((await poller())?.lastPushAt?.getTime()).toBe(row.receivedAt.getTime());
    });

    it('drops a report id the project does not have, answers 200 and logs it', async () => {
      await rule();
      const url = await makeUrl(true);
      const events: string[] = [];
      const spy = vi.spyOn(debugBus, 'recordEvent').mockImplementation((e) => {
        events.push(String(e.action));
      });
      const res = await push(url, pushBody(UNKNOWN));
      expect(res.status).toBe(200);
      const row = await settled(String(res.json.id));
      expect(row.outcome).toBe('ignored');
      expect(row.error).toMatch(/PostHog project 2 has no report .*dead\. Talyn dropped the request/);
      expect(events).toContain('posthog_inbox_unknown_report');
      expect(await runs()).toHaveLength(0);
      expect(created).toHaveLength(0);
      expect(await poller()).toBeUndefined();
      spy.mockRestore();
    });

    it.each<[string, string, RegExp]>([
      ['a body that is not JSON', 'report ready', /not a JSON object/],
      ['an empty object', '{}', /no report_id/],
      ['another event', JSON.stringify({ event: { event: '$pageview', properties: { report_id: R1 } } }), /\$pageview/],
      ['a report id with a path in it', pushBody('../../users'), /not a PostHog report id/],
      ['an array', JSON.stringify([R1]), /not a JSON object/],
    ])('stores %s, reads nothing from PostHog and ignores it', async (_name, body, reason) => {
      await rule();
      const url = await makeUrl(true);
      const res = await push(url, body);
      expect(res.status).toBe(200);
      const row = await settled(String(res.json.id));
      expect(row.outcome).toBe('ignored');
      expect(row.error).toMatch(reason);
      expect(posthog.requests).toEqual([]);
      expect(await runs()).toHaveLength(0);
    });

    it('stores a PostHog retry of one event once', async () => {
      await rule();
      posthog.put(R1);
      const url = await makeUrl(true);
      const body = pushBody(R1, { uuid: 'evt-same' });
      const first = await push(url, body);
      const second = await push(url, body);
      expect(second.json).toMatchObject({ duplicate: true, id: first.json.id });
      await settled(String(first.json.id));
      const rows = await deliveries();
      expect(rows).toHaveLength(1);
      expect(rows[0].deliveryId).toBe('evt-same');
      expect(posthog.reads(R1)).toBe(1);
      expect(await runs()).toHaveLength(1);
    });

    it('uses the report version as the delivery id when the body has no event uuid', async () => {
      await rule();
      posthog.put(R1);
      const url = await makeUrl(true);
      const body = pushBody(R1, { uuid: null, updatedAt: '2026-11-16T12:00:00.000001+00:00' });
      const first = await push(url, body);
      await settled(String(first.json.id));
      expect((await push(url, body)).json).toMatchObject({ duplicate: true });
      expect((await deliveries())[0].deliveryId).toBe(`posthog_inbox:${R1}:2026-11-16T12:00:00.000001+00:00`);
    });

    it('runs a rule once when two events name one report version', async () => {
      await rule();
      posthog.put(R1);
      const url = await makeUrl(true);
      const a = await push(url, pushBody(R1, { uuid: 'evt-a' }));
      await settled(String(a.json.id));
      const b = await push(url, pushBody(R1, { uuid: 'evt-b' }));
      const row = await settled(String(b.json.id));
      expect(row.outcome).toBe('ignored');
      expect(posthog.reads(R1)).toBe(2);
      expect(await runs()).toHaveLength(1);
      expect(created).toHaveLength(1);
    });

    it('drops a push for the old project after the connection moved to another one', async () => {
      await rule();
      posthog.put(R1);
      const url = await makeUrl(true);
      await connectPostHog('3');
      const res = await push(url, pushBody(R1));
      const row = await settled(String(res.json.id));
      expect(row.outcome).toBe('ignored');
      expect(row.error).toMatch(/for PostHog project 2, but the PostHog connection now reads project 3/);
      expect(posthog.requests).toEqual([]);
    });

    it('does nothing when the flag is turned off after the request was stored', async () => {
      await rule();
      posthog.put(R1);
      const url = await makeUrl(true);
      const stored = await storeOnly(url.connectionId, pushBody(R1));
      vi.stubEnv('POSTHOG_INBOX_RULES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      expect(await processInboundDelivery(stored)).toBe('ignored');
      const row = await settled(stored);
      expect(row).toMatchObject({ outcome: 'ignored', error: 'PostHog Inbox automations are off for this workspace.' });
      expect(posthog.requests).toEqual([]);
    });

    it('fails without a retry when PostHog refuses the credentials', async () => {
      await rule();
      posthog.put(R1);
      posthog.status = 403;
      const url = await makeUrl(true);
      const res = await push(url, pushBody(R1));
      const row = await settled(String(res.json.id));
      expect(row).toMatchObject({ outcome: 'failed', attempts: 1 });
      expect(row.error).toMatch(/Connect PostHog again/);
    });

    it('fails when the workspace has no PostHog connection any more', async () => {
      await rule();
      const url = await makeUrl(true);
      await testDb.db.delete(integrations).where(eq(integrations.workspaceId, 'ws1'));
      const res = await push(url, pushBody(R1));
      const row = await settled(String(res.json.id));
      expect(row.outcome).toBe('failed');
      expect(row.error).toMatch(/cannot read this workspace's PostHog Inbox/);
    });

    it('releases the delivery for a retry when PostHog is down', async () => {
      await rule();
      posthog.put(R1);
      posthog.status = 503;
      const url = await makeUrl(true);
      const stored = await storeOnly(url.connectionId, pushBody(R1));
      expect(await processInboundDelivery(stored)).toBe('failed');
      const [row] = await deliveries();
      expect(row).toMatchObject({ processedAt: null, claimedAt: null, attempts: 1 });
      expect(row.error).toBeTruthy();

      posthog.status = 200;
      expect(await processInboundDelivery(stored)).toBe('handled');
      expect(await runs()).toHaveLength(1);
    });

    it('a replay reads the report again but does not count as a push', async () => {
      await rule();
      posthog.put(R1);
      const url = await makeUrl(true);
      const res = await push(url, pushBody(R1));
      await settled(String(res.json.id));
      await testDb.db.update(posthogInboxPollers).set({ lastPushAt: null });
      const replayed = await store.replayDelivery(url.connectionId, String(res.json.id));
      expect(await processInboundDelivery(replayed!.id)).toBe('ignored');
      expect(posthog.reads(R1)).toBe(2);
      expect(await runs()).toHaveLength(1);
      expect((await poller())?.lastPushAt).toBeNull();
    });
  });

  // ---- Push and poll -------------------------------------------------------------

  describe('push and poll', () => {
    /** Run one poller tick at a time after `now`, and return the next poll time. */
    async function tick(at: Date) {
      await posthogInboxPoller.tick(at);
      return (await poller())!;
    }

    it('a poll after a push of the same version does not run the rule again', async () => {
      await rule();
      const t0 = new Date();
      await tick(t0); // The first poll sets the cursor.
      posthog.put(R1, { updated_at: new Date(t0.getTime() + 1000).toISOString() });
      const url = await makeUrl(true);
      const res = await push(url, pushBody(R1));
      await settled(String(res.json.id));
      expect(await runs()).toHaveLength(1);

      await testDb.db.update(posthogInboxPollers).set({ nextPollAt: t0 });
      await tick(new Date(t0.getTime() + 60_000));
      // The push's run claimed R1 in PostHog, and the poll lists only
      // unclaimed reports, so the poll does not even read it again.
      expect(posthog.activeClaim(R1)?.holder).toBe('talyn');
      expect(posthog.reads(R1)).toBe(1);
      expect(await runs()).toHaveLength(1);
      expect(created).toHaveLength(1);
    });

    it('a push after a poll of the same version does not run the rule again', async () => {
      await rule();
      const t0 = new Date();
      await tick(t0);
      posthog.put(R1, { updated_at: new Date(t0.getTime() + 1000).toISOString() });
      await testDb.db.update(posthogInboxPollers).set({ nextPollAt: t0 });
      await tick(new Date(t0.getTime() + 60_000));
      expect(await runs()).toHaveLength(1);

      const url = await makeUrl(true);
      const res = await push(url, pushBody(R1));
      const row = await settled(String(res.json.id));
      expect(row.outcome).toBe('ignored');
      expect(await runs()).toHaveLength(1);
      expect(created).toHaveLength(1);
    });

    it('a changed report version from a push runs the rule again', async () => {
      await rule();
      posthog.put(R1, { updated_at: '2026-11-16T12:00:00.000001+00:00' });
      const url = await makeUrl(true);
      await settled(String((await push(url, pushBody(R1))).json.id));
      posthog.put(R2, { updated_at: '2026-11-16T12:00:00.000002+00:00' });
      await settled(String((await push(url, pushBody(R2))).json.id));
      expect((await runs()).map((r) => r.deliveryId).sort()).toEqual([
        `posthog_inbox:${R1}:2026-11-16T12:00:00.000001+00:00`,
        `posthog_inbox:${R2}:2026-11-16T12:00:00.000002+00:00`,
      ]);
    });

    it('polls every 30 minutes while PostHog pushes, and every 3 minutes again 24 hours later', async () => {
      await rule();
      const t0 = new Date();
      let row = await tick(t0);
      expect(row.nextPollAt.getTime() - t0.getTime()).toBe(POSTHOG_INBOX_POLL_INTERVAL_MS);

      posthog.put(R1);
      const url = await makeUrl(true);
      await settled(String((await push(url, pushBody(R1))).json.id));
      const pushedAt = (await poller())!.lastPushAt!;
      expect(Math.abs(pushedAt.getTime() - Date.now())).toBeLessThan(60_000);

      const t1 = new Date(t0.getTime() + POSTHOG_INBOX_POLL_INTERVAL_MS);
      row = await tick(t1);
      expect(row.nextPollAt.getTime() - t1.getTime()).toBe(POSTHOG_INBOX_RECONCILE_INTERVAL_MS);

      // Not due again until the reconcile.
      expect((await tick(new Date(t1.getTime() + POSTHOG_INBOX_POLL_INTERVAL_MS))).nextPollAt.getTime()).toBe(row.nextPollAt.getTime());

      // A day after the last push, the next poll goes back to every 3 minutes.
      const t2 = new Date(pushedAt.getTime() + 24 * 60 * 60_000 + 60_000);
      row = await tick(t2);
      expect(row.nextPollAt.getTime() - t2.getTime()).toBe(POSTHOG_INBOX_POLL_INTERVAL_MS);
    });

    it('a push to a project without a rule creates the poller row in reconcile, and never moves the push time back', async () => {
      const later = new Date('2026-11-16T12:00:00Z');
      await recordPostHogInboxPush('int-1', 'ws1', later);
      expect((await poller())?.lastPushAt?.toISOString()).toBe(later.toISOString());
      await recordPostHogInboxPush('int-1', 'ws1', new Date('2026-11-16T11:00:00Z'));
      expect((await poller())?.lastPushAt?.toISOString()).toBe(later.toISOString());
      const newer = new Date('2026-11-16T13:00:00Z');
      await recordPostHogInboxPush('int-1', 'ws1', newer);
      expect((await poller())?.lastPushAt?.toISOString()).toBe(newer.toISOString());
    });

    it('shows the last push and the URL in the status', async () => {
      let status = await posthogInboxStatus('ws1');
      expect(status).toMatchObject({ lastPushAt: null, pushConfigured: false });
      await rule();
      posthog.put(R1);
      const url = await makeUrl(true);
      await settled(String((await push(url, pushBody(R1))).json.id));
      status = await posthogInboxStatus('ws1');
      expect(status.pushConfigured).toBe(true);
      expect(status.lastPushAt).toBe((await poller())!.lastPushAt!.toISOString());
    });
  });
});
