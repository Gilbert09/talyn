import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { POSTHOG_INBOX_OAUTH_SCOPES } from '@talyn/shared';
import { posthogPublicRoutes, posthogRoutes } from '../routes/posthog.js';
import { posthogInboxRoutes } from '../routes/posthogInbox.js';
import { cloudProviderRoutes } from '../routes/cloudProviders.js';
import { wrapAsyncRoutes } from '../middleware/asyncHandler.js';
import { resetPostHogOAuthConfigForTests } from '../services/posthogCode/oauthConfig.js';
import { resetWebAppUrlCacheForTests } from '../services/webApp.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { registerCloudProvider } from '../services/cloudProviders/registry.js';
import { postHogCodeProvider } from '../services/cloudProviders/posthog/provider.js';
import { ensureCloudEnvironment, notifyProviderConnected } from '../services/cloudProviders/environment.js';
import { encryptString, decryptString } from '../services/tokenCrypto.js';
import {
  getPostHogCodeCredentials,
  removePostHogCodeCredentials,
} from '../services/posthogCode/credentials.js';
import {
  completeAuthorization,
  consumeState,
  ensureFreshAccessToken,
  startAuthorization,
} from '../services/posthogCode/oauth.js';
import {
  completeInboxAuthorization,
  ensureFreshInboxAccessToken,
  startInboxAuthorization,
} from '../services/posthogInbox/oauth.js';
import { removeInboxConnection, storeInboxApiKey } from '../services/posthogInbox/credentials.js';
import {
  getPostHogInboxConnection,
  missingInboxScopes,
  postHogCodeRowServesInbox,
  storedInboxAccess,
} from '../services/posthogInbox/connection.js';
import { posthogInboxStatus } from '../services/posthogInbox/preview.js';
import { clearInboxPollerBackoff, preferInboxRows } from '../services/posthogInbox/poller.js';
import {
  isPostHogOAuthKind,
  refreshLockKey,
  resetPostHogOAuthInflightForTests,
  rowTypeForKind,
} from '../services/posthogOAuth/core.js';
import { integrations, posthogInboxPollers, posthogOauthStates, workspaces } from '../db/schema.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';

/**
 * The PostHog Inbox's own PostHog connection: its OAuth flow on the shared
 * callback, the state kind, the stored scopes, the single-flight refresh, the
 * resolver order (Inbox row, then a PostHog Code row that can serve it), the
 * isolation of the two rows, the routes and their flag, and that the Inbox is
 * never a cloud provider.
 */

vi.mock('../services/cloudProviders/environment.js', () => ({
  ensureCloudEnvironment: vi.fn(async () => undefined),
  notifyProviderConnected: vi.fn(),
}));

registerCloudProvider(postHogCodeProvider);

const WS = 'ws1';
const HOST = 'https://us.posthog.com';
const WEB_APP = 'https://app.talyn.dev';
const CLIENT_ID = 'https://www.talyn.dev/oauth-client';
const REDIRECT_URI = 'https://prod.talyn.dev/api/v1/posthog/oauth/callback';
const INBOX_SCOPE = 'openid inbox:read inbox:write task:write';
const ENV_KEYS = [
  'WEB_APP_URL',
  'TALYN_TOKEN_KEY',
  'POSTHOG_OAUTH_CLIENT_ID',
  'POSTHOG_OAUTH_REDIRECT_URI',
  'POSTHOG_CODE_RETIRED',
  'POSTHOG_INBOX_RULES_ENABLED',
] as const;
const saved: Record<string, string | undefined> = {};
// One key for the whole file: the case tables below encrypt at collect time.
const TOKEN_KEY = randomBytes(32).toString('base64');
const priorTokenKey = process.env.TALYN_TOKEN_KEY;
process.env.TALYN_TOKEN_KEY = TOKEN_KEY;
const realFetch = globalThis.fetch;

type Row = typeof integrations.$inferInsert;

function oauthConfig(over: { scope?: string; reauth?: boolean; expiresInMs?: number; access?: string; refresh?: string; projectId?: string } = {}) {
  return {
    projectId: over.projectId ?? '42',
    host: HOST,
    authMethod: 'oauth' as const,
    oauth: {
      accessTokenEnc: encryptString(over.access ?? 'pha_old'),
      refreshTokenEnc: encryptString(over.refresh ?? 'phr_old'),
      expiresAt: new Date(Date.now() + (over.expiresInMs ?? 3_600_000)).toISOString(),
      scope: over.scope,
      clientId: CLIENT_ID,
      ...(over.reauth ? { reauthRequiredAt: new Date().toISOString() } : {}),
    },
  };
}

function keyConfig(projectId = '7') {
  return { apiKeyEnc: encryptString('phx_key'), projectId, host: HOST, authMethod: 'personal_api_key' as const };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('PostHog Inbox connection', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let url: string;
  let close: () => Promise<void>;
  /** Calls to PostHog. Anything to the local test server goes to the real fetch. */
  let posthog: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.WEB_APP_URL = WEB_APP;
    process.env.TALYN_TOKEN_KEY = TOKEN_KEY;
    process.env.POSTHOG_OAUTH_CLIENT_ID = CLIENT_ID;
    process.env.POSTHOG_OAUTH_REDIRECT_URI = REDIRECT_URI;
    // PostHog Code retired (its production default), Inbox rules on.
    process.env.POSTHOG_CODE_RETIRED = 'true';
    process.env.POSTHOG_INBOX_RULES_ENABLED = 'true';
    resetFeatureFlagsForTests();
    resetPostHogOAuthConfigForTests();
    resetWebAppUrlCacheForTests();
    resetPostHogOAuthInflightForTests();
    vi.mocked(ensureCloudEnvironment).mockClear();
    vi.mocked(notifyProviderConnected).mockClear();

    posthog = vi.fn(async () => {
      throw new Error('unexpected PostHog call');
    });
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.startsWith(HOST)) return posthog(target, init);
      return realFetch(input, init);
    });

    testDb = await createTestDb();
    await seedUser(testDb.db, { id: TEST_USER_ID });
    await testDb.db.insert(workspaces).values({ id: WS, ownerId: TEST_USER_ID, name: 'A' });

    const app = express();
    app.use(express.json());
    app.use('/api/v1/posthog', wrapAsyncRoutes(posthogPublicRoutes()));
    app.use((req, _res, next) => {
      req.user = { id: TEST_USER_ID, email: 'a@example.test', isAdmin: false };
      next();
    });
    app.use('/api/v1/posthog', wrapAsyncRoutes(posthogRoutes()));
    app.use('/api/v1/posthog-inbox', wrapAsyncRoutes(posthogInboxRoutes()));
    app.use('/api/v1/cloud-providers', wrapAsyncRoutes(cloudProviderRoutes()));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    close = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
  });

  afterEach(async () => {
    await close();
    await testDb.cleanup();
    vi.unstubAllGlobals();
    for (const k of ENV_KEYS) {
      if (k === 'TALYN_TOKEN_KEY') process.env[k] = TOKEN_KEY;
      else if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetPostHogOAuthConfigForTests();
    resetWebAppUrlCacheForTests();
    resetFeatureFlagsForTests();
    resetPostHogOAuthInflightForTests();
  });

  afterAll(() => {
    if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorTokenKey;
  });

  async function insert(row: Partial<Row> & Pick<Row, 'type' | 'config'>): Promise<void> {
    await testDb.db.insert(integrations).values({
      id: row.id ?? `int-${row.type}`,
      workspaceId: WS,
      enabled: row.enabled ?? true,
      type: row.type,
      config: row.config,
    });
  }

  async function rowTypes(): Promise<string[]> {
    const rows = await testDb.db.select({ type: integrations.type }).from(integrations).where(eq(integrations.workspaceId, WS));
    return rows.map((r) => r.type).sort();
  }

  async function inboxConfig() {
    const rows = await testDb.db.select({ config: integrations.config }).from(integrations).where(eq(integrations.type, 'posthog_inbox'));
    return rows[0]?.config as ReturnType<typeof oauthConfig> & { apiKeyEnc?: unknown } | undefined;
  }

  function scriptTokenExchange(opts: { scope?: string; scopedTeams?: unknown[] } = {}) {
    posthog.mockImplementation(async (target: string) => {
      if (target.endsWith('/oauth/token/')) {
        return jsonResponse({
          access_token: 'pha_new',
          refresh_token: 'phr_new',
          expires_in: 3600,
          ...(opts.scope === undefined ? { scope: INBOX_SCOPE } : opts.scope === '' ? {} : { scope: opts.scope }),
        });
      }
      if (target.endsWith('/oauth/introspect/')) return jsonResponse({ active: true, scoped_teams: opts.scopedTeams ?? [42] });
      throw new Error(`unexpected PostHog call ${target}`);
    });
  }

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await res.text();
    let json: { success?: boolean; data?: Record<string, unknown>; error?: string; code?: string } = {};
    try {
      json = JSON.parse(text);
    } catch {
      // An HTML callback page.
    }
    return { status: res.status, json, text, location: res.headers.get('location') };
  }

  async function startInboxState(origin?: string): Promise<string> {
    const res = await call('POST', '/posthog-inbox/oauth/start', { workspaceId: WS }, origin ? { origin } : {});
    expect(res.status).toBe(200);
    return new URL(res.json.data!.authorizeUrl as string).searchParams.get('state')!;
  }

  // ---- OAuth start ----------------------------------------------------------

  describe('starting the Inbox OAuth flow', () => {
    it.each([
      ['PostHog Code retired, no PostHog Code row', 'true'],
      ['PostHog Code not retired', 'false'],
    ])('works with %s', async (_label, retired) => {
      process.env.POSTHOG_CODE_RETIRED = retired;
      resetFeatureFlagsForTests();
      const res = await call('POST', '/posthog-inbox/oauth/start', { workspaceId: WS, projectId: '42' });
      expect(res.status).toBe(200);
      const authorize = new URL(res.json.data!.authorizeUrl as string);
      expect(authorize.origin).toBe(HOST);
      expect(authorize.searchParams.get('scope')).toBe(POSTHOG_INBOX_OAUTH_SCOPES.join(' '));
      expect(authorize.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(authorize.searchParams.get('required_access_level')).toBe('project');
      expect(authorize.searchParams.get('team_id')).toBe('42');
      const states = await testDb.db.select({ kind: posthogOauthStates.kind, mobileReturn: posthogOauthStates.mobileReturn }).from(posthogOauthStates);
      expect(states).toEqual([{ kind: 'posthog_inbox', mobileReturn: null }]);
    });

    it('asks for exactly the Inbox scopes, and nothing from PostHog Code', () => {
      expect([...POSTHOG_INBOX_OAUTH_SCOPES]).toEqual(['openid', 'inbox:read', 'inbox:write', 'task:write']);
      expect(POSTHOG_INBOX_OAUTH_SCOPES).not.toContain('task:read');
    });

    it('still refuses the PostHog Code connect for the same workspace', async () => {
      const res = await call('POST', '/posthog/oauth/start', { workspaceId: WS });
      expect(res.status).toBe(410);
      expect(res.json.code).toBe('posthog_code_retired');
    });

    it('records PostHog Code states as posthog_code', async () => {
      process.env.POSTHOG_CODE_RETIRED = 'false';
      resetFeatureFlagsForTests();
      await startAuthorization({ workspaceId: WS, userId: TEST_USER_ID, client: 'desktop' });
      await startInboxAuthorization({ workspaceId: WS, userId: TEST_USER_ID, client: 'web' });
      const kinds = (await testDb.db.select({ kind: posthogOauthStates.kind, client: posthogOauthStates.client }).from(posthogOauthStates))
        .map((r) => `${r.kind}:${r.client}`)
        .sort();
      expect(kinds).toEqual(['posthog_code:desktop', 'posthog_inbox:web']);
    });

    it('refuses when this deployment has no PostHog OAuth', async () => {
      delete process.env.POSTHOG_OAUTH_CLIENT_ID;
      resetPostHogOAuthConfigForTests();
      const res = await call('POST', '/posthog-inbox/oauth/start', { workspaceId: WS });
      expect(res.status).toBe(400);
      expect(res.json.code).toBe('posthog_inbox_oauth_unavailable');
    });

    it('refuses a host that is not allowed', async () => {
      const res = await call('POST', '/posthog-inbox/oauth/start', { workspaceId: WS, host: 'https://evil.example.com' });
      expect(res.status).toBe(400);
      expect(await testDb.db.select().from(posthogOauthStates)).toEqual([]);
    });
  });

  // ---- Flag and access -------------------------------------------------------

  describe('the posthogInboxRules flag and workspace access', () => {
    const routes: Array<[string, string, unknown]> = [
      ['POST', '/posthog-inbox/oauth/start', { workspaceId: WS }],
      ['PUT', '/posthog-inbox/config', { workspaceId: WS, apiKey: 'phx', projectId: '7' }],
      ['DELETE', `/posthog-inbox/config?workspaceId=${WS}`, undefined],
    ];

    it.each(routes)('hides %s %s when the flag is off', async (method, path, body) => {
      process.env.POSTHOG_INBOX_RULES_ENABLED = 'false';
      resetFeatureFlagsForTests();
      await insert({ type: 'posthog_inbox', config: keyConfig() });
      const res = await call(method, path, body);
      expect(res.status).toBe(404);
      expect(res.json.code).toBe('posthog_inbox_rules_unavailable');
      expect(await rowTypes()).toEqual(['posthog_inbox']);
      expect(await testDb.db.select().from(posthogOauthStates)).toEqual([]);
      expect(posthog).not.toHaveBeenCalled();
    });

    it.each(routes)('refuses %s %s for another workspace', async (method, path, body) => {
      await seedUser(testDb.db, { id: 'other', email: 'other@example.test' });
      await testDb.db.insert(workspaces).values({ id: 'ws-other', ownerId: 'other', name: 'B' });
      const res = await call(
        method,
        path.replace(WS, 'ws-other'),
        body && typeof body === 'object' ? { ...body, workspaceId: 'ws-other' } : body
      );
      expect([403, 404]).toContain(res.status);
    });

    it.each(routes)('needs a workspaceId on %s %s', async (method, path, body) => {
      const res = await call(
        method,
        path.replace(`?workspaceId=${WS}`, ''),
        body && typeof body === 'object' ? { ...body, workspaceId: undefined } : body
      );
      expect(res.status).toBe(400);
    });
  });

  // ---- Callback -------------------------------------------------------------

  describe('the shared callback', () => {
    it('stores an Inbox grant on its own row, with the retirement flag on', async () => {
      scriptTokenExchange();
      const state = await startInboxState();
      const res = await call('GET', `/posthog/oauth/callback?code=c1&state=${state}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('PostHog Inbox');
      expect(res.text).toContain('project 42');
      expect(await rowTypes()).toEqual(['posthog_inbox']);
      const config = await inboxConfig();
      expect(config).toMatchObject({ projectId: '42', host: HOST, authMethod: 'oauth', oauth: { scope: INBOX_SCOPE, clientId: CLIENT_ID } });
      expect(decryptString(config!.oauth.accessTokenEnc)).toBe('pha_new');
      // Not a cloud provider: no environment marker, no provider notice.
      expect(ensureCloudEnvironment).not.toHaveBeenCalled();
      expect(notifyProviderConnected).not.toHaveBeenCalled();
      expect(await getPostHogCodeCredentials(WS)).toBeNull();
    });

    it.each([
      ['ok', 'connected', undefined],
      ['an error', 'error', 'access_denied'],
    ])('sends the web app back to the Inbox page on %s', async (_label, outcome, error) => {
      scriptTokenExchange();
      const state = await startInboxState(WEB_APP);
      const res = await call('GET', `/posthog/oauth/callback?${new URLSearchParams({ state, ...(error ? { error } : { code: 'c1' }) })}`);
      expect(res.status).toBe(302);
      const location = new URL(res.location!);
      expect(`${location.origin}${location.pathname}`).toBe(`${WEB_APP}/integrations/posthog_inbox`);
      expect(location.searchParams.get('posthog_inbox')).toBe(outcome);
      expect(location.searchParams.has('posthog')).toBe(false);
    });

    it.each([
      ['a cancelled consent', { error: 'access_denied' }, 400, 'access_denied'],
      ['no code', {}, 400, 'Missing code'],
    ])('renders a desktop page for %s', async (_label, params, status, text) => {
      const state = await startInboxState();
      const res = await call('GET', `/posthog/oauth/callback?${new URLSearchParams({ state, ...params })}`);
      expect(res.status).toBe(status);
      expect(res.location).toBeNull();
      expect(res.text).toContain('Connection failed');
      expect(res.text).toContain(text);
      expect(await rowTypes()).toEqual([]);
    });

    it.each([
      ['an organization-wide grant', []],
      ['two projects', [1, 2]],
    ])('refuses %s and stores nothing', async (_label, teams) => {
      scriptTokenExchange({ scopedTeams: teams });
      const state = await startInboxState();
      const res = await call('GET', `/posthog/oauth/callback?code=c1&state=${state}`);
      expect(res.status).toBe(400);
      expect(await rowTypes()).toEqual([]);
    });

    it('is single-use', async () => {
      scriptTokenExchange();
      const state = await startInboxState();
      expect((await call('GET', `/posthog/oauth/callback?code=c1&state=${state}`)).status).toBe(200);
      const replay = await call('GET', `/posthog/oauth/callback?code=c1&state=${state}`);
      expect(replay.status).toBe(400);
      expect(replay.text).toContain('expired');
    });

    it('replaces the Inbox row and leaves the PostHog Code row alone', async () => {
      await insert({ type: 'posthog', config: oauthConfig({ scope: 'openid task:read task:write', access: 'pha_code' }) });
      await insert({ type: 'posthog_inbox', config: keyConfig('7') });
      scriptTokenExchange();
      const state = await startInboxState();
      expect((await call('GET', `/posthog/oauth/callback?code=c1&state=${state}`)).status).toBe(200);
      const inbox = await inboxConfig();
      expect(inbox?.apiKeyEnc).toBeUndefined();
      expect(inbox?.projectId).toBe('42');
      expect(decryptString((await testDb.db.select().from(integrations).where(eq(integrations.type, 'posthog')))[0]!.config.oauth.accessTokenEnc)).toBe('pha_code');
    });

    it('clears the poller backoff of the workspace when the Inbox connects again', async () => {
      await insert({ type: 'posthog_inbox', id: 'int-inbox', config: keyConfig() });
      const later = new Date(Date.now() + 30 * 60_000);
      await testDb.db.insert(posthogInboxPollers).values({
        integrationId: 'int-inbox', workspaceId: WS, nextPollAt: later, lastError: 'forbidden', lastErrorStatus: 403, cursorUpdatedAt: 'c',
      });
      scriptTokenExchange();
      const state = await startInboxState();
      expect((await call('GET', `/posthog/oauth/callback?code=c1&state=${state}`)).status).toBe(200);
      const [poller] = await testDb.db.select().from(posthogInboxPollers);
      expect(poller).toMatchObject({ lastError: null, lastErrorStatus: null, cursorUpdatedAt: 'c' });
      expect(poller!.nextPollAt.getTime()).toBeLessThan(later.getTime());
    });
  });

  // ---- State kind ------------------------------------------------------------

  describe('the state kind', () => {
    it.each([
      ['the PostHog Code completion', 'posthog_inbox', 'code'],
      ['the Inbox completion', 'posthog_code', 'inbox'],
    ] as const)('%s refuses a %s state', async (_label, kind, completion) => {
      scriptTokenExchange();
      await testDb.db.insert(posthogOauthStates).values({
        state: 's1', workspaceId: WS, userId: TEST_USER_ID, codeVerifierEnc: encryptString('v'), host: HOST,
        client: 'desktop', kind, expiresAt: new Date(Date.now() + 60_000),
      });
      const pending = await consumeState('s1');
      expect(pending?.kind).toBe(kind);
      const complete = completion === 'code' ? completeAuthorization : completeInboxAuthorization;
      await expect(complete({ code: 'c', state: pending! })).rejects.toThrow(/another PostHog connection/);
      expect(posthog).not.toHaveBeenCalled();
      expect(await rowTypes()).toEqual([]);
    });

    it('refuses a hand-built state with no kind for the Inbox', async () => {
      await expect(
        completeInboxAuthorization({ code: 'c', state: { workspaceId: WS, userId: TEST_USER_ID, host: HOST, verifier: 'v', client: 'desktop' } })
      ).rejects.toThrow(/another PostHog connection/);
      expect(posthog).not.toHaveBeenCalled();
    });

    it.each(['', 'posthog', 'linear', 'POSTHOG_INBOX'])('refuses a stored kind %j it does not know', async (kind) => {
      await testDb.db.insert(posthogOauthStates).values({
        state: 's1', workspaceId: WS, userId: TEST_USER_ID, codeVerifierEnc: encryptString('v'), host: HOST,
        client: 'desktop', kind, expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await consumeState('s1')).toBeNull();
      // Consumed all the same.
      expect(await testDb.db.select().from(posthogOauthStates)).toEqual([]);
    });

    it.each([
      ['posthog_code', true, 'posthog'],
      ['posthog_inbox', true, 'posthog_inbox'],
    ] as const)('maps %s to its row', (kind, known, type) => {
      expect(isPostHogOAuthKind(kind)).toBe(known);
      expect(rowTypeForKind(kind)).toBe(type);
    });

    it.each([null, undefined, 3, 'posthog'])('does not take %j as a kind', (value) => {
      expect(isPostHogOAuthKind(value)).toBe(false);
    });
  });

  // ---- Scopes ----------------------------------------------------------------

  describe('scopes', () => {
    it.each([
      ['all of them', INBOX_SCOPE, []],
      ['an old PostHog Code grant', 'openid task:read task:write', ['inbox:read', 'inbox:write']],
      ['PostHog Code with the Inbox', 'openid task:read task:write inbox:read inbox:write', []],
      ['read only', 'openid inbox:read', ['inbox:write', 'task:write']],
      ['no task:write', 'openid inbox:read inbox:write', ['task:write']],
      ['nothing', '', ['inbox:read', 'inbox:write', 'task:write']],
      ['no scope at all', undefined, ['inbox:read', 'inbox:write', 'task:write']],
      ['extra spaces', '  inbox:read\tinbox:write   task:write ', []],
      ['a near miss', 'inbox:readx inbox task', ['inbox:read', 'inbox:write', 'task:write']],
    ])('lists what is missing from %s', (_label, scope, missing) => {
      expect(missingInboxScopes(scope)).toEqual(missing);
    });

    it.each([
      ['the full grant', INBOX_SCOPE, 'ok', []],
      // It can read, but it cannot attach a pull request to a claim, so the
      // rules start no session: reconnect, with the missing scope named.
      ['a grant without task:write', 'openid inbox:read inbox:write', 'reconnect', ['task:write']],
      ['a grant without inbox:read', 'openid inbox:write task:write', 'reconnect', ['inbox:read']],
      ['no scope returned', '', 'reconnect', ['inbox:read', 'inbox:write', 'task:write']],
    ])('stores %s and checks it', async (_label, scope, access, missing) => {
      scriptTokenExchange({ scope });
      const state = await startInboxState();
      await call('GET', `/posthog/oauth/callback?code=c1&state=${state}`);
      expect((await inboxConfig())?.oauth.scope).toBe(scope === '' ? undefined : scope);
      const status = await posthogInboxStatus(WS);
      expect(status).toMatchObject({ access, missingScopes: missing, connection: 'posthog_inbox', authMethod: 'oauth', projectId: '42', host: HOST });
      expect(Boolean(await getPostHogInboxConnection(WS))).toBe(access === 'ok');
      // The dry run reads with any grant that has inbox:read.
      expect(Boolean(await getPostHogInboxConnection(WS, 'read'))).toBe(scope.split(' ').includes('inbox:read'));
    });
  });

  // ---- Resolver --------------------------------------------------------------

  describe('the resolver', () => {
    type Setup = Array<Partial<Row> & Pick<Row, 'type' | 'config'>>;
    const cases: Array<[string, Setup, { access: string; connection: string | null; id: string | null; usable: boolean }]> = [
      ['no row', [], { access: 'not_connected', connection: null, id: null, usable: false }],
      ['an Inbox OAuth row', [{ type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE }) }],
        { access: 'ok', connection: 'posthog_inbox', id: 'int-posthog_inbox', usable: true }],
      ['an Inbox key row', [{ type: 'posthog_inbox', config: keyConfig() }],
        { access: 'unknown', connection: 'posthog_inbox', id: 'int-posthog_inbox', usable: true }],
      ['an Inbox row PostHog revoked', [{ type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE, reauth: true }) }],
        { access: 'reconnect', connection: 'posthog_inbox', id: 'int-posthog_inbox', usable: false }],
      ['a disabled Inbox row', [{ type: 'posthog_inbox', enabled: false, config: keyConfig() }],
        { access: 'not_connected', connection: 'posthog_inbox', id: 'int-posthog_inbox', usable: false }],
      ['an Inbox row with no project', [{ type: 'posthog_inbox', config: { ...keyConfig(), projectId: undefined } }],
        { access: 'not_connected', connection: 'posthog_inbox', id: 'int-posthog_inbox', usable: false }],
      ['an Inbox OAuth row with no tokens', [{ type: 'posthog_inbox', config: { projectId: '42', host: HOST, authMethod: 'oauth' } }],
        { access: 'not_connected', connection: 'posthog_inbox', id: 'int-posthog_inbox', usable: false }],
      ['an Inbox row on a host no longer allowed', [{ type: 'posthog_inbox', config: { ...keyConfig(), host: 'https://evil.example.com' } }],
        { access: 'reconnect', connection: 'posthog_inbox', id: 'int-posthog_inbox', usable: false }],
      ['a PostHog Code grant with the Inbox scope', [{ type: 'posthog', config: oauthConfig({ scope: 'openid task:read task:write inbox:read inbox:write' }) }],
        { access: 'ok', connection: 'posthog_code', id: 'int-posthog', usable: true }],
      ['a PostHog Code grant without the Inbox scope', [{ type: 'posthog', config: oauthConfig({ scope: 'openid task:read task:write' }) }],
        { access: 'not_connected', connection: null, id: null, usable: false }],
      ['a revoked PostHog Code grant with the Inbox scope', [{ type: 'posthog', config: oauthConfig({ scope: INBOX_SCOPE, reauth: true }) }],
        { access: 'not_connected', connection: null, id: null, usable: false }],
      ['a PostHog Code key', [{ type: 'posthog', config: keyConfig() }],
        { access: 'unknown', connection: 'posthog_code', id: 'int-posthog', usable: true }],
      ['a disabled PostHog Code row', [{ type: 'posthog', enabled: false, config: keyConfig() }],
        { access: 'not_connected', connection: null, id: null, usable: false }],
      ['both rows', [
        { type: 'posthog', config: oauthConfig({ scope: INBOX_SCOPE, projectId: '1' }) },
        { type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE, projectId: '2' }) },
      ], { access: 'ok', connection: 'posthog_inbox', id: 'int-posthog_inbox', usable: true }],
      ['both rows, the Inbox one revoked', [
        { type: 'posthog', config: oauthConfig({ scope: INBOX_SCOPE }) },
        { type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE, reauth: true }) },
      ], { access: 'reconnect', connection: 'posthog_inbox', id: 'int-posthog_inbox', usable: false }],
      ['both rows, the Inbox one disabled', [
        { type: 'posthog', config: keyConfig() },
        { type: 'posthog_inbox', enabled: false, config: keyConfig() },
      ], { access: 'not_connected', connection: 'posthog_inbox', id: 'int-posthog_inbox', usable: false }],
    ];

    it.each(cases)('with %s', async (_label, setup, expected) => {
      for (const row of setup) await insert(row);
      const stored = await storedInboxAccess(WS);
      expect(stored).toMatchObject({ access: expected.access, connection: expected.connection, integrationId: expected.id });
      const connection = await getPostHogInboxConnection(WS);
      expect(Boolean(connection)).toBe(expected.usable);
      if (connection) {
        expect(connection).toMatchObject({ id: expected.id, workspaceId: WS, host: HOST });
        expect(typeof connection.client.listReports).toBe('function');
      }
      expect((await posthogInboxStatus(WS)).connection).toBe(expected.connection);
    });

    it('reads the Inbox row with its own token, not the PostHog Code one', async () => {
      await insert({ type: 'posthog', config: oauthConfig({ scope: INBOX_SCOPE, access: 'pha_code', projectId: '1' }) });
      await insert({ type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE, access: 'pha_inbox', projectId: '2' }) });
      posthog.mockResolvedValue(jsonResponse({ results: [] }));
      const connection = await getPostHogInboxConnection(WS);
      await connection!.client.listReports({ limit: 1 });
      const [target, init] = posthog.mock.calls[0] as [string, RequestInit];
      expect(target).toContain('/api/projects/2/signals/reports/');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer pha_inbox');
    });

    it.each([
      ['no row', null, false],
      ['a disabled row', { id: 'x', enabled: false, config: keyConfig() }, false],
      ['a key with nothing to decrypt', { id: 'x', enabled: true, config: { projectId: '1', authMethod: 'personal_api_key' } }, false],
      ['a key', { id: 'x', enabled: true, config: keyConfig() }, true],
      ['a grant with the Inbox scope', { id: 'x', enabled: true, config: oauthConfig({ scope: 'inbox:read' }) }, true],
      ['a grant without it', { id: 'x', enabled: true, config: oauthConfig({ scope: 'task:read' }) }, false],
    ] as const)('decides whether PostHog Code serves the Inbox for %s', (_label, row, serves) => {
      expect(postHogCodeRowServesInbox(row as Parameters<typeof postHogCodeRowServesInbox>[0])).toBe(serves);
    });
  });

  // ---- Poller candidates -----------------------------------------------------

  describe('which row the poller reads', () => {
    it.each([
      ['only PostHog Code', [['a', 'w1', 'posthog']], ['a']],
      ['only the Inbox', [['b', 'w1', 'posthog_inbox']], ['b']],
      ['both in one workspace', [['a', 'w1', 'posthog'], ['b', 'w1', 'posthog_inbox']], ['b']],
      ['both, Inbox first', [['b', 'w1', 'posthog_inbox'], ['a', 'w1', 'posthog']], ['b']],
      ['two workspaces', [['a', 'w1', 'posthog'], ['b', 'w2', 'posthog_inbox'], ['c', 'w2', 'posthog']], ['a', 'b']],
      ['none', [], []],
    ])('with %s', (_label, rows, ids) => {
      const input = rows.map(([integrationId, workspaceId, type]) => ({ integrationId, workspaceId, type }));
      expect(preferInboxRows(input).map((r) => r.integrationId)).toEqual(ids);
    });

    it('clears only the given workspace', async () => {
      await insert({ type: 'posthog_inbox', id: 'int-inbox', config: keyConfig() });
      await seedUser(testDb.db, { id: 'other', email: 'other@example.test' });
      await testDb.db.insert(workspaces).values({ id: 'ws-other', ownerId: 'other', name: 'B' });
      await testDb.db.insert(integrations).values({ id: 'int-other', workspaceId: 'ws-other', type: 'posthog_inbox', enabled: true, config: keyConfig() });
      await testDb.db.insert(posthogInboxPollers).values([
        { integrationId: 'int-inbox', workspaceId: WS, lastError: 'x', lastErrorStatus: 403 },
        { integrationId: 'int-other', workspaceId: 'ws-other', lastError: 'y', lastErrorStatus: 403 },
      ]);
      await clearInboxPollerBackoff(WS);
      const rows = await testDb.db.select({ id: posthogInboxPollers.integrationId, status: posthogInboxPollers.lastErrorStatus }).from(posthogInboxPollers).orderBy(posthogInboxPollers.integrationId);
      expect(rows).toEqual([{ id: 'int-inbox', status: null }, { id: 'int-other', status: 403 }]);
    });
  });

  // ---- Personal API key --------------------------------------------------------

  describe('a personal API key for the Inbox', () => {
    it('is checked against the Inbox, stored on the Inbox row and returns the status', async () => {
      posthog.mockResolvedValue(jsonResponse({ results: [] }));
      const res = await call('PUT', '/posthog-inbox/config', { workspaceId: WS, apiKey: '  phx_inbox  ', projectId: ' 7 ' });
      expect(res.status).toBe(200);
      expect(res.json.data).toMatchObject({ access: 'unknown', connection: 'posthog_inbox', authMethod: 'personal_api_key', projectId: '7', host: HOST, missingScopes: [] });
      const [target, init] = posthog.mock.calls[0] as [string, RequestInit];
      expect(target).toBe(`${HOST}/api/projects/7/signals/reports/?limit=1`);
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer phx_inbox');
      expect(await rowTypes()).toEqual(['posthog_inbox']);
      expect(decryptString((await inboxConfig())!.apiKeyEnc as Parameters<typeof decryptString>[0])).toBe('phx_inbox');
      expect(ensureCloudEnvironment).not.toHaveBeenCalled();
    });

    it.each([
      ['a 403', 403],
      ['a 401', 401],
      ['a 404', 404],
    ])('is refused on %s and nothing is stored', async (_label, status) => {
      posthog.mockResolvedValue(jsonResponse({ detail: 'nope' }, status));
      const res = await call('PUT', '/posthog-inbox/config', { workspaceId: WS, apiKey: 'phx_bad', projectId: '7' });
      expect(res.status).toBe(400);
      expect(res.json.error).toMatch(/did not accept the key/);
      expect(await rowTypes()).toEqual([]);
    });

    it.each([
      ['no key', { projectId: '7' }],
      ['a blank key', { apiKey: '   ', projectId: '7' }],
      ['no project', { apiKey: 'phx' }],
      ['a blank project', { apiKey: 'phx', projectId: ' ' }],
      ['a key that is not text', { apiKey: 42, projectId: '7' }],
    ])('needs a key and a project: %s', async (_label, body) => {
      const res = await call('PUT', '/posthog-inbox/config', { workspaceId: WS, ...body });
      expect(res.status).toBe(400);
      expect(posthog).not.toHaveBeenCalled();
    });

    it('replaces an Inbox OAuth grant', async () => {
      await insert({ type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE }) });
      await storeInboxApiKey(WS, { apiKey: 'phx', projectId: '7' });
      const config = await inboxConfig();
      expect(config?.oauth).toBeUndefined();
      expect(config).toMatchObject({ authMethod: 'personal_api_key', projectId: '7' });
    });
  });

  // ---- Disconnect isolation ----------------------------------------------------

  describe('disconnecting', () => {
    beforeEach(async () => {
      await insert({ type: 'posthog', config: oauthConfig({ scope: INBOX_SCOPE }) });
      await insert({ type: 'posthog_inbox', config: keyConfig() });
    });

    it('the Inbox route removes only the Inbox row, and falls back to PostHog Code', async () => {
      const res = await call('DELETE', `/posthog-inbox/config?workspaceId=${WS}`);
      expect(res.status).toBe(200);
      expect(res.json.data).toMatchObject({ connection: 'posthog_code', access: 'ok' });
      expect(await rowTypes()).toEqual(['posthog']);
    });

    it('removing the Inbox connection twice is harmless', async () => {
      await removeInboxConnection(WS);
      await removeInboxConnection(WS);
      expect(await rowTypes()).toEqual(['posthog']);
    });

    it('PostHog Code removes only its row', async () => {
      await removePostHogCodeCredentials(WS);
      expect(await rowTypes()).toEqual(['posthog_inbox']);
      expect((await storedInboxAccess(WS)).connection).toBe('posthog_inbox');
    });

    it('the PostHog Code route removes only its row', async () => {
      const res = await call('DELETE', `/posthog/config?workspaceId=${WS}`);
      expect(res.status).toBe(200);
      expect(await rowTypes()).toEqual(['posthog_inbox']);
    });
  });

  // ---- Not a cloud provider ---------------------------------------------------

  describe('not a cloud provider', () => {
    async function listed() {
      const res = await call('GET', `/cloud-providers?workspaceId=${WS}`);
      expect(res.status).toBe(200);
      return (res.json.data as unknown as Array<{ type: string; connected: boolean }>).find((p) => p.type === 'posthog_code');
    }

    it.each([
      ['retired', 'true', undefined],
      ['not retired', 'false', { type: 'posthog_code', connected: false }],
    ])('an Inbox row alone does not list PostHog Code (%s)', async (_label, retired, expected) => {
      process.env.POSTHOG_CODE_RETIRED = retired;
      resetFeatureFlagsForTests();
      await insert({ type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE }) });
      const provider = await listed();
      if (expected) expect(provider).toMatchObject(expected);
      else expect(provider).toBeUndefined();
      expect(await postHogCodeProvider.hasCredentials(WS)).toBe(false);
      expect(await getPostHogCodeCredentials(WS)).toBeNull();
    });

    it('an Inbox row does not unlock the PostHog Code connect routes', async () => {
      await insert({ type: 'posthog_inbox', config: keyConfig() });
      const res = await call('PUT', '/posthog/config', { workspaceId: WS, apiKey: 'phx', projectId: '7' });
      expect(res.status).toBe(410);
    });
  });

  // ---- Refresh -----------------------------------------------------------------

  describe('refreshing the Inbox token', () => {
    it('collapses concurrent callers into ONE refresh and stores the rotated pair on the Inbox row', async () => {
      await insert({ type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE, expiresInMs: -1000 }) });
      let calls = 0;
      posthog.mockImplementation(async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse({ access_token: 'pha_new', refresh_token: 'phr_new', expires_in: 3600 });
      });
      const tokens = await Promise.all([1, 2, 3, 4].map(() => ensureFreshInboxAccessToken(WS)));
      expect(tokens).toEqual(['pha_new', 'pha_new', 'pha_new', 'pha_new']);
      expect(calls).toBe(1);
      const config = await inboxConfig();
      expect(decryptString(config!.oauth.refreshTokenEnc)).toBe('phr_new');
      // The scope survives a refresh that does not repeat it.
      expect(config!.oauth.scope).toBe(INBOX_SCOPE);
    });

    it('refreshes the two rows apart: neither single-flight hides the other', async () => {
      await insert({ type: 'posthog', config: oauthConfig({ scope: 'task:read', expiresInMs: -1000, refresh: 'phr_code' }) });
      await insert({ type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE, expiresInMs: -1000, refresh: 'phr_inbox' }) });
      posthog.mockImplementation(async (_target: string, init: RequestInit) => {
        const refresh = new URLSearchParams(init.body as string).get('refresh_token');
        await new Promise((r) => setTimeout(r, 10));
        return jsonResponse({ access_token: `pha_for_${refresh}`, refresh_token: `${refresh}_2`, expires_in: 3600 });
      });
      const [code, inbox] = await Promise.all([ensureFreshAccessToken(WS), ensureFreshInboxAccessToken(WS)]);
      expect(code).toBe('pha_for_phr_code');
      expect(inbox).toBe('pha_for_phr_inbox');
      expect(posthog).toHaveBeenCalledTimes(2);
    });

    it('marks only the Inbox row for reconnect when PostHog rejects its refresh token', async () => {
      await insert({ type: 'posthog', config: oauthConfig({ scope: INBOX_SCOPE }) });
      await insert({ type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE, expiresInMs: -1000 }) });
      posthog.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));
      await expect(ensureFreshInboxAccessToken(WS)).rejects.toThrow(/Reconnect/);
      expect((await storedInboxAccess(WS)).access).toBe('reconnect');
      expect((await getPostHogCodeCredentials(WS))?.reauthRequired).toBe(false);
    });

    it('uses a token with life left without asking PostHog', async () => {
      await insert({ type: 'posthog_inbox', config: oauthConfig({ scope: INBOX_SCOPE, access: 'pha_live' }) });
      expect(await ensureFreshInboxAccessToken(WS)).toBe('pha_live');
      expect(posthog).not.toHaveBeenCalled();
    });

    it.each([
      ['posthog', 'posthog-oauth-refresh:ws1'],
      ['posthog_inbox', 'posthog-inbox-oauth-refresh:ws1'],
    ] as const)('locks the %s row under its own key', (type, key) => {
      expect(refreshLockKey(type, WS)).toBe(key);
    });
  });
});
