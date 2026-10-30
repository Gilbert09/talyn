import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectSandboxSize, isComposeFileName, resolveSandboxSize, SANDBOX_SERVICES_NOTE, SANDBOX_SIZES, workbenchTurnPrompt,
  type RepositorySandboxSizeResponse, type SandboxSize,
} from '@talyn/shared';
import { repositories, workspaces } from '../db/schema.js';
import { githubService } from '../services/github.js';
import { FleetThrottleError } from '../services/selfHosted/client.js';
import * as sandboxRun from '../services/selfHosted/sandboxRun.js';
import { createWorkbenchSandbox } from '../services/workbenches/lifecycle.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import {
  detectRepoSandboxSize, getSizeRepository, isSizeRefusal, mergeSandboxSize, sizeForSession, validateSandboxSizeChoice,
} from '../services/workbenches/sandboxSize.js';
import { getWorkbench, insertWorkbench } from '../services/workbenches/store.js';
import { repositoryRoutes } from '../routes/repositories.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { FakeFleet } from './helpers/fakeFleet.js';
import { invokeRoute } from './helpers/invokeRoute.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';

const POSTHOG_LIKE = `
services:
  db:
    image: postgres:15
  redis:
    image: redis:7
  clickhouse:
    image: clickhouse/clickhouse-server:24
  zookeeper:
    image: zookeeper:3.7
  kafka:
    image: confluentinc/cp-kafka:7
`;

const compose = (...services: Array<[string, string]>) =>
  `version: '3'\nservices:\n${services.map(([name, image]) => `  ${name}:\n    image: ${image}\n    ports:\n      - "1:1"\n`).join('')}volumes:\n  data:\n`;

describe('detectSandboxSize', () => {
  it.each<[string, Array<{ path: string; content: string | null }>, 'standard' | 'large', RegExp]>([
    ['a posthog-like stack', [{ path: 'docker-compose.base.yml', content: POSTHOG_LIKE }], 'large', /clickhouse.*kafka.*zookeeper|clickhouse, kafka, zookeeper/],
    ['one heavy image', [{ path: 'compose.yml', content: compose(['search', 'elasticsearch:8']) }], 'large', /elasticsearch/],
    ['a heavy service found by name', [{ path: 'compose.yml', content: compose(['temporal', 'custom/image']) }], 'large', /temporal/],
    ['three services with a database', [{ path: 'docker/docker-compose.yml', content: compose(['app', 'node:20'], ['db', 'postgres:16'], ['cache', 'redis:7']) }], 'large', /3 services.*database db/],
    ['three services and no database', [{ path: 'compose.yml', content: compose(['app', 'node:20'], ['cache', 'redis:7'], ['mail', 'mailhog/mailhog']) }], 'standard', /small stack/],
    ['a small app with one database', [{ path: 'compose.yml', content: compose(['app', 'node:20'], ['db', 'postgres:16']) }], 'standard', /small stack/],
    ['only redis', [{ path: 'compose.yml', content: compose(['cache', 'redis:7']) }], 'standard', /small stack/],
    ['no compose file', [], 'standard', /No compose file/],
    ['an unreadable file', [{ path: 'compose.yml', content: null }], 'standard', /No compose file/],
    ['a file with no services', [{ path: 'compose.yml', content: 'name: x\n' }], 'standard', /No compose file/],
    ['a heavy name in a comment', [{ path: 'compose.yml', content: '# kafka later\nservices:\n  app:\n    image: node:20\n' }], 'standard', /small stack/],
    ['services split across files do not add up', [
      { path: 'a.yml', content: compose(['db', 'postgres:16'], ['app', 'node']) },
      { path: 'b.yml', content: compose(['cache', 'redis']) },
    ], 'standard', /small stack/],
  ])('%s', (_name, files, size, reason) => {
    const result = detectSandboxSize(files);
    expect(result.size).toBe(size);
    expect(result.reason).toMatch(reason);
  });

  it.each([
    ['docker-compose.yml', true], ['docker-compose.dev.yml', true], ['compose.yaml', true], ['compose.override.yml', true],
    ['docker-compose.md', false], ['composer.json', false], ['README.yml', false],
  ])('knows compose file name %s', (name, expected) => {
    expect(isComposeFileName(name)).toBe(expected);
  });
});

describe('resolveSandboxSize', () => {
  it.each<[Parameters<typeof resolveSandboxSize>[0], Parameters<typeof resolveSandboxSize>[1], SandboxSize]>([
    ['small', 'large', 'small'],
    ['large', 'standard', 'large'],
    ['standard', 'large', 'standard'],
    ['medium', 'large', 'medium'],
    ['xlarge', 'standard', 'xlarge'],
    ['auto', 'large', 'large'],
    [undefined, 'large', 'large'],
    ['auto', 'standard', 'standard'],
    ['auto', null, 'standard'],
    [undefined, undefined, 'standard'],
  ])('setting %s with detection %s gives %s', (setting, detected, expected) => {
    expect(resolveSandboxSize(setting, detected)).toBe(expected);
  });
});

describe('sandbox resources', () => {
  it.each<[SandboxSize, number, number, string]>([
    ['small', 2048, 2000, 'Small · 2 GB'],
    ['standard', 4096, 4000, 'Standard · 4 GB'],
    ['medium', 8192, 4000, 'Medium · 8 GB'],
    ['large', 12288, 6000, 'Large · 12 GB'],
    ['xlarge', 16384, 8000, 'X-Large · 16 GB'],
  ])('%s has the expected resources and label', (size, memMib, milliVcpu, label) => {
    expect(SANDBOX_SIZES[size]).toMatchObject({ memMib, milliVcpu, label });
  });
});

describe('the prompt', () => {
  it('tells every turn to start heavy services only when a test needs them', () => {
    const { appendSystemPrompt } = workbenchTurnPrompt({ agent: 'claude', text: 'hi', planMode: false, createPr: { branch: 'b', baseBranch: 'main' } });
    expect(appendSystemPrompt).toContain(SANDBOX_SERVICES_NOTE);
    expect(SANDBOX_SERVICES_NOTE).toMatch(/only when a test needs them/);
    expect(SANDBOX_SERVICES_NOTE).toMatch(/Stop the services you started/);
  });
});

describe('validateSandboxSizeChoice', () => {
  it.each(['auto', 'small', 'standard', 'medium', 'large', 'xlarge'])('accepts %s', (value) => {
    expect(validateSandboxSizeChoice({ sandboxSize: value })).toBe(value);
  });
  it.each<[string, unknown]>([
    ['an unknown size', { sandboxSize: 'huge' }], ['a missing size', {}], ['a number', { sandboxSize: 4096 }],
    ['an extra key', { sandboxSize: 'large', memMib: 1 }], ['a string body', 'large'], ['null', null], ['an array', ['large']],
  ])('refuses %s', (_name, body) => {
    expect(() => validateSandboxSizeChoice(body)).toThrow();
  });
});

describe('sandbox size for a repository', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  const router = repositoryRoutes();

  beforeEach(async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: TEST_USER_ID });
    await seedUser(testDb.db, { id: 'other' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws', ownerId: TEST_USER_ID, name: 'Test' }, { id: 'other-ws', ownerId: 'other', name: 'Other' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo', workspaceId: 'ws', name: 'a/b', url: 'https://github.com/a/b' },
      { id: 'other-repo', workspaceId: 'other-ws', name: 'a/private', url: 'https://github.com/a/private' },
    ]);
    await insertWorkbench({ id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'a/b', name: 'paris',
      branch: 'paris', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'provisioning' });
    fleet = new FakeFleet();
    vi.spyOn(githubService, 'getRefSha').mockResolvedValue('sha1');
    vi.spyOn(githubService, 'getDirectoryListing').mockImplementation(async (_ws, _o, _r, path) =>
      path === '' ? [{ name: 'docker-compose.base.yml', path: '', type: 'file', sha: '', size: 1 }, { name: 'README.md', path: '', type: 'file', sha: '', size: 1 }] : []);
    vi.spyOn(githubService, 'getFileContent').mockResolvedValue({ content: POSTHOG_LIKE, size: POSTHOG_LIKE.length });
    vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'agent-token' }, githubToken: 'github-token' });
    vi.spyOn(sandboxRun, 'resolveRepository').mockResolvedValue({ slug: 'a/b', defaultBranch: 'main' });
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client: fleet.asClient() });
    vi.spyOn(runtime, 'gitAuthorFor').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
    await testDb.cleanup();
  });

  const create = async () => createWorkbenchSandbox((await getWorkbench('wb'))!, 'talyn-wb-paris');
  const call = (method: string, suffix = '', body?: unknown, id = 'repo') =>
    invokeRoute<{ data: RepositorySandboxSizeResponse }>(router, method, `/:id/sandbox-size${suffix}`, {
      params: { id }, body, user: { id: TEST_USER_ID, email: 'owner@test.invalid', isAdmin: false },
    });

  it('detects large, reads only compose files, and caches by head SHA', async () => {
    expect(await sizeForSession({ repositoryId: 'repo', workspaceId: 'ws' })).toBe('large');
    expect(githubService.getFileContent).toHaveBeenCalledTimes(1);
    expect(githubService.getFileContent).toHaveBeenCalledWith('ws', 'a', 'b', 'docker-compose.base.yml', 'sha1', expect.any(Number));
    const stored = (await getSizeRepository('repo'))!.settings?.detectedSandboxSize;
    expect(stored).toMatchObject({ size: 'large', sha: 'sha1' });
    expect(stored?.reason).toMatch(/clickhouse/);

    // A fresh answer costs nothing; a stale one costs one head read while the SHA is unchanged.
    await sizeForSession({ repositoryId: 'repo', workspaceId: 'ws' });
    expect(githubService.getRefSha).toHaveBeenCalledTimes(1);
    await mergeSandboxSize('repo', { detectedSandboxSize: { ...stored!, at: '2020-01-01T00:00:00Z' } });
    await detectRepoSandboxSize('ws', (await getSizeRepository('repo'))!);
    expect(githubService.getRefSha).toHaveBeenCalledTimes(2);
    expect(githubService.getFileContent).toHaveBeenCalledTimes(1);

    vi.mocked(githubService.getRefSha).mockResolvedValue('sha2');
    await mergeSandboxSize('repo', { detectedSandboxSize: { ...stored!, at: '2020-01-01T00:00:00Z' } });
    await detectRepoSandboxSize('ws', (await getSizeRepository('repo'))!);
    expect(githubService.getFileContent).toHaveBeenCalledTimes(2);
  });

  it('is standard when GitHub cannot be read', async () => {
    vi.mocked(githubService.getRefSha).mockRejectedValue(new Error('down'));
    expect(await sizeForSession({ repositoryId: 'repo', workspaceId: 'ws' })).toBe('standard');
  });

  it('is standard for an unknown repository', async () => {
    expect(await sizeForSession({ repositoryId: 'nope', workspaceId: 'ws' })).toBe('standard');
  });

  it.each<SandboxSize>(['small', 'standard', 'medium', 'large', 'xlarge'])('uses the %s setting without reading GitHub', async (size) => {
    await mergeSandboxSize('repo', { sandboxSize: size });
    expect(await sizeForSession({ repositoryId: 'repo', workspaceId: 'ws' })).toBe(size);
    expect(githubService.getRefSha).not.toHaveBeenCalled();
  });

  it('removes the setting when it goes back to auto and keeps the detection', async () => {
    await sizeForSession({ repositoryId: 'repo', workspaceId: 'ws' });
    await mergeSandboxSize('repo', { sandboxSize: 'standard' });
    await mergeSandboxSize('repo', { sandboxSize: 'auto' });
    const settings = (await getSizeRepository('repo'))!.settings!;
    expect(settings.sandboxSize).toBeUndefined();
    expect(settings.detectedSandboxSize?.size).toBe('large');
  });

  it('creates the box at the detected size', async () => {
    expect((await create()).ok).toBe(true);
    expect(fleet.created[0]).toMatchObject({
      memMib: SANDBOX_SIZES.large.memMib,
      milliVcpu: SANDBOX_SIZES.large.milliVcpu,
      policy: {
        credentials: { openai: 'none' },
        github: { readAllRepos: true },
      },
    });
  });

  it('does not request cross-repository reads when GitHub is suppressed', async () => {
    vi.spyOn(sandboxRun, 'buildSandboxCreateBody').mockResolvedValueOnce({
      ok: true,
      body: { id: 'talyn-wb-paris', workspaceId: 'ws', policy: { credentials: { github: 'none' } } },
    });
    await create();
    expect(fleet.created[0].policy).toEqual({ credentials: { github: 'none' } });
  });

  it.each<SandboxSize>(['small', 'standard', 'medium', 'large', 'xlarge'])('creates a %s box with its resources', async (size) => {
    await mergeSandboxSize('repo', { sandboxSize: size });
    await create();
    expect(fleet.created[0]).toMatchObject({ memMib: SANDBOX_SIZES[size].memMib, milliVcpu: SANDBOX_SIZES[size].milliVcpu });
  });

  it.each<SandboxSize>(['medium', 'large', 'xlarge'])('asks again for standard when the fleet refuses %s', async (size) => {
    await mergeSandboxSize('repo', { sandboxSize: size });
    const client = fleet.asClient();
    const real = client.createSandbox.bind(client);
    const refuse = new FleetThrottleError(`tenant_memory: 4096 MiB held + ${SANDBOX_SIZES[size].memMib} MiB requested exceeds the 10240 MiB permitted`);
    const spy = vi.spyOn(client, 'createSandbox').mockRejectedValueOnce(refuse);
    spy.mockImplementation(real);
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client });
    expect((await create()).ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toMatchObject({ memMib: SANDBOX_SIZES[size].memMib, milliVcpu: SANDBOX_SIZES[size].milliVcpu });
    expect(spy.mock.calls[1][0]).toMatchObject({ memMib: 4096, milliVcpu: 4000 });
  });

  it.each<[string, Error]>([
    ['a rate limit', new FleetThrottleError('slow down')],
    ['another error', new Error('boom')],
  ])('does not retry smaller after %s', async (_name, error) => {
    const client = fleet.asClient();
    const spy = vi.spyOn(client, 'createSandbox').mockRejectedValue(error);
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client });
    await expect(create()).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not retry a standard box that was refused', async () => {
    await mergeSandboxSize('repo', { sandboxSize: 'standard' });
    const client = fleet.asClient();
    const spy = vi.spyOn(client, 'createSandbox').mockRejectedValue(new FleetThrottleError('exceeds the 512 MiB permitted'));
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client });
    await expect(create()).rejects.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['memory', 'tenant_memory: exceeds the 10240 MiB permitted', true],
    ['vcpu', '4000 milli-vCPU held + 6000 requested exceeds the 8000 permitted', true],
    ['a rate limit', 'rate limited', false],
  ])('knows a %s refusal', (_name, message, expected) => {
    expect(isSizeRefusal(new FleetThrottleError(message))).toBe(expected);
  });

  describe('the route', () => {
    it('reports auto with the detected answer', async () => {
      const res = await call('GET');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ setting: 'auto', effective: 'large', detected: { size: 'large', sha: 'sha1' } });
    });

    it.each<SandboxSize>(['small', 'standard', 'medium', 'large', 'xlarge'])('saves %s and returns it', async (size) => {
      const res = await call('PATCH', '', { sandboxSize: size });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ setting: size, effective: size });
      expect((await call('PATCH', '', { sandboxSize: 'auto' })).body.data).toMatchObject({ setting: 'auto' });
    });

    it.each([{ sandboxSize: 'huge' }, {}, { sandboxSize: 'large', extra: 1 }])('refuses %j with 400', async (body) => {
      expect((await call('PATCH', '', body)).status).toBe(400);
    });

    it('refuses another account repository', async () => {
      expect((await call('PATCH', '', { sandboxSize: 'large' }, 'other-repo')).status).toBeGreaterThanOrEqual(403);
    });
  });
});
