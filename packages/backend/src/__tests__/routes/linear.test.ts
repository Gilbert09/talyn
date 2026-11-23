import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { LinearStatus } from '@talyn/shared';
import { linearPublicRoutes, linearRoutes } from '../../routes/linear.js';

// pglite has one connection, so a lock transaction that waits for the
// callback's own queries would wait forever. The lock is real Postgres's job.
vi.mock('../../services/advisoryLock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/advisoryLock.js')>()),
  withBlockingAdvisoryLock: async (_db: unknown, _name: string, run: () => Promise<unknown>) => run(),
}));
import { workflowRoutes } from '../../routes/workflows.js';
import { apiErrorHandler } from '../../routes/index.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { internalProxyHeaders, requireAuth } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import { inboundConnections, inboundOauthStates, workspaces } from '../../db/schema.js';
import { resetFeatureFlagsForTests } from '../../services/featureFlags.js';
import { resetWebAppUrlCacheForTests } from '../../services/webApp.js';
import { _resetWorkflowStore } from '../../services/workflows/store.js';
import { consumeLinearState, startLinearAuthorization } from '../../services/linear/oauth.js';
import {
  linearAccessToken,
  LinearConnectionUnavailableError,
  upsertLinearConnection,
} from '../../services/linear/store.js';
import { resetLinearOptionsCacheForTests } from '../../services/linear/issues.js';

/**
 * Connecting Linear: the authorize URL, the single-use state, the callback's
 * code exchange and identity read, the refresh under rotation, a dead grant,
 * the owner routes and their gates, and the Linear rule's connection gate.
 */

const OTHER = 'user-other';
const headersFor = (userId: string) => ({ ...internalProxyHeaders(userId), 'content-type': 'application/json' });
const mine = headersFor(TEST_USER_ID);
const realFetch = globalThis.fetch;

interface TokenCall {
  form: URLSearchParams;
}

describe('Linear connect', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let tokenCalls: TokenCall[];
  let tokenAnswer: () => Response;

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('ISSUE_RULES_ENABLED', 'true');
    vi.stubEnv('LINEAR_CLIENT_ID', 'cid');
    vi.stubEnv('LINEAR_CLIENT_SECRET', 'csecret');
    vi.stubEnv('LINEAR_OAUTH_REDIRECT_URI', 'https://api.talyn.test/api/v1/linear/oauth/callback');
    vi.stubEnv('WEB_APP_URL', 'https://app.talyn.test');
    resetFeatureFlagsForTests();
    resetWebAppUrlCacheForTests();
    resetLinearOptionsCacheForTests();
    _resetWorkflowStore();
    tokenCalls = [];
    tokenAnswer = () => Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 86399, scope: 'read write app:assignable' });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target === 'https://api.linear.app/oauth/token') {
        tokenCalls.push({ form: new URLSearchParams(String(init?.body ?? '')) });
        return tokenAnswer();
      }
      if (target === 'https://api.linear.app/oauth/revoke') return new Response('', { status: 200 });
      if (target === 'https://api.linear.app/graphql') {
        const { query } = JSON.parse(String(init?.body ?? '{}')) as { query: string };
        if (query.includes('TalynIdentity')) {
          return Response.json({ data: { viewer: { id: 'app-user' }, organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' } } });
        }
        if (query.includes('TalynEditorOptions')) {
          return Response.json({
            data: {
              teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering' }] },
              issueLabels: { nodes: [{ id: 'l1', name: 'Bug', team: null }] },
              workflowStates: { nodes: [{ id: 's1', name: 'Done', type: 'completed', position: 2, team: { id: 't1' } }] },
              projects: { nodes: [{ id: 'p1', name: 'Editor' }] },
            },
          });
        }
      }
      return realFetch(input, init);
    });

    testDb = await createTestDb();
    await seedUser(testDb.db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await seedUser(testDb.db, { id: OTHER, email: 'other@example.test' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-mine', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
      { id: 'ws-theirs', ownerId: OTHER, name: 'theirs', settings: {} },
    ]);

    const app = express();
    app.use(express.json());
    app.use('/api/v1/linear', wrapAsyncRoutes(linearPublicRoutes()));
    app.use('/api/v1/linear', requireAuth, wrapAsyncRoutes(linearRoutes()));
    app.use('/api/v1/workflows', requireAuth, wrapAsyncRoutes(workflowRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    _resetWorkflowStore();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
    resetWebAppUrlCacheForTests();
  });

  async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = mine) {
    const res = await realFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as { success: boolean; data: T; code?: string; error?: string } };
  }

  describe('the authorize URL and the state', () => {
    it('asks for an app actor with PKCE and the assignable scope', async () => {
      const { authorizeUrl, state } = await startLinearAuthorization({ userId: TEST_USER_ID, workspaceId: 'ws-mine', client: 'web' });
      const url = new URL(authorizeUrl);
      expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: 'cid',
        redirect_uri: 'https://api.talyn.test/api/v1/linear/oauth/callback',
        response_type: 'code',
        scope: 'read,write,issues:create,comments:create,app:assignable',
        actor: 'app',
        code_challenge_method: 'S256',
        prompt: 'consent',
        state,
      });
      const pending = await consumeLinearState(state);
      expect(pending).toMatchObject({ userId: TEST_USER_ID, workspaceId: 'ws-mine', client: 'web', mobileReturn: null });
      const challenge = createHash('sha256').update(pending!.verifier).digest('base64url');
      expect(url.searchParams.get('code_challenge')).toBe(challenge);
      // Single use.
      expect(await consumeLinearState(state)).toBeNull();
    });

    it.each([
      ['unknown', 'nope'],
      ['empty', ''],
    ])('answers null for an %s state', async (_name, state) => {
      expect(await consumeLinearState(state)).toBeNull();
    });

    it('answers null for an expired state', async () => {
      const { state } = await startLinearAuthorization({ userId: TEST_USER_ID, workspaceId: 'ws-mine', client: 'desktop' });
      await testDb.db.update(inboundOauthStates).set({ expiresAt: new Date(Date.now() - 1000) });
      expect(await consumeLinearState(state)).toBeNull();
    });
  });

  describe('the callback', () => {
    async function callback(query: string) {
      return realFetch(`${base}/linear/oauth/callback?${query}`, { redirect: 'manual' });
    }

    it('exchanges the code, reads the organization and the app user, and returns to the web app', async () => {
      const { state } = await startLinearAuthorization({ userId: TEST_USER_ID, workspaceId: 'ws-mine', client: 'web' });
      const res = await callback(`code=abc&state=${state}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://app.talyn.test/integrations/linear?linear=connected');
      expect(tokenCalls[0].form.get('grant_type')).toBe('authorization_code');
      expect(tokenCalls[0].form.get('code')).toBe('abc');
      expect(tokenCalls[0].form.get('code_verifier')).toBeTruthy();
      const [row] = await testDb.db.select().from(inboundConnections);
      expect(row).toMatchObject({ workspaceId: 'ws-mine', kind: 'linear', externalAccountId: 'org-1' });
      expect(row.credentialMeta).toMatchObject({ appUserId: 'app-user', organizationName: 'Acme', urlKey: 'acme', scopes: ['read', 'write', 'app:assignable'] });
      expect(JSON.stringify(row.credentialEnc)).not.toContain('at-1');
    });

    it('replaces the grant when the same organization connects again', async () => {
      for (let i = 0; i < 2; i++) {
        const { state } = await startLinearAuthorization({ userId: TEST_USER_ID, workspaceId: 'ws-mine', client: 'web' });
        await callback(`code=c${i}&state=${state}`);
      }
      expect(await testDb.db.select().from(inboundConnections)).toHaveLength(1);
    });

    it('returns a mobile flow to the app', async () => {
      const { state } = await startLinearAuthorization({
        userId: TEST_USER_ID,
        workspaceId: 'ws-mine',
        client: 'desktop',
        mobileReturn: 'talyn-mobile://',
      });
      const res = await callback(`error=access_denied&state=${state}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(/^talyn-mobile:\/\/linear\/callback\?linear=error&message=/);
    });

    it.each([
      ['a used state', 'code=abc&state=unknown', 400],
      ['no code', 'state=x', 400],
    ])('refuses %s', async (_name, query, status) => {
      const res = await callback(query);
      expect(res.status).toBe(status);
      expect(await res.text()).toContain('Connection failed');
    });
  });

  describe('the access token', () => {
    async function connect(expiresAt: number) {
      return upsertLinearConnection({
        workspaceId: 'ws-mine',
        organizationId: 'org-1',
        tokens: { accessToken: 'old', refreshToken: 'rt-0', expiresAt },
        meta: { appUserId: 'app-user' },
        createdBy: TEST_USER_ID,
      });
    }

    it('answers a fresh token without a refresh', async () => {
      const id = await connect(Date.now() + 3_600_000);
      expect(await linearAccessToken(id)).toBe('old');
      expect(tokenCalls).toHaveLength(0);
    });

    it('refreshes an expiring token and stores the rotated pair', async () => {
      const id = await connect(Date.now() + 1000);
      expect(await linearAccessToken(id)).toBe('at-1');
      expect(Object.fromEntries(tokenCalls[0].form)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-0', client_id: 'cid' });
      // The next call reads the stored, rotated pair: no second refresh.
      expect(await linearAccessToken(id)).toBe('at-1');
      expect(tokenCalls).toHaveLength(1);
    });

    it('records a dead grant and stops trying', async () => {
      tokenAnswer = () => Response.json({ error: 'invalid_grant', error_description: 'The refresh token is revoked.' }, { status: 400 });
      const id = await connect(Date.now() - 1000);
      await expect(linearAccessToken(id)).rejects.toBeInstanceOf(LinearConnectionUnavailableError);
      const [row] = await testDb.db.select().from(inboundConnections).where(eq(inboundConnections.id, id));
      expect(row.credentialMeta).toMatchObject({ reauthReason: 'The refresh token is revoked.' });
      await expect(linearAccessToken(id)).rejects.toThrow('The refresh token is revoked.');
      expect(tokenCalls).toHaveLength(1);
    });

    it('leaves the grant alone on a transient failure', async () => {
      tokenAnswer = () => new Response('busy', { status: 503 });
      const id = await connect(Date.now() - 1000);
      await expect(linearAccessToken(id)).rejects.toThrow('Linear refused the token request');
      const [row] = await testDb.db.select().from(inboundConnections).where(eq(inboundConnections.id, id));
      expect((row.credentialMeta as { reauthRequiredAt?: string | null }).reauthRequiredAt ?? null).toBeNull();
    });
  });

  describe('the owner routes', () => {
    it('lists connections without a credential', async () => {
      await upsertLinearConnection({
        workspaceId: 'ws-mine',
        organizationId: 'org-1',
        tokens: { accessToken: 'secret-token', refreshToken: null, expiresAt: null },
        meta: { appUserId: 'app-user', scopes: ['read', 'app:assignable'], organizationName: 'Acme' },
        createdBy: TEST_USER_ID,
      });
      const res = await call<LinearStatus>('GET', '/linear?workspaceId=ws-mine');
      expect(res.status).toBe(200);
      expect(res.body.data.configured).toBe(true);
      expect(res.body.data.connections).toEqual([
        expect.objectContaining({ organizationId: 'org-1', organizationName: 'Acme', canAssign: true, reauthRequiredAt: null }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain('secret-token');
    });

    it.each([
      ['GET', '/linear?workspaceId=ws-mine'],
      ['POST', '/linear/connect'],
      ['GET', '/linear/connections/x/options?workspaceId=ws-mine'],
      ['DELETE', '/linear/connections/x?workspaceId=ws-mine'],
    ])('answers 404 for %s %s with the flag off', async (method, path) => {
      vi.stubEnv('ISSUE_RULES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await call(method, path, method === 'POST' ? { workspaceId: 'ws-mine' } : undefined);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('issue_rules_unavailable');
    });

    it('answers 503 for connect without a Linear app', async () => {
      vi.stubEnv('LINEAR_CLIENT_SECRET', '');
      const res = await call('POST', '/linear/connect', { workspaceId: 'ws-mine' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('linear_not_configured');
    });

    it('starts a connect for the caller\'s workspace and refuses another', async () => {
      const ok = await call<{ authorizeUrl: string }>('POST', '/linear/connect', { workspaceId: 'ws-mine', returnTo: 'talyn-mobile://' });
      expect(ok.status).toBe(200);
      expect(ok.body.data.authorizeUrl).toContain('actor=app');
      const [state] = await testDb.db.select().from(inboundOauthStates);
      expect(state.mobileReturn).toBe('talyn-mobile://');
      expect((await call('POST', '/linear/connect', { workspaceId: 'ws-theirs' })).status).toBe(404);
      expect((await call('POST', '/linear/connect', { workspaceId: 'ws-mine', returnTo: 'https://evil.test/' })).status).toBe(400);
    });

    it('reads editor options and disconnects only its own connection', async () => {
      const id = await upsertLinearConnection({
        workspaceId: 'ws-mine',
        organizationId: 'org-1',
        tokens: { accessToken: 'tok', refreshToken: null, expiresAt: null },
        meta: {},
        createdBy: TEST_USER_ID,
      });
      const options = await call<{ teams: unknown[]; partial: boolean }>('GET', `/linear/connections/${id}/options?workspaceId=ws-mine`);
      expect(options.body.data).toMatchObject({ teams: [{ id: 't1', key: 'ENG', name: 'Engineering' }], partial: false });
      expect((await call('DELETE', `/linear/connections/${id}?workspaceId=ws-theirs`, undefined, headersFor(OTHER))).status).toBe(404);
      expect((await call('DELETE', `/linear/connections/${id}?workspaceId=ws-mine`)).status).toBe(200);
      expect(await testDb.db.select().from(inboundConnections)).toHaveLength(0);
    });
  });

  describe('Linear rules', () => {
    const rule = (connectionId: string) => ({
      workspaceId: 'ws-mine',
      integration: 'linear',
      name: 'Triage',
      events: ['issue_created'],
      conditions: { connectionId },
      actions: [{ type: 'start_session', repositoryId: 'r1', prompt: 'Fix it' }],
    });

    it('saves a rule on its own workspace\'s connection and refuses another', async () => {
      const id = await upsertLinearConnection({
        workspaceId: 'ws-mine',
        organizationId: 'org-1',
        tokens: { accessToken: 'tok', refreshToken: null, expiresAt: null },
        meta: {},
        createdBy: TEST_USER_ID,
      });
      const theirs = await upsertLinearConnection({
        workspaceId: 'ws-theirs',
        organizationId: 'org-2',
        tokens: { accessToken: 'tok', refreshToken: null, expiresAt: null },
        meta: {},
        createdBy: OTHER,
      });
      expect((await call('POST', '/workflows', rule(id))).status).toBe(200);
      const refused = await call('POST', '/workflows', rule(theirs));
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('linear_connection_unavailable');
    });

    it.each(['linear', 'github_issues'])('answers 404 for a %s rule with the flag off', async (integration) => {
      vi.stubEnv('ISSUE_RULES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await call('GET', `/workflows?workspaceId=ws-mine&integration=${integration}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('issue_rules_unavailable');
    });
  });
});
