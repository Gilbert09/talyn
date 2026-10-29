import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { execFileSync, spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workspaces } from '../db/schema.js';

/**
 * Instructions written in Talyn for one repository: the routes, and delivery
 * into the box. As in workbenchInstructions.test.ts, the in-box scripts run
 * for real against a temp HOME and a temp git repository.
 */

const sandbox = vi.hoisted(() => ({ home: '', repo: '', calls: [] as string[] }));

vi.mock('../services/workbenches/sandboxRuntime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/sandboxRuntime.js')>()),
  repoDirFor: () => sandbox.repo,
  runCapture: async (_row: unknown, script: string, opts: { env?: Record<string, string> } = {}) => {
    sandbox.calls.push(script);
    const r = spawnSync('bash', ['-c', script], {
      cwd: '/',
      env: { PATH: process.env.PATH, HOME: sandbox.home, ...(opts.env ?? {}) },
      encoding: 'utf8',
    });
    return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, stdoutBytes: Buffer.from(r.stdout) };
  },
}));

const { repositoryRoutes } = await import('../routes/repositories.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { putInstructionFile, syncInstructionFiles } = await import('../services/workbenches/instructions.js');
const { putRepositoryInstructions, removeRepositoryInstructions, SUMMARY_COLUMNS, TURN_COLUMNS } = await import(
  '../services/workbenches/repositoryInstructions.js'
);
const { repositoryInstructions: table } = await import('../db/schema.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

describe('repository instructions', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let tmp: string;

  async function call(method: string, url: string, body?: unknown, user = 'owner-a') {
    const resp = await fetch(`${base}${url}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: (await resp.json()) as { success: boolean; data?: Loose; error?: string; code?: string } };
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
      { id: 'repo-a2', workspaceId: 'ws-a', name: 'acme/other', url: 'https://github.com/acme/other' },
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
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-repoinstr-'));
    sandbox.home = path.join(tmp, 'home');
    sandbox.repo = path.join(tmp, 'work', 'app');
    sandbox.calls = [];
    await fs.mkdir(sandbox.home, { recursive: true });
    await fs.mkdir(sandbox.repo, { recursive: true });
    execFileSync('git', ['init', '-q', sandbox.repo]);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
  });

  describe('routes', () => {
    it('saves, reads back and lists without the text', async () => {
      const put = await call('PUT', '/repositories/repo-a/instructions', { body: '# House style\nUse tabs.', agents: 'claude' });
      expect(put.status).toBe(200);
      expect(put.body.data).toMatchObject({ repositoryId: 'repo-a', agents: 'claude', bytes: 23, body: '# House style\nUse tabs.' });

      const got = await call('GET', '/repositories/repo-a/instructions');
      expect(got.body.data).toMatchObject({ body: '# House style\nUse tabs.', agents: 'claude' });

      const list = await call('GET', '/repositories/instructions?workspaceId=ws-a');
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({ repositoryId: 'repo-a', agents: 'claude', bytes: 23 });
      expect(list.body.data[0]).not.toHaveProperty('body');
      expect(JSON.stringify(list.body)).not.toContain('House style');
    });

    it('answers null for a repository without instructions', async () => {
      const got = await call('GET', '/repositories/repo-a/instructions');
      expect(got.status).toBe(200);
      expect(got.body.data).toBeNull();
    });

    it('replaces the text and the agents on a second save', async () => {
      await call('PUT', '/repositories/repo-a/instructions', { body: 'one', agents: 'claude' });
      await call('PUT', '/repositories/repo-a/instructions', { body: 'two', agents: 'both' });
      const got = await call('GET', '/repositories/repo-a/instructions');
      expect(got.body.data).toMatchObject({ body: 'two', agents: 'both', bytes: 3 });
      const rows = await testDb.pglite.query(`SELECT 1 FROM repository_instructions`);
      expect(rows.rows).toHaveLength(1);
    });

    it('deletes by emptying the row, and 404s a second delete', async () => {
      await call('PUT', '/repositories/repo-a/instructions', { body: 'secret', agents: 'both' });
      expect((await call('DELETE', '/repositories/repo-a/instructions')).status).toBe(200);
      expect((await call('GET', '/repositories/repo-a/instructions')).body.data).toBeNull();
      expect((await call('GET', '/repositories/instructions?workspaceId=ws-a')).body.data).toEqual([]);
      expect((await call('DELETE', '/repositories/repo-a/instructions')).status).toBe(404);
      const stored = await testDb.pglite.query<{ body: string }>(`SELECT body FROM repository_instructions`);
      expect(stored.rows).toEqual([{ body: '' }]);
    });

    it.each([
      ['an unknown agent', { body: 'x', agents: 'gemini' }],
      ['no agent', { body: 'x' }],
      ['a body that is not a string', { body: 42, agents: 'both' }],
      ['no body', { agents: 'both' }],
      ['an empty body', { body: '', agents: 'both' }],
      ['a body of whitespace', { body: ' \n\t', agents: 'both' }],
    ])('refuses %s', async (_name, payload) => {
      const res = await call('PUT', '/repositories/repo-a/instructions', payload);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('bad_repository_instructions');
    });

    it('refuses a body over 64 KB and says why', async () => {
      const res = await call('PUT', '/repositories/repo-a/instructions', { body: 'x'.repeat(70 * 1024), agents: 'both' });
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('repository_instructions_too_large');
      expect(res.body.error).toBe('Repository instructions load into every turn; these are 70 KB. Trim them below 64 KB.');
    });

    it('counts bytes, not characters, against the cap', async () => {
      const res = await call('PUT', '/repositories/repo-a/instructions', { body: '€'.repeat(30000), agents: 'both' });
      expect(res.status).toBe(413);
    });

    it('accepts a body of exactly 64 KB', async () => {
      const res = await call('PUT', '/repositories/repo-a/instructions', { body: 'x'.repeat(64 * 1024), agents: 'both' });
      expect(res.status).toBe(200);
    });

    it.each([
      ['GET', '/repositories/repo-a/instructions', undefined],
      ['PUT', '/repositories/repo-a/instructions', { body: 'hijack', agents: 'both' }],
      ['DELETE', '/repositories/repo-a/instructions', undefined],
    ])('refuses %s %s to another owner', async (method, url, body) => {
      await call('PUT', '/repositories/repo-a/instructions', { body: 'mine', agents: 'both' });
      const res = await call(method, url, body, 'owner-b');
      expect([403, 404]).toContain(res.status);
      const got = await call('GET', '/repositories/repo-a/instructions');
      expect(got.body.data).toMatchObject({ body: 'mine' });
    });

    it('does not list another workspace to its non-owner', async () => {
      await call('PUT', '/repositories/repo-a/instructions', { body: 'mine', agents: 'both' });
      expect([403, 404]).toContain((await call('GET', '/repositories/instructions?workspaceId=ws-a', undefined, 'owner-b')).status);
      const own = await call('GET', '/repositories/instructions?workspaceId=ws-b', undefined, 'owner-b');
      expect(own.body.data).toEqual([]);
    });

    it('requires a workspaceId for the list', async () => {
      expect((await call('GET', '/repositories/instructions')).status).toBe(400);
    });

    it('refuses when sessions are switched off', async () => {
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      expect((await call('GET', '/repositories/repo-a/instructions')).status).toBe(403);
      expect((await call('GET', '/repositories/instructions?workspaceId=ws-a')).status).toBe(403);
    });

    it('goes with its repository', async () => {
      await call('PUT', '/repositories/repo-a/instructions', { body: 'x', agents: 'both' });
      await testDb.pglite.exec(`DELETE FROM repositories WHERE id = 'repo-a'`);
      expect((await testDb.pglite.query(`SELECT 1 FROM repository_instructions`)).rows).toEqual([]);
    });
  });

  describe('egress', () => {
    it('never selects the body in the list, and selects only two columns on the turn path', () => {
      const list = testDb.db.select(SUMMARY_COLUMNS).from(table).toSQL().sql;
      expect(list).not.toContain('"body"');
      const turn = testDb.db.select(TURN_COLUMNS).from(table).toSQL().sql;
      expect(turn).toContain('"body"');
      expect(turn).toContain('"agents"');
      expect(turn).not.toContain('"workspace_id"');
      expect(turn).not.toContain('"updated_at"');
    });
  });

  describe('delivery', () => {
    const row = (repositoryId = 'repo-a') =>
      ({ id: 'wb-1', workspaceId: 'ws-a', repositoryId, repoFullName: 'acme/app', agent: 'claude' }) as Loose;
    const repoFile = (name: string) => path.join(sandbox.repo, name);
    const read = (p: string) => fs.readFile(p, 'utf8');
    const exists = (p: string) => fs.access(p).then(() => true, () => false);
    const set = (body: string, agents: 'claude' | 'codex' | 'both') => putRepositoryInstructions('repo-a', { body, agents });
    const excludeLines = async () => (await read(path.join(sandbox.repo, '.git', 'info', 'exclude'))).split('\n');

    it('runs no exec for a repository that never had instructions', async () => {
      await syncInstructionFiles(row('repo-a2'), 'claude');
      await syncInstructionFiles(row('repo-a2'), 'codex');
      expect(sandbox.calls).toEqual([]);
    });

    it('writes CLAUDE.local.md for Claude, excluded from git, and nothing for Codex files', async () => {
      await set('Run `make test`.\n', 'both');
      await syncInstructionFiles(row(), 'claude');
      await syncInstructionFiles(row(), 'claude');
      expect(await read(repoFile('CLAUDE.local.md'))).toBe('Run `make test`.');
      expect((await excludeLines()).filter((l) => l === 'CLAUDE.local.md')).toHaveLength(1);
      expect(await exists(repoFile('AGENTS.override.md'))).toBe(false);
      expect(execFileSync('git', ['-C', sandbox.repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    });

    it('writes AGENTS.override.md for Codex, excluded from git', async () => {
      await set('Prefer pnpm.', 'codex');
      await syncInstructionFiles(row(), 'codex');
      expect(await read(repoFile('AGENTS.override.md'))).toBe('Prefer pnpm.');
      expect((await excludeLines()).filter((l) => l === 'AGENTS.override.md')).toHaveLength(1);
      expect(await exists(repoFile('CLAUDE.local.md'))).toBe(false);
      expect(execFileSync('git', ['-C', sandbox.repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
      expect(await exists(path.join(sandbox.home, '.talyn', 'codex-repo-instructions.md'))).toBe(false);
    });

    it("keeps the repository's own AGENTS.md ahead of the Talyn text, because Codex reads one file per directory", async () => {
      await fs.writeFile(repoFile('AGENTS.md'), '# Team rules\nBe kind.\n');
      await set('Prefer pnpm.\n', 'both');
      await syncInstructionFiles(row(), 'codex');
      expect(await read(repoFile('AGENTS.override.md'))).toBe(
        '# Team rules\nBe kind.\n\n## Talyn repository instructions\n\nPrefer pnpm.\n',
      );
      await fs.writeFile(repoFile('AGENTS.md'), '# Team rules\nBe kind and quick.\n');
      await syncInstructionFiles(row(), 'codex');
      expect(await read(repoFile('AGENTS.override.md'))).toContain('Be kind and quick.');
      expect((await read(repoFile('AGENTS.override.md'))).match(/Talyn repository instructions/g)).toHaveLength(1);
    });

    it('puts the synced Mac CLAUDE.local.md first, then the Talyn heading and text', async () => {
      await putInstructionFile('ws-a', {
        key: 'claude-local:acme/app', agent: 'claude', target: 'repo', repoFullName: 'acme/app',
        sourcePath: '~/dev/app/CLAUDE.local.md', content: 'from my Mac\n', enabled: true,
      });
      await set('from Talyn\n', 'claude');
      await syncInstructionFiles(row(), 'claude');
      expect(await read(repoFile('CLAUDE.local.md'))).toBe('from my Mac\n\n## Talyn repository instructions\n\nfrom Talyn');
      expect((await excludeLines()).filter((l) => l === 'CLAUDE.local.md')).toHaveLength(1);
    });

    it('leaves the synced Mac file exactly as it is when the Talyn text does not apply', async () => {
      await putInstructionFile('ws-a', {
        key: 'claude-local:acme/app', agent: 'claude', target: 'repo', repoFullName: 'acme/app',
        sourcePath: '~/dev/app/CLAUDE.local.md', content: 'from my Mac\n', enabled: true,
      });
      await set('codex only', 'codex');
      await syncInstructionFiles(row(), 'claude');
      expect(await read(repoFile('CLAUDE.local.md'))).toBe('from my Mac\n');
    });

    it('takes the files out when the instructions are deleted', async () => {
      await set('x', 'both');
      await syncInstructionFiles(row(), 'claude');
      await syncInstructionFiles(row(), 'codex');
      expect(await exists(repoFile('CLAUDE.local.md'))).toBe(true);
      expect(await exists(repoFile('AGENTS.override.md'))).toBe(true);
      await removeRepositoryInstructions('repo-a');
      await syncInstructionFiles(row(), 'claude');
      await syncInstructionFiles(row(), 'codex');
      expect(await exists(repoFile('CLAUDE.local.md'))).toBe(false);
      expect(await exists(repoFile('AGENTS.override.md'))).toBe(false);
    });

    it('takes the Claude file out when the instructions are aimed at Codex only', async () => {
      await set('x', 'both');
      await syncInstructionFiles(row(), 'claude');
      await set('x', 'codex');
      await syncInstructionFiles(row(), 'claude');
      expect(await exists(repoFile('CLAUDE.local.md'))).toBe(false);
    });

    it('never replaces or removes an AGENTS.override.md the repository ships', async () => {
      await fs.writeFile(repoFile('AGENTS.override.md'), 'committed override');
      await set('x', 'codex');
      await syncInstructionFiles(row(), 'codex');
      expect(await read(repoFile('AGENTS.override.md'))).toBe('committed override');
      await removeRepositoryInstructions('repo-a');
      await syncInstructionFiles(row(), 'codex');
      expect(await read(repoFile('AGENTS.override.md'))).toBe('committed override');
    });

    it('does not touch another repository', async () => {
      await set('x', 'both');
      await syncInstructionFiles(row('repo-a2'), 'claude');
      expect(await exists(repoFile('CLAUDE.local.md'))).toBe(false);
    });

    it('keeps the user-level Codex block and the repository override apart', async () => {
      await putInstructionFile('ws-a', { key: 'codex-user', agent: 'codex', target: 'user', sourcePath: '~/.codex/AGENTS.md', content: 'user level', enabled: true });
      await set('repo level', 'codex');
      await syncInstructionFiles(row(), 'codex');
      expect(await read(path.join(sandbox.home, '.codex', 'AGENTS.md'))).toContain('user level');
      expect(await read(path.join(sandbox.home, '.codex', 'AGENTS.md'))).not.toContain('repo level');
      expect(await read(repoFile('AGENTS.override.md'))).toBe('repo level');
    });
  });
});
