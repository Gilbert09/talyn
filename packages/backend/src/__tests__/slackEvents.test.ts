import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { slackEvents, slackInstallations, slackUserLinks } from '../db/schema.js';
import {
  handleSlackWebhook,
  MAX_EVENT_ATTEMPTS,
  processSlackEvent,
  PROCESSED_RETENTION_MS,
  SLACK_EVENT_HANDLERS,
  slackEventSweep,
  verifySlackSignature,
} from '../services/slack/events.js';
import { encryptString } from '../services/tokenCrypto.js';

/**
 * The Slack Events API receiver: signature, url_verification, idempotent
 * storage, the uninstall/revocation handlers, and the sweep.
 */

const SECRET = 'test-signing-secret';
const NOW = 1_790_000_000;

function sign(body: string, ts: number | string, secret = SECRET): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
}

describe('verifySlackSignature', () => {
  const body = '{"type":"event_callback","event_id":"Ev1"}';
  const good = sign(body, NOW);

  it.each([
    ['a good signature', body, String(NOW), good, 'valid'],
    ['a signature made with another secret', body, String(NOW), sign(body, NOW, 'other'), 'invalid'],
    ['a tampered body', body.replace('Ev1', 'Ev2'), String(NOW), good, 'invalid'],
    ['a signature over another timestamp', body, String(NOW + 1), good, 'invalid'],
    ['a truncated signature', body, String(NOW), good.slice(0, 20), 'invalid'],
    ['a timestamp six minutes old', body, String(NOW - 6 * 60), sign(body, NOW - 6 * 60), 'stale'],
    ['a timestamp six minutes ahead', body, String(NOW + 6 * 60), sign(body, NOW + 6 * 60), 'stale'],
    ['a timestamp four minutes old', body, String(NOW - 4 * 60), sign(body, NOW - 4 * 60), 'valid'],
    ['a non-numeric timestamp', body, 'abc', sign(body, 'abc'), 'invalid'],
    ['no timestamp', body, undefined, good, 'missing'],
    ['no signature', body, String(NOW), undefined, 'missing'],
  ])('%s', (_name, rawBody, ts, sig, expected) => {
    expect(verifySlackSignature(Buffer.from(rawBody), ts, sig, SECRET, NOW)).toBe(expected);
  });
});

describe('Slack events webhook', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let server: Server;
  let url: string;
  let priorSecret: string | undefined;
  let priorKey: string | undefined;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    priorSecret = process.env.SLACK_SIGNING_SECRET;
    priorKey = process.env.TALYN_TOKEN_KEY;
    process.env.SLACK_SIGNING_SECRET = SECRET;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    const app = express();
    app.post('/webhooks/slack', express.raw({ type: () => true }), (req, res) => {
      void handleSlackWebhook(req, res);
    });
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/slack`;
    slackEventSweep.resetForTests();
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
    if (priorSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = priorSecret;
    if (priorKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorKey;
  });

  async function post(payload: unknown, opts: { secret?: string; ts?: number; headers?: Record<string, string> } = {}) {
    const body = JSON.stringify(payload);
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': sign(body, ts, opts.secret ?? SECRET),
        ...(opts.headers ?? {}),
      },
      body,
    });
  }

  function callback(eventId: string, event: Record<string, unknown>, teamId = 'T1') {
    return { type: 'event_callback', token: 'legacy-verification-token', team_id: teamId, event_id: eventId, event };
  }

  async function settled(eventId: string) {
    for (let i = 0; i < 100; i++) {
      const rows = await db.select().from(slackEvents).where(eq(slackEvents.eventId, eventId));
      if (rows[0]?.processedAt) return rows[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`event ${eventId} was not processed`);
  }

  async function seedTeam(teamId = 'T1') {
    await seedUser(db, { id: 'u1' });
    await seedUser(db, { id: 'u2' });
    await db.insert(slackInstallations).values({
      teamId,
      appId: 'A1',
      botUserId: 'UBOT',
      accessTokenEnc: encryptString('xoxb-1'),
      installedByUserId: 'u1',
    });
    await db.insert(slackUserLinks).values([
      { id: `l1-${teamId}`, teamId, slackUserId: 'US1', userId: 'u1' },
      { id: `l2-${teamId}`, teamId, slackUserId: 'US2', userId: 'u2' },
    ]);
  }

  it('answers url_verification with the challenge', async () => {
    const res = await post({ type: 'url_verification', challenge: 'abc123', token: 'x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it.each([
    ['a bad signature', { secret: 'wrong' }],
    ['an old timestamp', { ts: Math.floor(Date.now() / 1000) - 600 }],
    ['a future timestamp', { ts: Math.floor(Date.now() / 1000) + 600 }],
  ])('refuses %s with 401 and stores nothing', async (_name, opts) => {
    const res = await post(callback('EvBad', { type: 'app_mention' }), opts);
    expect(res.status).toBe(401);
    expect(await db.select().from(slackEvents)).toHaveLength(0);
  });

  it('refuses a request with no signature headers', async () => {
    const res = await fetch(url, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('answers 500 when no signing secret is configured, so nothing unverified is stored', async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const res = await post(callback('EvX', { type: 'app_mention' }));
    expect(res.status).toBe(500);
    expect(await db.select().from(slackEvents)).toHaveLength(0);
  });

  it('stores a retried event id once and drops the verification token', async () => {
    const payload = callback('EvDup', { type: 'app_mention', text: 'hi' });
    const [a, b] = await Promise.all([post(payload), post(payload, { headers: { 'x-slack-retry-num': '1' } })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const row = await settled('EvDup');
    expect(await db.select().from(slackEvents)).toHaveLength(1);
    expect(row.attempts).toBe(1);
    expect(row.outcome).toBe('ignored');
    expect(row.payload).not.toHaveProperty('token');
    expect((row.payload as { event: { text: string } }).event.text).toBe('hi');
  });

  it.each(['app_mention', 'reaction_added', 'message', 'channel_created'])(
    'stores %s and marks it ignored when no installation or link applies',
    async (type) => {
      await post(callback(`Ev-${type}`, { type }));
      expect((await settled(`Ev-${type}`)).outcome).toBe('ignored');
    }
  );

  it('app_uninstalled deletes the installation and every link in that team only', async () => {
    await seedTeam('T1');
    await seedTeam('T2');
    await post(callback('EvUn', { type: 'app_uninstalled' }, 'T1'));
    expect((await settled('EvUn')).outcome).toBe('handled');
    expect((await db.select().from(slackInstallations)).map((r) => r.teamId)).toEqual(['T2']);
    expect((await db.select().from(slackUserLinks)).map((r) => r.teamId)).toEqual(['T2', 'T2']);
  });

  it.each([
    ['the bot token', { bot: ['UBOT'] }, [], []],
    ['one user grant', { oauth: ['US1'] }, ['T1'], ['US2']],
    ['another bot id', { bot: ['UOTHER'] }, ['T1'], ['US1', 'US2']],
  ])('tokens_revoked for %s', async (_name, tokens, installs, links) => {
    await seedTeam('T1');
    await post(callback('EvRev', { type: 'tokens_revoked', tokens }));
    await settled('EvRev');
    expect((await db.select().from(slackInstallations)).map((r) => r.teamId)).toEqual(installs);
    expect((await db.select().from(slackUserLinks)).map((r) => r.slackUserId).sort()).toEqual(links);
  });

  it('a claimed event is not processed twice', async () => {
    await db.insert(slackEvents).values({ eventId: 'EvC', teamId: 'T1', eventType: 'app_mention', payload: {} });
    const [a, b] = await Promise.all([processSlackEvent('EvC'), processSlackEvent('EvC')]);
    expect([a, b].sort()).toEqual(['ignored', 'skipped']);
  });

  it('retries a failing handler, then settles it failed after the last attempt', async () => {
    const original = SLACK_EVENT_HANDLERS.app_mention;
    SLACK_EVENT_HANDLERS.app_mention = async () => {
      throw new Error('boom');
    };
    try {
      await db.insert(slackEvents).values({ eventId: 'EvF', teamId: 'T1', eventType: 'app_mention', payload: {} });
      for (let i = 1; i <= MAX_EVENT_ATTEMPTS; i++) {
        expect(await processSlackEvent('EvF')).toBe('failed');
        const [row] = await db.select().from(slackEvents).where(eq(slackEvents.eventId, 'EvF'));
        expect(row.attempts).toBe(i);
        expect(row.processedAt === null).toBe(i < MAX_EVENT_ATTEMPTS);
      }
      const [row] = await db.select().from(slackEvents).where(eq(slackEvents.eventId, 'EvF'));
      expect(row.outcome).toBe('failed');
      expect(row.error).toBe('boom');
    } finally {
      SLACK_EVENT_HANDLERS.app_mention = original;
    }
  });

  it('the sweep processes what was left pending and deletes processed events past retention', async () => {
    const now = new Date();
    await db.insert(slackEvents).values([
      // Left behind by a crash: received two minutes ago, never processed.
      { eventId: 'EvOld', eventType: 'app_mention', payload: {}, receivedAt: new Date(now.getTime() - 120_000) },
      // Just arrived: the inline path owns it, the sweep leaves it alone.
      { eventId: 'EvNew', eventType: 'app_mention', payload: {}, receivedAt: now },
      {
        eventId: 'EvExpired',
        eventType: 'app_mention',
        payload: {},
        processedAt: new Date(now.getTime() - PROCESSED_RETENTION_MS - 60_000),
        outcome: 'ignored',
      },
      {
        eventId: 'EvRecent',
        eventType: 'app_mention',
        payload: {},
        processedAt: new Date(now.getTime() - 60_000),
        outcome: 'ignored',
      },
    ]);
    const result = await slackEventSweep.tick(now);
    expect(result).toEqual({ retried: 1, deleted: 1 });
    const rows = await db.select().from(slackEvents);
    const byId = new Map(rows.map((r) => [r.eventId, r]));
    expect(byId.has('EvExpired')).toBe(false);
    expect(byId.get('EvOld')?.outcome).toBe('ignored');
    expect(byId.get('EvNew')?.processedAt).toBeNull();
    expect(byId.has('EvRecent')).toBe(true);
  });
});
