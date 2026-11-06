import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiTokenPrincipal } from '../services/apiTokens.js';
import { createTestDb } from './helpers/testDb.js';
import { repositories, spaceRepositories, spaces, teamMembers, teams, users, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { githubService } from '../services/github.js';
import { authorizedReadableChat, authorizedReadableSession, authorizedSession } from '../services/public/authorize.js';
import { resetRepoReadCacheForTests } from '../services/teams/access.js';
import { spaceRoutes } from '../routes/public/spaces.js';
import { sessionRoutes } from '../routes/public/sessions.js';

const token = (ownerId: string, scopes: ApiTokenPrincipal['scopes']): ApiTokenPrincipal => ({
  tokenId: `token-${ownerId}`, name: 'test', ownerId, email: `${ownerId}@example.test`,
  isAdmin: false, scopes, workspaceIds: null, expiresAt: null,
});

function route(path: string) {
  const found = spaceRoutes.find((item) => item.path === path);
  if (!found) throw new Error(`Missing route ${path}`);
  return found;
}

describe('public space handlers', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    vi.stubEnv('SPACES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    resetRepoReadCacheForTests();
    testDb = await createTestDb();
    await testDb.db.insert(users).values([
      { id: 'anna', email: 'anna@example.test', githubUserId: 100, githubUsername: 'anna' },
      { id: 'ben', email: 'ben@example.test', githubUserId: 200, githubUsername: 'ben' },
      { id: 'cy', email: 'cy@example.test', githubUserId: 300, githubUsername: 'cy' },
    ]);
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'anna', name: 'A' },
      { id: 'ws-b', ownerId: 'ben', name: 'B' },
      { id: 'ws-c', ownerId: 'cy', name: 'C' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main' },
      { id: 'repo-secret', workspaceId: 'ws-a', name: 'acme/secret', url: 'https://github.com/acme/secret', defaultBranch: 'main' },
    ]);
    await testDb.db.insert(teams).values({ id: 'team-a', name: 'Acme' });
    await testDb.db.insert(teamMembers).values([
      { id: 'm-a', teamId: 'team-a', githubUserId: 100, userId: 'anna', githubLogin: 'anna', role: 'owner' },
      { id: 'm-b', teamId: 'team-a', githubUserId: 200, userId: 'ben', githubLogin: 'ben', role: 'member' },
    ]);
    await testDb.db.insert(spaces).values({ id: 'space-a', teamId: 'team-a', name: 'Web', color: '#4f46e5' });
    await testDb.db.insert(spaceRepositories).values({ spaceId: 'space-a', repoFullName: 'acme/app' });
    await testDb.db.insert(workbenches).values([
      { id: 'visible', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: 'visible', branch: 'visible', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready', spaceId: 'space-a', createdAt: new Date('2026-11-01T00:00:00Z') },
      { id: 'hidden', workspaceId: 'ws-a', repositoryId: 'repo-secret', repoFullName: 'acme/secret', name: 'hidden', branch: 'hidden', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready', spaceId: 'space-a', createdAt: new Date('2026-11-02T00:00:00Z') },
    ]);
    await testDb.db.insert(workbenchChats).values({ id: 'chat-visible', workbenchId: 'visible', workspaceId: 'ws-a', title: 'Chat', agent: 'claude' });
    vi.spyOn(githubService, 'canAccessRepository').mockImplementation(async (_workspace, _owner, repo) => repo === 'app');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
    resetRepoReadCacheForTests();
    await testDb.cleanup();
  });

  it('lists teams, spaces, and visible sessions across two pages', async () => {
    const ben = token('ben', ['teams:read', 'spaces:read']);
    const context = { req: {} as never, res: {} as never, params: {}, query: { limit: 50 }, body: undefined, token: ben };
    const teamsResult = await route('/teams').handler(context);
    expect(teamsResult).toMatchObject({ body: { data: [{ id: 'team-a', my_role: 'member' }] } });
    const spacesResult = await route('/spaces').handler({ ...context, query: { limit: 50, team_id: 'team-a' } });
    expect(spacesResult).toMatchObject({ body: { data: [{ id: 'space-a', team_id: 'team-a' }] } });
    const first = await route('/spaces/{id}/sessions').handler({ ...context, params: { id: 'space-a' }, query: { limit: 1 } });
    expect(first).toMatchObject({ body: { data: [], hidden_count: 1, has_more: true } });
    const cursor = (first as { body: { next_cursor: string } }).body.next_cursor;
    const second = await route('/spaces/{id}/sessions').handler({ ...context, params: { id: 'space-a' }, query: { limit: 1, cursor } });
    expect(second).toMatchObject({ body: { data: [{ id: 'visible', creator_github_login: 'anna' }], hidden_count: 0, has_more: false } });
  });

  it('lets a member read a teammate session but keeps writes with its owner', async () => {
    const ben = token('ben', ['sessions:read']);
    await expect(authorizedReadableSession(ben, 'visible')).resolves.toMatchObject({ id: 'visible' });
    await expect(authorizedReadableChat(ben, 'chat-visible')).resolves.toMatchObject({ id: 'chat-visible' });
    await expect(authorizedReadableSession(ben, 'hidden')).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(authorizedSession(ben, 'visible')).rejects.toMatchObject({ code: 'session_not_found' });
  });

  it('checks the extra write scope, membership, and the flag before a create', async () => {
    const create = sessionRoutes.find((item) => item.operationId === 'createSession')!;
    const context = { req: {} as never, res: {} as never, params: {}, query: {}, body: { space_id: 'space-a', agent: 'claude' }, token: token('ben', ['sessions:write']) };
    await expect(create.preflight!(context)).rejects.toMatchObject({ code: 'insufficient_scope' });
    await expect(create.preflight!({ ...context, token: token('cy', ['sessions:write', 'spaces:write']) })).rejects.toMatchObject({ code: 'space_not_found' });
    vi.stubEnv('SPACES_ENABLED', 'false');
    resetFeatureFlagsForTests();
    await expect(create.preflight!({ ...context, token: token('ben', ['sessions:write', 'spaces:write']) })).rejects.toMatchObject({ code: 'spaces_unavailable' });
  });
});
