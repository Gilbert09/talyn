import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { slackInstallations } from '../db/schema.js';
import { getSlackBotToken, resetSlackTokenStateForTests } from '../services/slack/tokens.js';
import { decryptString, encryptString, type EncryptedEnvelope } from '../services/tokenCrypto.js';

/**
 * Bot-token refresh under token rotation. A refresh token is single-use, so
 * the properties pinned here are: one refresh per expiry, the NEW refresh
 * token stored, a dead grant recorded, and a transient failure left alone.
 */

const ENV_KEYS = ['TALYN_TOKEN_KEY', 'SLACK_APP_CLIENT_ID', 'SLACK_APP_CLIENT_SECRET', 'SLACK_OAUTH_REDIRECT_URI'] as const;

describe('getSlackBotToken', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  const prior: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;
  let calls: Array<Record<string, string>>;
  let answer: () => Promise<Response> | Response;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    for (const k of ENV_KEYS) prior[k] = process.env[k];
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.SLACK_APP_CLIENT_ID = 'cid';
    process.env.SLACK_APP_CLIENT_SECRET = 'csecret';
    process.env.SLACK_OAUTH_REDIRECT_URI = 'https://prod.talyn.dev/api/v1/slack/oauth/callback';
    resetSlackTokenStateForTests();
    calls = [];
    answer = () => Response.json({ ok: true, access_token: 'xoxe.xoxb-new', refresh_token: 'xoxe-1-new', expires_in: 43_200 });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (!target.startsWith('https://slack.com/api/oauth.v2.access')) throw new Error(`unexpected ${target}`);
      calls.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))));
      // Slow enough that concurrent callers overlap.
      await new Promise((r) => setTimeout(r, 30));
      return answer();
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await cleanup();
    for (const k of ENV_KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  });

  async function seed(expiresInMs: number | null, extra: Partial<typeof slackInstallations.$inferInsert> = {}) {
    await db.insert(slackInstallations).values({
      teamId: 'T1',
      appId: 'A1',
      botUserId: 'UBOT',
      accessTokenEnc: encryptString('xoxe.xoxb-old'),
      refreshTokenEnc: encryptString('xoxe-1-old'),
      expiresAt: expiresInMs === null ? null : new Date(Date.now() + expiresInMs),
      ...extra,
    });
  }

  async function row() {
    return (await db.select().from(slackInstallations).where(eq(slackInstallations.teamId, 'T1')))[0];
  }

  it.each([
    ['hours of life left', 6 * 3600_000],
    ['no expiry (a non-rotating token)', null],
  ])('returns the stored token without calling Slack when it has %s', async (_n, expires) => {
    await seed(expires);
    expect(await getSlackBotToken('T1')).toBe('xoxe.xoxb-old');
    expect(calls).toHaveLength(0);
  });

  it('returns null for a team with no installation', async () => {
    expect(await getSlackBotToken('T-none')).toBeNull();
  });

  it('refreshes near expiry and stores the rotated refresh token', async () => {
    await seed(60_000);
    expect(await getSlackBotToken('T1')).toBe('xoxe.xoxb-new');
    expect(calls).toEqual([
      { grant_type: 'refresh_token', refresh_token: 'xoxe-1-old', client_id: 'cid', client_secret: 'csecret' },
    ]);
    const r = await row();
    expect(decryptString(r.accessTokenEnc as EncryptedEnvelope)).toBe('xoxe.xoxb-new');
    expect(decryptString(r.refreshTokenEnc as EncryptedEnvelope)).toBe('xoxe-1-new');
    expect(r.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000);
    expect(r.refreshLeaseUntil).toBeNull();
    // The next call uses the new token without another refresh.
    expect(await getSlackBotToken('T1')).toBe('xoxe.xoxb-new');
    expect(calls).toHaveLength(1);
  });

  it('two concurrent callers spend the refresh token once', async () => {
    await seed(60_000);
    const results = await Promise.all([getSlackBotToken('T1'), getSlackBotToken('T1'), getSlackBotToken('T1')]);
    expect(results).toEqual(['xoxe.xoxb-new', 'xoxe.xoxb-new', 'xoxe.xoxb-new']);
    expect(calls).toHaveLength(1);
  });

  it('waits for another replica holding the lease and reads its token', async () => {
    await seed(60_000, { refreshLeaseUntil: new Date(Date.now() + 30_000) });
    // A drizzle builder runs only when awaited, hence the async callback.
    setTimeout(async () => {
      await db
        .update(slackInstallations)
        .set({
          accessTokenEnc: encryptString('xoxe.xoxb-other-replica'),
          refreshTokenEnc: encryptString('xoxe-1-other'),
          expiresAt: new Date(Date.now() + 12 * 3600_000),
          refreshLeaseUntil: null,
        })
        .where(eq(slackInstallations.teamId, 'T1'));
    }, 300);
    expect(await getSlackBotToken('T1')).toBe('xoxe.xoxb-other-replica');
    expect(calls).toHaveLength(0);
  });

  it('takes over an expired lease', async () => {
    await seed(60_000, { refreshLeaseUntil: new Date(Date.now() - 1000) });
    expect(await getSlackBotToken('T1')).toBe('xoxe.xoxb-new');
    expect(calls).toHaveLength(1);
  });

  it.each(['invalid_refresh_token', 'token_revoked', 'app_uninstalled'])(
    'records a dead grant (%s) and stops trying',
    async (code) => {
      await seed(60_000);
      answer = () => Response.json({ ok: false, error: code });
      expect(await getSlackBotToken('T1')).toBeNull();
      const r = await row();
      expect(r.tokenError).toBe(code);
      expect(r.accessTokenEnc).toBeNull();
      expect(r.refreshTokenEnc).toBeNull();
      expect(await getSlackBotToken('T1')).toBeNull();
      expect(calls).toHaveLength(1);
    }
  );

  it.each([
    ['a rate limit', () => Response.json({ ok: false, error: 'ratelimited' })],
    ['a 503', () => new Response('down', { status: 503 })],
    ['a client misconfiguration', () => Response.json({ ok: false, error: 'bad_client_secret' })],
  ])('keeps the grant and the still-valid token after %s', async (_n, fail) => {
    await seed(60_000);
    answer = fail;
    expect(await getSlackBotToken('T1')).toBe('xoxe.xoxb-old');
    const r = await row();
    expect(r.tokenError).toBeNull();
    expect(decryptString(r.refreshTokenEnc as EncryptedEnvelope)).toBe('xoxe-1-old');
    expect(r.refreshLeaseUntil).toBeNull();
  });

  it('returns null after a transient failure once the old token has really expired', async () => {
    await seed(-1000);
    answer = () => new Response('down', { status: 503 });
    expect(await getSlackBotToken('T1')).toBeNull();
    expect((await row()).tokenError).toBeNull();
  });
});
