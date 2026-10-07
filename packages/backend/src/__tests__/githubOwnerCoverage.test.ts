import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { githubService } from '../services/github.js';
import { fetchOwnerInstallation, probeOrgSso } from '../services/githubApp.js';
import { debugBus } from '../services/debugBus.js';
import { repositories, workspaces } from '../db/schema.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import type { GitHubOwnerCoverage } from '@talyn/shared';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const ssoUrl = 'https://github.com/orgs/PostHog/sso?authorization_request=123';
let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: 'coverage-user', email: 'coverage@example.test' });
  await testDb.db.insert(workspaces).values([
    { id: 'coverage', ownerId: 'coverage-user', name: 'Coverage' },
    { id: 'other', ownerId: 'coverage-user', name: 'Other' },
  ]);
});

afterAll(async () => {
  await githubService.removeToken('coverage');
  await githubService.removeToken('other');
  await testDb.cleanup();
});

beforeEach(async () => {
  vi.stubEnv('GITHUB_APP_ID', '123');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
  await testDb.db.delete(repositories);
  await githubService.storeToken('coverage', 'ghu_user', 'bearer', 'repo');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function watch(owners: string[], workspaceId = 'coverage') {
  await testDb.db.insert(repositories).values(owners.map((owner, index) => ({
    id: `${workspaceId}-${index}`,
    workspaceId,
    name: `repo-${index}`,
    url: `https://github.com/${owner}/repo-${index}`,
  })));
}

interface OwnerResponse {
  installed?: boolean;
  suspended?: boolean;
  personal?: boolean;
  error?: number;
  sso?: string;
  ssoOn?: 'metadata' | 'repos';
  probeStatus?: number;
}

function mockGithub(owners: Record<string, OwnerResponse>, visible: string[] = []) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/user/installations') {
      return Response.json({ installations: visible.map((login) => ({
        id: 42, account: { login, type: 'Organization' }, repository_selection: 'all',
      })) });
    }
    const [, kind, owner, resource] = url.pathname.split('/');
    const fixture = owners[owner];
    if (!fixture) throw new Error(`Unexpected request: ${url}`);
    if (resource === 'installation') {
      const status = fixture.error ?? (fixture.installed === false || (kind === 'orgs' && fixture.personal) ? 404 : 200);
      return Response.json({
        id: 42, account: { login: owner },
        suspended_at: fixture.suspended ? '2026-10-01T00:00:00Z' : null,
        repository_selection: 'all',
      }, { status });
    }
    const includeSso = fixture.ssoOn === 'metadata' ? !resource : resource === 'repos';
    return Response.json({}, {
      status: fixture.probeStatus ?? (fixture.personal ? 404 : 200),
      headers: fixture.sso && includeSso ? { 'X-GitHub-SSO': fixture.sso } : {},
    });
  });
}

describe('owner coverage', () => {
  it.each<{ name: string; response: OwnerResponse; expected: Omit<GitHubOwnerCoverage, 'owner'> }>([
    { name: 'not installed', response: { installed: false }, expected: { state: 'not_installed' } },
    { name: 'suspended', response: { suspended: true }, expected: { state: 'suspended' } },
    { name: 'SSO on repository response', response: { sso: `required; url=${ssoUrl}`, probeStatus: 403 }, expected: { state: 'sso_required', ssoUrl } },
    { name: 'SSO on metadata response', response: { sso: `required; url=${ssoUrl}`, ssoOn: 'metadata' }, expected: { state: 'sso_required', ssoUrl } },
    { name: 'partial results', response: { sso: 'partial-results; organizations=123,456' }, expected: { state: 'sso_required', ssoUrl: null } },
    { name: 'SSO without URL', response: { sso: 'required' }, expected: { state: 'sso_required', ssoUrl: null } },
    { name: 'no SSO signal', response: {}, expected: { state: 'not_accessible' } },
    { name: 'forbidden without SSO', response: { probeStatus: 403 }, expected: { state: 'not_accessible' } },
    { name: 'personal account', response: { personal: true }, expected: { state: 'not_accessible' } },
    { name: 'installation error', response: { error: 500 }, expected: { state: 'unknown' } },
    // The App said "installed" before the probe failed, so never `unknown`.
    { name: 'probe error', response: { probeStatus: 503 }, expected: { state: 'not_accessible' } },
    { name: 'probe rate limit', response: { probeStatus: 429 }, expected: { state: 'not_accessible' } },
    { name: 'probe unauthorized', response: { probeStatus: 401 }, expected: { state: 'not_accessible' } },
  ])('diagnoses $name', async ({ response, expected }) => {
    await watch(['PostHog']);
    const fetchMock = mockGithub({ PostHog: response });
    expect(await githubService.diagnoseOwnerCoverage('coverage')).toEqual([{ owner: 'PostHog', ...expected }]);
    if (response.installed === false || response.personal) {
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain('https://api.github.com/users/PostHog/installation');
    }
  });

  it('continues after one owner fails', async () => {
    await watch(['Broken', 'PostHog']);
    mockGithub({ Broken: { error: 502 }, PostHog: { suspended: true } });
    expect(await githubService.diagnoseOwnerCoverage('coverage')).toEqual([
      { owner: 'Broken', state: 'unknown' },
      { owner: 'PostHog', state: 'suspended' },
    ]);
  });

  it('records each diagnosis on the debug bus, and nothing for a covered workspace', async () => {
    await watch(['Broken', 'PostHog']);
    mockGithub({ Broken: { error: 502 }, PostHog: {} });
    const record = vi.spyOn(debugBus, 'recordEvent');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await githubService.diagnoseOwnerCoverage('coverage');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      service: 'github',
      action: 'coverage:diagnosed',
      workspaceId: 'coverage',
      summary: 'owner coverage — Broken=unknown, PostHog=not_accessible',
      meta: { problems: [
        { owner: 'Broken', state: 'unknown' },
        { owner: 'PostHog', state: 'not_accessible' },
      ] },
    }));

    record.mockClear();
    await githubService.storeToken('coverage', 'ghu_again', 'bearer', 'repo');
    vi.mocked(globalThis.fetch).mockRestore();
    mockGithub({}, ['broken', 'posthog']);
    await githubService.diagnoseOwnerCoverage('coverage');
    expect(record.mock.calls.filter(([e]) => e.action === 'coverage:diagnosed')).toEqual([]);
  });

  it('omits covered owners and ignores case when it removes duplicate owners', async () => {
    await watch(['Covered', 'covered', 'PostHog', 'posthog']);
    await watch(['Unrelated'], 'other');
    const fetchMock = mockGithub({ PostHog: { suspended: true } }, ['COVERED']);
    expect(await githubService.diagnoseOwnerCoverage('coverage')).toEqual([{ owner: 'PostHog', state: 'suspended' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('omits every covered owner without an App lookup', async () => {
    await watch(['PostHog']);
    const fetchMock = mockGithub({}, ['posthog']);
    expect(await githubService.diagnoseOwnerCoverage('coverage')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caches for 60 seconds and shares concurrent requests', async () => {
    await watch(['PostHog']);
    const fetchMock = mockGithub({ PostHog: { suspended: true } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await Promise.all([githubService.diagnoseOwnerCoverage('coverage'), githubService.diagnoseOwnerCoverage('coverage')]);
    clock.mockReturnValue(1_800_000_059_999);
    await githubService.diagnoseOwnerCoverage('coverage');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(1_800_000_060_000);
    await githubService.diagnoseOwnerCoverage('coverage');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('clears the cached diagnosis when a token is stored', async () => {
    await watch(['PostHog']);
    const fetchMock = mockGithub({ PostHog: { suspended: true } });
    await githubService.diagnoseOwnerCoverage('coverage');
    await githubService.storeToken('coverage', 'ghu_reconnected', 'bearer', 'repo');
    await githubService.diagnoseOwnerCoverage('coverage');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get('authorization')).toContain('ghu_reconnected');
  });

  it('keeps each workspace cache separate', async () => {
    await watch(['PostHog']);
    await watch(['PostHog'], 'other');
    await githubService.storeToken('other', 'ghu_other', 'bearer', 'repo');
    const fetchMock = mockGithub({ PostHog: { suspended: true } });
    await githubService.diagnoseOwnerCoverage('coverage');
    await githubService.diagnoseOwnerCoverage('other');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('uses an App JWT for installation lookup and the user token for both SSO probes', async () => {
    const fetchMock = mockGithub({ PostHog: {} });
    const record = vi.spyOn(debugBus, 'recordHttp');
    expect(await fetchOwnerInstallation('PostHog')).toEqual({
      installationId: '42', accountLogin: 'PostHog', suspended: false, repositorySelection: 'all',
    });
    expect(await probeOrgSso('ghu_user', 'PostHog')).toEqual({ required: false });
    const auth = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));
    expect(auth[0]).toMatch(/^Bearer ey/);
    expect(auth.slice(1)).toEqual(['Bearer ghu_user', 'Bearer ghu_user']);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.github.com/orgs/PostHog/installation',
      'https://api.github.com/orgs/PostHog',
      'https://api.github.com/orgs/PostHog/repos?per_page=1',
    ]);
    expect(record).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 429, 500])('throws for installation HTTP %i without a user fallback', async (status) => {
    const fetchMock = mockGithub({ PostHog: { error: status } });
    await expect(fetchOwnerInstallation('PostHog')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('appInstalledOnOwner', () => {
  it.each([
    { name: 'an active install', fixture: { installed: true }, expected: true },
    { name: 'no install', fixture: { installed: false }, expected: false },
    { name: 'a suspended install', fixture: { suspended: true }, expected: false },
    { name: 'a personal account with an install', fixture: { personal: true }, expected: true },
    { name: 'a GitHub failure', fixture: { error: 500 }, expected: null },
  ])('answers $expected for $name', async ({ fixture, expected }) => {
    const owner = `Owner${Math.random().toString(36).slice(2, 8)}`;
    mockGithub({ [owner]: fixture });
    expect(await githubService.appInstalledOnOwner(owner)).toBe(expected);
  });

  it('caches an answer per owner, case-insensitively', async () => {
    const owner = `Cached${Math.random().toString(36).slice(2, 8)}`;
    const fetchSpy = mockGithub({ [owner]: { installed: false }, [owner.toLowerCase()]: { installed: false } });
    expect(await githubService.appInstalledOnOwner(owner)).toBe(false);
    const calls = fetchSpy.mock.calls.length;
    expect(await githubService.appInstalledOnOwner(owner.toLowerCase())).toBe(false);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  it('answers null without calling GitHub when the App is not configured', async () => {
    vi.stubEnv('GITHUB_APP_ID', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await githubService.appInstalledOnOwner('ClickHouse')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
