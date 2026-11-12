import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import type {
  CreatedWorkflow,
  InboundDelivery,
  InboundDeliverySummary,
  WebhookConnectionSummary,
  WebhookSecretReveal,
} from '@talyn/shared';
import { workflowRoutes } from '../../routes/workflows.js';
import { workflowWebhookRoutes } from '../../routes/workflowWebhooks.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { internalProxyHeaders, requireAuth } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import { inboundConnections, inboundDeliveries, repositories, workspaces } from '../../db/schema.js';
import { _resetWorkflowStore } from '../../services/workflows/store.js';
import { resetFeatureFlagsForTests } from '../../services/featureFlags.js';
import * as receiver from '../../services/inbound/receiver.js';
import { insertDelivery } from '../../services/inbound/store.js';

/**
 * The owner routes of webhook rules: create answers the URL once, the summary
 * never carries the token, rotate replaces it, deliveries list without their
 * bodies, one delivery with its body, replay, delete, and the flag and
 * workspace gates (404 for both).
 */

const OTHER = 'user-other';
const headersFor = (userId: string) => ({ ...internalProxyHeaders(userId), 'content-type': 'application/json' });
const mine = headersFor(TEST_USER_ID);

const ruleBody = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'ws-mine',
  integration: 'webhook',
  name: 'Hook',
  events: ['webhook_received'],
  actions: [{ type: 'start_task', repositoryId: 'r1', prompt: 'Fix it' }],
  ...over,
});

describe('webhook rule routes', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('WEBHOOK_RULES_ENABLED', 'true');
    vi.stubEnv('TALYN_PUBLIC_API_URL', 'https://api.talyn.test');
    resetFeatureFlagsForTests();
    _resetWorkflowStore();
    // Replays are processed after the response; the route test pins the row only.
    vi.spyOn(receiver, 'scheduleProcessing').mockImplementation(() => undefined);
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await seedUser(testDb.db, { id: OTHER, email: 'other@example.test' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws-theirs', ownerId: OTHER, name: 'theirs', settings: {} },
    ]);
    await testDb.db.insert(repositories).values({ id: 'r1', workspaceId: 'ws-mine', name: 'acme/api', url: 'https://github.com/acme/api' });

    const app = express();
    app.use(express.json());
    app.use('/api/v1/workflows', requireAuth, wrapAsyncRoutes(workflowRoutes()));
    app.use('/api/v1/workflows', requireAuth, wrapAsyncRoutes(workflowWebhookRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/workflows`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    _resetWorkflowStore();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  async function call<T>(method: string, path: string, body?: unknown, headers = mine) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { success: boolean; data: T; error?: string; code?: string };
    return { status: res.status, json };
  }

  async function create(): Promise<CreatedWorkflow> {
    const res = await call<CreatedWorkflow>('POST', '', ruleBody());
    expect(res.json.success, res.json.error).toBe(true);
    return res.json.data;
  }

  it('answers the URL and the signing secret once, on create', async () => {
    const rule = await create();
    expect(rule.integration).toBe('webhook');
    expect(rule.webhook?.url).toMatch(
      new RegExp(`^https://api\\.talyn\\.test/api/v1/webhooks/in/${rule.webhook!.connectionId}/[A-Za-z0-9_-]{43}$`)
    );
    expect(rule.webhook?.signingSecret).toMatch(/^whsec_/);

    const listed = await call<CreatedWorkflow[]>('GET', '?workspaceId=ws-mine&integration=webhook');
    expect(listed.json.data).toHaveLength(1);
    expect(listed.json.data[0]).not.toHaveProperty('webhook');

    const summary = await call<WebhookConnectionSummary>('GET', `/${rule.id}/webhook`);
    expect(summary.json.data).toMatchObject({
      connectionId: rule.webhook!.connectionId,
      ruleId: rule.id,
      urlPrefix: `https://api.talyn.test/api/v1/webhooks/in/${rule.webhook!.connectionId}/`,
      rotatedAt: null,
      lastDeliveryAt: null,
    });
    const token = rule.webhook!.url.split('/').pop()!;
    expect(JSON.stringify(summary.json)).not.toContain(token);
    expect(JSON.stringify(summary.json)).not.toContain(rule.webhook!.signingSecret);
  });

  it('rotates the URL and the secret', async () => {
    const rule = await create();
    const rotated = await call<WebhookSecretReveal>('POST', `/${rule.id}/webhook/rotate`);
    expect(rotated.json.data.connectionId).toBe(rule.webhook!.connectionId);
    expect(rotated.json.data.url).not.toBe(rule.webhook!.url);
    expect(rotated.json.data.signingSecret).not.toBe(rule.webhook!.signingSecret);
    const summary = await call<WebhookConnectionSummary>('GET', `/${rule.id}/webhook`);
    expect(summary.json.data.rotatedAt).not.toBeNull();
  });

  it('lists deliveries without bodies, opens one with its body, and replays it', async () => {
    const rule = await create();
    const stored = await insertDelivery({
      connectionId: rule.webhook!.connectionId,
      deliveryId: 'd1',
      eventType: 'issue.created',
      payload: { secret_sauce: 1 },
      headers: { 'x-talyn-event': 'issue.created' },
      payloadBytes: 16,
    });

    const list = await call<InboundDeliverySummary[]>('GET', `/${rule.id}/deliveries`);
    expect(list.json.data).toEqual([
      expect.objectContaining({ id: stored.id, deliveryId: 'd1', eventType: 'issue.created', payloadBytes: 16, outcome: null }),
    ]);
    expect(JSON.stringify(list.json.data)).not.toContain('secret_sauce');
    expect(list.json.data[0]).not.toHaveProperty('payload');
    expect(list.json.data[0]).not.toHaveProperty('headers');

    const one = await call<InboundDelivery>('GET', `/${rule.id}/deliveries/${stored.id}`);
    expect(one.json.data).toMatchObject({ payload: { secret_sauce: 1 }, headers: { 'x-talyn-event': 'issue.created' } });

    const replay = await call<InboundDeliverySummary>('POST', `/${rule.id}/deliveries/${stored.id}/replay`);
    expect(replay.json.data).toMatchObject({ deliveryId: 'd1:replay:1', replayOf: stored.id });
    expect(receiver.scheduleProcessing).toHaveBeenCalledWith(replay.json.data.id);

    const paged = await call<InboundDeliverySummary[]>('GET', `/${rule.id}/deliveries?limit=1`);
    expect(paged.json.data).toHaveLength(1);
    const next = await call<InboundDeliverySummary[]>(
      'GET',
      `/${rule.id}/deliveries?limit=1&cursor=${encodeURIComponent(paged.json.data[0].receivedAt)}`
    );
    expect(next.json.data.map((d) => d.id)).not.toContain(paged.json.data[0].id);

    expect((await call('GET', `/${rule.id}/deliveries/nope`)).status).toBe(404);
    expect((await call('POST', `/${rule.id}/deliveries/nope/replay`)).status).toBe(404);
  });

  it('deletes the URL and the deliveries with the rule', async () => {
    const rule = await create();
    await insertDelivery({
      connectionId: rule.webhook!.connectionId,
      deliveryId: 'd1',
      eventType: 'webhook',
      payload: {},
      headers: {},
      payloadBytes: 2,
    });
    expect((await call('DELETE', `/${rule.id}`)).status).toBe(200);
    expect(await testDb.db.select().from(inboundConnections)).toHaveLength(0);
    expect(await testDb.db.select().from(inboundDeliveries)).toHaveLength(0);
  });

  it('answers 404 on every route for a rule that is not a webhook rule', async () => {
    const res = await call<CreatedWorkflow>('POST', '', {
      workspaceId: 'ws-mine',
      name: 'GitHub rule',
      events: ['pr_opened'],
      actions: [{ type: 'watch_pr' }],
    });
    expect(res.json.data).not.toHaveProperty('webhook');
    for (const [method, path] of routes(res.json.data.id)) {
      expect((await call(method, path)).status, `${method} ${path}`).toBe(404);
    }
  });

  it("answers 404 for another account's rule", async () => {
    const rule = await create();
    for (const [method, path] of routes(rule.id)) {
      expect((await call(method, path, undefined, headersFor(OTHER))).status, `${method} ${path}`).toBe(404);
    }
  });

  it('answers 404 everywhere, create included, when the flag is off', async () => {
    const rule = await create();
    vi.stubEnv('WEBHOOK_RULES_ENABLED', 'false');
    resetFeatureFlagsForTests();
    for (const [method, path] of routes(rule.id)) {
      const res = await call(method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const created = await call('POST', '', ruleBody());
    expect(created.status).toBe(404);
    expect(created.json.code).toBe('webhook_rules_unavailable');
    expect((await call('GET', '?workspaceId=ws-mine&integration=webhook')).status).toBe(404);
    expect((await call('DELETE', `/${rule.id}`)).status).toBe(404);
  });

  it('refuses a webhook session without a repository', async () => {
    const res = await call('POST', '', ruleBody({ actions: [{ type: 'start_session', repositoryId: null, prompt: 'x' }] }));
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/choose the repository/);
  });
});

function routes(id: string): Array<[string, string]> {
  return [
    ['GET', `/${id}/webhook`],
    ['POST', `/${id}/webhook/rotate`],
    ['GET', `/${id}/deliveries`],
    ['GET', `/${id}/deliveries/x`],
    ['POST', `/${id}/deliveries/x/replay`],
  ];
}
