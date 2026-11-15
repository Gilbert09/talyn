import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { posthogRoutes } from '../../routes/posthog.js';
import { cloudProviderRoutes } from '../../routes/cloudProviders.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { resetPostHogOAuthConfigForTests } from '../../services/posthogCode/oauthConfig.js';
import { resetFeatureFlagsForTests } from '../../services/featureFlags.js';
import { registerCloudProvider } from '../../services/cloudProviders/registry.js';
import { postHogCodeProvider } from '../../services/cloudProviders/posthog/provider.js';
import { integrations, workspaces } from '../../db/schema.js';
import { encryptString } from '../../services/tokenCrypto.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';

/**
 * The `posthogCodeRetired` flag at the connect routes. With it on, a workspace
 * that has no PostHog Code row cannot make one, and one that has a row keeps
 * every route. With it off, nothing changes.
 */

vi.mock('../../services/posthogCode/client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/posthogCode/client.js')>();
  class FakeClient {
    async ping(): Promise<void> {}
  }
  return { ...real, PostHogCodeClient: FakeClient };
});
vi.mock('../../services/cloudProviders/environment.js', () => ({
  ensureCloudEnvironment: vi.fn(async () => undefined),
  notifyProviderConnected: vi.fn(),
}));
vi.mock('../../services/cloudProviders/fleetAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  workspaceMayUseFleet: async () => false,
  fleetRefusalReason: () => 'fleet off',
}));

registerCloudProvider(postHogCodeProvider);

const ENV_KEYS = [
  'TALYN_TOKEN_KEY',
  'POSTHOG_OAUTH_CLIENT_ID',
  'POSTHOG_OAUTH_REDIRECT_URI',
  'POSTHOG_CODE_RETIRED',
] as const;
const saved: Record<string, string | undefined> = {};

type FlagState = 'on' | 'off' | 'unset';

describe('PostHog Code retirement at the connect routes', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.POSTHOG_OAUTH_CLIENT_ID = 'https://www.talyn.dev/oauth-client';
    process.env.POSTHOG_OAUTH_REDIRECT_URI = 'https://prod.talyn.dev/api/v1/posthog/oauth/callback';
    resetPostHogOAuthConfigForTests();
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: TEST_USER_ID });
    await testDb.db.insert(workspaces).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'A' });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: TEST_USER_ID, email: 'a@example.test', isAdmin: false };
      next();
    });
    app.use('/api/v1/posthog', wrapAsyncRoutes(posthogRoutes()));
    app.use('/api/v1/cloud-providers', wrapAsyncRoutes(cloudProviderRoutes()));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
  });

  afterEach(async () => {
    await close();
    await testDb.cleanup();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetPostHogOAuthConfigForTests();
    resetFeatureFlagsForTests();
  });

  function setFlag(state: FlagState) {
    if (state === 'on') process.env.POSTHOG_CODE_RETIRED = 'true';
    else if (state === 'off') process.env.POSTHOG_CODE_RETIRED = 'false';
    else delete process.env.POSTHOG_CODE_RETIRED;
    resetFeatureFlagsForTests();
  }

  async function seedRow(config: Record<string, unknown> = { apiKeyEnc: encryptString('k'), projectId: '1' }) {
    await testDb.db.insert(integrations).values({
      id: 'int-ph',
      workspaceId: 'ws1',
      type: 'posthog',
      enabled: true,
      config,
    });
  }

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${url}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  const calls = {
    'POST /posthog/oauth/start': () => send('POST', '/posthog/oauth/start', { workspaceId: 'ws1' }),
    'PUT /posthog/config': () =>
      send('PUT', '/posthog/config', { workspaceId: 'ws1', apiKey: 'phx_k', projectId: '1' }),
    'PUT /cloud-providers/posthog_code/config': () =>
      send('PUT', '/cloud-providers/posthog_code/config', { workspaceId: 'ws1', apiKey: 'phx_k', projectId: '1' }),
  } as const;
  const routeNames = Object.keys(calls) as (keyof typeof calls)[];

  describe.each(routeNames)('%s', (name) => {
    it('refuses with 410 posthog_code_retired when the flag is on and nothing is connected', async () => {
      setFlag('on');
      const res = await calls[name]();
      expect(res.status).toBe(410);
      expect(await res.json()).toMatchObject({ success: false, code: 'posthog_code_retired' });
      const rows = await testDb.db.select({ id: integrations.id }).from(integrations);
      expect(rows).toEqual([]);
    });

    it.each(['on', 'off'] as const)('lets a connected workspace reconnect with the flag %s', async (state) => {
      await seedRow();
      setFlag(state);
      const res = await calls[name]();
      expect(res.status).toBe(200);
    });

    it('lets a workspace whose grant expired reconnect with the flag on', async () => {
      await seedRow({ projectId: '1', authMethod: 'oauth', oauth: { reauthRequiredAt: new Date().toISOString() } });
      setFlag('on');
      expect((await calls[name]()).status).toBe(200);
    });

    it.each(['off', 'unset'] as const)('connects as today with the flag %s', async (state) => {
      setFlag(state);
      expect((await calls[name]()).status).toBe(200);
    });
  });

  it.each(['on', 'off'] as const)('lets a connected workspace disconnect with the flag %s', async (state) => {
    await seedRow();
    setFlag(state);
    const res = await send('DELETE', '/posthog/config?workspaceId=ws1');
    expect(res.status).toBe(200);
    expect(await testDb.db.select({ id: integrations.id }).from(integrations)).toEqual([]);
  });

  describe('GET /cloud-providers', () => {
    async function listedTypes(): Promise<string[]> {
      const res = await send('GET', '/cloud-providers?workspaceId=ws1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { type: string }[] };
      return body.data.map((p) => p.type);
    }

    it.each<[string, FlagState, boolean, boolean]>([
      ['hides it when the flag is on and nothing is connected', 'on', false, false],
      ['keeps it when the flag is on and it is connected', 'on', true, true],
      ['keeps it when the flag is off', 'off', false, true],
      ['keeps it when the flag is unset', 'unset', false, true],
    ])('%s', async (_label, state, connected, listed) => {
      if (connected) await seedRow();
      setFlag(state);
      expect((await listedTypes()).includes('posthog_code')).toBe(listed);
    });
  });
});
