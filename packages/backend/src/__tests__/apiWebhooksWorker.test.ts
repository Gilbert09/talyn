import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { Webhook } from 'standardwebhooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { apiWebhookDeliveries, apiWebhookEndpoints, workspaces } from '../db/schema.js';
import { debugBus } from '../services/debugBus.js';
import { buildEnvelope } from '../services/apiWebhooks/events.js';
import { enqueueSingleDelivery, insertEndpoint } from '../services/apiWebhooks/store.js';
import { setWebhookDnsResolverForTests } from '../services/apiWebhooks/urlPolicy.js';
import {
  deliveryBody,
  DISABLE_AFTER_FAILURES,
  MAX_ATTEMPTS,
  pruneWebhookTables,
  RETRY_DELAYS_MS,
  WebhookDeliveryWorker,
} from '../services/apiWebhooks/worker.js';

/**
 * The delivery worker against a real local HTTP receiver: signing, success,
 * the retry schedule, 410, the failure-streak disable, and two workers
 * sharing one queue.
 */

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('webhook delivery worker', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: http.Server;
  let baseUrl: string;
  let received: Received[];
  let reply: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const policy = { allowLoopback: true };
  const worker = () => new WebhookDeliveryWorker({ policy, timeoutMs: 2000 });

  async function endpoint(path = '/hook', opts: { enabled?: boolean } = {}) {
    const { row, secret } = await insertEndpoint({
      ownerId: 'owner-a',
      workspaceId: 'ws-a',
      url: `${baseUrl}${path}`,
      description: null,
      eventTypes: [],
      enabled: opts.enabled ?? true,
    });
    return { id: row.id, secret };
  }

  async function queue(endpointId: string, n = 1) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const row = await enqueueSingleDelivery(endpointId, buildEnvelope('ping', 'ws-a', { object: { object: 'webhook_endpoint', id: endpointId } }));
      ids.push(row.id);
    }
    return ids;
  }

  async function delivery(id: string) {
    const [row] = await testDb.db.select().from(apiWebhookDeliveries).where(eq(apiWebhookDeliveries.id, id));
    return row;
  }

  async function endpointRow(id: string) {
    const [row] = await testDb.db.select().from(apiWebhookEndpoints).where(eq(apiWebhookEndpoints.id, id));
    return row;
  }

  /** Make every pending row due now, as if its wait had passed. */
  async function makeDue(): Promise<void> {
    await testDb.db
      .update(apiWebhookDeliveries)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(apiWebhookDeliveries.status, 'pending'));
  }

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', Buffer.from('k'.repeat(32)).toString('base64'));
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    received = [];
    reply = (_req, res) => res.writeHead(200).end('ok');
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        reply(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setWebhookDnsResolverForTests(null);
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('posts a signed body that a Standard Webhooks receiver verifies, and records success', async () => {
    const recordHttp = vi.spyOn(debugBus, 'recordHttp');
    const ep = await endpoint('/hook/secret-token-in-path');
    const [id] = await queue(ep.id);

    expect(await worker().tick()).toBe(1);

    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    const payload = new Webhook(ep.secret).verify(body, {
      'webhook-id': headers['webhook-id'] as string,
      'webhook-timestamp': headers['webhook-timestamp'] as string,
      'webhook-signature': headers['webhook-signature'] as string,
    }) as Record<string, unknown>;
    expect(payload).toMatchObject({ type: 'ping', workspace_id: 'ws-a', data: { object: { id: ep.id } } });
    expect(headers['webhook-id']).toBe(payload.id);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toMatch(/^Talyn-Webhooks\//);
    expect(Object.keys(JSON.parse(body))).toEqual(['id', 'type', 'created_at', 'workspace_id', 'data']);

    expect(await delivery(id)).toMatchObject({ status: 'succeeded', attemptCount: 1, lastResponseStatus: 200, claimToken: null });
    expect((await delivery(id)).deliveredAt).toBeInstanceOf(Date);
    // The debug log gets the origin, never the path (it can hold a receiver's token).
    const call = recordHttp.mock.calls.find(([c]) => c.service === 'api_webhooks')?.[0];
    expect(call).toMatchObject({ method: 'POST', status: 200, ok: true, url: baseUrl, workspaceId: 'ws-a' });
  });

  it.each(RETRY_DELAYS_MS.map((delay, i) => [i + 1, delay]))(
    'after failed attempt %i waits %i ms',
    async (attempt, delay) => {
      reply = (_req, res) => res.writeHead(503).end();
      const ep = await endpoint();
      const [id] = await queue(ep.id);
      const w = worker();
      for (let i = 1; i < attempt; i++) {
        await makeDue();
        await w.tick();
      }
      await makeDue();
      const now = new Date();
      await w.tick(() => now);
      const row = await delivery(id);
      expect(row).toMatchObject({ status: 'pending', attemptCount: attempt, lastResponseStatus: 503, lastError: 'The endpoint answered 503.' });
      expect(row.nextAttemptAt.getTime() - now.getTime()).toBe(delay);
    },
  );

  it(`fails a delivery for good after ${MAX_ATTEMPTS} attempts`, async () => {
    reply = (_req, res) => res.writeHead(500).end();
    const ep = await endpoint();
    const [id] = await queue(ep.id);
    const w = worker();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await makeDue();
      await w.tick();
    }
    expect(await delivery(id)).toMatchObject({ status: 'failed', attemptCount: MAX_ATTEMPTS });
    await makeDue();
    expect(await w.tick()).toBe(0);
    expect(received).toHaveLength(MAX_ATTEMPTS);
  });

  it('disables the endpoint on 410 Gone and abandons what it still owed', async () => {
    reply = (_req, res) => res.writeHead(410).end();
    const ep = await endpoint();
    const ids = await queue(ep.id, 2);
    const w = new WebhookDeliveryWorker({ policy, timeoutMs: 2000, batch: 1 });
    expect(await w.tick()).toBe(1);
    expect(await w.tick()).toBe(0);
    const rows = await Promise.all(ids.map(delivery));
    expect(rows.map((r) => r.status).sort()).toEqual(['abandoned', 'failed']);
    expect(await endpointRow(ep.id)).toMatchObject({ enabled: false, disabledReason: 'The endpoint answered 410 Gone.' });
    expect(received).toHaveLength(1);
  });

  it.each([
    ['a long streak', DISABLE_AFTER_FAILURES - 1, 4 * 24, false],
    ['a streak younger than 3 days', DISABLE_AFTER_FAILURES + 20, 2 * 24, true],
    ['too few failures, however old', 2, 30 * 24, true],
  ])('with %s, stays enabled: %s', async (_name, failures, hoursAgo, staysEnabled) => {
    reply = (_req, res) => res.writeHead(500).end();
    const ep = await endpoint();
    await testDb.db
      .update(apiWebhookEndpoints)
      .set({ consecutiveFailures: failures, failingSince: new Date(Date.now() - hoursAgo * 3_600_000) })
      .where(eq(apiWebhookEndpoints.id, ep.id));
    await queue(ep.id);
    await worker().tick();
    const row = await endpointRow(ep.id);
    expect(row.consecutiveFailures).toBe(failures + 1);
    expect(row.enabled).toBe(staysEnabled);
    if (!staysEnabled) expect(row.disabledReason).toMatch(/Every delivery failed for 3 days/);
  });

  it('resets the failure streak on a success', async () => {
    const ep = await endpoint();
    await testDb.db.update(apiWebhookEndpoints).set({ consecutiveFailures: 4, failingSince: new Date() }).where(eq(apiWebhookEndpoints.id, ep.id));
    await queue(ep.id);
    await worker().tick();
    expect(await endpointRow(ep.id)).toMatchObject({ consecutiveFailures: 0, failingSince: null });
  });

  it('counts a redirect as a failure and does not follow it', async () => {
    reply = (_req, res) => res.writeHead(301, { location: 'http://169.254.169.254/' }).end();
    const ep = await endpoint();
    const [id] = await queue(ep.id);
    await worker().tick();
    expect(await delivery(id)).toMatchObject({ status: 'pending', lastResponseStatus: 301, lastError: expect.stringMatching(/Redirects are not followed/) });
    expect(received).toHaveLength(1);
  });

  it('refuses a name that resolves to a private address at delivery time', async () => {
    const { row } = await insertEndpoint({
      ownerId: 'owner-a', workspaceId: 'ws-a', url: 'https://internal.example.com/hook', description: null, eventTypes: [], enabled: true,
    });
    setWebhookDnsResolverForTests(async () => [{ address: '10.0.0.7', family: 4 }]);
    const [id] = await queue(row.id);
    await new WebhookDeliveryWorker({ policy: { allowLoopback: false }, timeoutMs: 2000 }).tick();
    expect(await delivery(id)).toMatchObject({ status: 'pending', attemptCount: 1, lastResponseStatus: null, lastError: expect.stringMatching(/private/) });
  });

  it('delivers each row once when two workers run at the same time', async () => {
    const ep = await endpoint();
    await queue(ep.id, 6);
    const [a, b] = [worker(), worker()];
    const counts = await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(6);
    expect(received).toHaveLength(6);
    expect(new Set(received.map((r) => r.headers['webhook-id'])).size).toBe(6);
  });

  it('lets a second worker take over an expired lease, and the first one cannot overwrite it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    reply = (_req, res) => {
      calls += 1;
      if (calls === 1) void gate.then(() => res.writeHead(500).end());
      else res.writeHead(200).end();
    };
    const ep = await endpoint();
    const [id] = await queue(ep.id);
    const first = worker().tick();
    await vi.waitFor(() => expect(received).toHaveLength(1));
    // The first worker's lease runs out while it waits.
    await makeDue();
    await worker().tick();
    release();
    await first;
    expect(await delivery(id)).toMatchObject({ status: 'succeeded', attemptCount: 2, lastResponseStatus: 200 });
  });

  it('does not claim the rows of a disabled endpoint, and the prune abandons them', async () => {
    const ep = await endpoint('/hook', { enabled: false });
    const [id] = await queue(ep.id);
    expect(await worker().tick()).toBe(0);
    await pruneWebhookTables();
    expect(await delivery(id)).toMatchObject({ status: 'abandoned' });
  });

  it('prunes finished deliveries after 30 days and keeps pending ones', async () => {
    const ep = await endpoint();
    const [oldDone, oldPending, fresh] = await queue(ep.id, 3);
    const longAgo = new Date(Date.now() - 31 * 24 * 3_600_000);
    await testDb.db.update(apiWebhookDeliveries).set({ status: 'succeeded', createdAt: longAgo }).where(eq(apiWebhookDeliveries.id, oldDone));
    await testDb.db.update(apiWebhookDeliveries).set({ createdAt: longAgo }).where(eq(apiWebhookDeliveries.id, oldPending));
    await pruneWebhookTables();
    expect(await delivery(oldDone)).toBeUndefined();
    expect(await delivery(oldPending)).toBeDefined();
    expect(await delivery(fresh)).toBeDefined();
  });

  it('writes the envelope keys in the documented order', () => {
    expect(deliveryBody({ data: { object: {} }, workspace_id: 'w', type: 'ping', created_at: 't', id: 'evt' })).toBe(
      '{"id":"evt","type":"ping","created_at":"t","workspace_id":"w","data":{"object":{}}}',
    );
  });
});
