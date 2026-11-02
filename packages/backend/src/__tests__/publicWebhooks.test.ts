import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiScope } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { callPublic, mintToken, startPublicApi, type Loose } from './helpers/publicApi.js';
import { apiIdempotencyKeys, apiWebhookDeliveries, apiWebhookEndpoints, workspaces } from '../db/schema.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { WEBHOOK_EVENT_TYPES } from '../services/apiWebhooks/events.js';
import { endpointsForDelivery, insertEndpoint, MAX_WEBHOOK_ENDPOINTS_PER_OWNER } from '../services/apiWebhooks/store.js';
import { setWebhookDnsResolverForTests } from '../services/apiWebhooks/urlPolicy.js';

/** `/v1/webhooks` and `/v1/webhook-deliveries` end to end. */

const WRITE: ApiScope[] = ['webhooks:write'];
const URL_OK = 'https://hooks.example.com/talyn';

describe('/v1 webhooks', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let api: Awaited<ReturnType<typeof startPublicApi>>;
  let token: string;

  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>, as = token) =>
    callPublic(api.base, method, path, { token: as, body, headers });

  async function create(body: Record<string, unknown> = {}, as = token): Promise<Loose> {
    const res = await call('POST', '/webhooks', { url: URL_OK, ...body }, undefined, as);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  }

  beforeEach(async () => {
    vi.stubEnv('PUBLIC_API_ENABLED', 'true');
    vi.stubEnv('TALYN_TOKEN_KEY', Buffer.from('k'.repeat(32)).toString('base64'));
    resetFeatureFlagsForTests();
    setWebhookDnsResolverForTests(async (host) =>
      host === 'internal.example.com' ? [{ address: '10.1.2.3', family: 4 }] : [{ address: '93.184.216.34', family: 4 }],
    );
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-a2', ownerId: 'owner-a', name: 'A2' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    token = await mintToken('owner-a', { scopes: WRITE });
    api = await startPublicApi();
  });

  afterEach(async () => {
    await api.close();
    await testDb.cleanup();
    setWebhookDnsResolverForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  describe('creating', () => {
    it('answers 201 with the secret once, and never again', async () => {
      const created = await create({ description: 'CI bot', event_types: ['session.created', 'chat.turn_completed'] });
      expect(created).toMatchObject({
        object: 'webhook_endpoint',
        url: URL_OK,
        description: 'CI bot',
        workspace_id: null,
        event_types: ['session.created', 'chat.turn_completed'],
        enabled: true,
        disabled_reason: null,
        consecutive_failures: 0,
        secret: expect.stringMatching(/^whsec_/),
      });
      const got = await call('GET', `/webhooks/${created.id}`);
      expect(got.status).toBe(200);
      expect(got.body).not.toHaveProperty('secret');
      const list = await call('GET', '/webhooks');
      expect(JSON.stringify(list.body)).not.toContain(created.secret);
      for (const key of ['secret_enc', 'secretEnc', 'owner_id', 'previous_secret_enc']) expect(got.body).not.toHaveProperty(key);
      // Encrypted at rest.
      const [row] = await testDb.db.select().from(apiWebhookEndpoints).where(eq(apiWebhookEndpoints.id, created.id));
      expect(JSON.stringify(row.secretEnc)).not.toContain(created.secret.slice(6));
    });

    it.each([
      ['plain http', { url: 'http://hooks.example.com/x' }, 'url', 'invalid_webhook_url'],
      ['a private address', { url: 'https://10.0.0.1/x' }, 'url', 'invalid_webhook_url'],
      ['the metadata address', { url: 'https://169.254.169.254/latest' }, 'url', 'invalid_webhook_url'],
      ['a name that resolves inside', { url: 'https://internal.example.com/x' }, 'url', 'invalid_webhook_url'],
      ['credentials in the URL', { url: 'https://a:b@hooks.example.com/x' }, 'url', 'invalid_webhook_url'],
      ['no URL', { url: undefined }, 'url', 'invalid_parameter'],
      ['an unknown event type', { event_types: ['session.exploded'] }, 'event_types.0', 'invalid_parameter'],
      ['ping as a subscription', { event_types: ['ping'] }, 'event_types.0', 'invalid_parameter'],
      ['a camelCase field', { eventTypes: [] }, 'eventTypes', 'invalid_parameter'],
      ['a long description', { description: 'x'.repeat(501) }, 'description', 'invalid_parameter'],
    ])('refuses %s with 400', async (_name, patch, param, code) => {
      const res = await call('POST', '/webhooks', { url: URL_OK, ...patch });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ type: 'invalid_request_error', code, param });
    });

    it('binds to a workspace the token reaches, and 404s a foreign one', async () => {
      expect((await create({ workspace_id: 'ws-a' })).workspace_id).toBe('ws-a');
      const foreign = await call('POST', '/webhooks', { url: URL_OK, workspace_id: 'ws-b' });
      expect(foreign.status).toBe(404);
    });

    it('takes the workspace of a token bound to exactly one, and asks a token bound to several', async () => {
      const one = await mintToken('owner-a', { scopes: WRITE, workspaceIds: ['ws-a'] });
      expect((await create({}, one)).workspace_id).toBe('ws-a');
      const two = await mintToken('owner-a', { scopes: WRITE, workspaceIds: ['ws-a', 'ws-a2'] });
      const res = await call('POST', '/webhooks', { url: URL_OK }, undefined, two);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'missing_parameter', param: 'workspace_id' });
      const outside = await call('POST', '/webhooks', { url: URL_OK, workspace_id: 'ws-a2' }, undefined, one);
      expect(outside.status).toBe(404);
    });

    it(`refuses the ${MAX_WEBHOOK_ENDPOINTS_PER_OWNER + 1}th endpoint with 409`, async () => {
      for (let i = 0; i < MAX_WEBHOOK_ENDPOINTS_PER_OWNER; i++) {
        await insertEndpoint({ ownerId: 'owner-a', workspaceId: null, url: URL_OK, description: null, eventTypes: [], enabled: true });
      }
      const res = await call('POST', '/webhooks', { url: URL_OK });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'webhook_endpoint_limit_reached', limit: MAX_WEBHOOK_ENDPOINTS_PER_OWNER });
    });

    it('replays an idempotent create with the current secret, and never stores the secret with the key', async () => {
      const body = { url: URL_OK };
      const first = await call('POST', '/webhooks', body, { 'Idempotency-Key': 'create-1' });
      const again = await call('POST', '/webhooks', body, { 'Idempotency-Key': 'create-1' });
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(again.body.id).toBe(first.body.id);
      expect(again.body.secret).toBe(first.body.secret);
      expect((await call('GET', '/webhooks')).body.data).toHaveLength(1);
      const keys = await testDb.db.select().from(apiIdempotencyKeys);
      expect(JSON.stringify(keys)).not.toContain('whsec_');
    });
  });

  describe('reading and changing', () => {
    it('hides another owner\'s endpoint and its deliveries as 404', async () => {
      const other = await mintToken('owner-b', { scopes: WRITE });
      const theirs = await create({}, other);
      for (const [method, path] of [
        ['GET', `/webhooks/${theirs.id}`],
        ['PATCH', `/webhooks/${theirs.id}`],
        ['DELETE', `/webhooks/${theirs.id}`],
        ['POST', `/webhooks/${theirs.id}/test`],
        ['POST', `/webhooks/${theirs.id}/rotate-secret`],
        ['GET', `/webhooks/${theirs.id}/deliveries`],
      ] as const) {
        const res = await call(method, path, method === 'GET' || method === 'DELETE' ? undefined : {});
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body.error.code).toBe('webhook_endpoint_not_found');
      }
      const ping = await call('POST', `/webhooks/${theirs.id}/test`, undefined, undefined, other);
      const delivery = await call('GET', `/webhook-deliveries/${ping.body.id}`);
      expect(delivery.status).toBe(404);
      expect(delivery.body.error.code).toBe('webhook_delivery_not_found');
      expect((await call('GET', '/webhooks')).body.data).toHaveLength(0);
    });

    it('shows a workspace-bound token only the endpoints bound to its workspaces', async () => {
      const all = await create();
      const bound = await create({ workspace_id: 'ws-a' });
      await create({ workspace_id: 'ws-a2' });
      const scoped = await mintToken('owner-a', { scopes: ['webhooks:read'], workspaceIds: ['ws-a'] });
      const list = await call('GET', '/webhooks', undefined, undefined, scoped);
      expect(list.body.data.map((e: Loose) => e.id)).toEqual([bound.id]);
      expect((await call('GET', `/webhooks/${all.id}`, undefined, undefined, scoped)).status).toBe(404);
    });

    it('pages the list with a cursor', async () => {
      const ids = [(await create()).id, (await create()).id, (await create()).id];
      const first = await call('GET', '/webhooks?limit=2');
      expect(first.body).toMatchObject({ object: 'list', has_more: true });
      const second = await call('GET', `/webhooks?limit=2&cursor=${first.body.next_cursor}`);
      expect(second.body).toMatchObject({ has_more: false, next_cursor: null });
      expect([...first.body.data, ...second.body.data].map((e: Loose) => e.id).sort()).toEqual(ids.sort());
    });

    it('changes the fields, and switches the endpoint off and on', async () => {
      const created = await create({ description: 'old' });
      const patched = await call('PATCH', `/webhooks/${created.id}`, {
        url: 'https://other.example.com/x',
        description: null,
        event_types: ['pull_request.merged'],
      });
      expect(patched.body).toMatchObject({ url: 'https://other.example.com/x', description: null, event_types: ['pull_request.merged'] });

      const off = await call('PATCH', `/webhooks/${created.id}`, { enabled: false });
      expect(off.body).toMatchObject({ enabled: false, disabled_reason: 'Disabled through the API.', disabled_at: expect.any(String) });
      const on = await call('PATCH', `/webhooks/${created.id}`, { enabled: true });
      expect(on.body).toMatchObject({ enabled: true, disabled_reason: null, disabled_at: null, consecutive_failures: 0 });

      const bad = await call('PATCH', `/webhooks/${created.id}`, { url: 'https://10.0.0.9/x' });
      expect(bad.status).toBe(400);
      expect(bad.body.error.param).toBe('url');
    });

    it('deletes an endpoint', async () => {
      const created = await create();
      const res = await call('DELETE', `/webhooks/${created.id}`);
      expect(res.status).toBe(204);
      expect((await call('GET', `/webhooks/${created.id}`)).status).toBe(404);
    });

    it('rotates the secret and keeps the old one signing for the time asked', async () => {
      const created = await create();
      const rotated = await call('POST', `/webhooks/${created.id}/rotate-secret`, {});
      expect(rotated.status).toBe(200);
      expect(rotated.body.secret).toMatch(/^whsec_/);
      expect(rotated.body.secret).not.toBe(created.secret);
      expect((await endpointsForDelivery([created.id])).get(created.id)?.secrets).toEqual([rotated.body.secret, created.secret]);

      const now = await call('POST', `/webhooks/${created.id}/rotate-secret`, { expire_previous_in_seconds: 0 });
      expect((await endpointsForDelivery([created.id])).get(created.id)?.secrets).toEqual([now.body.secret]);

      const tooLong = await call('POST', `/webhooks/${created.id}/rotate-secret`, { expire_previous_in_seconds: 999_999 });
      expect(tooLong.status).toBe(400);
    });

    it('lists the event types', async () => {
      const res = await call('GET', '/webhook-event-types');
      expect(res.status).toBe(200);
      expect(res.body.data.map((t: Loose) => t.type)).toEqual([...WEBHOOK_EVENT_TYPES]);
      expect(res.body.data[0]).toMatchObject({ object: 'webhook_event_type', description: expect.any(String) });
    });
  });

  describe('test events and deliveries', () => {
    it('queues a ping, lists it, shows its payload, and redelivers it once it is done', async () => {
      const created = await create();
      const ping = await call('POST', `/webhooks/${created.id}/test`);
      expect(ping.status).toBe(202);
      expect(ping.body).toMatchObject({ object: 'webhook_delivery', event_type: 'ping', status: 'pending', attempt_count: 0 });

      const list = await call('GET', `/webhooks/${created.id}/deliveries`);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).not.toHaveProperty('payload');

      const one = await call('GET', `/webhook-deliveries/${ping.body.id}`);
      expect(one.body.payload).toMatchObject({ type: 'ping', data: { object: { object: 'webhook_endpoint', id: created.id } } });
      expect(JSON.stringify(one.body.payload)).not.toContain(created.secret);

      const pending = await call('POST', `/webhook-deliveries/${ping.body.id}/redeliver`);
      expect(pending.status).toBe(409);
      expect(pending.body.error.code).toBe('delivery_pending');

      await testDb.db
        .update(apiWebhookDeliveries)
        .set({ status: 'failed', attemptCount: 8, lastError: 'The endpoint answered 500.' })
        .where(eq(apiWebhookDeliveries.id, ping.body.id));
      const failedOnly = await call('GET', `/webhooks/${created.id}/deliveries?status=failed`);
      expect(failedOnly.body.data).toHaveLength(1);
      expect((await call('GET', `/webhooks/${created.id}/deliveries?status=succeeded`)).body.data).toHaveLength(0);

      const again = await call('POST', `/webhook-deliveries/${ping.body.id}/redeliver`);
      expect(again.status).toBe(202);
      expect(again.body).toMatchObject({ id: ping.body.id, status: 'pending', attempt_count: 0, last_error: null });
    });

    it('refuses a test or a redelivery on a disabled endpoint', async () => {
      const created = await create();
      const ping = await call('POST', `/webhooks/${created.id}/test`);
      await testDb.db.update(apiWebhookDeliveries).set({ status: 'failed' }).where(eq(apiWebhookDeliveries.id, ping.body.id));
      await call('PATCH', `/webhooks/${created.id}`, { enabled: false });
      for (const path of [`/webhooks/${created.id}/test`, `/webhook-deliveries/${ping.body.id}/redeliver`]) {
        const res = await call('POST', path);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('webhook_endpoint_disabled');
      }
    });

    it('replays an idempotent test ping instead of sending a second one', async () => {
      const created = await create();
      const a = await call('POST', `/webhooks/${created.id}/test`, undefined, { 'Idempotency-Key': 'ping-1' });
      const b = await call('POST', `/webhooks/${created.id}/test`, undefined, { 'Idempotency-Key': 'ping-1' });
      expect(b.body.id).toBe(a.body.id);
      expect((await call('GET', `/webhooks/${created.id}/deliveries`)).body.data).toHaveLength(1);
    });
  });

  describe('scopes', () => {
    it.each([
      ['GET', '/webhooks', ['sessions:read']],
      ['GET', '/webhook-event-types', ['sessions:write']],
      ['POST', '/webhooks', ['webhooks:read']],
    ] as const)('%s %s needs the webhook scope', async (method, path, scopes) => {
      const weak = await mintToken('owner-a', { scopes: [...scopes] });
      const res = await call(method, path, method === 'POST' ? { url: URL_OK } : undefined, undefined, weak);
      expect(res.status).toBe(403);
      expect(res.body.error.type).toBe('permission_error');
    });

    it('lets webhooks:write read', async () => {
      expect((await call('GET', '/webhooks')).status).toBe(200);
    });
  });
});
