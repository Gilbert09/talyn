import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  normalizeSlackEmojiName,
  validateSlackTriggerEmojis,
  type SlackStatus,
  type SlackUserLinkView,
} from '@talyn/shared';
import { slackPublicRoutes, slackRoutes } from '../../routes/slack.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import {
  slackInstallations,
  slackOauthStates,
  slackUserLinks,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { resetFeatureFlagsForTests } from '../../services/featureFlags.js';
import { resetWebAppUrlCacheForTests } from '../../services/webApp.js';
import { decryptString, encryptString, type EncryptedEnvelope } from '../../services/tokenCrypto.js';
import { hashState } from '../../services/slack/oauth.js';

/**
 * The /slack routes and the shared OAuth callback.
 *
 * Pinned: the flag gates every route; both flows send PKCE and are told apart
 * only by the server-side state, which is single use and expires; an install
 * stores encrypted rotating tokens and links the installer; a link needs an
 * installed team and an identity Slack vouches for; a person can only touch
 * their own links and workspaces; only the installer can forget a token.
 */

const OTHER = 'user-other';
const REDIRECT = 'https://prod.talyn.dev/api/v1/slack/oauth/callback';
const ENV_KEYS = [
  'TALYN_TOKEN_KEY',
  'SLACK_ENABLED',
  'SLACK_APP_CLIENT_ID',
  'SLACK_APP_CLIENT_SECRET',
  'SLACK_MCP_CLIENT_ID',
  'SLACK_MCP_CLIENT_SECRET',
  'SLACK_OAUTH_REDIRECT_URI',
  'WEB_APP_URL',
] as const;

function headersFor(userId: string, extra: Record<string, string> = {}) {
  return { ...internalProxyHeaders(userId), 'content-type': 'application/json', ...extra };
}

describe('Slack routes', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let server: Server;
  let base: string;
  const prior: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;
  /** Every Slack Web API call: the method and its form or bearer token. */
  let slackCalls: Array<{ method: string; form: Record<string, string>; auth?: string }>;
  /** What each Slack method answers next. */
  let slackAnswers: Record<string, () => Response>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    for (const k of ENV_KEYS) prior[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.SLACK_ENABLED = 'true';
    // Only the MCP pair is set: the app pair falls back to it.
    process.env.SLACK_MCP_CLIENT_ID = 'cid';
    process.env.SLACK_MCP_CLIENT_SECRET = 'csecret';
    process.env.SLACK_OAUTH_REDIRECT_URI = REDIRECT;
    resetFeatureFlagsForTests();
    resetWebAppUrlCacheForTests();

    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: OTHER });
    await db.insert(workspacesTable).values([
      { id: 'ws1', ownerId: TEST_USER_ID, name: 'Mine', createdAt: new Date('2026-01-01') },
      { id: 'ws2', ownerId: TEST_USER_ID, name: 'Mine too', createdAt: new Date('2026-02-01') },
      { id: 'ws-other', ownerId: OTHER, name: 'Theirs' },
    ]);

    slackCalls = [];
    slackAnswers = {
      'oauth.v2.access': () =>
        Response.json({
          ok: true,
          access_token: 'xoxe.xoxb-bot',
          refresh_token: 'xoxe-1-refresh',
          expires_in: 43_200,
          token_type: 'bot',
          scope: 'app_mentions:read,reactions:write',
          bot_user_id: 'UBOT',
          app_id: 'A1',
          team: { id: 'T1', name: 'Acme' },
          authed_user: { id: 'UINSTALLER' },
        }),
      'auth.test': () => Response.json({ ok: true, user: 'talyn', url: 'https://acme.slack.com/' }),
      'openid.connect.token': () => Response.json({ ok: true, access_token: 'xoxp-user', id_token: 'ignored' }),
      'openid.connect.userInfo': () =>
        Response.json({ ok: true, sub: 'U9', 'https://slack.com/user_id': 'U9', 'https://slack.com/team_id': 'T1' }),
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (!target.startsWith('https://slack.com/api/')) return realFetch(input, init);
      const method = target.slice('https://slack.com/api/'.length);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      slackCalls.push({
        method,
        form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))),
        auth: headers.authorization,
      });
      const answer = slackAnswers[method];
      if (!answer) throw new Error(`unexpected Slack call ${method}`);
      return answer();
    }) as typeof fetch;

    const app = express();
    app.use(express.json());
    app.use('/slack', wrapAsyncRoutes(slackPublicRoutes()));
    app.use('/slack', requireAuth, wrapAsyncRoutes(slackRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await cleanup();
    for (const k of ENV_KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
    resetFeatureFlagsForTests();
    resetWebAppUrlCacheForTests();
  });

  async function call<T>(method: string, path: string, opts: { user?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: headersFor(opts.user ?? TEST_USER_ID, opts.headers),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return { status: res.status, body: (await res.json()) as { success: boolean; data?: T; error?: string; code?: string } };
  }

  async function start(flow: 'install' | 'link', opts: { user?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await call<{ authorizeUrl: string }>('POST', `/slack/${flow}`, { body: {}, ...opts });
    expect(res.status).toBe(200);
    const url = new URL(res.body.data!.authorizeUrl);
    return { url, state: url.searchParams.get('state')! };
  }

  async function callback(query: Record<string, string>) {
    const res = await realFetch(`${base}/slack/oauth/callback?${new URLSearchParams(query)}`, { redirect: 'manual' });
    return { status: res.status, text: await res.text(), location: res.headers.get('location') };
  }

  async function seedInstall(teamId = 'T1', installedBy = TEST_USER_ID) {
    await db.insert(slackInstallations).values({
      teamId,
      teamName: `Team ${teamId}`,
      appId: 'A1',
      botUserId: 'UBOT',
      botName: 'talyn',
      accessTokenEnc: encryptString('xoxb'),
      installedByUserId: installedBy,
    });
  }

  async function links() {
    return db.select().from(slackUserLinks);
  }

  // -------------------------------------------------------------------------
  // Flag and configuration
  // -------------------------------------------------------------------------

  it.each([
    ['GET', '/slack'],
    ['POST', '/slack/install'],
    ['POST', '/slack/link'],
    ['PATCH', '/slack/links/l1'],
    ['DELETE', '/slack/links/l1'],
    ['DELETE', '/slack/installations/T1'],
  ])('%s %s answers 403 slack_unavailable when the flag is off', async (method, path) => {
    process.env.SLACK_ENABLED = 'false';
    resetFeatureFlagsForTests();
    const res = await call(method, path, { body: method === 'GET' || method === 'DELETE' ? undefined : {} });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('slack_unavailable');
  });

  it.each(['install', 'link'])('POST /%s answers 503 slack_not_configured without a redirect URI', async (flow) => {
    delete process.env.SLACK_OAUTH_REDIRECT_URI;
    const res = await call('POST', `/slack/${flow}`, { body: {} });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('slack_not_configured');
  });

  it('prefers the SLACK_APP_* pair over the MCP pair', async () => {
    process.env.SLACK_APP_CLIENT_ID = 'app-cid';
    process.env.SLACK_APP_CLIENT_SECRET = 'app-secret';
    const { url } = await start('install');
    expect(url.searchParams.get('client_id')).toBe('app-cid');
  });

  // -------------------------------------------------------------------------
  // Authorize URLs
  // -------------------------------------------------------------------------

  it('builds the install URL with the bot scopes and PKCE, and stores only a state hash', async () => {
    const { url, state } = await start('install');
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')!.split(',')).toEqual([
      'app_mentions:read', 'reactions:read', 'reactions:write', 'channels:history', 'groups:history',
      'im:history', 'mpim:history', 'channels:read', 'groups:read', 'users:read',
    ]);
    expect(url.searchParams.get('scope')).not.toContain('chat:write');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await db.select().from(slackOauthStates);
    expect(rows).toHaveLength(1);
    expect(rows[0].stateHash).toBe(hashState(state));
    expect(rows[0].stateHash).not.toBe(state);
    expect(rows[0].flow).toBe('install');
    // No workspace asked for: the caller's first one.
    expect(rows[0].workspaceId).toBe('ws1');
    expect(rows[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  });

  it('builds the link URL for Sign in with Slack', async () => {
    const { url } = await start('link', { body: { workspaceId: 'ws2' } });
    expect(url.origin + url.pathname).toBe('https://slack.com/openid/connect/authorize');
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect((await db.select().from(slackOauthStates))[0].workspaceId).toBe('ws2');
  });

  it.each(['install', 'link'])('POST /%s refuses another user’s workspace with 404', async (flow) => {
    const res = await call('POST', `/slack/${flow}`, { body: { workspaceId: 'ws-other' } });
    expect(res.status).toBe(404);
    expect(await db.select().from(slackOauthStates)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Install callback
  // -------------------------------------------------------------------------

  it('install stores encrypted rotating tokens and links the installer', async () => {
    const { url, state } = await start('install');
    const res = await callback({ code: 'c1', state });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Slack connected');

    const exchange = slackCalls.find((c) => c.method === 'oauth.v2.access')!;
    expect(exchange.form).toMatchObject({ code: 'c1', client_id: 'cid', client_secret: 'csecret', redirect_uri: REDIRECT });
    const challenge = createHash('sha256').update(exchange.form.code_verifier).digest('base64url');
    expect(challenge).toBe(url.searchParams.get('code_challenge'));
    expect(slackCalls.find((c) => c.method === 'auth.test')?.auth).toBe('Bearer xoxe.xoxb-bot');

    const [install] = await db.select().from(slackInstallations);
    expect(install).toMatchObject({
      teamId: 'T1', teamName: 'Acme', teamUrl: 'https://acme.slack.com/', appId: 'A1',
      botUserId: 'UBOT', botName: 'talyn', installedByUserId: TEST_USER_ID, tokenError: null,
    });
    expect(JSON.stringify(install.accessTokenEnc)).not.toContain('xoxe');
    expect(decryptString(install.accessTokenEnc as EncryptedEnvelope)).toBe('xoxe.xoxb-bot');
    expect(decryptString(install.refreshTokenEnc as EncryptedEnvelope)).toBe('xoxe-1-refresh');
    expect(install.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 11 * 3600_000);

    const ls = await links();
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ teamId: 'T1', slackUserId: 'UINSTALLER', userId: TEST_USER_ID, workspaceId: 'ws1' });
  });

  it('a reinstall updates the row and clears a recorded token error', async () => {
    await seedInstall('T1', OTHER);
    await db.update(slackInstallations).set({ tokenError: 'token_revoked', accessTokenEnc: null });
    const { state } = await start('install');
    expect((await callback({ code: 'c', state })).status).toBe(200);
    const rows = await db.select().from(slackInstallations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokenError: null, installedByUserId: TEST_USER_ID, teamName: 'Acme' });
  });

  it('refuses an org-wide install', async () => {
    slackAnswers['oauth.v2.access'] = () =>
      Response.json({ ok: true, access_token: 'x', token_type: 'bot', bot_user_id: 'U', app_id: 'A', team: null, is_enterprise_install: true });
    const { state } = await start('install');
    const res = await callback({ code: 'c', state });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Enterprise Grid');
    expect(await db.select().from(slackInstallations)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // State handling
  // -------------------------------------------------------------------------

  it('a state works once: a replayed callback is refused and spends nothing', async () => {
    const { state } = await start('install');
    expect((await callback({ code: 'c', state })).status).toBe(200);
    const again = await callback({ code: 'c', state });
    expect(again.status).toBe(400);
    expect(again.text).toContain('expired or was already used');
    expect(slackCalls.filter((c) => c.method === 'oauth.v2.access')).toHaveLength(1);
  });

  it.each([
    ['an expired state', async (state: string) => {
      await db.update(slackOauthStates).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(slackOauthStates.stateHash, hashState(state)));
      return state;
    }],
    ['an unknown state', async () => 'not-a-state'],
    ['a state row with an unknown flow', async (state: string) => {
      await db.update(slackOauthStates).set({ flow: 'admin' }).where(eq(slackOauthStates.stateHash, hashState(state)));
      return state;
    }],
  ])('refuses %s without calling Slack', async (_n, prepare) => {
    const { state } = await start('install');
    const res = await callback({ code: 'c', state: await prepare(state) });
    expect(res.status).toBe(400);
    expect(slackCalls).toHaveLength(0);
  });

  it('a cancelled sign-in consumes the state', async () => {
    const { state } = await start('link');
    const res = await callback({ error: 'access_denied', state });
    expect(res.status).toBe(400);
    expect(res.text).toContain('cancelled');
    expect(await db.select().from(slackOauthStates)).toHaveLength(0);
  });

  it.each([
    ['install', ['oauth.v2.access', 'auth.test']],
    ['link', ['openid.connect.token', 'openid.connect.userInfo']],
  ] as const)('the %s state alone decides which token endpoint the code goes to', async (flow, methods) => {
    await seedInstall('T1', OTHER);
    const { state } = await start(flow);
    await callback({ code: 'c', state });
    expect(slackCalls.map((c) => c.method)).toEqual(methods);
  });

  it('refuses at the callback when the flag was switched off after the start', async () => {
    const { state } = await start('install');
    process.env.SLACK_ENABLED = 'false';
    resetFeatureFlagsForTests();
    const res = await callback({ code: 'c', state });
    expect(res.status).toBe(403);
    expect(slackCalls).toHaveLength(0);
  });

  it('the web client is sent back to its settings page', async () => {
    process.env.WEB_APP_URL = 'https://app.talyn.dev';
    resetWebAppUrlCacheForTests();
    const { state } = await start('install', { headers: { origin: 'https://app.talyn.dev' } });
    const ok = await callback({ code: 'c', state });
    expect(ok.status).toBe(302);
    expect(ok.location).toBe('https://app.talyn.dev/settings?slack=installed');

    const { state: s2 } = await start('link', { headers: { origin: 'https://app.talyn.dev' } });
    slackAnswers['openid.connect.userInfo'] = () =>
      Response.json({ ok: true, 'https://slack.com/user_id': 'U9', 'https://slack.com/team_id': 'T-none' });
    const bad = await callback({ code: 'c', state: s2 });
    expect(bad.status).toBe(302);
    const target = new URL(bad.location!);
    expect(target.searchParams.get('slack')).toBe('error');
    expect(target.searchParams.get('message')).toContain('not installed');
  });

  // -------------------------------------------------------------------------
  // Link callback
  // -------------------------------------------------------------------------

  it('links the identity Slack vouches for', async () => {
    await seedInstall('T1', OTHER);
    const { state } = await start('link', { body: { workspaceId: 'ws2' } });
    const res = await callback({ code: 'c', state });
    expect(res.status).toBe(200);
    expect(slackCalls.find((c) => c.method === 'openid.connect.userInfo')?.auth).toBe('Bearer xoxp-user');
    const ls = await links();
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ teamId: 'T1', slackUserId: 'U9', userId: TEST_USER_ID, workspaceId: 'ws2' });
  });

  it('refuses a link to a team with no installation', async () => {
    const { state } = await start('link');
    const res = await callback({ code: 'c', state });
    expect(res.status).toBe(400);
    expect(res.text).toContain('not installed in that Slack workspace');
    expect(await links()).toHaveLength(0);
  });

  it('refuses when Slack does not name the user', async () => {
    await seedInstall('T1', OTHER);
    slackAnswers['openid.connect.userInfo'] = () => Response.json({ ok: true, sub: 'U9' });
    const { state } = await start('link');
    expect((await callback({ code: 'c', state })).status).toBe(400);
    expect(await links()).toHaveLength(0);
  });

  it('a re-link by the same user keeps emojis and workspace', async () => {
    await seedInstall('T1', OTHER);
    await db.insert(slackUserLinks).values({
      id: 'l1', teamId: 'T1', slackUserId: 'U9', userId: TEST_USER_ID, workspaceId: 'ws2', triggerEmojis: ['robot_face'],
    });
    const { state } = await start('link');
    await callback({ code: 'c', state });
    expect(await links()).toMatchObject([{ id: 'l1', workspaceId: 'ws2', triggerEmojis: ['robot_face'] }]);
  });

  it('an identity proven by another Talyn user moves to them with settings reset', async () => {
    await seedInstall('T1', OTHER);
    await db.insert(slackUserLinks).values({
      id: 'l1', teamId: 'T1', slackUserId: 'U9', userId: OTHER, workspaceId: 'ws-other', triggerEmojis: ['eyes'],
    });
    const { state } = await start('link');
    await callback({ code: 'c', state });
    expect(await links()).toMatchObject([{ id: 'l1', userId: TEST_USER_ID, workspaceId: 'ws1', triggerEmojis: [] }]);
  });

  it('a user’s older identity in the same team is replaced', async () => {
    await seedInstall('T1', OTHER);
    await db.insert(slackUserLinks).values({ id: 'old', teamId: 'T1', slackUserId: 'U-old', userId: TEST_USER_ID });
    const { state } = await start('link');
    await callback({ code: 'c', state });
    const ls = await links();
    expect(ls.map((l) => l.slackUserId)).toEqual(['U9']);
  });

  // -------------------------------------------------------------------------
  // GET / PATCH / DELETE
  // -------------------------------------------------------------------------

  it('GET /slack shows installs I made or am linked in, and only my links', async () => {
    await seedInstall('T1', TEST_USER_ID);
    await seedInstall('T2', OTHER);
    await seedInstall('T3', OTHER);
    await db.update(slackInstallations).set({ tokenError: 'token_revoked' }).where(eq(slackInstallations.teamId, 'T2'));
    await db.insert(slackUserLinks).values([
      { id: 'l-mine', teamId: 'T2', slackUserId: 'U1', userId: TEST_USER_ID, triggerEmojis: ['eyes'] },
      { id: 'l-gone', teamId: 'T-forgotten', slackUserId: 'U1', userId: TEST_USER_ID },
      { id: 'l-theirs', teamId: 'T3', slackUserId: 'U2', userId: OTHER },
    ]);
    const res = await call<SlackStatus>('GET', '/slack');
    expect(res.status).toBe(200);
    const data = res.body.data!;
    expect(data.installations.map((i) => [i.teamId, i.installedByMe, i.needsReinstall, i.botName])).toEqual([
      ['T1', true, false, 'talyn'],
      ['T2', false, true, 'talyn'],
    ]);
    expect(data.links.map((l) => [l.id, l.teamName, l.installed, l.triggerEmojis])).toEqual([
      ['l-mine', 'Team T2', true, ['eyes']],
      ['l-gone', null, false, []],
    ]);
  });

  async function seedMyLink() {
    await db.insert(slackUserLinks).values([
      { id: 'mine', teamId: 'T1', slackUserId: 'U1', userId: TEST_USER_ID, workspaceId: 'ws1' },
      { id: 'theirs', teamId: 'T1', slackUserId: 'U2', userId: OTHER, workspaceId: 'ws-other' },
    ]);
  }

  it.each([
    [[':robot_face:', 'Eyes', 'eyes', '+1', 'thumbsup', 'white_check_mark'], ['robot_face', 'eyes', '+1', 'thumbsup', 'white_check_mark']],
    [[], []],
    [['-1', 'my-custom_emoji2'], ['-1', 'my-custom_emoji2']],
  ])('PATCH normalizes trigger emojis %j', async (input, stored) => {
    await seedMyLink();
    const res = await call<SlackUserLinkView>('PATCH', '/slack/links/mine', { body: { triggerEmojis: input } });
    expect(res.status).toBe(200);
    expect(res.body.data!.triggerEmojis).toEqual(stored);
    expect((await db.select().from(slackUserLinks).where(eq(slackUserLinks.id, 'mine')))[0].triggerEmojis).toEqual(stored);
  });

  it.each([
    ['not a list', 'robot_face'],
    ['a non-string', [1]],
    ['an empty name', ['::']],
    ['a space', ['robot face']],
    ['a skin-tone suffix', ['thumbsup::skin-tone-2']],
    ['a non-ASCII name', ['café']],
    ['an over-long name', ['a'.repeat(101)]],
  ])('PATCH refuses %s with 400 and changes nothing', async (_n, input) => {
    await seedMyLink();
    const res = await call('PATCH', '/slack/links/mine', { body: { triggerEmojis: input } });
    expect(res.status).toBe(400);
    expect((await db.select().from(slackUserLinks).where(eq(slackUserLinks.id, 'mine')))[0].triggerEmojis).toEqual([]);
  });

  it('PATCH moves sessions to another of my workspaces', async () => {
    await seedMyLink();
    const res = await call<SlackUserLinkView>('PATCH', '/slack/links/mine', { body: { workspaceId: 'ws2' } });
    expect(res.status).toBe(200);
    expect(res.body.data!.workspaceId).toBe('ws2');
  });

  it.each([
    ['someone else’s link', 'theirs', { triggerEmojis: ['eyes'] }],
    ['a missing link', 'nope', { triggerEmojis: ['eyes'] }],
    ['someone else’s workspace', 'mine', { workspaceId: 'ws-other' }],
  ])('PATCH answers 404 for %s', async (_n, id, body) => {
    await seedMyLink();
    const res = await call('PATCH', `/slack/links/${id}`, { body });
    expect(res.status).toBe(404);
    const rows = await db.select().from(slackUserLinks);
    expect(rows.find((r) => r.id === 'theirs')).toMatchObject({ triggerEmojis: [], workspaceId: 'ws-other' });
    expect(rows.find((r) => r.id === 'mine')).toMatchObject({ workspaceId: 'ws1' });
  });

  it('DELETE removes only my own link', async () => {
    await seedMyLink();
    expect((await call('DELETE', '/slack/links/theirs')).status).toBe(404);
    expect((await call('DELETE', '/slack/links/mine')).status).toBe(200);
    expect((await links()).map((l) => l.id)).toEqual(['theirs']);
  });

  it.each([
    ['the installer', TEST_USER_ID, 200],
    ['a linked user who did not install', OTHER, 403],
    ['a stranger', 'user-stranger', 404],
  ])('DELETE /installations/:teamId by %s', async (_n, user, status) => {
    await seedUser(db, { id: 'user-stranger' });
    await seedInstall('T1', TEST_USER_ID);
    await seedMyLink();
    const res = await call<{ message: string }>('DELETE', '/slack/installations/T1', { user });
    expect(res.status).toBe(status);
    const installs = await db.select().from(slackInstallations);
    expect(installs).toHaveLength(status === 200 ? 0 : 1);
    if (status === 200) expect(res.body.data!.message).toContain('still installed in Slack');
    // Links outlive a forgotten token, so a reinstall restores them.
    expect(await links()).toHaveLength(2);
  });
});

describe('Slack trigger-emoji validation', () => {
  it.each([
    [':tada:', 'tada'],
    ['  Robot_Face ', 'robot_face'],
    ['+1', '+1'],
    ['::eyes::', 'eyes'],
    ['a'.repeat(100), 'a'.repeat(100)],
    ['a'.repeat(101), null],
    ['', null],
    [':', null],
    ['white check', null],
    ['emoji:inner', null],
    ['ünicode', null],
  ])('normalizeSlackEmojiName(%j) = %j', (raw, expected) => {
    expect(normalizeSlackEmojiName(raw)).toBe(expected);
  });

  it('dedupes after normalizing and keeps the first order', () => {
    expect(validateSlackTriggerEmojis([':eyes:', 'EYES', 'tada', 'eyes'])).toEqual({ ok: true, emojis: ['eyes', 'tada'] });
  });

  it('names the bad entry', () => {
    const result = validateSlackTriggerEmojis(['eyes', 'bad name']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('"bad name"');
  });
});
