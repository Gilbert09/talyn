import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { githubPublicRoutes, githubRoutes } from '../../routes/github.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import * as githubApp from '../../services/githubApp.js';
import { githubService } from '../../services/github.js';
import { prMonitorService } from '../../services/prMonitor.js';
import { resetWebAppUrlCacheForTests } from '../../services/webApp.js';
import { workspaces } from '../../db/schema.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';

/**
 * The GitHub App callback for a flow the MOBILE app started: the install-url
 * request carries an allowlisted `returnTo`, and the callback ends with a 302
 * to `${returnTo}github/callback?…` instead of a page or the web app.
 */

vi.mock('../../services/githubApp.js', () => ({
  isGitHubAppConfigured: vi.fn(() => true),
  buildUserAuthUrl: vi.fn((state: string) => `https://github.example/authorize?state=${state}`),
  buildInstallUrl: vi.fn((state: string) => `https://github.example/install?state=${state}`),
  appInstallationsPageUrl: vi.fn(() => 'https://github.example/install'),
  exchangeUserCode: vi.fn(),
  fetchUserInstallations: vi.fn(),
  fetchInstallation: vi.fn(),
  fetchInstallationRepos: vi.fn(),
}));

// The OAuth limiter (20 per 10 minutes per IP) is module-level and this file
// makes far more calls than that from one address.
vi.mock('../../middleware/rateLimit.js', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const WEB_APP = 'https://app.talyn.dev';
const ENV_KEYS = ['WEB_APP_URL', 'MOBILE_RETURN_SCHEMES'] as const;
const saved: Record<string, string | undefined> = {};

describe('GitHub callback — mobile return', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.WEB_APP_URL = WEB_APP;
    resetWebAppUrlCacheForTests();
    vi.clearAllMocks();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: TEST_USER_ID });
    await testDb.db.insert(workspaces).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'A' });
    vi.mocked(githubApp.exchangeUserCode).mockResolvedValue({ access_token: 'user-a', token_type: 'bearer', scope: '' });
    vi.mocked(githubApp.fetchUserInstallations).mockResolvedValue([
      { installationId: 'allowed', accountLogin: 'a', accountType: 'User', suspended: false, repositorySelection: 'all' },
    ]);
    vi.mocked(githubApp.fetchInstallation).mockResolvedValue({
      installationId: 'allowed', accountLogin: 'a', accountType: 'User', suspended: false,
    });
    vi.mocked(githubApp.fetchInstallationRepos).mockResolvedValue(['a/repo']);
    vi.spyOn(githubService, 'storeToken').mockResolvedValue(undefined);
    vi.spyOn(prMonitorService, 'refreshWorkspaceNow').mockResolvedValue({ failedRepos: 0 });
    const app = express();
    app.use(express.json());
    app.use('/api/v1/github', wrapAsyncRoutes(githubPublicRoutes()));
    app.use((req, _res, next) => {
      req.user = { id: TEST_USER_ID, email: 'a@example.test', isAdmin: false };
      next();
    });
    app.use('/api/v1/github', wrapAsyncRoutes(githubRoutes()));
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });

  afterEach(async () => {
    await close();
    await testDb.cleanup();
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetWebAppUrlCacheForTests();
  });

  function installUrl(body: Record<string, unknown>, origin?: string) {
    return fetch(`${url}/api/v1/github/app/install-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify({ workspaceId: 'ws1', ...body }),
    });
  }

  async function state(body: Record<string, unknown> = {}, origin?: string) {
    const response = await installUrl(body, origin);
    expect(response.status).toBe(200);
    return `ws1:${(await response.json()).data.state}`;
  }

  function callback(params: Record<string, string>, origin?: string) {
    return fetch(`${url}/api/v1/github/app/callback?${new URLSearchParams(params)}`, {
      redirect: 'manual',
      headers: origin ? { origin } : {},
    });
  }

  function location(res: Response): string | null {
    return res.headers.get('location');
  }

  describe('install-url validation', () => {
    it.each<[string, unknown]>([
      ['an https URL', 'https://evil.example.com/'],
      ['the web app', WEB_APP],
      ['a scheme with a host', 'talyn-mobile://evil'],
      ['a scheme with a path', 'talyn-mobile://github/callback'],
      ['a scheme without slashes', 'talyn-mobile-development:'],
      ['uppercase', 'TALYN-MOBILE://'],
      ['javascript', 'javascript:alert(1)'],
      ['an unknown scheme', 'other-app://'],
      ['an empty string', ''],
      ['a number', 7],
      ['an object', { scheme: 'talyn-mobile://' }],
    ])('400 invalid_return_to for %s', async (_label, returnTo) => {
      const res = await installUrl({ returnTo });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, code: 'invalid_return_to' });
    });

    it.each<[string, Record<string, unknown>]>([
      ['no returnTo', {}],
      ['null returnTo', { returnTo: null }],
      ['a valid returnTo', { returnTo: 'talyn-mobile://' }],
    ])('200 for %s', async (_label, body) => {
      expect((await installUrl(body)).status).toBe(200);
    });

    it('honours a MOBILE_RETURN_SCHEMES override', async () => {
      process.env.MOBILE_RETURN_SCHEMES = 'myapp://';
      expect((await installUrl({ returnTo: 'myapp://' })).status).toBe(200);
      expect((await installUrl({ returnTo: 'talyn-mobile://' })).status).toBe(400);
    });
  });

  describe('success', () => {
    it.each(['talyn-mobile://', 'talyn-mobile-preview://', 'talyn-mobile-development://'])(
      '302s to %sgithub/callback?github=connected',
      async (returnTo) => {
        const res = await callback({ code: 'c', state: await state({ returnTo }), installation_id: 'allowed' });
        expect(res.status).toBe(302);
        expect(location(res)).toBe(`${returnTo}github/callback?github=connected`);
        expect(githubService.storeToken).toHaveBeenCalledTimes(1);
      }
    );

    it('the mobile return wins over a web Origin on the install-url request', async () => {
      const value = await state({ returnTo: 'talyn-mobile://' }, WEB_APP);
      const res = await callback({ code: 'c', state: value, installation_id: 'allowed' });
      expect(location(res)).toBe('talyn-mobile://github/callback?github=connected');
    });

    it('an installation hint the user cannot access → connect_failed', async () => {
      const res = await callback({ code: 'c', state: await state({ returnTo: 'talyn-mobile://' }), installation_id: 'foreign' });
      expect(location(res)).toBe('talyn-mobile://github/callback?github=error&reason=connect_failed');
    });

    it('the install re-hop keeps the mobile return on its fresh state', async () => {
      vi.mocked(githubApp.fetchUserInstallations).mockResolvedValueOnce([]);
      const first = await callback({ code: 'c', state: await state({ returnTo: 'talyn-mobile-preview://' }) });
      expect(first.status).toBe(302);
      const installHop = new URL(location(first)!);
      expect(installHop.origin).toBe('https://github.example');
      const freshState = installHop.searchParams.get('state')!;
      const second = await callback({ code: 'c2', state: freshState, installation_id: 'allowed' });
      expect(location(second)).toBe('talyn-mobile-preview://github/callback?github=connected');
    });
  });

  describe('errors', () => {
    it.each<[string, string, Record<string, string>]>([
      ['the person declined', 'access_denied', { error: 'access_denied' }],
      ['another provider error', 'provider_error', { error: 'application_suspended', error_description: 'x' }],
      ['no code', 'missing_code', {}],
    ])('%s → reason=%s, state kept', async (_label, reason, extra) => {
      const value = await state({ returnTo: 'talyn-mobile://' });
      const res = await callback({ state: value, ...extra });
      expect(res.status).toBe(302);
      expect(location(res)).toBe(`talyn-mobile://github/callback?github=error&reason=${reason}`);
      // An error hop does not consume the state: a retry can still use it.
      const retry = await callback({ code: 'c', state: value, installation_id: 'allowed' });
      expect(location(retry)).toBe('talyn-mobile://github/callback?github=connected');
    });

    it('a state for another workspace → invalid_state', async () => {
      const value = await state({ returnTo: 'talyn-mobile://' });
      const res = await callback({ code: 'c', state: value.replace('ws1:', 'ws-other:') });
      expect(location(res)).toBe('talyn-mobile://github/callback?github=error&reason=invalid_state');
      expect(githubApp.exchangeUserCode).not.toHaveBeenCalled();
    });

    it('an expired state → invalid_state', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const value = await state({ returnTo: 'talyn-mobile://' });
      vi.mocked(Date.now).mockReturnValue(now + 600_000);
      const res = await callback({ code: 'c', state: value, installation_id: 'allowed' });
      expect(location(res)).toBe('talyn-mobile://github/callback?github=error&reason=invalid_state');
    });

    it('a consumed state → no mobile return is known, so the old ending', async () => {
      const value = await state({ returnTo: 'talyn-mobile://' });
      await callback({ code: 'c', state: value, installation_id: 'allowed' });
      const replay = await callback({ code: 'c', state: value, installation_id: 'allowed' });
      expect(replay.status).toBe(400);
      expect(location(replay)).toBeNull();
    });

    it('an unknown state → the old ending', async () => {
      const res = await callback({ code: 'c', state: 'ws1:nope' });
      expect(res.status).toBe(400);
      expect(location(res)).toBeNull();
    });

    it('a failed code exchange → connect_failed, without GitHub text in the URL', async () => {
      vi.mocked(githubApp.exchangeUserCode).mockRejectedValue(new Error('bad_verification_code https://evil'));
      const res = await callback({ code: 'c', state: await state({ returnTo: 'talyn-mobile://' }) });
      expect(location(res)).toBe('talyn-mobile://github/callback?github=error&reason=connect_failed');
    });
  });

  describe('without returnTo: unchanged', () => {
    it('desktop renders the page', async () => {
      const res = await callback({ code: 'c', state: await state(), installation_id: 'allowed' });
      expect(res.status).toBe(200);
      expect(location(res)).toBeNull();
      expect(await res.text()).toContain('<!doctype html>');
    });

    it('web redirects to the web app settings', async () => {
      const value = await state({}, WEB_APP);
      const res = await callback({ code: 'c', state: value, installation_id: 'allowed' });
      expect(res.status).toBe(302);
      const target = new URL(location(res)!);
      expect(target.origin).toBe(WEB_APP);
      expect(target.pathname).toBe('/settings');
      expect(target.searchParams.get('github')).toBe('connected');
    });

    it('a desktop error with a known state still renders the page', async () => {
      const res = await callback({ state: await state(), error: 'access_denied' });
      expect(res.status).toBe(400);
      expect(location(res)).toBeNull();
    });
  });
});
