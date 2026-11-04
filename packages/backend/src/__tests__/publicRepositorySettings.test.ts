import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiScope } from '@talyn/shared';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { callPublic, mintToken, startPublicApi } from './helpers/publicApi.js';
import { repositories, repositoryInstructions, setupSteps, workspaces } from '../db/schema.js';

const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { githubService } = await import('../services/github.js');

/**
 * `/v1/repositories/{id}` and its settings: the sandbox size, the preview,
 * setup learning, the instructions and the setup recipe. The services are the
 * app's own; these tests hold the public shapes, the scopes and the rule that
 * a settings read never spends the caller's GitHub rate limit.
 */

const WRITE: ApiScope[] = ['repositories:write'];

describe('/v1 repository settings', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let api: Awaited<ReturnType<typeof startPublicApi>>;
  let token: string;
  let github: ReturnType<typeof vi.spyOn>;

  const call = (method: string, path: string, body?: unknown, as = token) => callPublic(api.base, method, path, { token: as, body });

  beforeEach(async () => {
    vi.stubEnv('PUBLIC_API_ENABLED', 'true');
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-a2', ownerId: 'owner-a', name: 'A2' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values([
      {
        id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
        settings: {
          detectedSandboxSize: { size: 'large', reason: 'compose runs postgres and redis', sha: 'abc', at: '2026-11-01T00:00:00.000Z' },
          preview: { detected: { target: 'sandbox', ports: [{ port: 3000, label: 'web', primary: true }], reasons: [], sha: 'abc', at: '2026-11-01T00:00:00.000Z' } },
        },
      },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'other/app', url: 'https://github.com/other/app', defaultBranch: 'main' },
    ]);
    github = vi.spyOn(githubService, 'getRefSha').mockRejectedValue(new Error('offline'));
    token = await mintToken('owner-a', { scopes: WRITE });
    api = await startPublicApi();
  });

  afterEach(async () => {
    await api.close();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  it('gets a repository', async () => {
    const res = await call('GET', '/repositories/repo-a');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ object: 'repository', id: 'repo-a', full_name: 'acme/app', default_branch: 'main' });
  });

  it('reads the stored settings without asking GitHub', async () => {
    const res = await call('GET', '/repositories/repo-a/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      object: 'repository_settings',
      repository_id: 'repo-a',
      sandbox_size: { setting: 'auto', detected: 'large', detected_reason: 'compose runs postgres and redis', effective: 'large' },
      preview: {
        target: 'auto',
        ports: null,
        coder: null,
        effective: { target: 'sandbox', ports: [{ port: 3000, label: 'web', primary: true }], source: 'detected' },
      },
      setup_learning: true,
    });
    expect(github).not.toHaveBeenCalled();
  });

  it('changes the size, the preview and setup learning in one request', async () => {
    const res = await call('PATCH', '/repositories/repo-a/settings', {
      sandbox_size: 'small',
      preview: { target: 'sandbox', ports: [{ port: 5173, label: 'vite' }] },
      setup_learning: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.sandbox_size).toMatchObject({ setting: 'small', effective: 'small' });
    expect(res.body.preview).toMatchObject({
      target: 'sandbox',
      ports: [{ port: 5173, label: 'vite', primary: false }],
      effective: { target: 'sandbox', ports: [{ port: 5173, label: 'vite', primary: false }], source: 'user' },
    });
    expect(res.body.setup_learning).toBe(false);
    const back = await call('PATCH', '/repositories/repo-a/settings', { sandbox_size: 'auto' });
    expect(back.body.sandbox_size).toMatchObject({ setting: 'auto', effective: 'large' });
    expect(back.body.preview.target).toBe('sandbox');
  });

  it.each([
    ['an unknown size', { sandbox_size: 'huge' }, 'sandbox_size'],
    ['an unknown preview target', { preview: { target: 'cloud' } }, 'preview.target'],
    ['too many ports', { preview: { ports: Array.from({ length: 17 }, (_, i) => ({ port: 3000 + i })) } }, 'preview.ports'],
    ['a Coder URL that is not http', { preview: { coder: { url: 'ftp://x' } } }, 'preview'],
    ['an unknown field', { sandboxSize: 'small' }, 'sandboxSize'],
  ])('refuses %s and changes nothing', async (_label, body, param) => {
    const before = (await call('GET', '/repositories/repo-a/settings')).body;
    const res = await call('PATCH', '/repositories/repo-a/settings', body);
    expect([res.status, res.body.error.param]).toEqual([400, param]);
    expect((await call('GET', '/repositories/repo-a/settings')).body).toEqual(before);
  });

  it('writes, reads and deletes the instructions', async () => {
    expect((await call('GET', '/repositories/repo-a/instructions')).body.error.code).toBe('repository_instructions_not_found');
    const put = await call('PUT', '/repositories/repo-a/instructions', { body: 'Use pnpm.', agents: 'both' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      object: 'repository_instructions', repository_id: 'repo-a', agents: 'both', body: 'Use pnpm.', bytes: 9, updated_at: expect.any(String),
    });
    expect((await call('GET', '/repositories/repo-a/instructions')).body.body).toBe('Use pnpm.');
    expect((await call('DELETE', '/repositories/repo-a/instructions')).status).toBe(204);
    expect((await call('DELETE', '/repositories/repo-a/instructions')).status).toBe(204);
    expect((await call('GET', '/repositories/repo-a/instructions')).status).toBe(404);
    const [row] = await testDb.db.select({ bytes: repositoryInstructions.bytes }).from(repositoryInstructions);
    expect(row.bytes).toBe(0);
  });

  it.each([
    ['an empty body', { body: '', agents: 'both' }, 400],
    ['unknown agents', { body: 'x', agents: 'gpt' }, 400],
    ['text over the limit', { body: 'x'.repeat(64 * 1024 + 1), agents: 'both' }, 413],
  ])('refuses instructions with %s', async (_label, body, status) => {
    expect((await call('PUT', '/repositories/repo-a/instructions', body)).status).toBe(status);
  });

  it('reads the deprecated setup recipe and reverts a step', async () => {
    const now = new Date('2026-11-01T00:00:00Z');
    await testDb.db.insert(setupSteps).values({
      id: 'step-1', workspaceId: 'ws-a', repositoryId: 'repo-a', position: 0, stepKey: 'k1', name: 'apt-get install -y jq',
      command: 'apt-get install -y jq', kind: 'apt', runOn: 'image', origin: 'learned', status: 'suggested',
      firstSeenAt: now, lastSeenAt: now, seenCount: 2,
    });
    const recipe = await call('GET', '/repositories/repo-a/setup_recipe');
    expect(recipe.body).toMatchObject({
      object: 'setup_recipe', repository_id: 'repo-a', learning: true,
      steps: [{
        id: 'step-1', command: 'apt-get install -y jq', phase: 'install', seen_count: 2, reverted_at: null,
        state: 'waiting', session_count: 0, box_failure_count: 0, box_last_failure: null, box_disabled_at: null, box_disabled_reason: null,
      }],
    });
    const reverted = await call('POST', '/repositories/repo-a/setup_recipe/steps/step-1/revert');
    expect(reverted.status).toBe(200);
    expect(reverted.body.steps[0].reverted_at).toBeTruthy();
    const missing = await call('POST', '/repositories/repo-a/setup_recipe/steps/nope/revert');
    expect([missing.status, missing.body.error.code]).toEqual([404, 'setup_step_not_found']);
  });

  describe('the Setup list', () => {
    const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const learned = async (overrides: Partial<typeof setupSteps.$inferInsert> = {}) => {
      const now = new Date('2026-11-01T00:00:00Z');
      await testDb.db.insert(setupSteps).values({
        id: 'step-1', workspaceId: 'ws-a', repositoryId: 'repo-a', position: 0, stepKey: 'k1', name: 'apt-get install -y jq',
        command: 'apt-get install -y jq', kind: 'apt', runOn: 'image', origin: 'learned', status: 'suggested',
        firstSeenAt: now, lastSeenAt: now, seenCount: 2, ...overrides,
      });
    };

    it('reads the list in snake_case', async () => {
      await learned();
      const res = await call('GET', '/repositories/repo-a/setup');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        object: 'repository_setup', repository_id: 'repo-a', learning: true, hosts: [], image: null,
        last_setup_timing: null, timing_history: [],
        limits: { image_max_steps: 20, image_total_sec: 3600, max_hosts: 10, max_user_steps: 40, step_max_sec: 3600 },
        repo_setup: { command: null, source: null, read_at: null, run_on_box: 'always' },
        steps: [{
          id: 'step-1', repository_id: 'repo-a', run_on: 'image', origin: 'learned', status: 'suggested', accepted_by: null,
          seen_count: 2, box_only_reason: null, recent_sessions: 0, share: null,
        }],
      });
      expect(JSON.stringify(res.body)).not.toMatch(/runOn|repositoryId/);
    });

    it('writes the list, the hosts, the repository setup knob and learning', async () => {
      const res = await call('PUT', '/repositories/repo-a/setup', {
        steps: [
          { name: 'tools', command: 'make tools', run_on: 'image', timeout_sec: 120 },
          { name: 'login', command: 'npm config set //r/:_authToken $NPM_TOKEN', run_on: 'image' },
        ],
        hosts: ['registry.example.com'],
        run_on_box: 'never',
        learning: false,
      });
      expect(res.status).toBe(200);
      expect(res.body.steps.map((s: { name: string; run_on: string; timeout_sec: number | null }) => [s.name, s.run_on, s.timeout_sec]))
        .toEqual([['tools', 'image', 120], ['login', 'box', null]]);
      expect(res.body.steps[1].box_only_reason).toMatch(/secret variable/);
      expect([res.body.hosts, res.body.repo_setup.run_on_box, res.body.learning]).toEqual([['registry.example.com'], 'never', false]);
      expect((await call('GET', '/repositories/repo-a/settings')).body.setup_learning).toBe(false);
    });

    it.each([
      ['a literal token', { steps: [{ name: 'a', command: `echo ${TOKEN}`, run_on: 'box' }] }, 400, 'setup_step_refused'],
      ['an unknown step', { steps: [{ id: 'nope', name: 'a', run_on: 'box' }] }, 400, 'unknown_step'],
      ['a changed learned command', { steps: [{ id: 'step-1', name: 'a', command: 'apt-get install -y yq', run_on: 'image' }] }, 400, 'learned_command'],
      ['bad hosts', { hosts: ['not a host'] }, 400, 'invalid_hosts'],
      ['an unknown place', { steps: [{ name: 'a', command: 'x', run_on: 'cloud' }] }, 400, 'invalid_parameter'],
      ['a camelCase field', { runOnBox: 'never' }, 400, 'invalid_parameter'],
    ])('refuses %s with its code, and changes nothing', async (_label, body, status, code) => {
      await learned();
      const before = (await call('GET', '/repositories/repo-a/setup')).body;
      const res = await call('PUT', '/repositories/repo-a/setup', body);
      expect([res.status, res.body.error.code]).toEqual([status, code]);
      expect((await call('GET', '/repositories/repo-a/setup')).body).toEqual(before);
    });

    it.each([
      ['accept', { status: 'suggested' }, { status: 'active', accepted_by: 'person' }],
      ['dismiss', { status: 'suggested' }, { status: 'dismissed', status_reason: 'Dismissed by a person.' }],
      ['retry', { status: 'disabled', boxFailureCount: 2 }, { status: 'active', box_failure_count: 0 }],
    ])('can %s a step, and answers the whole list', async (action, row, expected) => {
      await learned(row);
      const res = await call('POST', `/repositories/repo-a/setup/steps/step-1/${action}`);
      expect(res.status).toBe(200);
      expect(res.body.object).toBe('repository_setup');
      expect(res.body.steps[0]).toMatchObject(expected);
    });

    it("refuses to dismiss a person's own step with 409 not_learned", async () => {
      const put = await call('PUT', '/repositories/repo-a/setup', { steps: [{ name: 'mine', command: 'make', run_on: 'box' }] });
      const res = await call('POST', `/repositories/repo-a/setup/steps/${put.body.steps[0].id}/dismiss`);
      expect([res.status, res.body.error.code]).toEqual([409, 'not_learned']);
    });

    it.each(['accept', 'dismiss', 'retry'])('answers 404 setup_step_not_found on %s of an unknown step', async (action) => {
      const res = await call('POST', `/repositories/repo-a/setup/steps/nope/${action}`);
      expect([res.status, res.body.error.code]).toEqual([404, 'setup_step_not_found']);
    });

    it.each([
      ['GET', '/repositories/repo-b/setup'],
      ['PUT', '/repositories/repo-b/setup'],
      ['POST', '/repositories/repo-b/setup/steps/step-1/accept'],
      ['POST', '/repositories/repo-b/setup/steps/step-1/dismiss'],
      ['POST', '/repositories/repo-b/setup/steps/step-1/retry'],
    ])('answers 404 repository_not_found for %s %s', async (method, path) => {
      const res = await call(method, path, method === 'PUT' ? {} : undefined);
      expect([res.status, res.body.error.code]).toEqual([404, 'repository_not_found']);
    });

    it('reads, writes and retries the workspace sandbox setup', async () => {
      const empty = await call('GET', '/workspaces/ws-a/sandbox_setup');
      expect(empty.body).toMatchObject({ object: 'workspace_sandbox_setup', workspace_id: 'ws-a', dotfiles: null, hosts: [], steps: [] });
      const put = await call('PUT', '/workspaces/ws-a/sandbox_setup', {
        dotfiles: { slug: 'tom/dotfiles' },
        steps: [{ name: 'zsh', command: 'apt-get install -y zsh', run_on: 'image' }],
      });
      expect(put.status).toBe(200);
      expect(put.body.dotfiles).toEqual({ slug: 'tom/dotfiles', ref: '', install: null });
      expect(put.body.steps[0]).toMatchObject({ name: 'zsh', repository_id: null, origin: 'user', status: 'active' });
      const id = put.body.steps[0].id as string;
      await testDb.db.update(setupSteps).set({ status: 'disabled', boxFailureCount: 2 }).where(eq(setupSteps.id, id));
      const retried = await call('POST', `/workspaces/ws-a/sandbox_setup/steps/${id}/retry`);
      expect(retried.status).toBe(200);
      expect(retried.body.steps[0]).toMatchObject({ id, status: 'active', box_failure_count: 0 });
      const cleared = await call('PUT', '/workspaces/ws-a/sandbox_setup', { dotfiles: null });
      expect(cleared.body.dotfiles).toBeNull();
    });

    it.each([
      ['a bad slug', { dotfiles: { slug: 'nope' } }, 'invalid_dotfiles'],
      ['an install that reads a secret', { dotfiles: { slug: 'a/b', install: 'echo $NPM_TOKEN' } }, 'setup_step_refused'],
      ['an unknown field', { dotfile: null }, 'invalid_parameter'],
    ])('refuses a workspace sandbox setup with %s', async (_label, body, code) => {
      const res = await call('PUT', '/workspaces/ws-a/sandbox_setup', body);
      expect([res.status, res.body.error.code]).toEqual([400, code]);
    });

    it.each([
      ['GET', '/workspaces/ws-b/sandbox_setup'],
      ['PUT', '/workspaces/ws-b/sandbox_setup'],
      ['POST', '/workspaces/ws-b/sandbox_setup/steps/x/retry'],
      ['GET', '/workspaces/missing/sandbox_setup'],
    ])('answers 404 workspace_not_found for %s %s', async (method, path) => {
      const res = await call(method, path, method === 'PUT' ? {} : undefined);
      expect([res.status, res.body.error.code]).toEqual([404, 'workspace_not_found']);
    });

    it('answers 404 setup_step_not_found for an unknown workspace step', async () => {
      const res = await call('POST', '/workspaces/ws-a/sandbox_setup/steps/nope/retry');
      expect([res.status, res.body.error.code]).toEqual([404, 'setup_step_not_found']);
    });

    it('needs repositories:write to change, repositories:read to read, and sessions to be on', async () => {
      const reader = await mintToken('owner-a', { scopes: ['repositories:read'] });
      expect((await call('GET', '/repositories/repo-a/setup', undefined, reader)).status).toBe(200);
      expect((await call('GET', '/workspaces/ws-a/sandbox_setup', undefined, reader)).status).toBe(200);
      for (const [method, path] of [
        ['PUT', '/repositories/repo-a/setup'],
        ['POST', '/repositories/repo-a/setup/steps/step-1/accept'],
        ['PUT', '/workspaces/ws-a/sandbox_setup'],
        ['POST', '/workspaces/ws-a/sandbox_setup/steps/x/retry'],
      ]) {
        const res = await call(method, path, method === 'PUT' ? {} : undefined, reader);
        expect([res.status, res.body.error.code], path).toEqual([403, 'insufficient_scope']);
      }
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      expect((await call('GET', '/repositories/repo-a/setup')).body.error.code).toBe('workbenches_unavailable');
      expect((await call('GET', '/workspaces/ws-a/sandbox_setup')).body.error.code).toBe('workbenches_unavailable');
    });

    it('keeps a workspace-bound token to its workspace', async () => {
      const bound = await mintToken('owner-a', { scopes: WRITE, workspaceIds: ['ws-a2'] });
      expect((await call('GET', '/repositories/repo-a/setup', undefined, bound)).status).toBe(404);
      expect((await call('GET', '/workspaces/ws-a/sandbox_setup', undefined, bound)).status).toBe(404);
      expect((await call('GET', '/workspaces/ws-a2/sandbox_setup', undefined, bound)).status).toBe(200);
    });
  });

  describe('access', () => {
    it.each([
      ['GET', '/repositories/repo-b'],
      ['GET', '/repositories/repo-b/settings'],
      ['PATCH', '/repositories/repo-b/settings'],
      ['GET', '/repositories/repo-b/instructions'],
      ['PUT', '/repositories/repo-b/instructions'],
      ['DELETE', '/repositories/repo-b/instructions'],
      ['GET', '/repositories/repo-b/setup_recipe'],
      ['GET', '/repositories/missing'],
    ])('answers 404 repository_not_found for %s %s', async (method, path) => {
      const body = method === 'PATCH' ? {} : method === 'PUT' ? { body: 'x', agents: 'both' } : undefined;
      const res = await call(method, path, body);
      expect([res.status, res.body.error.code]).toEqual([404, 'repository_not_found']);
    });

    it('needs repositories:write to change, and repositories:read to read', async () => {
      const reader = await mintToken('owner-a', { scopes: ['repositories:read'] });
      expect((await call('GET', '/repositories/repo-a/settings', undefined, reader)).status).toBe(200);
      const refused = await call('PATCH', '/repositories/repo-a/settings', { sandbox_size: 'small' }, reader);
      expect([refused.status, refused.body.error.code]).toEqual([403, 'insufficient_scope']);
      expect((await call('PUT', '/repositories/repo-a/instructions', { body: 'x', agents: 'both' }, reader)).status).toBe(403);
    });

    it('keeps a workspace-bound token to its workspace', async () => {
      const bound = await mintToken('owner-a', { scopes: WRITE, workspaceIds: ['ws-a2'] });
      expect((await call('GET', '/repositories/repo-a', undefined, bound)).status).toBe(404);
      expect((await call('PATCH', '/repositories/repo-a/settings', { sandbox_size: 'small' }, bound)).status).toBe(404);
      const [row] = await testDb.db.select({ settings: repositories.settings }).from(repositories).where(eq(repositories.id, 'repo-a'));
      expect(row.settings?.sandboxSize).toBeUndefined();
    });

    it('needs sessions to be on for the settings, but not for the repository itself', async () => {
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      expect((await call('GET', '/repositories/repo-a')).status).toBe(200);
      const res = await call('GET', '/repositories/repo-a/settings');
      expect([res.status, res.body.error.code]).toEqual([403, 'workbenches_unavailable']);
    });
  });
});
