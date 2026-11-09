import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { posthogPublicRoutes, posthogRoutes } from '../../routes/posthog.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import { completeAuthorization } from '../../services/posthogCode/oauth.js';
import { resetPostHogOAuthConfigForTests } from '../../services/posthogCode/oauthConfig.js';
import { resetWebAppUrlCacheForTests } from '../../services/webApp.js';
import { posthogOauthStates, workspaces } from '../../db/schema.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';

/**
 * The PostHog Code OAuth flow started by the MOBILE app: `/oauth/start`
 * carries an allowlisted `returnTo`, and the public callback ends with a 302
 * to `${returnTo}posthog/callback?...` instead of a page or the web app.
 */

// The exchange itself is covered in posthogOauth.test.ts; here only its outcome matters.
vi.mock('../../services/posthogCode/oauth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/posthogCode/oauth.js')>()),
  completeAuthorization: vi.fn(),
}));
vi.mock('../../services/cloudProviders/environment.js', () => ({
  ensureCloudEnvironment: vi.fn(async () => undefined),
  notifyProviderConnected: vi.fn(),
}));

const WEB_APP = 'https://app.talyn.dev';
const ENV_KEYS = [
  'WEB_APP_URL',
  'MOBILE_RETURN_SCHEMES',
  'TALYN_TOKEN_KEY',
  'POSTHOG_OAUTH_CLIENT_ID',
  'POSTHOG_OAUTH_REDIRECT_URI',
] as const;
const saved: Record<string, string | undefined> = {};

describe('PostHog OAuth — mobile return', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.WEB_APP_URL = WEB_APP;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.POSTHOG_OAUTH_CLIENT_ID = 'https://www.talyn.dev/oauth-client';
    process.env.POSTHOG_OAUTH_REDIRECT_URI = 'https://prod.talyn.dev/api/v1/posthog/oauth/callback';
    resetPostHogOAuthConfigForTests();
    resetWebAppUrlCacheForTests();
    vi.mocked(completeAuthorization).mockReset();
    vi.mocked(completeAuthorization).mockResolvedValue({
      workspaceId: 'ws1',
      userId: TEST_USER_ID,
      projectId: '42',
      host: 'https://us.posthog.com',
    });
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: TEST_USER_ID });
    await testDb.db.insert(workspaces).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'A' });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/posthog', wrapAsyncRoutes(posthogPublicRoutes()));
    app.use((req, _res, next) => {
      req.user = { id: TEST_USER_ID, email: 'a@example.test', isAdmin: false };
      next();
    });
    app.use('/api/v1/posthog', wrapAsyncRoutes(posthogRoutes()));
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
    resetWebAppUrlCacheForTests();
  });

  function startFlow(body: Record<string, unknown>, origin?: string) {
    return fetch(`${url}/api/v1/posthog/oauth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify({ workspaceId: 'ws1', ...body }),
    });
  }

  async function state(body: Record<string, unknown> = {}, origin?: string): Promise<string> {
    const res = await startFlow(body, origin);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { authorizeUrl: string } };
    return new URL(data.authorizeUrl).searchParams.get('state')!;
  }

  function callback(params: Record<string, string>) {
    return fetch(`${url}/api/v1/posthog/oauth/callback?${new URLSearchParams(params)}`, { redirect: 'manual' });
  }

  async function storedRows() {
    return testDb.db.select({ mobileReturn: posthogOauthStates.mobileReturn }).from(posthogOauthStates);
  }

  describe('POST /oauth/start', () => {
    it.each(['talyn-mobile://', 'talyn-mobile-preview://', 'talyn-mobile-development://'])(
      'stores the allowlisted returnTo %s',
      async (returnTo) => {
        await state({ returnTo });
        expect(await storedRows()).toEqual([{ mobileReturn: returnTo }]);
      }
    );

    it.each([undefined, null])('stores none for returnTo %s', async (returnTo) => {
      await state(returnTo === undefined ? {} : { returnTo });
      expect(await storedRows()).toEqual([{ mobileReturn: null }]);
    });

    it.each([
      'TALYN-MOBILE://',
      'talyn-mobile:///',
      'talyn-mobile://evil',
      'https://evil.com',
      'javascript:',
      ' talyn-mobile://',
      '',
      42,
      { scheme: 'talyn-mobile://' },
    ])('refuses returnTo %j with 400 invalid_return_to and mints no state', async (returnTo) => {
      const res = await startFlow({ returnTo });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, code: 'invalid_return_to' });
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('callback', () => {
    it('a connected flow ends with a 302 to the app', async () => {
      const s = await state({ returnTo: 'talyn-mobile://' });
      const res = await callback({ code: 'c', state: s });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('talyn-mobile://posthog/callback?posthog=connected');
      expect(completeAuthorization).toHaveBeenCalledTimes(1);
    });

    it('the app return wins over the web settings page', async () => {
      const s = await state({ returnTo: 'talyn-mobile://' }, WEB_APP);
      const res = await callback({ code: 'c', state: s });
      expect(res.headers.get('location')).toBe('talyn-mobile://posthog/callback?posthog=connected');
    });

    it.each([
      ['a denial with a description', { error: 'access_denied', error_description: 'The user said no.' }, 'The user said no.'],
      ['a denial without one', { error: 'access_denied' }, 'access_denied'],
      ['a missing code', {}, 'Missing code or state.'],
    ])('%s ends with posthog=error and the message, and consumes the state', async (_label, params, message) => {
      const s = await state({ returnTo: 'talyn-mobile://' });
      const res = await callback({ ...params, state: s });
      expect(res.status).toBe(302);
      const target = new URL(res.headers.get('location')!);
      expect(`${target.protocol}//${target.host}${target.pathname}`).toBe('talyn-mobile://posthog/callback');
      expect(target.searchParams.get('posthog')).toBe('error');
      expect(target.searchParams.get('message')).toBe(message);
      expect(completeAuthorization).not.toHaveBeenCalled();
      expect(await storedRows()).toEqual([]);
    });

    it('a failed exchange ends with posthog=error and the reason', async () => {
      vi.mocked(completeAuthorization).mockRejectedValue(new Error('PostHog refused the code.'));
      const s = await state({ returnTo: 'talyn-mobile://' });
      const res = await callback({ code: 'c', state: s });
      expect(res.headers.get('location')).toBe(
        'talyn-mobile://posthog/callback?posthog=error&message=PostHog+refused+the+code.'
      );
    });

    it('a stored return that has left the allowlist is never a redirect target', async () => {
      const s = await state({ returnTo: 'talyn-mobile-preview://' });
      process.env.MOBILE_RETURN_SCHEMES = 'talyn-mobile://';
      const res = await callback({ code: 'c', state: s });
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    });

    it('a stored return that was never valid is ignored', async () => {
      const s = await state();
      await testDb.db
        .update(posthogOauthStates)
        .set({ mobileReturn: 'https://evil.com' })
        .where(eq(posthogOauthStates.state, s));
      const res = await callback({ code: 'c', state: s });
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
    });

    it('an unknown state has no app to return to', async () => {
      await state({ returnTo: 'talyn-mobile://' });
      const res = await callback({ code: 'c', state: 'not-a-state' });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    });
  });

  describe('without a returnTo (web and desktop, unchanged)', () => {
    it('a desktop flow renders the page', async () => {
      const s = await state();
      const res = await callback({ code: 'c', state: s });
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('PostHog');
    });

    it('a web flow goes back to its settings page', async () => {
      const s = await state({}, WEB_APP);
      const res = await callback({ code: 'c', state: s });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${WEB_APP}/settings?posthog=connected`);
    });

    it('a desktop denial renders the error page', async () => {
      const s = await state();
      const res = await callback({ error: 'access_denied', state: s });
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
    });
  });
});
