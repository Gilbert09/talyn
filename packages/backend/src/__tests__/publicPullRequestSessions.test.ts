import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeFleet, claudeTurnLines, isAgentTurn } from './helpers/fakeFleet.js';
import { callPublic, mintToken, startPublicApi } from './helpers/publicApi.js';
import { pullRequests, repositories, workspaces } from '../db/schema.js';

/**
 * `POST /v1/pull-requests/{id}/sessions`: a session on the pull request's
 * head branch, through `createWorkbench`, against a fake fleet. The session
 * rules (the `workbenches` flag, `sessions:write`) apply as on `POST /sessions`.
 */

vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  getSelfHostedCredentials: async () => ({ claudeToken: 'sk-ant-oat-claude', openaiKey: 'oa-codex' }),
  fleetAgentStatus: async () => ({ connectedAgents: ['claude', 'codex'], reauthAgents: [] }),
}));

vi.mock('../services/cloudProviders/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/cloudProviders/registry.js')>()),
  getCloudProvider: () => ({ type: 'selfhosted' }),
}));

vi.mock('../services/repoDefaultBranch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/repoDefaultBranch.js')>()),
  reconcileDefaultBranch: async (input: { stored: string }) => input.stored || 'main',
}));

const { settleArchivesForTests } = await import('../services/workbenches/lifecycle.js');
const { githubService } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { getWorkbench } = await import('../services/workbenches/store.js');

describe('/v1 sessions on a pull request', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let api: Awaited<ReturnType<typeof startPublicApi>>;
  let fleet: FakeFleet;
  let token: string;

  const call = (method: string, path: string, body?: unknown, as = token) => callPublic(api.base, method, path, { token: as, body });

  beforeEach(async () => {
    vi.stubEnv('PUBLIC_API_ENABLED', 'true');
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main' },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'other/app', url: 'https://github.com/other/app', defaultBranch: 'main' },
    ]);
    const summary = { headBranch: 'feat/fast', baseBranch: 'release', headSha: 'a'.repeat(40), title: 'Fast' } as never;
    await testDb.db.insert(pullRequests).values([
      { id: 'pr-1', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'acme', repo: 'app', number: 1, state: 'open', lastSummary: summary },
      { id: 'pr-closed', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'acme', repo: 'app', number: 2, state: 'closed', lastSummary: summary },
      { id: 'pr-b', workspaceId: 'ws-b', repositoryId: 'repo-b', owner: 'other', repo: 'app', number: 3, state: 'open', lastSummary: summary },
    ]);
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(true);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    vi.spyOn(githubService, 'getRefSha').mockRejectedValue(new Error('offline'));
    fleet = new FakeFleet();
    fleet.handler = async (script) => {
      if (isAgentTurn(script)) return { stdout: claudeTurnLines('sess-1', 'done') };
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    token = await mintToken('owner-a');
    api = await startPublicApi();
  });

  afterEach(async () => {
    await settleArchivesForTests();
    setWorkbenchFleetClientForTests(null);
    await api.close();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  it('starts a session on the head branch, linked to the pull request', async () => {
    const res = await call('POST', '/pull-requests/pr-1/sessions', { agent: 'claude', prompt: 'Fix the failing checks.' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      object: 'session',
      workspace_id: 'ws-a',
      repository_id: 'repo-a',
      pull_request_id: 'pr-1',
      branch: 'feat/fast',
      base_branch: 'release',
      status: 'provisioning',
    });
    expect(res.body.chats).toHaveLength(1);
    await vi.waitFor(async () => expect((await getWorkbench(res.body.id))?.status).toBe('ready'), { timeout: 5000 });
    const pr = await call('GET', '/pull-requests/pr-1');
    expect(pr.body.session_ids).toEqual([res.body.id]);
  });

  it.each([
    ['a closed pull request', '/pull-requests/pr-closed/sessions', 409, 'pull_request_not_open'],
    ['another owner’s pull request', '/pull-requests/pr-b/sessions', 404, 'pull_request_not_found'],
  ])('refuses %s', async (_label, path, status, code) => {
    const res = await call('POST', path, { agent: 'claude' });
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(fleet.created).toEqual([]);
  });

  it('needs sessions:write, not pull_requests:write', async () => {
    const prOnly = await mintToken('owner-a', { scopes: ['pull_requests:write'] });
    const res = await call('POST', '/pull-requests/pr-1/sessions', { agent: 'claude' }, prOnly);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('insufficient_scope');
  });

  it('answers 403 workbenches_unavailable when sessions are off for the account', async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'false');
    resetFeatureFlagsForTests();
    const res = await call('POST', '/pull-requests/pr-1/sessions', { agent: 'claude' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('workbenches_unavailable');
  });

  it('refuses a field a pull-request session does not take', async () => {
    const res = await call('POST', '/pull-requests/pr-1/sessions', { agent: 'claude', branch: 'other' });
    expect(res.status).toBe(400);
    expect(res.body.error.param).toBe('branch');
  });
});
