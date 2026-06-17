import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { randomBytes } from 'node:crypto';
import { githubRoutes, githubPublicRoutes } from '../../routes/github.js';
import { requireAuth, internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { workspaces as workspacesTable } from '../../db/schema.js';
import { githubService } from '../../services/github.js';

const OTHER_USER_ID = 'user-other';

async function makeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  // Public routes (unauthenticated — hit by GitHub's browser redirect).
  app.use('/github', githubPublicRoutes());
  // Authenticated routes.
  app.use('/api/v1/github', requireAuth, githubRoutes());
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function seed(db: Database): Promise<void> {
  await seedUser(db, { id: TEST_USER_ID });
  await seedUser(db, { id: OTHER_USER_ID });
  await db.insert(workspacesTable).values([
    { id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} },
    { id: 'ws2', ownerId: OTHER_USER_ID, name: 'theirs', settings: {} },
  ]);
}

const authHeaders = {
  ...internalProxyHeaders(TEST_USER_ID),
  'content-type': 'application/json',
};

describe('routes/github', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.FASTOWL_TOKEN_KEY = randomBytes(32).toString('base64');
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seed(db);
    const s = await makeServer();
    serverUrl = s.url;
    closeServer = s.close;
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
  });

  afterEach(async () => {
    for (const ws of githubService.getConnectedWorkspaces()) {
      await githubService.removeToken(ws).catch(() => {});
    }
    await closeServer();
    await cleanup();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('GET /api/v1/github/status', () => {
    it('returns configured=false shape + connected=false when no workspaceId', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/status`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('configured');
    });

    it('reports connected=false for a fresh workspace', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/status?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data.connected).toBe(false);
    });

    it('reports connected=true with scopes after a token is stored', async () => {
      vi.spyOn(githubService, 'isConfigured').mockReturnValue(true);
      await githubService.storeToken('ws1', 'gho_test', 'bearer', 'repo read:user');
      const res = await fetch(`${serverUrl}/api/v1/github/status?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data.connected).toBe(true);
      expect(body.data.scopes).toEqual(['repo', 'read:user']);
    });

    it('404s a workspace the caller does not own', async () => {
      vi.spyOn(githubService, 'isConfigured').mockReturnValue(true);
      const res = await fetch(`${serverUrl}/api/v1/github/status?workspaceId=ws2`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/v1/github/app/install-url', () => {
    it('401s unauthenticated', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/app/install-url`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
      expect(res.status).toBe(401);
    });

    it('404s a cross-tenant workspace', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/app/install-url`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws2' }),
      });
      expect(res.status).toBe(404);
    });

    it('400s when the GitHub App is not configured', async () => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;
      const res = await fetch(`${serverUrl}/api/v1/github/app/install-url`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/not configured/i);
    });
  });

  describe('GET /api/v1/github/installations', () => {
    it('401s unauthenticated', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/installations?workspaceId=ws1`);
      expect(res.status).toBe(401);
    });

    it('404s a workspace the caller does not own', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/installations?workspaceId=ws2`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });

    it('returns the installations for an owned workspace', async () => {
      const spy = vi.spyOn(githubService, 'listInstallations').mockResolvedValue([
        {
          accountLogin: 'acme',
          accountType: 'Organization',
          suspended: false,
          repositorySelection: 'all',
        },
      ]);
      const res = await fetch(`${serverUrl}/api/v1/github/installations?workspaceId=ws1`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual([
        {
          accountLogin: 'acme',
          accountType: 'Organization',
          suspended: false,
          repositorySelection: 'all',
        },
      ]);
      expect(spy).toHaveBeenCalledWith('ws1');
    });
  });

  describe('GET /github/app/callback', () => {
    it('400s (HTML page) on an error query param', async () => {
      const res = await fetch(
        `${serverUrl}/github/app/callback?error=access_denied&error_description=User+declined`
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      const body = await res.text();
      expect(body).toContain('User declined');
    });

    it('400s on missing code/state/installation_id', async () => {
      const res = await fetch(`${serverUrl}/github/app/callback?code=abc`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('Missing code');
    });

    it('400s on a bogus state token not in the in-memory map', async () => {
      const res = await fetch(
        `${serverUrl}/github/app/callback?code=abc&installation_id=42&state=ws1:never-issued`
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toMatch(/Invalid install state/);
    });
  });

  describe('POST /api/v1/github/disconnect', () => {
    it('removes the token for the workspace', async () => {
      await githubService.storeToken('ws1', 'gho', 'bearer', 'repo');
      const removeSpy = vi.spyOn(githubService, 'removeToken');

      const res = await fetch(`${serverUrl}/api/v1/github/disconnect`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws1' }),
      });
      expect(res.status).toBe(200);
      expect(removeSpy).toHaveBeenCalledWith('ws1', expect.stringContaining('user disconnected'));
    });

    it('404s a cross-tenant workspace', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/disconnect`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ workspaceId: 'ws2' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/v1/github/user', () => {
    it('404s a cross-tenant workspace', async () => {
      const res = await fetch(`${serverUrl}/api/v1/github/user?workspaceId=ws2`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });

    it('forwards to githubService.getUser and returns the result', async () => {
      vi.spyOn(githubService, 'getUser').mockResolvedValue({
        id: 1, login: 'octocat', name: 'Octo', avatar_url: 'x', email: null,
      });
      const res = await fetch(`${serverUrl}/api/v1/github/user?workspaceId=ws1`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.login).toBe('octocat');
    });

    it('400s when githubService surfaces an error', async () => {
      vi.spyOn(githubService, 'getUser').mockRejectedValue(new Error('token expired'));
      const res = await fetch(`${serverUrl}/api/v1/github/user?workspaceId=ws1`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/v1/github/repos', () => {
    it('delegates to listRepositories', async () => {
      vi.spyOn(githubService, 'listRepositories').mockResolvedValue([
        {
          id: 1, name: 'a', full_name: 'o/a', private: false,
          html_url: 'u', default_branch: 'main', owner: { login: 'o', avatar_url: 'x' },
        },
      ]);
      const res = await fetch(`${serverUrl}/api/v1/github/repos?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data).toHaveLength(1);
    });
  });

  describe('GET /api/v1/github/all-repos', () => {
    it('delegates to listAllAccessibleRepos', async () => {
      vi.spyOn(githubService, 'listAllAccessibleRepos').mockResolvedValue([
        {
          id: 1, name: 'owl', full_name: 'Gilbert09/owl', private: false,
          html_url: 'u', default_branch: 'main', owner: { login: 'Gilbert09', avatar_url: 'x' },
        },
        {
          id: 2, name: 'posthog', full_name: 'PostHog/posthog', private: false,
          html_url: 'u', default_branch: 'master', owner: { login: 'PostHog', avatar_url: 'x' },
        },
      ]);
      const res = await fetch(`${serverUrl}/api/v1/github/all-repos?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data.map((r: { full_name: string }) => r.full_name)).toEqual([
        'Gilbert09/owl',
        'PostHog/posthog',
      ]);
    });
  });

  describe('GET /api/v1/github/orgs', () => {
    it('delegates to listOrganizations', async () => {
      vi.spyOn(githubService, 'listOrganizations').mockResolvedValue([
        { login: 'PostHog', avatar_url: 'x' },
      ]);
      const res = await fetch(`${serverUrl}/api/v1/github/orgs?workspaceId=ws1`, {
        headers: authHeaders,
      });
      const body = await res.json();
      expect(body.data).toEqual([{ login: 'PostHog', avatar_url: 'x' }]);
    });
  });

  describe('GET /api/v1/github/orgs/:org/repos', () => {
    it('delegates to listOrgRepositories with the org param', async () => {
      const spy = vi.spyOn(githubService, 'listOrgRepositories').mockResolvedValue([
        {
          id: 1, name: 'posthog', full_name: 'PostHog/posthog', private: false,
          html_url: 'u', default_branch: 'master', owner: { login: 'PostHog', avatar_url: 'x' },
        },
      ]);
      const res = await fetch(
        `${serverUrl}/api/v1/github/orgs/posthog/repos?workspaceId=ws1`,
        { headers: authHeaders }
      );
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].full_name).toBe('PostHog/posthog');
      expect(spy).toHaveBeenCalledWith('ws1', 'posthog');
    });
  });

  // The PR-management routes (list / get / create / merge /
  // review / comment) were dropped in Phase 7. Those tests went
  // with them. Coverage for createPullRequest still lives in
  // githubService.test.ts since the service is invoked directly
  // from openPullRequestForTask.

  describe('GET /api/v1/github/repos/:owner/:repo/branches', () => {
    it('delegates to listBranches', async () => {
      const spy = vi
        .spyOn(githubService, 'listBranches')
        .mockResolvedValue([{ name: 'main' }, { name: 'dev' }]);
      const res = await fetch(
        `${serverUrl}/api/v1/github/repos/acme/widgets/branches?workspaceId=ws1`,
        { headers: authHeaders }
      );
      const body = await res.json();
      expect(body.data).toEqual([{ name: 'main' }, { name: 'dev' }]);
      expect(spy).toHaveBeenCalledWith(
        'ws1',
        'acme',
        'widgets',
        expect.any(Object)
      );
    });
  });
});
