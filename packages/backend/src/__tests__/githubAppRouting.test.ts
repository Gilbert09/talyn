import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { githubService, GitHubAuthorizationUnavailableError } from '../services/github.js';
import { githubRateGate } from '../services/githubRateGate.js';
import * as githubApp from '../services/githubApp.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { workspaces, githubInstallations, integrations } from '../db/schema.js';
import { encryptString } from '../services/tokenCrypto.js';
import type { Database } from '../db/client.js';

describe('workspace GitHub authorization', () => {
  let cleanup: () => Promise<void>;
  let db: Database;

  beforeEach(async () => {
    githubRateGate._reset();
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    const testDb = await createTestDb();
    db = testDb.db;
    cleanup = testDb.cleanup;
    for (const ws of githubService.getConnectedWorkspaces()) await githubService.removeToken(ws);
    await seedUser(testDb.db, { id: 'owner-a', email: 'a@example.test' });
    await seedUser(testDb.db, { id: 'owner-b', email: 'b@example.test' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(githubInstallations).values({
      installationId: 'victim-install', accountLogin: 'victim', accountType: 'Organization',
      repoFullNames: ['victim/private'],
    });
    vi.spyOn(githubApp, 'isGitHubAppConfigured').mockReturnValue(true);
    vi.spyOn(githubApp, 'getInstallationToken').mockResolvedValue('installation-must-not-be-used');
    await githubService.storeToken('ws-a', 'user-a', 'bearer', 'repo', { installationId: 'victim-install' });
    await githubService.storeToken('ws-b', 'user-b', 'bearer', 'repo', { installationId: 'victim-install' });
    await githubService.init();
  });

  afterEach(async () => {
    for (const ws of githubService.getConnectedWorkspaces()) await githubService.removeToken(ws);
    await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const operations = [
    ['repository', (ws: string) => githubService.getRepository(ws, 'victim', 'private')],
    ['merge', (ws: string) => githubService.mergePullRequest(ws, 'victim', 'private', 7)],
    ['search', (ws: string) => githubService.searchPullRequestNumbers(ws, 'repo:victim/private is:pr')],
    ['GraphQL read', (ws: string) => githubService.executeGraphql(ws, 'query { viewer { login } }', { owner: 'victim' })],
    ['GraphQL mutation', (ws: string) => githubService.executeGraphql(ws, 'mutation { example }', { owner: 'victim' })],
  ] as const;

  it.each(operations)('uses each user token for %s, never the global installation', async (_name, operation) => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      const allowed = authorization === 'bearer user-b';
      return new Response(JSON.stringify(allowed
        ? { full_name: 'victim/private', merged: true, items: [], data: { allowed: true } }
        : { message: 'Not Found' }), { status: allowed ? 200 : 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(operation('ws-a')).rejects.toThrow();
    await expect(operation('ws-b')).resolves.toBeDefined();
    expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')))
      .toEqual(['bearer user-a', 'bearer user-b']);
    expect(githubApp.getInstallationToken).not.toHaveBeenCalled();
  });

  it.each(operations)('refuses disconnected workspace %s without an outbound call', async (_name, operation) => {
    await githubService.removeToken('ws-a');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(operation('ws-a')).rejects.toThrow(/not connected/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(githubApp.getInstallationToken).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])('refuses webhook access on HTTP %i', async (status) => {
    vi.spyOn(githubService, 'checkTokenHealth').mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
    expect(await githubService.canAccessRepository('ws-a', 'victim', 'private')).toBe(false);
    expect(githubApp.getInstallationToken).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])('keeps authorization unverifiable on HTTP %i', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })));
    await expect(githubService.canAccessRepository('ws-a', 'victim', 'private'))
      .rejects.toBeInstanceOf(GitHubAuthorizationUnavailableError);
  });

  it.each(['deleted', 'disabled'])('refuses a cached credential after its integration is %s elsewhere', async (change) => {
    const where = eq(integrations.workspaceId, 'ws-a');
    if (change === 'deleted') await db.delete(integrations).where(where);
    else await db.update(integrations).set(change === 'disabled'
      ? { enabled: false }
      : { config: { accessTokenEnc: encryptString('replacement-user') } }).where(where);
    expect(githubService.getAccessToken('ws-a')).toBe('user-a');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await githubService.canAccessRepository('ws-a', 'victim', 'private')).toBe(false);
    await expect(githubService.executeGraphql('ws-a', 'query { viewer { login } }')).rejects.toThrow(/not connected/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses network errors and mismatched repository responses', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ full_name: 'other/repo' })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(githubService.canAccessRepository('ws-a', 'victim', 'private'))
      .rejects.toBeInstanceOf(GitHubAuthorizationUnavailableError);
    expect(await githubService.canAccessRepository('ws-a', 'victim', 'private')).toBe(false);
  });

  it('does not restore a credential when disconnect occurs during refresh', async () => {
    await githubService.storeToken('ws-a', 'user-a', 'bearer', 'repo', {
      refreshToken: 'refresh-a', accessTokenExpiresAt: Date.now() - 1,
    });
    vi.spyOn(githubApp, 'refreshUserToken').mockImplementation(async () => {
      await githubService.removeToken('ws-a');
      return { access_token: 'new-a', token_type: 'bearer', scope: 'repo', expiresInSec: 3600 };
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await githubService.canAccessRepository('ws-a', 'victim', 'private')).toBe(false);
    expect(githubService.getAccessToken('ws-a')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never shares fetched data or installation budgets between workspaces', () => {
    expect(githubService.graphqlAccountKeyForOwner('ws-a', 'victim'))
      .not.toBe(githubService.graphqlAccountKeyForOwner('ws-b', 'victim'));
    expect(githubService.accountKeyFor('ws-a')).not.toBe('inst:victim-install');
    expect(githubService.accountKeyFor('ws-a')).toMatch(/^token:[a-f0-9]{64}$/);
    expect(githubService.accountKeyFor('ws-a')).not.toContain('user-a');
    expect(githubService.accountKeyFor('ws-a')).not.toBe(githubService.accountKeyFor('ws-b'));
    expect(githubService.accountKeyFor('ws-a')).toBe(githubService.accountKeyFor('ws-a'));
  });
});
