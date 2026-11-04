import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { execFileSync, spawnSync } from 'child_process';
import { bashScriptFile } from './helpers/bashScript.js';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { eq } from 'drizzle-orm';
import { repositories, workspaceMemories, workspaces } from '../db/schema.js';

/**
 * The user's instruction files: the routes, and the in-box sync. The sync's
 * scripts are run for real, in bash against a temp HOME and a temp git
 * repository, so the assertions are about files on disk and not about the
 * text of a script.
 */

const sandbox = vi.hoisted(() => ({
  home: '',
  repo: '',
  calls: [] as Array<{ script: string; env: Record<string, string> }>,
  fail: null as null | ((script: string) => boolean),
}));

const runInSandbox = async (_row: unknown, script: string, opts: { env?: Record<string, string> } = {}) => {
  sandbox.calls.push({ script, env: opts.env ?? {} });
  if (sandbox.fail?.(script)) return { exitCode: 1, stdout: '', stderr: 'boom', stdoutBytes: Buffer.alloc(0) };
  const r = spawnSync('bash', [bashScriptFile(script)], {
    cwd: '/',
    env: { PATH: process.env.PATH, HOME: sandbox.home, ...(opts.env ?? {}) },
    encoding: 'utf8',
  });
  return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, stdoutBytes: Buffer.from(r.stdout) };
};

const runtime = await import('../services/workbenches/sandboxRuntime.js');
const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { observeSessionFiles, sessionFileProbe, syncSessionFiles } = await import('../services/workbenches/sessionFileSync.js');
const repositoryInstructions = await import('../services/workbenches/repositoryInstructions.js');
const { putInstructionFile, ruleFileName, syncInstructionFiles, CODEX_BLOCK_END, CODEX_BLOCK_START, MEMORY_RULE_FILE } =
  await import('../services/workbenches/instructions.js');
const { writeSandboxFiles } = await import('../services/workbenches/sandboxFiles.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const claudeUser = (content: string, enabled = true) => ({
  key: 'claude-user',
  agent: 'claude' as const,
  target: 'user' as const,
  sourcePath: '~/.claude/CLAUDE.md',
  content,
  enabled,
});

describe('workbench instruction files', () => {
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

    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-instr-'));
    sandbox.home = path.join(tmp, 'home');
    sandbox.repo = path.join(tmp, 'work', 'app');
    sandbox.calls = [];
    vi.spyOn(runtime, 'runCapture').mockImplementation(runInSandbox);
    vi.spyOn(runtime, 'repoDirFor').mockImplementation(() => sandbox.repo);
    sandbox.fail = null;
    await fs.mkdir(path.join(sandbox.home, '.claude'), { recursive: true });
    await fs.mkdir(sandbox.repo, { recursive: true });
    execFileSync('git', ['init', '-q', sandbox.repo]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await testDb.cleanup();
    await fs.rm(tmp, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
  });

  describe('routes', () => {
    beforeEach(async () => {
      const app = express();
      app.use(express.json({ limit: '2mb' }));
      app.use((req, _res, next) => {
        const id = req.headers['x-user'] as string;
        req.user = { id, email: `${id}@example.test`, isAdmin: false };
        next();
      });
      app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
      app.use(apiErrorHandler);
      server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it('upserts a file and lists it without its content', async () => {
      const put = await call('PUT', '/workbenches/instructions', { workspaceId: 'ws-a', file: claudeUser('be terse') });
      expect(put.status).toBe(200);
      expect(put.body.data).toMatchObject({ key: 'claude-user', bytes: 8, enabled: true, repoFullName: null });
      expect(put.body.data.contentHash).toMatch(/^[0-9a-f]{64}$/);

      const again = await call('PUT', '/workbenches/instructions', { workspaceId: 'ws-a', file: claudeUser('be very terse') });
      expect(again.body.data.bytes).toBe(13);
      expect(again.body.data.contentHash).not.toBe(put.body.data.contentHash);

      const list = await call('GET', '/workbenches/instructions?workspaceId=ws-a');
      expect(list.status).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).not.toHaveProperty('content');
      expect(JSON.stringify(list.body)).not.toContain('very terse');
    });

    it('keeps the row but drops the text when a file is switched off', async () => {
      await call('PUT', '/workbenches/instructions', { workspaceId: 'ws-a', file: claudeUser('secret') });
      const off = await call('PUT', '/workbenches/instructions', {
        workspaceId: 'ws-a',
        file: { ...claudeUser('secret', false), content: undefined },
      });
      expect(off.status).toBe(200);
      expect(off.body.data).toMatchObject({ enabled: false, bytes: 0, contentHash: '' });
      const stored = await testDb.pglite.query<{ content: string }>(`SELECT content FROM workbench_instruction_files`);
      expect(stored.rows).toEqual([{ content: '' }]);
    });

    it.each([
      ['an unknown key', { ...claudeUser('x'), key: 'claude-everything' }, 400, 'bad_instruction_key'],
      ['an agent the key does not name', { ...claudeUser('x'), agent: 'codex' }, 400, 'bad_instruction_file'],
      ['a target the key does not name', { ...claudeUser('x'), target: 'repo' }, 400, 'bad_instruction_file'],
      ['a repo the key does not name', { ...claudeUser('x'), key: 'claude-local:acme/app', target: 'repo', repoFullName: 'acme/other' }, 400, 'bad_instruction_file'],
      ['content that is not a string', { ...claudeUser('x'), content: 42 }, 400, 'bad_instruction_file'],
      ['no content for a file switched on', { ...claudeUser('x'), content: undefined }, 400, 'bad_instruction_file'],
      ['a non-boolean enabled', { ...claudeUser('x'), enabled: 'yes' }, 400, 'bad_instruction_file'],
      ['an empty source path', { ...claudeUser('x'), sourcePath: ' ' }, 400, 'bad_instruction_file'],
    ])('refuses %s', async (_name, file, status, code) => {
      const res = await call('PUT', '/workbenches/instructions', { workspaceId: 'ws-a', file });
      expect(res.status).toBe(status);
      expect(res.body.code).toBe(code);
    });

    it('refuses a file over 256 KB and says why', async () => {
      const res = await call('PUT', '/workbenches/instructions', { workspaceId: 'ws-a', file: claudeUser('x'.repeat(300 * 1024)) });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('Instruction files load into every turn; this one is 300 KB. Trim it below 256 KB.');
    });

    it('accepts a file of exactly 256 KB', async () => {
      const res = await call('PUT', '/workbenches/instructions', { workspaceId: 'ws-a', file: claudeUser('x'.repeat(256 * 1024)) });
      expect(res.status).toBe(200);
    });

    it('deletes by key, and 404s a key that is not there', async () => {
      await call('PUT', '/workbenches/instructions', {
        workspaceId: 'ws-a',
        file: { key: 'claude-rule:team/style.md', agent: 'claude', target: 'user', sourcePath: '~/.claude/rules/team/style.md', content: 'x', enabled: true },
      });
      const key = encodeURIComponent('claude-rule:team/style.md');
      expect((await call('DELETE', `/workbenches/instructions/${key}?workspaceId=ws-a`)).status).toBe(200);
      expect((await call('GET', '/workbenches/instructions?workspaceId=ws-a')).body.data).toEqual([]);
      expect((await call('DELETE', `/workbenches/instructions/${key}?workspaceId=ws-a`)).status).toBe(404);
    });

    it.each([
      ['GET', '/workbenches/instructions?workspaceId=ws-a', undefined],
      ['PUT', '/workbenches/instructions', { workspaceId: 'ws-a', file: claudeUser('x') }],
      ['DELETE', '/workbenches/instructions/claude-user?workspaceId=ws-a', undefined],
    ])('refuses %s %s to another owner', async (method, url, body) => {
      await call('PUT', '/workbenches/instructions', { workspaceId: 'ws-a', file: claudeUser('mine') });
      const res = await call(method, url, body, 'owner-b');
      expect([403, 404]).toContain(res.status);
      const list = await call('GET', '/workbenches/instructions?workspaceId=ws-a');
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].bytes).toBe(4);
    });

    it.each([
      ['GET', '/workbenches/instructions'],
      ['PUT', '/workbenches/instructions'],
    ])('requires a workspaceId for %s', async (method, url) => {
      expect((await call(method, url, method === 'PUT' ? { file: claudeUser('x') } : undefined)).status).toBe(400);
    });

    it('refuses when sessions are switched off', async () => {
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await call('GET', '/workbenches/instructions?workspaceId=ws-a');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('workbenches_unavailable');
    });
  });

  describe('syncInstructionFiles', () => {
    const row = (repoFullName = 'acme/app') => ({ id: 'wb-1', workspaceId: 'ws-a', repositoryId: 'repo-none', repoFullName, agent: 'claude' }) as Loose;
    const put = (file: Parameters<typeof putInstructionFile>[1]) => putInstructionFile('ws-a', file);
    const home = (...p: string[]) => path.join(sandbox.home, ...p);
    const read = (p: string) => fs.readFile(p, 'utf8');
    const exists = (p: string) => fs.access(p).then(() => true, () => false);

    it('cleans stale files when the workspace has no file for the agent', async () => {
      await put({ ...claudeUser('x'), enabled: true });
      await syncInstructionFiles(row(), 'codex');
      expect(sandbox.calls).toHaveLength(1);
    });

    function probe(target = row()) {
      const r = spawnSync('bash', [bashScriptFile(sessionFileProbe(sandbox.repo))], {
        env: { ...process.env, HOME: sandbox.home }, encoding: 'utf8',
      });
      expect(r.status, r.stderr).toBe(0);
      observeSessionFiles(target, r.stderr);
    }

    it.each(['claude', 'codex'] as const)('skips unchanged %s files and syncs after source or disk changes', async (agent) => {
      const file = agent === 'claude' ? claudeUser('first') : {
        key: 'codex-user', agent, target: 'user' as const, sourcePath: '~/.codex/AGENTS.md', content: 'first', enabled: true,
      };
      const target = row();
      await put(file);
      await syncInstructionFiles(target, agent);
      probe(target);
      sandbox.calls = [];
      await syncInstructionFiles(target, agent);
      expect(sandbox.calls).toHaveLength(0);
      await put({ ...file, content: 'changed' });
      await syncInstructionFiles(target, agent);
      expect(sandbox.calls).toHaveLength(1);
      const dest = agent === 'claude' ? home('.claude/rules/talyn-user.md') : home('.codex/AGENTS.md');
      await fs.writeFile(dest, 'terminal edit');
      probe(target);
      await syncInstructionFiles(target, agent);
      expect(sandbox.calls).toHaveLength(2);
      expect(await read(dest)).toContain('changed');
      observeSessionFiles(target, '');
      await syncInstructionFiles(target, agent);
      expect(sandbox.calls).toHaveLength(3);
    });

    it('invalidates a cached sync when the last source file is deleted', async () => {
      await put(claudeUser('first'));
      await syncInstructionFiles(row(), 'claude');
      probe();
      const { removeInstructionFile } = await import('../services/workbenches/instructions.js');
      await removeInstructionFile('ws-a', 'claude-user');
      await syncInstructionFiles(row(), 'claude');
      expect(await exists(home('.claude/rules/talyn-user.md'))).toBe(false);
    });

    it('does not cache a failed write', async () => {
      await put(claudeUser('first'));
      sandbox.fail = () => true;
      await expect(syncInstructionFiles(row(), 'claude')).rejects.toThrow('boom');
      sandbox.fail = null;
      probe();
      await syncInstructionFiles(row(), 'claude');
      expect(await read(home('.claude/rules/talyn-user.md'))).toBe('first');
    });

    it('serializes writes to the shared Codex file', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const write = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined);
      const io = { repoDir: sandbox.repo, write };
      const file = { path: '~/x', base64: '' };
      const first = syncSessionFiles(row(), 'instructions-codex', 'instructions', [[file], { after: 'true' }], io);
      const second = syncSessionFiles(row(), 'skills', 'skills', [[file], { after: 'true' }], io);
      try {
        await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      } finally { release(); }
      await Promise.all([first, second]);
      expect(write).toHaveBeenCalledTimes(2);
    });

    it('invalidates repository instruction changes and missing git exclusions', async () => {
      const source = vi.spyOn(repositoryInstructions, 'repositoryInstructionsForTurn').mockResolvedValue({ hasRow: true, body: 'first' });
      try {
        await syncInstructionFiles(row(), 'claude');
        probe();
        sandbox.calls = [];
        await fs.writeFile(path.join(sandbox.repo, '.git/info/exclude'), '');
        probe();
        await syncInstructionFiles(row(), 'claude');
        expect(sandbox.calls).toHaveLength(1);
        expect(await read(path.join(sandbox.repo, '.git/info/exclude'))).toContain('CLAUDE.local.md');
        probe();
        sandbox.calls = [];
        source.mockResolvedValue({ hasRow: true, body: 'second' });
        await syncInstructionFiles(row(), 'claude');
        expect(sandbox.calls).toHaveLength(1);
        expect(await read(path.join(sandbox.repo, 'CLAUDE.local.md'))).toContain('second');
      } finally { source.mockRestore(); }
    });

    it('invalidates a cached sync when its source path changes', async () => {
      await put(claudeUser('same content'));
      await syncInstructionFiles(row(), 'claude');
      probe();
      sandbox.calls = [];
      await put({ ...claudeUser('same content'), sourcePath: '/new/source/CLAUDE.md' });
      await syncInstructionFiles(row(), 'claude');
      expect(sandbox.calls).toHaveLength(1);
    });

    it('writes Claude files as rules, removes stale ones, and leaves the fleet briefing alone', async () => {
      await fs.writeFile(home('.claude', 'CLAUDE.md'), 'fleet briefing\n');
      await fs.mkdir(home('.claude', 'rules'), { recursive: true });
      await fs.writeFile(home('.claude', 'rules', 'talyn-old.md'), 'stale');
      await fs.writeFile(home('.claude', 'rules', 'mine.md'), 'made in the box');
      await put(claudeUser('be terse\n'));
      await put({ key: 'claude-rule:team/style.md', agent: 'claude', target: 'user', sourcePath: '~/.claude/rules/team/style.md', content: 'tabs', enabled: true });
      await put({ key: 'claude-rule:off.md', agent: 'claude', target: 'user', sourcePath: '~/.claude/rules/off.md', enabled: false });
      await put({ key: 'codex-user', agent: 'codex', target: 'user', sourcePath: '~/.codex/AGENTS.md', content: 'codex only', enabled: true });

      await syncInstructionFiles(row(), 'claude');

      expect((await fs.readdir(home('.claude', 'rules'))).sort()).toEqual(['mine.md', 'talyn-rule-team-style.md', 'talyn-user.md']);
      expect(await read(home('.claude', 'rules', 'talyn-user.md'))).toBe('be terse\n');
      expect(await read(home('.claude', 'rules', 'talyn-rule-team-style.md'))).toBe('tabs');
      expect(await read(home('.claude', 'CLAUDE.md'))).toBe('fleet briefing\n');
      expect(await exists(home('.codex', 'AGENTS.md'))).toBe(false);
      // Small files travel in one exec, base64 in the env.
      expect(sandbox.calls).toHaveLength(1);
      expect(Object.values(sandbox.calls[0].env)).toContain(b64('be terse\n'));
    });

    it('removes every rule it wrote once the files are switched off', async () => {
      await put(claudeUser('x'));
      await syncInstructionFiles(row(), 'claude');
      expect(await exists(home('.claude', 'rules', 'talyn-user.md'))).toBe(true);
      await put({ ...claudeUser('x', false), content: undefined });
      await syncInstructionFiles(row(), 'claude');
      expect(await fs.readdir(home('.claude', 'rules'))).toEqual([]);
    });

    it("writes the session repository's CLAUDE.local.md, excludes it from git once, and removes it when switched off", async () => {
      const local = (content: string, enabled = true) => ({
        key: 'claude-local:acme/app', agent: 'claude' as const, target: 'repo' as const, repoFullName: 'acme/app',
        sourcePath: '~/dev/app/CLAUDE.local.md', ...(enabled ? { content } : {}), enabled,
      });
      await put(local('repo notes'));
      await put({ key: 'claude-local:other/thing', agent: 'claude', target: 'repo', repoFullName: 'other/thing', sourcePath: '~/x/CLAUDE.local.md', content: 'not this one', enabled: true });

      await syncInstructionFiles(row('Acme/App'), 'claude');
      await syncInstructionFiles(row('Acme/App'), 'claude');

      expect(await read(path.join(sandbox.repo, 'CLAUDE.local.md'))).toBe('repo notes');
      const exclude = await read(path.join(sandbox.repo, '.git', 'info', 'exclude'));
      expect(exclude.split('\n').filter((l) => l === 'CLAUDE.local.md')).toHaveLength(1);
      expect(execFileSync('git', ['-C', sandbox.repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');

      await put(local('', false));
      await syncInstructionFiles(row('acme/app'), 'claude');
      expect(await exists(path.join(sandbox.repo, 'CLAUDE.local.md'))).toBe(false);
    });

    it('leaves a CLAUDE.local.md it did not write', async () => {
      await put(claudeUser('x'));
      await fs.writeFile(path.join(sandbox.repo, 'CLAUDE.local.md'), 'the agent made this');
      await syncInstructionFiles(row(), 'claude');
      expect(await read(path.join(sandbox.repo, 'CLAUDE.local.md'))).toBe('the agent made this');
    });

    it('appends one Codex block to AGENTS.md, replaces it on the next sync, and strips it when switched off', async () => {
      const briefing = '# Sandbox\n\nYou are in a sandbox.\n';
      await fs.mkdir(home('.codex'), { recursive: true });
      await fs.writeFile(home('.codex', 'AGENTS.md'), briefing);
      const codex = (content: string, enabled = true) => ({
        key: 'codex-user', agent: 'codex' as const, target: 'user' as const, sourcePath: '~/.codex/AGENTS.md',
        ...(enabled ? { content } : {}), enabled,
      });
      await put(codex('use pnpm\n'));
      await put(claudeUser('claude only'));

      await syncInstructionFiles(row(), 'codex');
      expect(await read(home('.codex', 'AGENTS.md'))).toBe(
        `${briefing}\n${CODEX_BLOCK_START}\n<!-- from ~/.codex/AGENTS.md -->\nuse pnpm\n${CODEX_BLOCK_END}\n`,
      );
      expect(await exists(home('.claude', 'rules'))).toBe(false);

      await put(codex('use npm'));
      await syncInstructionFiles(row(), 'codex');
      await syncInstructionFiles(row(), 'codex');
      const text = await read(home('.codex', 'AGENTS.md'));
      expect(text.split(CODEX_BLOCK_START)).toHaveLength(2);
      expect(text).toContain('use npm');
      expect(text).not.toContain('use pnpm');

      await put(codex('', false));
      await syncInstructionFiles(row(), 'codex');
      expect(await read(home('.codex', 'AGENTS.md'))).toBe(briefing);
      expect(await exists(home('.talyn', 'codex-instructions.md'))).toBe(false);
    });

    it('re-adds the block after a reboot rewrote AGENTS.md', async () => {
      await put({ key: 'codex-user', agent: 'codex', target: 'user', sourcePath: '~/.codex/AGENTS.md', content: 'mine', enabled: true });
      await syncInstructionFiles(row(), 'codex');
      await fs.writeFile(home('.codex', 'AGENTS.md'), 'rewritten at boot\n');
      await syncInstructionFiles(row(), 'codex');
      expect(await read(home('.codex', 'AGENTS.md'))).toContain(`rewritten at boot\n\n${CODEX_BLOCK_START}`);
    });

    it('sends a file near the cap in env chunks under the kernel limit, byte for byte', async () => {
      const big = Array.from({ length: 250 * 1024 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
      await put(claudeUser(big));
      await syncInstructionFiles(row(), 'claude');
      expect(await read(home('.claude', 'rules', 'talyn-user.md'))).toBe(big);
      const chunks = sandbox.calls.flatMap((c) => Object.values(c.env));
      expect(chunks.length).toBeGreaterThan(1);
      for (const v of chunks) expect(v.length).toBeLessThanOrEqual(96 * 1024);
    });

    it('spreads a file larger than one exec over several execs', async () => {
      const bytes = Buffer.from(Array.from({ length: 600 * 1024 }, (_, i) => (i * 7) % 256));
      await writeSandboxFiles(row(), [{ path: '~/big.bin', base64: bytes.toString('base64') }]);
      expect(sandbox.calls.length).toBeGreaterThan(1);
      expect(Buffer.compare(await fs.readFile(home('big.bin')), bytes)).toBe(0);
      expect(await exists(home('big.bin.talyn-tmp'))).toBe(false);
    });

    it('creates an empty file', async () => {
      await writeSandboxFiles(row(), [{ path: '~/empty.txt', base64: '' }]);
      expect(await read(home('empty.txt'))).toBe('');
    });

    describe('the memory index', () => {
      const memRow = (agent = 'claude') =>
        ({ id: 'wb-1', workspaceId: 'ws-a', repositoryId: 'repo-1', repoFullName: 'acme/app', agent }) as Loose;
      let seq = 0;
      const remember = (over: Partial<typeof workspaceMemories.$inferInsert> = {}) =>
        testDb.db.insert(workspaceMemories).values({
          id: `mem-${++seq}`,
          workspaceId: 'ws-a',
          ownerId: 'owner-a',
          scope: 'workspace',
          type: 'project',
          name: `entry ${seq}`,
          description: `about ${seq}`,
          body: 'the secret body',
          ...over,
        });
      const setMemory = (on: boolean) =>
        testDb.db.update(workspaces).set({ settings: { sessionMemory: on } }).where(eq(workspaces.id, 'ws-a'));
      const forgetAll = () => testDb.db.update(workspaceMemories).set({ forgottenAt: new Date() });
      const rule = () => home('.claude', 'rules', MEMORY_RULE_FILE);

      beforeEach(async () => {
        await testDb.db.insert(repositories).values([
          { id: 'repo-1', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app' },
          { id: 'repo-2', workspaceId: 'ws-a', name: 'acme/other', url: 'https://github.com/acme/other' },
        ]);
      });

      it('cleans stale files when the workspace has no entry or file', async () => {
        await syncInstructionFiles(memRow(), 'claude');
        await syncInstructionFiles(memRow('codex'), 'codex');
        expect(sandbox.calls).toHaveLength(2);
      });

      it('writes the index as a Claude rule: workspace and own-repository entries, no bodies', async () => {
        await remember({ name: 'pnpm only', description: 'Use pnpm, never npm', type: 'feedback' });
        await remember({ scope: 'repository', repositoryId: 'repo-1', name: 'flaky e2e', description: 'e2e retries once' });
        await remember({ scope: 'repository', repositoryId: 'repo-2', name: 'other repo', description: 'not this one' });

        await syncInstructionFiles(memRow(), 'claude');

        const text = await read(rule());
        expect(text).toContain('# Talyn memory');
        expect(text).toContain('- pnpm only (feedback, workspace): Use pnpm, never npm');
        expect(text).toContain('- flaky e2e (project, repository): e2e retries once');
        expect(text).not.toContain('other repo');
        expect(text).not.toContain('the secret body');
        expect(text.indexOf('pnpm only')).toBeLessThan(text.indexOf('flaky e2e'));
      });

      it('keeps the index through the stale-rule cleanup, next to the user files', async () => {
        await fs.mkdir(home('.claude', 'rules'), { recursive: true });
        await fs.writeFile(home('.claude', 'rules', 'talyn-old.md'), 'stale');
        await remember();
        await put(claudeUser('be terse'));

        await syncInstructionFiles(memRow(), 'claude');
        await syncInstructionFiles(memRow(), 'claude');

        expect((await fs.readdir(home('.claude', 'rules'))).sort()).toEqual([MEMORY_RULE_FILE, 'talyn-user.md']);
      });

      it.each([
        ['memory is switched off', async () => setMemory(false)],
        ['every entry is forgotten', forgetAll],
      ])('removes the Claude rule when %s, and leaves the user rules', async (_label, change) => {
        await remember();
        await put(claudeUser('be terse'));
        await syncInstructionFiles(memRow(), 'claude');
        expect(await exists(rule())).toBe(true);

        probe(memRow());
        await change();
        await syncInstructionFiles(memRow(), 'claude');

        expect(await exists(rule())).toBe(false);
        expect(await read(home('.claude', 'rules', 'talyn-user.md'))).toBe('be terse');
      });

      it('removes the rule with no instruction file left to trigger the sync', async () => {
        await remember();
        await syncInstructionFiles(memRow(), 'claude');
        expect(await exists(rule())).toBe(true);
        probe(memRow());
        await forgetAll();
        await syncInstructionFiles(memRow(), 'claude');
        expect(await exists(rule())).toBe(false);
      });

      it('writes nothing when memory is off from the start', async () => {
        await setMemory(false);
        await remember();
        await syncInstructionFiles(memRow(), 'claude');
        expect(await exists(rule())).toBe(false);
      });

      it('puts the index in the Codex block after the user file, and takes it out when off', async () => {
        const briefing = '# Sandbox\n';
        await fs.mkdir(home('.codex'), { recursive: true });
        await fs.writeFile(home('.codex', 'AGENTS.md'), briefing);
        await put({ key: 'codex-user', agent: 'codex', target: 'user', sourcePath: '~/.codex/AGENTS.md', content: 'use pnpm\n', enabled: true });
        await remember({ name: 'deploys', description: 'Deploys go out on push to main' });

        await syncInstructionFiles(memRow('codex'), 'codex');
        await syncInstructionFiles(memRow('codex'), 'codex');

        let text = await read(home('.codex', 'AGENTS.md'));
        expect(text.split(CODEX_BLOCK_START)).toHaveLength(2);
        const block = text.slice(text.indexOf(CODEX_BLOCK_START), text.indexOf(CODEX_BLOCK_END));
        expect(block).toContain('use pnpm');
        expect(block).toContain('- deploys (project, workspace): Deploys go out on push to main');
        expect(block.indexOf('use pnpm')).toBeLessThan(block.indexOf('# Talyn memory'));
        expect(await exists(home('.claude', 'rules'))).toBe(false);

        await setMemory(false);
        await syncInstructionFiles(memRow('codex'), 'codex');
        text = await read(home('.codex', 'AGENTS.md'));
        expect(text).toContain('use pnpm');
        expect(text).not.toContain('# Talyn memory');
      });

      it('gives Codex a block with the index alone, and strips it when the entries are forgotten', async () => {
        const briefing = '# Sandbox\n';
        await fs.mkdir(home('.codex'), { recursive: true });
        await fs.writeFile(home('.codex', 'AGENTS.md'), briefing);
        await remember();

        await syncInstructionFiles(memRow('codex'), 'codex');
        expect(await read(home('.codex', 'AGENTS.md'))).toContain(`${CODEX_BLOCK_START}\n# Talyn memory`);

        await forgetAll();
        await syncInstructionFiles(memRow('codex'), 'codex');
        expect(await read(home('.codex', 'AGENTS.md'))).toBe(briefing);
      });
    });

    it('throws when the box refuses, so the turn can report it', async () => {
      await put(claudeUser('x'));
      sandbox.fail = () => true;
      await expect(syncInstructionFiles(row(), 'claude')).rejects.toThrow(/boom/);
    });
  });

  it.each([
    ['claude-user', 'talyn-user.md'],
    ['claude-rule:style.md', 'talyn-rule-style.md'],
    ['claude-rule:team/review notes.md', 'talyn-rule-team-review-notes.md'],
  ])('names the rule for %s %s', (key, name) => {
    expect(ruleFileName(key)).toBe(name);
  });
});
