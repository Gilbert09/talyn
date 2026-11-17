import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { setupRoutes } from '../../routes/index.js';
import { internalProxyHeaders } from '../../middleware/auth.js';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { workspaces as workspacesTable, repositories, skills as skillsTable } from '../../db/schema.js';
import { githubService } from '../../services/github.js';
import { clearRepoSkillCache } from '../../services/skills.js';

/**
 * A route that waits on GitHub or a vendor must not run inside the owner-scope
 * request transaction. On 2026-11-17 four `GET /skills` requests held theirs
 * for 24 minutes. These pin which routes pass through `ownerScope`.
 */

const reached = vi.hoisted(() => [] as string[]);

vi.mock('../../middleware/ownerScope.js', () => ({
  ownerScope: (req: { method: string; originalUrl: string }, _res: unknown, next: () => void) => {
    reached.push(`${req.method} ${req.originalUrl.split('?')[0]}`);
    next();
  },
}));

vi.mock('../../services/github.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/github.js')>('../../services/github.js');
  const service = actual.githubService as unknown as Record<string, unknown>;
  service.getDirectoryListingResolved = vi.fn();
  service.getTreeRecursive = vi.fn();
  service.getFileContent = vi.fn();
  service.getDirectoryListing = vi.fn();
  for (const name of [
    'getUser', 'listInstallations', 'diagnoseOwnerCoverage', 'listRepositories',
    'listAllAccessibleRepos', 'listOrganizations', 'listOrgRepositories', 'listBranches',
  ]) {
    service[name] = vi.fn(async () => []);
  }
  return actual;
});

const SKILL_MD = '---\nname: reviewer\ndescription: Reviews PRs\n---\n\nReview carefully.';

describe('skill routes and the owner scope', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    reached.length = 0;
    vi.clearAllMocks();
    clearRepoSkillCache();
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'mine', settings: {} });
    await db.insert(repositories).values({
      id: 'repo1', workspaceId: 'ws1', name: 'acme/widgets', url: 'https://github.com/acme/widgets',
    });
    await db.insert(skillsTable).values({
      id: 'sk1', workspaceId: 'ws1', name: 'platform', description: '', content: 'x',
      createdAt: new Date(), updatedAt: new Date(),
    });
    vi.mocked(githubService.getDirectoryListingResolved).mockResolvedValue({
      path: '.claude/skills',
      entries: [{ name: 'reviewer', path: '.claude/skills/reviewer', type: 'dir', size: 0 }],
    });
    vi.mocked(githubService.getTreeRecursive).mockResolvedValue({
      truncated: false,
      entries: [{ path: 'reviewer/SKILL.md', sha: 'sha1', size: SKILL_MD.length, type: 'blob', mode: '100644' }],
    });
    vi.mocked(githubService.getFileContent).mockResolvedValue({ content: SKILL_MD, size: SKILL_MD.length });

    const app = express();
    app.use(express.json());
    setupRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  const get = (path: string) => fetch(`${baseUrl}${path}`, { headers: internalProxyHeaders(TEST_USER_ID) });

  it.each([
    { path: '/skills?workspaceId=ws1&repositoryId=repo1', status: 200, scoped: false },
    { path: '/skills?workspaceId=ws1', status: 200, scoped: false },
    { path: '/skills/repo/content?workspaceId=ws1&repositoryId=repo1&name=reviewer', status: 200, scoped: false },
    { path: '/skills/repo/content?workspaceId=ws1&repositoryId=repo1&name=missing', status: 404, scoped: false },
    { path: '/skills/sk1', status: 200, scoped: true },
    { path: '/skills/unknown', status: 404, scoped: true },
  ])('GET $path answers $status, owner scope: $scoped', async ({ path, status, scoped }) => {
    const res = await get(path);
    expect(res.status).toBe(status);
    const urlPath = `/api/v1${path.split('?')[0]}`;
    expect(reached.includes(`GET ${urlPath}`)).toBe(scoped);
  });

  it.each([
    { path: '/github/user?workspaceId=ws1', scoped: false },
    { path: '/github/installations?workspaceId=ws1', scoped: false },
    { path: '/github/coverage?workspaceId=ws1', scoped: false },
    { path: '/github/repos?workspaceId=ws1', scoped: false },
    { path: '/github/all-repos?workspaceId=ws1', scoped: false },
    { path: '/github/orgs?workspaceId=ws1', scoped: false },
    { path: '/github/orgs/acme/repos?workspaceId=ws1', scoped: false },
    { path: '/github/repos/acme/widgets/branches?workspaceId=ws1', scoped: false },
    { path: '/github/status?workspaceId=ws1', scoped: true },
    { path: '/cloud-providers/selfhosted/accounts?workspaceId=ws1', scoped: false },
    { path: '/cloud-providers?workspaceId=ws1', scoped: true },
  ])('GET $path reaches ownerScope: $scoped', async ({ path, scoped }) => {
    const res = await get(path);
    expect(res.status).not.toBe(404);
    expect(reached.includes(`GET /api/v1${path.split('?')[0]}`)).toBe(scoped);
  });

  it.each([
    '/github/user?workspaceId=ws2',
    '/github/coverage?workspaceId=ws2',
    '/cloud-providers/selfhosted/accounts?workspaceId=ws2',
  ])('GET %s refuses a workspace the caller does not own', async (path) => {
    await seedUser(db, { id: 'user-other' });
    await db.insert(workspacesTable).values({ id: 'ws2', ownerId: 'user-other', name: 'theirs', settings: {} });
    const res = await get(path);
    expect(res.status).toBe(404);
    expect(githubService.getUser).not.toHaveBeenCalled();
    expect(githubService.diagnoseOwnerCoverage).not.toHaveBeenCalled();
  });

  it('answers a discovery with the same shape as before', async () => {
    const res = await get('/skills?workspaceId=ws1&repositoryId=repo1');
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(Object.keys(body.data).sort()).toEqual(['platform', 'repo', 'repoStatus', 'usage']);
    expect(body.data.repoStatus).toBe('ok');
    expect((body.data.repo as Array<Record<string, unknown>>)[0]).not.toHaveProperty('content');
    expect((body.data.platform as Array<{ name: string }>).map((s) => s.name)).toEqual(['platform']);
  });

  it('refuses a workspace the caller does not own before any GitHub read', async () => {
    await seedUser(db, { id: 'user-other' });
    await db.insert(workspacesTable).values({ id: 'ws2', ownerId: 'user-other', name: 'theirs', settings: {} });
    const res = await get('/skills?workspaceId=ws2&repositoryId=repo1');
    expect(res.status).toBe(404);
    expect(githubService.getDirectoryListingResolved).not.toHaveBeenCalled();
  });
});
