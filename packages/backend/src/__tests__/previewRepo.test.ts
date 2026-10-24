import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryPreviewResponse } from '@talyn/shared';
import { invokeRoute } from './helpers/invokeRoute.js';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import { repositories, workspaces } from '../db/schema.js';
import { githubService } from '../services/github.js';
import { detectRepoPreview, effectivePreview, getPreviewRepository, mergePreview } from '../services/preview/repoPreview.js';
import { repositoryRoutes } from '../routes/repositories.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';

let testDb: Awaited<ReturnType<typeof createTestDb>>;
const router = repositoryRoutes();
const cached = { target: 'sandbox' as const, ports: [{ port: 3000 }], reasons: [], sha: 'old', at: 'then' };

beforeAll(async () => {
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: TEST_USER_ID });
  await seedUser(testDb.db, { id: 'other' });
  await testDb.db.insert(workspaces).values([
    { id: 'ws', ownerId: TEST_USER_ID, name: 'Mine' }, { id: 'other-ws', ownerId: 'other', name: 'Other' },
  ]);
  await testDb.db.insert(repositories).values([
    { id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' },
    { id: 'other-repo', workspaceId: 'other-ws', name: 'o/private', url: 'https://github.com/o/private' },
  ]);

});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('WORKBENCHES_ENABLED', 'true');
  resetFeatureFlagsForTests();
  vi.spyOn(githubService, 'getRefSha').mockResolvedValue('new');
  vi.spyOn(githubService, 'getFileContent').mockImplementation(async (_ws, _owner, _repo, path) =>
    path === 'package.json' ? { content: '{"scripts":{"dev":"vite"}}', size: 26 } : null);
  vi.spyOn(githubService, 'getDirectoryListing').mockResolvedValue([]);
  await testDb.db.update(repositories).set({ settings: null });
});

afterAll(async () => {
  await testDb.cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetFeatureFlagsForTests();
});

async function call(method: string, suffix = '', body?: unknown, id = 'repo') {
  return invokeRoute<{ data: RepositoryPreviewResponse }>(router, method, `/:id/preview${suffix}`, {
    params: { id }, body, user: { id: TEST_USER_ID, email: 'owner@test.invalid', isAdmin: false },
  });
}

describe('repository preview detection', () => {
  it('caches by SHA and reads files at that SHA with a 64 KB cap', async () => {
    await detectRepoPreview('ws', (await getPreviewRepository('repo'))!);
    expect(githubService.getFileContent).toHaveBeenCalledWith('ws', 'o', 'r', 'package.json', 'new', 65536);
    const count = vi.mocked(githubService.getFileContent).mock.calls.length;
    await detectRepoPreview('ws', (await getPreviewRepository('repo'))!);
    expect(githubService.getFileContent).toHaveBeenCalledTimes(count);
    expect((await getPreviewRepository('repo'))?.settings?.preview?.detected?.ports).toContainEqual({ port: 5173, primary: true });
    vi.mocked(githubService.getRefSha).mockResolvedValue('next');
    await detectRepoPreview('ws', (await getPreviewRepository('repo'))!);
    expect(githubService.getFileContent).toHaveBeenCalledTimes(count * 2);
  });

  it('merges detection into the latest user choice', async () => {
    const stale = (await getPreviewRepository('repo'))!;
    await mergePreview('repo', { target: 'off', ports: [{ port: 8010 }], coder: { workspace: 'mine' } });
    await detectRepoPreview('ws', stale);
    await mergePreview('repo', { coder: { checkout: '~/repo' } });
    const row = (await getPreviewRepository('repo'))!;
    expect(row.settings?.preview).toMatchObject({ target: 'off', coder: { workspace: 'mine', checkout: '~/repo' }, detected: { sha: 'new' } });
    expect(effectivePreview(row)).toMatchObject({ target: 'off', ports: [{ port: 8010 }], source: 'user' });
  });

  it.each(['head', 'file', 'listing'])('keeps the cache after a GitHub %s failure', async (failure) => {
    await mergePreview('repo', { detected: cached });
    const method = failure === 'head' ? 'getRefSha' : failure === 'file' ? 'getFileContent' : 'getDirectoryListing';
    vi.mocked(githubService[method]).mockRejectedValue(new Error('GitHub unavailable'));
    expect(await detectRepoPreview('ws', (await getPreviewRepository('repo'))!)).toEqual(cached);
    expect((await getPreviewRepository('repo'))?.settings?.preview?.detected).toEqual(cached);
  });

  it('uses directory names and keeps file settings above detection', async () => {
    vi.mocked(githubService.getDirectoryListing).mockImplementation(async (_ws, _owner, _repo, path) =>
      [{ name: path === '' ? '.coder' : 'coder-guide.md', path: '', type: 'dir', sha: '', size: 0 }]);
    vi.mocked(githubService.getFileContent).mockImplementation(async (_ws, _owner, _repo, path) => path === '.talyn/settings.toml'
      ? { content: '[preview]\ntarget="off"\nports=[]\n[preview.coder]\nrun="start"\ncheckout="~/app"', size: 80 } : null);
    await detectRepoPreview('ws', (await getPreviewRepository('repo'))!);
    expect(effectivePreview((await getPreviewRepository('repo'))!)).toMatchObject({ target: 'off', ports: [], coder: { run: 'start', checkout: '~/app' }, source: 'file' });
  });

  it('has no effective preview before detection', () => {
    expect(effectivePreview({ settings: null })).toEqual({ target: null, ports: [], reasons: [], source: 'none' });
  });
});

describe('repository preview routes', () => {
  it.each([['GET', ''], ['PATCH', ''], ['POST', '/detect']])('%s requires access and the flag', async (method, suffix) => {
    expect((await call(method, suffix, method === 'PATCH' ? {} : undefined, 'other-repo')).status).toBe(404);
    expect((await call(method, suffix, method === 'PATCH' ? {} : undefined, 'missing')).status).toBe(404);
    vi.stubEnv('WORKBENCHES_ENABLED', 'false');
    resetFeatureFlagsForTests();
    expect((await call(method, suffix, method === 'PATCH' ? {} : undefined)).status).toBe(403);
    expect(githubService.getRefSha).not.toHaveBeenCalled();
  });

  it.each([
    { target: 'bad' }, { target: null }, { detected: cached }, { ports: [1023] }, { ports: [65536] },
    { ports: [3000.5] }, { ports: Array(17).fill(3000) }, { ports: [{ port: 3000, label: 'x'.repeat(501) }] },
    { ports: [{ port: 3000, primary: 'yes' }] }, { coder: { url: 'file:///tmp' } }, { coder: { url: 'https://' } },
    { coder: { run: 'x'.repeat(501) } }, { coder: [] },
  ])('refuses invalid settings: %j', async (body) => {
    expect((await call('PATCH', '', body)).status).toBe(400);
    expect((await getPreviewRepository('repo'))?.settings).toBeNull();
  });

  it('refreshes detection on request even when the SHA has not changed', async () => {
    await call('GET');
    const count = vi.mocked(githubService.getFileContent).mock.calls.length;
    await call('POST', '/detect');
    expect(githubService.getFileContent).toHaveBeenCalledTimes(count * 2);
  });

  it('returns the effective config, stored choice, and detection', async () => {
    expect((await call('POST', '/detect')).status).toBe(200);
    const response = await call('PATCH', '', { target: 'coder', ports: [1024, 65535], coder: { url: 'https://coder.test', workspace: 'mine' } });
    expect(response.status).toBe(200);
    const { data } = (await call('GET')).body;
    expect(data).toMatchObject({ target: 'coder', source: 'user', user: { target: 'coder' }, detected: { sha: 'new' } });
    expect(data.ports.map((p: { port: number }) => p.port)).toEqual([1024, 65535]);
    await call('PATCH', '', { target: 'auto' });
    const [row] = await testDb.db.select({ settings: repositories.settings }).from(repositories).where(eq(repositories.id, 'repo'));
    expect(row.settings?.preview?.target).toBe('auto');
  });
});
