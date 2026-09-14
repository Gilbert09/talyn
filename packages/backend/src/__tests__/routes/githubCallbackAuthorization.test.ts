import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { githubPublicRoutes, githubRoutes } from '../../routes/github.js';
import { wrapAsyncRoutes } from '../../middleware/asyncHandler.js';
import * as githubApp from '../../services/githubApp.js';
import { githubService } from '../../services/github.js';
import { prMonitorService } from '../../services/prMonitor.js';
import { githubInstallations, workspaces } from '../../db/schema.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';

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

describe('GitHub callback authorization', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
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
  });

  async function state() {
    const response = await fetch(`${url}/api/v1/github/app/install-url`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: 'ws1' }),
    });
    expect(response.status).toBe(200);
    return `ws1:${(await response.json()).data.state}`;
  }

  function callback(value: string, hint?: string) {
    const query = new URLSearchParams({ code: 'test-code', state: value, ...(hint ? { installation_id: hint } : {}) });
    return fetch(`${url}/api/v1/github/app/callback?${query}`, { redirect: 'manual' });
  }

  it.each(['foreign', 'allowed'])('accepts only a user-verified installation hint: %s', async (hint) => {
    const response = await callback(await state(), hint);
    expect(response.status).toBe(hint === 'allowed' ? 200 : 500);
    if (hint === 'foreign') {
      expect(githubApp.fetchInstallation).not.toHaveBeenCalled();
      expect(githubApp.fetchInstallationRepos).not.toHaveBeenCalled();
      expect(githubService.storeToken).not.toHaveBeenCalled();
      expect(await testDb.db.select().from(githubInstallations)).toEqual([]);
    } else {
      expect(githubApp.fetchInstallation).toHaveBeenCalledWith('allowed');
      expect(githubService.storeToken).toHaveBeenCalledWith('ws1', 'user-a', 'bearer', '', { installationId: 'allowed' });
    }
  });

  it('does not treat an installation listing failure as proof of the callback hint', async () => {
    vi.mocked(githubApp.fetchUserInstallations).mockRejectedValue(new Error('listing failed'));
    const response = await callback(await state(), 'foreign');
    expect(response.status).toBe(500);
    expect(githubApp.fetchInstallation).not.toHaveBeenCalled();
    expect(githubApp.fetchInstallationRepos).not.toHaveBeenCalled();
    expect(githubService.storeToken).not.toHaveBeenCalled();
  });

  it.each([600_000, 600_001])('rejects expired state after %i ms without a cleanup tick', async (elapsed) => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const value = await state();
    vi.mocked(Date.now).mockReturnValue(now + elapsed);
    expect((await callback(value, 'allowed')).status).toBe(400);
    expect(githubApp.exchangeUserCode).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(now);
    expect((await callback(value, 'allowed')).status).toBe(400);
  });

  it('consumes successful state and refuses a modified workspace', async () => {
    const value = await state();
    expect((await callback(value.replace('ws1:', 'ws-other:'), 'allowed')).status).toBe(400);
    expect(githubApp.exchangeUserCode).not.toHaveBeenCalled();
    expect((await callback(value, 'allowed')).status).toBe(200);
    expect((await callback(value, 'allowed')).status).toBe(400);
    expect(githubApp.exchangeUserCode).toHaveBeenCalledTimes(1);
  });
});
