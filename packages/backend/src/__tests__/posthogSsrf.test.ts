import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { integrations, posthogOauthStates, workspaces } from '../db/schema.js';
import { wrapAsyncRoutes } from '../middleware/asyncHandler.js';
import { posthogPublicRoutes, posthogRoutes } from '../routes/posthog.js';
import { cloudProviderRoutes } from '../routes/cloudProviders.js';
import { registerCloudProvider } from '../services/cloudProviders/registry.js';
import { postHogCodeProvider } from '../services/cloudProviders/posthog/provider.js';
import { PostHogCodeClient } from '../services/posthogCode/client.js';
import { getPostHogCodeCredentials, storePostHogCodeCredentials } from '../services/posthogCode/credentials.js';
import { ensureFreshAccessToken, resetOAuthInflightForTests } from '../services/posthogCode/oauth.js';
import { resetPostHogOAuthConfigForTests } from '../services/posthogCode/oauthConfig.js';
import { encryptString } from '../services/tokenCrypto.js';

const HOST = 'https://us.posthog.com';
const WS = 'posthog-security';
const BODY_SECRET = 'PRIVATE_RESPONSE_MARKER';
const nativeFetch = globalThis.fetch;
const fetchMock = vi.fn<typeof fetch>();
let db: Database;
let cleanup: () => Promise<void>;
let server: Server;
let base: string;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await seedUser(db);
  await db.insert(workspaces).values({ id: WS, ownerId: TEST_USER_ID, name: 'Security test' });
  registerCloudProvider(postHogCodeProvider);
  const app = express();
  app.use(express.json());
  app.use('/posthog', wrapAsyncRoutes(posthogPublicRoutes()));
  app.use((req, _res, next) => {
    req.user = { id: TEST_USER_ID, email: 'security@example.com', isAdmin: false };
    next();
  });
  app.use('/posthog', wrapAsyncRoutes(posthogRoutes()));
  app.use('/cloud-providers', wrapAsyncRoutes(cloudProviderRoutes()));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err.message });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', '');
  vi.stubEnv('POSTHOG_OAUTH_CLIENT_ID', 'test-client');
  vi.stubEnv('POSTHOG_OAUTH_REDIRECT_URI', 'https://talyn.example/callback');
  resetPostHogOAuthConfigForTests();
  resetOAuthInflightForTests();
  await db.delete(integrations);
  await db.delete(posthogOauthStates);
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error('Unexpected outbound request'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetPostHogOAuthConfigForTests();
  resetOAuthInflightForTests();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  await cleanup();
});

async function api(path: string, method = 'POST', body?: unknown) {
  return nativeFetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
  });
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CONFIG_ROUTES = ['/posthog/config', '/cloud-providers/posthog_code/config'];
const DISALLOWED = [
  'http://127.0.0.1:4747/health#', 'https://127.0.0.1', 'https://localhost',
  'https://10.0.0.1', 'https://169.254.169.254', 'https://[::1]',
  'https://posthog.example', 'https://us.posthog.com.evil.example',
  'https://user:password@us.posthog.com', 'https://us.posthog.com/path',
  'https://us.posthog.com?query', 'https://us.posthog.com#fragment',
  'https://2130706433', 'https://%75s.posthog.com',
];

describe.each([...CONFIG_ROUTES, '/posthog/oauth/start'])('%s origin validation', (path) => {
  it.each(DISALLOWED)('rejects %s before requesting or storing credentials', async (host) => {
    const res = await api(path, path.endsWith('/config') ? 'PUT' : 'POST', {
      workspaceId: WS, apiKey: 'test-key', projectId: '1', host,
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.select().from(integrations)).toHaveLength(0);
    expect(await db.select().from(posthogOauthStates)).toHaveLength(0);
  });

  it.each(['https://us.posthog.com', 'https://eu.posthog.com', 'https://10.0.0.1:8443']) (
    'accepts an approved destination: %s', async (host) => {
      if (host.includes('10.0.0.1')) vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', host);
      fetchMock.mockResolvedValue(response([]));
      const res = await api(path, path.endsWith('/config') ? 'PUT' : 'POST', {
        workspaceId: WS, apiKey: 'test-key', projectId: '1', host,
      });
      expect(res.status).toBe(200);
      if (path.endsWith('/config')) {
        expect(fetchMock).toHaveBeenCalledWith(`${host}/api/projects/1/tasks/?limit=1`, expect.objectContaining({ redirect: 'error' }));
      } else {
        const data = await res.json() as { data: { authorizeUrl: string } };
        expect(new URL(data.data.authorizeUrl).origin).toBe(host);
      }
    },
  );
});

describe.each(CONFIG_ROUTES)('%s responses', (path) => {
  it.each([301, 302, 303, 307, 308, 400, 500])('refuses HTTP %s without disclosing its body', async (status) => {
    fetchMock.mockResolvedValue(new Response(BODY_SECRET, { status, headers: { Location: 'https://127.0.0.1' } }));
    const res = await api(path, 'PUT', { workspaceId: WS, apiKey: 'key', projectId: '1', host: HOST });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(BODY_SECRET);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
    expect(await db.select().from(integrations)).toHaveLength(0);
  });

  it('does not disclose malformed success bodies', async () => {
    fetchMock.mockResolvedValue(new Response(BODY_SECRET));
    const res = await api(path, 'PUT', { workspaceId: WS, apiKey: 'key', projectId: '1' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(BODY_SECRET);
  });
});

async function seedCredential(host: string, oauth: boolean) {
  await db.insert(integrations).values({
    id: 'stored-posthog', workspaceId: WS, type: 'posthog', enabled: true,
    config: {
      host, projectId: '1', authMethod: oauth ? 'oauth' : 'personal_api_key',
      ...(oauth ? { oauth: {
        accessTokenEnc: encryptString('access'), refreshTokenEnc: encryptString('refresh'),
        expiresAt: new Date(0).toISOString(), clientId: 'test-client',
      } } : { apiKeyEnc: encryptString('key') }),
    },
  });
}

describe('persisted PostHog destinations', () => {
  it.each([false, true])('rejects an unsafe stored host (OAuth: %s)', async (oauth) => {
    await seedCredential('https://127.0.0.1', oauth);
    await expect(getPostHogCodeCredentials(WS)).rejects.toThrow('not allowed');
    if (oauth) await expect(ensureFreshAccessToken(WS)).rejects.toThrow('not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates direct credential writes', async () => {
    await expect(storePostHogCodeCredentials(WS, { apiKey: 'key', projectId: '1', host: 'https://localhost' })).rejects.toThrow('not allowed');
    expect(await db.select().from(integrations)).toHaveLength(0);
  });

  it.each(['api', 'stream'])('rechecks the allowlist on every %s request', async (kind) => {
    const host = 'https://posthog.example';
    vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', host);
    const client = new PostHogCodeClient('key', '1', host);
    vi.stubEnv('POSTHOG_ALLOWED_ORIGINS', '');
    await expect(kind === 'api' ? client.ping() : client.openRunStream('task', 'run')).rejects.toThrow('not allowed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unsafe host in a persisted OAuth state', async () => {
    await db.insert(posthogOauthStates).values({
      state: 'unsafe', workspaceId: WS, userId: TEST_USER_ID,
      host: 'https://127.0.0.1', client: 'desktop',
      codeVerifierEnc: encryptString('verifier'), expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await api('/posthog/oauth/callback?state=unsafe&code=code', 'GET');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('OAuth request security', () => {
  it.each(['token', 'introspect', 'refresh'])('refuses redirects from %s', async (stage) => {
    fetchMock.mockImplementation(async (url, init) => {
      expect(init?.redirect).toBe('error');
      if (stage === 'introspect' && String(url).endsWith('/oauth/token/')) {
        return response({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
      }
      return new Response(BODY_SECRET, { status: 307, headers: { Location: 'https://127.0.0.1' } });
    });
    if (stage === 'refresh') {
      await seedCredential(HOST, true);
      await expect(ensureFreshAccessToken(WS)).rejects.toThrow('failed (307)');
    } else {
      const started = await api('/posthog/oauth/start', 'POST', { workspaceId: WS });
      const data = await started.json() as { data: { authorizeUrl: string } };
      const state = new URL(data.data.authorizeUrl).searchParams.get('state');
      const res = await api(`/posthog/oauth/callback?state=${state}&code=code`, 'GET');
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain(BODY_SECRET);
      expect(await db.select().from(integrations)).toHaveLength(0);
    }
    expect(fetchMock).toHaveBeenCalledTimes(stage === 'introspect' ? 2 : 1);
  });

  it.each(['invalid_grant', 'invalid_client', BODY_SECRET])('does not disclose OAuth error descriptions: %s', async (error) => {
    await seedCredential(HOST, true);
    fetchMock.mockResolvedValue(response({ error, error_description: BODY_SECRET }, 400));
    const failure = await ensureFreshAccessToken(WS).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(BODY_SECRET);
    expect(JSON.stringify(await db.select().from(integrations))).not.toContain(BODY_SECRET);
  });
});

describe('API retry and stream security', () => {
  it('keeps redirect refusal on a refreshed API retry', async () => {
    const token = vi.fn(async () => 'access');
    fetchMock.mockResolvedValueOnce(response({}, 401)).mockResolvedValueOnce(response([], 200));
    await new PostHogCodeClient(token, '1', HOST).ping();
    expect(token).toHaveBeenLastCalledWith({ forceRefresh: true });
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
  });

  it.each([302, 307, 400, 500])('refuses stream HTTP %s without exposing the body', async (status) => {
    fetchMock.mockResolvedValue(new Response(BODY_SECRET, { status }));
    await expect(new PostHogCodeClient('key', '1', HOST).openRunStream('task', 'run')).rejects.toThrow(`failed (${status})`);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('error');
  });
});
