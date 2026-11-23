import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { workflowRoutes } from '../../routes/workflows.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { internalProxyHeaders, requireAuth } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { inboundConnections, inboundDeliveries, integrations, workspaces as workspacesTable } from '../../db/schema.js';
import { _resetWorkflowStore } from '../../services/workflows/store.js';
import { resetFeatureFlagsForTests } from '../../services/featureFlags.js';
import { encryptString } from '../../services/tokenCrypto.js';
import { hashWebhookToken } from '../../services/inbound/adapters/webhook.js';
import { insertDelivery } from '../../services/inbound/store.js';
import * as processModule from '../../services/inbound/process.js';

/**
 * The PostHog Inbox push routes: the webhook URL (made, rotated, revealed
 * once, removed), the stored requests (list, one, replay), and the two gates
 * on every verb (workspace access and the `posthogInboxRules` flag).
 */

vi.mock('../../services/inbound/process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/inbound/process.js')>()),
  processInboundDelivery: vi.fn(async () => 'ignored'),
}));

const headers = { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' };
const priorTokenKey = process.env.TALYN_TOKEN_KEY;

describe('PostHog Inbox push routes', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let url: string;
  let server: Server;

  beforeEach(async () => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.POSTHOG_INBOX_RULES_ENABLED = 'true';
    resetFeatureFlagsForTests();
    _resetWorkflowStore();
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await db.insert(workspacesTable).values({ id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/workflows', requireAuth, wrapAsyncRoutes(workflowRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workflows`;
  });

  afterEach(async () => {
    if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorTokenKey;
    delete process.env.POSTHOG_INBOX_RULES_ENABLED;
    resetFeatureFlagsForTests();
    _resetWorkflowStore();
    vi.mocked(processModule.processInboundDelivery).mockClear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  async function connect(workspaceId = 'ws-mine', projectId = '2'): Promise<void> {
    await db.delete(integrations).where(eq(integrations.workspaceId, workspaceId));
    await db.insert(integrations).values({
      id: `int-${workspaceId}`,
      workspaceId,
      type: 'posthog',
      enabled: true,
      config: { apiKeyEnc: encryptString('phx_test'), projectId, host: 'https://us.posthog.com', authMethod: 'personal_api_key' },
    });
  }

  type Json = { success: boolean; data: Record<string, unknown> | Array<Record<string, unknown>> | null; error?: string; code?: string };
  async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Json, text: '' };
  }
  const data = (r: { json: Json }) => r.json.data as Record<string, unknown>;

  it('has no URL until one is made', async () => {
    await connect();
    const res = await call('GET', '/posthog-inbox/webhook?workspaceId=ws-mine');
    expect(res.status).toBe(200);
    expect(res.json.data).toBeNull();
    expect(data(await call('GET', '/posthog-inbox/status?workspaceId=ws-mine'))).toMatchObject({ pushConfigured: false, lastPushAt: null });
  });

  it('makes a URL with a secret by default, shows both once, and never again', async () => {
    await connect();
    const made = await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' });
    expect(made.status).toBe(200);
    const reveal = data(made) as { connectionId: string; url: string; secret: string; secretHeader: string };
    expect(reveal.secretHeader).toBe('x-talyn-secret');
    expect(reveal.secret).toMatch(/^whsec_/);
    const token = reveal.url.split('/').pop()!;
    expect(reveal.url).toContain(`/api/v1/webhooks/in/${reveal.connectionId}/${token}`);

    const [row] = await db.select().from(inboundConnections).where(eq(inboundConnections.id, reveal.connectionId));
    expect(row.tokenHash).toBe(hashWebhookToken(token));

    const shown = await call('GET', '/posthog-inbox/webhook?workspaceId=ws-mine');
    expect(data(shown)).toMatchObject({
      connectionId: reveal.connectionId,
      projectId: '2',
      secretRequired: true,
      createdAt: expect.any(String),
      rotatedAt: null,
      lastDeliveryAt: null,
      lastPushAt: null,
    });
    expect(String(data(shown).urlPrefix)).toMatch(new RegExp(`/api/v1/webhooks/in/${reveal.connectionId}/$`));
    const text = JSON.stringify(shown.json);
    expect(text).not.toContain(token);
    expect(text).not.toContain(reveal.secret);
    expect(data(await call('GET', '/posthog-inbox/status?workspaceId=ws-mine'))).toMatchObject({ pushConfigured: true });
  });

  it('makes a URL without a secret when asked', async () => {
    await connect();
    const made = await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine', requireSecret: false });
    expect(data(made).secret).toBeNull();
    expect(data(await call('GET', '/posthog-inbox/webhook?workspaceId=ws-mine'))).toMatchObject({ secretRequired: false });
  });

  it.each([['yes'], [1], [null], [{}]])('refuses requireSecret %j', async (requireSecret) => {
    await connect();
    const res = await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine', requireSecret });
    expect(res.status).toBe(400);
    expect(await db.select().from(inboundConnections)).toHaveLength(0);
  });

  it('rotates: same connection, new token and secret, and the old hash is gone', async () => {
    await connect();
    const first = data(await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' }));
    const second = data(await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' }));
    expect(second.connectionId).toBe(first.connectionId);
    expect(second.url).not.toBe(first.url);
    expect(second.secret).not.toBe(first.secret);
    const rows = await db.select().from(inboundConnections);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashWebhookToken(String(second.url).split('/').pop()!));
  });

  it('turns the secret off and on again with a rotate', async () => {
    await connect();
    await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine', requireSecret: false });
    expect(data(await call('GET', '/posthog-inbox/webhook?workspaceId=ws-mine')).secretRequired).toBe(false);
    await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine', requireSecret: true });
    expect(data(await call('GET', '/posthog-inbox/webhook?workspaceId=ws-mine')).secretRequired).toBe(true);
  });

  it('shows no URL after the connection moved to another project, and a new one replaces the old', async () => {
    await connect();
    const old = data(await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' }));
    await connect('ws-mine', '3');
    expect((await call('GET', '/posthog-inbox/webhook?workspaceId=ws-mine')).json.data).toBeNull();
    const next = data(await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' }));
    expect(next.connectionId).not.toBe(old.connectionId);
    expect((await db.select().from(inboundConnections)).map((r) => r.externalAccountId)).toEqual(['3']);
  });

  it('removes the URL and its requests', async () => {
    await connect();
    const made = data(await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' }));
    await insertDelivery({ connectionId: String(made.connectionId), deliveryId: 'evt-1', eventType: 'x', payload: {}, headers: {}, payloadBytes: 2 });
    const removed = await call('DELETE', '/posthog-inbox/webhook?workspaceId=ws-mine');
    expect(data(removed)).toEqual({ removed: 1, destination: null });
    expect(await db.select().from(inboundConnections)).toHaveLength(0);
    expect(await db.select().from(inboundDeliveries)).toHaveLength(0);
    expect(data(await call('DELETE', '/posthog-inbox/webhook?workspaceId=ws-mine'))).toEqual({ removed: 0, destination: null });
  });

  it('lists the requests without bodies, shows one with its body, and replays it', async () => {
    await connect();
    expect((await call('GET', '/posthog-inbox/deliveries?workspaceId=ws-mine')).json.data).toEqual([]);
    const made = data(await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' }));
    const connectionId = String(made.connectionId);
    const stored = await insertDelivery({
      connectionId,
      deliveryId: 'evt-1',
      eventType: '$signals_report_ready',
      payload: { event: { properties: { report_id: 'r1' } } },
      headers: { 'content-type': 'application/json' },
      payloadBytes: 40,
    });

    const list = await call('GET', '/posthog-inbox/deliveries?workspaceId=ws-mine&limit=500');
    const rows = list.json.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: stored.id, deliveryId: 'evt-1', eventType: '$signals_report_ready' });
    expect(rows[0]).not.toHaveProperty('payload');

    const one = await call('GET', `/posthog-inbox/deliveries/${stored.id}?workspaceId=ws-mine`);
    expect(data(one)).toMatchObject({ payload: { event: { properties: { report_id: 'r1' } } } });

    const replayed = await call('POST', `/posthog-inbox/deliveries/${stored.id}/replay`, { workspaceId: 'ws-mine' });
    expect(replayed.status).toBe(200);
    expect(data(replayed)).toMatchObject({ deliveryId: 'evt-1:replay:1', replayOf: stored.id });
    await new Promise((r) => setImmediate(r));
    expect(processModule.processInboundDelivery).toHaveBeenCalledWith(data(replayed).id);

    expect((await call('GET', `/posthog-inbox/deliveries/nope?workspaceId=ws-mine`)).status).toBe(404);
    expect((await call('POST', `/posthog-inbox/deliveries/nope/replay`, { workspaceId: 'ws-mine' })).status).toBe(404);
  });

  it("never shows another workspace's requests", async () => {
    await connect();
    await seedUser(db, { id: 'user-other', email: 'other@example.test' });
    await db.insert(workspacesTable).values({ id: 'ws-theirs', ownerId: 'user-other', name: 'theirs', settings: {} });
    await connect('ws-theirs');
    const { rotatePostHogInboxPushConnection } = await import('../../services/inbound/store.js');
    const theirs = await rotatePostHogInboxPushConnection('ws-theirs', '2', { requireSecret: true, createdBy: 'user-other' });
    const stored = await insertDelivery({ connectionId: theirs.connectionId, deliveryId: 'evt-x', eventType: 'x', payload: { secret: 1 }, headers: {}, payloadBytes: 2 });
    await call('POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' });
    // Their delivery id, asked through my workspace: not found.
    expect((await call('GET', `/posthog-inbox/deliveries/${stored.id}?workspaceId=ws-mine`)).status).toBe(404);
    expect((await call('POST', `/posthog-inbox/deliveries/${stored.id}/replay`, { workspaceId: 'ws-mine' })).status).toBe(404);
  });

  it.each<[string, string, unknown]>([
    ['GET', '/posthog-inbox/webhook?workspaceId=ws-theirs', undefined],
    ['POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-theirs' }],
    ['DELETE', '/posthog-inbox/webhook?workspaceId=ws-theirs', undefined],
    ['GET', '/posthog-inbox/deliveries?workspaceId=ws-theirs', undefined],
    ['GET', '/posthog-inbox/deliveries/d1?workspaceId=ws-theirs', undefined],
    ['POST', '/posthog-inbox/deliveries/d1/replay', { workspaceId: 'ws-theirs' }],
    ['POST', '/posthog-inbox/webhook/setup', { workspaceId: 'ws-theirs' }],
  ])("refuses %s %s for another workspace", async (method, path, body) => {
    await seedUser(db, { id: 'user-other', email: 'other@example.test' });
    await db.insert(workspacesTable).values({ id: 'ws-theirs', ownerId: 'user-other', name: 'theirs', settings: {} });
    await connect('ws-theirs');
    const res = await call(method, path, body);
    expect([403, 404]).toContain(res.status);
    expect(await db.select().from(inboundConnections)).toHaveLength(0);
  });

  it.each<[string, string, unknown]>([
    ['GET', '/posthog-inbox/webhook?workspaceId=ws-mine', undefined],
    ['POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' }],
    ['DELETE', '/posthog-inbox/webhook?workspaceId=ws-mine', undefined],
    ['GET', '/posthog-inbox/deliveries?workspaceId=ws-mine', undefined],
    ['GET', '/posthog-inbox/deliveries/d1?workspaceId=ws-mine', undefined],
    ['POST', '/posthog-inbox/deliveries/d1/replay', { workspaceId: 'ws-mine' }],
    ['POST', '/posthog-inbox/webhook/setup', { workspaceId: 'ws-mine' }],
  ])('hides %s %s behind the flag', async (method, path, body) => {
    await connect();
    process.env.POSTHOG_INBOX_RULES_ENABLED = 'false';
    resetFeatureFlagsForTests();
    const res = await call(method, path, body);
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('posthog_inbox_rules_unavailable');
    expect(await db.select().from(inboundConnections)).toHaveLength(0);
  });

  it.each<[string, string, unknown]>([
    ['GET', '/posthog-inbox/webhook?workspaceId=ws-mine', undefined],
    ['POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' }],
    ['GET', '/posthog-inbox/deliveries?workspaceId=ws-mine', undefined],
    ['POST', '/posthog-inbox/webhook/setup', { workspaceId: 'ws-mine' }],
  ])('asks to connect PostHog first: %s %s', async (method, path, body) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('posthog_inbox_unavailable');
  });

  it.each<[string, string, unknown]>([
    ['GET', '/posthog-inbox/webhook?workspaceId=ws-mine', undefined],
    ['POST', '/posthog-inbox/webhook/rotate', { workspaceId: 'ws-mine' }],
    ['POST', '/posthog-inbox/webhook/setup', { workspaceId: 'ws-mine' }],
  ])('refuses %s %s while the connection cannot read the Inbox', async (method, path, body) => {
    // An OAuth grant from before Inbox rules: no inbox:read.
    await db.insert(integrations).values({
      id: 'int-ws-mine',
      workspaceId: 'ws-mine',
      type: 'posthog',
      enabled: true,
      config: {
        projectId: '2',
        host: 'https://us.posthog.com',
        authMethod: 'oauth',
        oauth: {
          accessTokenEnc: encryptString('pha_access'),
          refreshTokenEnc: encryptString('phr_refresh'),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          scope: 'task:read task:write',
          clientId: 'client',
        },
      },
    });
    const res = await call(method, path, body);
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/Connect PostHog with the Inbox permission/);
    expect(await db.select().from(inboundConnections)).toHaveLength(0);
  });

  it.each<[string, string, unknown]>([
    ['GET', '/posthog-inbox/webhook', undefined],
    ['POST', '/posthog-inbox/webhook/rotate', {}],
    ['DELETE', '/posthog-inbox/webhook', undefined],
    ['POST', '/posthog-inbox/webhook/setup', {}],
  ])('needs a workspace: %s %s', async (method, path, body) => {
    expect((await call(method, path, body)).status).toBe(400);
  });
});
