import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, setupSteps, workbenches, workspaces } from '../db/schema.js';

const { repositoryRoutes } = await import('../routes/repositories.js');
const { workspaceRoutes } = await import('../routes/workspaces.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

/**
 * The Setup list routes of the app: `/repositories/:id/setup`, its step
 * actions, `/workspaces/:id/sandbox-setup`, and the old `/bake` and
 * `/setup-recipe` routes that stay for one release.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

describe('Setup list routes', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;

  async function call(method: string, url: string, body?: unknown, user = 'owner-a') {
    const resp = await fetch(`${base}${url}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: (await resp.json()) as { success: boolean; data?: Loose; error?: string; code?: string } };
  }

  async function learnedStep(overrides: Partial<typeof setupSteps.$inferInsert> = {}) {
    const now = new Date('2026-11-01T00:00:00Z');
    await testDb.db.insert(setupSteps).values({
      id: 'st_learned', workspaceId: 'ws-a', repositoryId: 'repo-a', position: 0, stepKey: 'k1',
      name: 'apt-get install -y jq', command: 'apt-get install -y jq', kind: 'apt', runOn: 'image',
      origin: 'learned', status: 'suggested', firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now,
      ...overrides,
    });
  }

  beforeEach(async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app' },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'bee/hive', url: 'https://github.com/bee/hive' },
    ]);
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/repositories', wrapAsyncRoutes(repositoryRoutes()));
    app.use('/workspaces', wrapAsyncRoutes(workspaceRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
  });

  describe('/repositories/:id/setup', () => {
    it('reads an empty list with the limits and the repository setup', async () => {
      const res = await call('GET', '/repositories/repo-a/setup');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        repositoryId: 'repo-a', learningDisabled: false, steps: [], hosts: [],
        repoSetup: { command: null, source: null, readAt: null, runOnBox: 'always' },
        limits: { imageMaxSteps: 20, imageTotalSec: 3600 },
      });
    });

    it('writes a list and reads it back in order', async () => {
      const put = await call('PUT', '/repositories/repo-a/setup', {
        steps: [
          { name: 'Install tools', command: 'make tools', runOn: 'image' },
          { name: 'Start redis', command: 'redis-server --daemonize yes', runOn: 'box', timeoutSec: 60 },
        ],
        hosts: ['registry.example.com'],
        runOnBox: 'moved',
      });
      expect(put.status).toBe(200);
      expect(put.body.data.steps.map((s: Loose) => [s.name, s.runOn, s.origin, s.status])).toEqual([
        ['Install tools', 'image', 'user', 'active'],
        ['Start redis', 'box', 'user', 'active'],
      ]);
      expect(put.body.data.hosts).toEqual(['registry.example.com']);
      expect(put.body.data.repoSetup.runOnBox).toBe('moved');
      const got = await call('GET', '/repositories/repo-a/setup');
      expect(got.body.data.steps.map((s: Loose) => s.name)).toEqual(['Install tools', 'Start redis']);
    });

    it.each([
      ['steps that are not a list', { steps: 'x' }, 'invalid_steps'],
      ['a step with no name', { steps: [{ command: 'x', runOn: 'box' }] }, 'invalid_step'],
      ['an unknown place', { steps: [{ name: 'a', command: 'x', runOn: 'cloud' }] }, 'invalid_step'],
      ['a literal token', { steps: [{ name: 'a', command: `echo ${TOKEN}`, runOn: 'box' }] }, 'setup_step_refused'],
      ['an unknown step id', { steps: [{ id: 'st_nope', name: 'a', runOn: 'box' }] }, 'unknown_step'],
      ['a bad runOnBox', { runOnBox: 'sometimes' }, 'invalid_run_on_box'],
      ['bad hosts', { hosts: 'example.com' }, 'invalid_hosts'],
    ])('answers 400 with a code for %s, and changes nothing', async (_label, body, code) => {
      const res = await call('PUT', '/repositories/repo-a/setup', body);
      expect([res.status, res.body.success, res.body.code]).toEqual([400, false, code]);
      expect(res.body.error).toEqual(expect.any(String));
      expect(await testDb.db.select({ id: setupSteps.id }).from(setupSteps)).toEqual([]);
    });

    it('refuses to change the command of a learned step', async () => {
      await learnedStep();
      const res = await call('PUT', '/repositories/repo-a/setup', {
        steps: [{ id: 'st_learned', name: 'jq', command: 'apt-get install -y yq', runOn: 'image' }],
      });
      expect([res.status, res.body.code]).toEqual([400, 'learned_command']);
    });

    it.each([
      ['GET', '/repositories/missing/setup'],
      ['PUT', '/repositories/missing/setup'],
      ['POST', '/repositories/missing/setup/steps/st_learned/accept'],
    ])('answers 404 for %s %s', async (method, url) => {
      const res = await call(method, url, method === 'PUT' ? {} : undefined);
      expect(res.status).toBe(404);
    });

    it.each([
      ['GET', '/repositories/repo-b/setup'],
      ['PUT', '/repositories/repo-b/setup'],
      ['POST', '/repositories/repo-b/setup/steps/st_b/accept'],
      ['POST', '/repositories/repo-b/setup/steps/st_b/dismiss'],
      ['POST', '/repositories/repo-b/setup/steps/st_b/retry'],
    ])("refuses %s %s for another workspace's repository", async (method, url) => {
      await learnedStep({ id: 'st_b', workspaceId: 'ws-b', repositoryId: 'repo-b' });
      const res = await call(method, url, method === 'PUT' ? { steps: [] } : undefined);
      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
      const [row] = await testDb.db.select({ status: setupSteps.status }).from(setupSteps).where(eq(setupSteps.id, 'st_b'));
      expect(row.status).toBe('suggested');
    });

    it.each(['GET', 'PUT'])('refuses %s when sessions are switched off', async (method) => {
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await call(method, '/repositories/repo-a/setup', method === 'PUT' ? {} : undefined);
      expect(res.status).toBe(403);
    });
  });

  describe('step actions', () => {
    it('accepts a suggested step and answers the whole list', async () => {
      await learnedStep();
      const res = await call('POST', '/repositories/repo-a/setup/steps/st_learned/accept');
      expect(res.status).toBe(200);
      expect(res.body.data.repositoryId).toBe('repo-a');
      expect(res.body.data.steps[0]).toMatchObject({ id: 'st_learned', status: 'active', acceptedBy: 'person' });
    });

    it('dismisses a learned step, and it goes last', async () => {
      await learnedStep();
      await learnedStep({ id: 'st_other', stepKey: 'k2', position: 1, command: 'brew install x', name: 'brew install x' });
      const res = await call('POST', '/repositories/repo-a/setup/steps/st_learned/dismiss');
      expect(res.status).toBe(200);
      expect(res.body.data.steps.map((s: Loose) => [s.id, s.status])).toEqual([['st_other', 'suggested'], ['st_learned', 'dismissed']]);
    });

    it("answers 409 not_learned for a person's own step", async () => {
      const put = await call('PUT', '/repositories/repo-a/setup', { steps: [{ name: 'mine', command: 'make', runOn: 'box' }] });
      const id = put.body.data.steps[0].id;
      const res = await call('POST', `/repositories/repo-a/setup/steps/${id}/dismiss`);
      expect([res.status, res.body.code]).toEqual([409, 'not_learned']);
    });

    it('retries a disabled step with a clean count', async () => {
      await learnedStep({ status: 'disabled', boxFailureCount: 2, statusReason: 'Failed on 2 boxes in a row.' });
      const res = await call('POST', '/repositories/repo-a/setup/steps/st_learned/retry');
      expect(res.status).toBe(200);
      expect(res.body.data.steps[0]).toMatchObject({ status: 'active', boxFailureCount: 0, statusReason: null });
    });

    it.each(['accept', 'dismiss', 'retry'])('answers 404 for an unknown step on %s', async (action) => {
      const res = await call('POST', `/repositories/repo-a/setup/steps/st_nope/${action}`);
      expect([res.status, res.body.error]).toEqual([404, 'This repository has no such setup step.']);
    });
  });

  describe('/workspaces/:id/sandbox-setup', () => {
    it('reads, writes and reads back the dotfiles, hosts and steps', async () => {
      const empty = await call('GET', '/workspaces/ws-a/sandbox-setup');
      expect(empty.status).toBe(200);
      expect(empty.body.data).toMatchObject({ workspaceId: 'ws-a', dotfiles: null, hosts: [], steps: [] });
      const put = await call('PUT', '/workspaces/ws-a/sandbox-setup', {
        dotfiles: { slug: 'tom/dotfiles', ref: 'main', install: null },
        hosts: ['example.com'],
        steps: [{ name: 'zsh', command: 'apt-get install -y zsh', runOn: 'image' }],
      });
      expect(put.status).toBe(200);
      expect(put.body.data.dotfiles).toEqual({ slug: 'tom/dotfiles', ref: 'main', install: null });
      expect(put.body.data.steps[0]).toMatchObject({ name: 'zsh', repositoryId: null, origin: 'user' });
      expect((await call('GET', '/workspaces/ws-a/sandbox-setup')).body.data.hosts).toEqual(['example.com']);
    });

    it.each([
      ['a dotfiles slug that is not owner/name', { dotfiles: { slug: 'nope', ref: '' } }, 'invalid_dotfiles'],
      ['a dotfiles install that reads a secret', { dotfiles: { slug: 'a/b', ref: '', install: 'echo $NPM_TOKEN' } }, 'setup_step_refused'],
      ['bad hosts', { hosts: [42] }, 'invalid_hosts'],
      ['a step with a literal token', { steps: [{ name: 'a', command: `echo ${TOKEN}`, runOn: 'image' }] }, 'setup_step_refused'],
    ])('answers 400 with a code for %s', async (_label, body, code) => {
      const res = await call('PUT', '/workspaces/ws-a/sandbox-setup', body);
      expect([res.status, res.body.code]).toEqual([400, code]);
    });

    it('retries a disabled workspace step and answers the step', async () => {
      await learnedStep({ id: 'st_ws', repositoryId: null, origin: 'user', status: 'disabled', boxFailureCount: 2, stepKey: '' });
      const res = await call('POST', '/workspaces/ws-a/sandbox-setup/steps/st_ws/retry');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: 'st_ws', status: 'active', boxFailureCount: 0 });
    });

    it("answers 404 for an unknown step, and for a repository's step", async () => {
      await learnedStep();
      expect((await call('POST', '/workspaces/ws-a/sandbox-setup/steps/st_nope/retry')).status).toBe(404);
      expect((await call('POST', '/workspaces/ws-a/sandbox-setup/steps/st_learned/retry')).status).toBe(404);
    });

    it.each([
      ['GET', '/workspaces/ws-b/sandbox-setup'],
      ['PUT', '/workspaces/ws-b/sandbox-setup'],
      ['POST', '/workspaces/ws-b/sandbox-setup/steps/st_ws/retry'],
      ['GET', '/workspaces/missing/sandbox-setup'],
    ])('refuses %s %s for a workspace the caller cannot reach', async (method, url) => {
      const res = await call(method, url, method === 'PUT' ? { hosts: [] } : undefined);
      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it('refuses when sessions are switched off', async () => {
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      expect((await call('GET', '/workspaces/ws-a/sandbox-setup')).status).toBe(403);
      expect((await call('PUT', '/workspaces/ws-a/sandbox-setup', {})).status).toBe(403);
    });
  });

  describe('the old routes, for one release', () => {
    it('reads the recipe in the old shape, and reverts a step', async () => {
      await learnedStep();
      const recipe = await call('GET', '/repositories/repo-a/setup-recipe');
      expect(recipe.body.data.steps).toEqual([expect.objectContaining({ id: 'st_learned', state: 'waiting', phase: 'install' })]);
      const reverted = await call('DELETE', '/repositories/repo-a/setup-recipe/steps/st_learned');
      expect(reverted.body.data.steps[0].state).toBe('reverted');
    });

    it('records an agent step as suggested and answers the old shape', async () => {
      await testDb.db.insert(workbenches).values({
        id: 'wb-1', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: 'wb-1', kind: 'session',
        branch: 'talyn/wb-1', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      });
      const res = await call('POST', '/repositories/repo-a/setup-recipe/steps', {
        command: 'cargo install sqlx-cli', why: 'migrations', sessionId: 'wb-1',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.steps).toEqual([expect.objectContaining({ command: 'cargo install sqlx-cli', state: 'waiting', source: 'agent' })]);
      expect(res.body.data.steps[0]).not.toHaveProperty('status');
      const [row] = await testDb.db.select({ status: setupSteps.status, origin: setupSteps.origin }).from(setupSteps);
      expect(row).toEqual({ status: 'suggested', origin: 'agent' });
    });

    it('writes and reads the old bake over the Setup list', async () => {
      const put = await call('PUT', '/repositories/repo-a/bake', { steps: [{ name: 'tools', run: 'make tools' }] });
      expect(put.status).toBe(200);
      expect((await call('GET', '/repositories/repo-a/bake')).body.data).toEqual({ steps: [{ name: 'tools', run: 'make tools' }] });
      const setup = await call('GET', '/repositories/repo-a/setup');
      expect(setup.body.data.steps[0]).toMatchObject({ name: 'tools', command: 'make tools', runOn: 'image', origin: 'user' });
    });
  });
});
