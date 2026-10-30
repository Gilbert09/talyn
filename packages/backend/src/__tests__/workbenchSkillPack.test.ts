import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { eq } from 'drizzle-orm';
import { TALYN_SKILL_PACK, TALYN_SKILLS_NOTE, TALYN_TOOLS_NOTE, workbenchTurnPrompt } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { workspaces } from '../db/schema.js';
import { SESSION_TOKEN_TOOLS } from '../mcp/sessionScope.js';
import { TOOLS } from '../mcp/tools/index.js';

/**
 * Talyn's built-in session skills: the files themselves, the tool names they
 * cite, delivery into the box (scripts run for real in bash against a temp
 * HOME, as in workbenchInstructions.test.ts), the setting, and the build step
 * that puts them in `dist`.
 */

const sandbox = vi.hoisted(() => ({
  home: '',
  calls: [] as Array<{ script: string; env: Record<string, string> }>,
}));

vi.mock('../services/workbenches/sandboxRuntime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/sandboxRuntime.js')>()),
  runCapture: async (_row: unknown, script: string, opts: { env?: Record<string, string> } = {}) => {
    sandbox.calls.push({ script, env: opts.env ?? {} });
    const r = spawnSync('bash', ['-c', script], {
      cwd: '/',
      env: { PATH: process.env.PATH, HOME: sandbox.home, ...(opts.env ?? {}) },
      encoding: 'utf8',
    });
    return { exitCode: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, stdoutBytes: Buffer.from(r.stdout) };
  },
}));

const {
  MAX_SKILL_DESCRIPTION_CHARS,
  SKILL_PACK_SOURCE_DIR,
  SKILL_PACK_STAMP,
  loadSkillPack,
  parseSkillFrontmatter,
  readSkillPack,
  sessionSkillPackEnabled,
  skillPackSyncPlan,
  syncSkillPack,
} = await import('../services/workbenches/skillPack.js');
const { sandboxScriptEnv } = await import('../services/workbenches/sandboxRuntime.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const skillText = (name: string) => readFileSync(path.join(SKILL_PACK_SOURCE_DIR, name, 'SKILL.md'), 'utf8');
const toolsByName = new Map(TOOLS.map((t) => [t.name, t]));

describe('session skill pack', () => {
  describe('the files', () => {
    it('ships the six skills, in the order the prompt names them', () => {
      expect([...TALYN_SKILL_PACK]).toEqual([
        'talyn-multi-repo',
        'talyn-delegate',
        'talyn-ci-triage',
        'talyn-ship-pr',
        'talyn-review-loop',
        'talyn-wrap-up',
      ]);
      expect(readSkillPack().map((s) => s.name)).toEqual([...TALYN_SKILL_PACK]);
    });

    it.each(TALYN_SKILL_PACK.map((n) => [n]))('%s has valid frontmatter and a usable length', (name) => {
      const content = skillText(name);
      const meta = parseSkillFrontmatter(content);
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe(name);
      expect(meta!.name).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(meta!.description.length).toBeGreaterThan(80);
      expect(meta!.description.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_CHARS);
      // The router picks a skill from its description, so it must say when.
      expect(meta!.description).toMatch(/^Use (when|at)\b/);
      const lines = content.split('\n').length;
      expect(lines).toBeGreaterThanOrEqual(60);
      expect(lines).toBeLessThanOrEqual(150);
    });

    it.each(TALYN_SKILL_PACK.map((n) => [n]))('%s cites only real tools a session token may call', (name) => {
      const content = skillText(name);
      const cited = new Set(content.match(/\btalyn_[a-z0-9_]+\b/g) ?? []);
      expect(cited.size).toBeGreaterThan(0);
      for (const tool of cited) {
        expect(toolsByName.has(tool), `${name} cites ${tool}, which is not a registered tool`).toBe(true);
        expect(SESSION_TOKEN_TOOLS.has(tool), `${name} cites ${tool}, which a session token may not call`).toBe(true);
      }
    });

    it.each(TALYN_SKILL_PACK.map((n) => [n]))('%s never names a tool without its talyn_ prefix', (name) => {
      const bare = new Set(TOOLS.map((t) => t.name.replace(/^talyn_/, '')));
      const backticked = [...skillText(name).matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1]);
      expect(backticked.filter((word) => bare.has(word))).toEqual([]);
    });

    it.each(TALYN_SKILL_PACK.map((n) => [n]))('%s passes only arguments the tool accepts', (name) => {
      const lines = skillText(name).split('\n');
      let checked = 0;
      for (let i = 0; i < lines.length; i++) {
        const head = /^(talyn_[a-z0-9_]+)\s*$/.exec(lines[i]);
        if (!head) continue;
        const props = (toolsByName.get(head[1])!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
        for (let j = i + 1; j < lines.length && /^\s+[a-z_]+:/.test(lines[j]); j++) {
          const arg = /^\s+([a-z_]+):/.exec(lines[j])![1];
          expect(Object.keys(props), `${name}: ${head[1]} has no argument ${arg}`).toContain(arg);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });

    it('says the same things about the product in every skill that touches them', () => {
      const all = TALYN_SKILL_PACK.map(skillText);
      // Never invent a Slack path: Talyn does not post there.
      for (const name of ['talyn-multi-repo', 'talyn-ship-pr', 'talyn-wrap-up']) {
        expect(skillText(name)).toMatch(/Talyn does not post (in|there)/);
      }
      // The box has no gh login; every skill that calls GitHub uses the proxy.
      for (const content of all) {
        if (content.includes('curl')) expect(content).toContain('http://github.$YAS_INTEGRATIONS_DOMAIN');
        expect(content).not.toMatch(/\bgh (api|pr|run|auth)\b/);
      }
      // The two limits on starting sessions.
      for (const name of ['talyn-multi-repo', 'talyn-delegate']) {
        expect(skillText(name)).toContain('3 sessions per hour');
        expect(skillText(name)).toContain('2 levels');
      }
    });
  });

  describe('parseSkillFrontmatter', () => {
    it.each([
      ['---\nname: a\ndescription: Use when x.\n---\nbody', { name: 'a', description: 'Use when x.' }],
      ['---\r\nname: a\r\ndescription: "Use when x."\r\n---\r\nbody', { name: 'a', description: 'Use when x.' }],
      ["---\nname: 'a'\ndescription: d\nlicense: MIT\n---\n", { name: 'a', description: 'd' }],
      ['---\nname: a\n---\nbody', null],
      ['---\ndescription: d\n---\nbody', null],
      ['name: a\ndescription: d\n', null],
      ['---\nname: a\ndescription: d\n', null],
    ])('%j', (content, expected) => {
      expect(parseSkillFrontmatter(content)).toEqual(expected);
    });

    it('refuses a pack whose skill is misnamed, too long or missing', async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-pack-'));
      try {
        await fs.cp(SKILL_PACK_SOURCE_DIR, tmp, { recursive: true });
        const file = path.join(tmp, 'talyn-delegate', 'SKILL.md');
        const good = await fs.readFile(file, 'utf8');
        await fs.writeFile(file, good.replace('name: talyn-delegate', 'name: delegate'));
        expect(() => readSkillPack(tmp)).toThrow(/named "delegate"/);
        await fs.writeFile(file, good.replace(/description: .*/, `description: ${'x'.repeat(MAX_SKILL_DESCRIPTION_CHARS + 1)}`));
        expect(() => readSkillPack(tmp)).toThrow(/over 1024/);
        await fs.rm(file);
        expect(() => readSkillPack(tmp)).toThrow();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('skillPackSyncPlan', () => {
    it('stages nothing and only removes when the pack is off', () => {
      const [files, { after }] = skillPackSyncPlan(null);
      expect(files).toEqual([]);
      expect(after).not.toContain('cmp -s');
      expect(after).toContain(SKILL_PACK_STAMP);
    });

    it('stages the whole pack as one file, for both agents to share', () => {
      const [files, { after }] = skillPackSyncPlan(loadSkillPack());
      expect(files.map((f) => f.path)).toEqual(['~/.talyn/skill-pack/bundle']);
      expect(Buffer.from(files[0].base64, 'base64').toString('utf8')).toBe(TALYN_SKILL_PACK.map(skillText).join(''));
      expect(after).toContain('"$HOME"/.claude/skills');
      expect(after).toContain('"$HOME"/.codex/skills');
    });
  });

  describe('syncSkillPack', () => {
    let testDb: Awaited<ReturnType<typeof createTestDb>>;
    let tmp: string;
    const row = { id: 'wb-1', workspaceId: 'ws-a', repositoryId: 'repo-x', repoFullName: 'acme/app', agent: 'claude' } as Loose;
    const home = (...p: string[]) => path.join(sandbox.home, ...p);
    const exists = (p: string) => fs.access(p).then(() => true, () => false);
    const roots = [['.claude', 'skills'], ['.codex', 'skills']] as const;
    const setPack = (value: unknown) =>
      testDb.db.update(workspaces).set({ settings: value === undefined ? {} : { sessionSkillPack: value } }).where(eq(workspaces.id, 'ws-a'));

    beforeEach(async () => {
      testDb = await createTestDb();
      await seedUser(testDb.db, { id: 'owner-a' });
      await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-skills-'));
      sandbox.home = path.join(tmp, 'home');
      sandbox.calls = [];
      await fs.mkdir(sandbox.home, { recursive: true });
    });

    afterEach(async () => {
      await testDb.cleanup();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    it.each([
      [undefined, true],
      [true, true],
      [false, false],
    ])('reads settings.sessionSkillPack %j as %j', async (value, expected) => {
      await setPack(value);
      expect(await sessionSkillPackEnabled('ws-a')).toBe(expected);
    });

    it('treats a workspace it cannot find as on, so a missing row never strips a box', async () => {
      expect(await sessionSkillPackEnabled('ws-missing')).toBe(true);
    });

    it('writes every skill for Claude and Codex, stamped, in one exec, and clears the staging', async () => {
      expect(await syncSkillPack(row, { talynTools: true })).toBe(true);
      for (const root of roots) {
        for (const name of TALYN_SKILL_PACK) {
          expect(await fs.readFile(home(...root, name, 'SKILL.md'), 'utf8')).toBe(skillText(name));
          expect(await exists(home(...root, name, SKILL_PACK_STAMP))).toBe(true);
        }
      }
      expect(sandbox.calls).toHaveLength(1);
      expect(await exists(home('.talyn', 'skill-pack'))).toBe(false);
    });

    it('does not rewrite an unchanged skill, and restores one edited in the box', async () => {
      await syncSkillPack(row, { talynTools: true });
      const old = new Date('2020-01-01T00:00:00Z');
      const kept = home('.claude', 'skills', 'talyn-ci-triage', 'SKILL.md');
      const edited = home('.codex', 'skills', 'talyn-wrap-up', 'SKILL.md');
      await fs.utimes(kept, old, old);
      await fs.writeFile(edited, 'changed in the box');
      await fs.utimes(edited, old, old);

      await syncSkillPack(row, { talynTools: true });

      expect((await fs.stat(kept)).mtime.getTime()).toBe(old.getTime());
      expect(await fs.readFile(edited, 'utf8')).toBe(skillText('talyn-wrap-up'));
      expect((await fs.stat(edited)).mtime.getTime()).not.toBe(old.getTime());
    });

    it("never overwrites or removes a skill directory that is not Talyn's", async () => {
      const mine = home('.claude', 'skills', 'talyn-ci-triage');
      await fs.mkdir(mine, { recursive: true });
      await fs.writeFile(path.join(mine, 'SKILL.md'), 'my own skill');
      const mineNoFile = home('.codex', 'skills', 'talyn-delegate');
      await fs.mkdir(mineNoFile, { recursive: true });
      await fs.writeFile(path.join(mineNoFile, 'notes.txt'), 'mine');

      await syncSkillPack(row, { talynTools: true });
      expect(await fs.readFile(path.join(mine, 'SKILL.md'), 'utf8')).toBe('my own skill');
      expect(await exists(path.join(mine, SKILL_PACK_STAMP))).toBe(false);
      expect(await exists(path.join(mineNoFile, 'SKILL.md'))).toBe(false);
      // The same name under the other agent's root is still Talyn's to write.
      expect(await fs.readFile(home('.codex', 'skills', 'talyn-ci-triage', 'SKILL.md'), 'utf8')).toBe(skillText('talyn-ci-triage'));

      await setPack(false);
      await syncSkillPack(row, { talynTools: true });
      expect(await fs.readFile(path.join(mine, 'SKILL.md'), 'utf8')).toBe('my own skill');
      expect(await fs.readFile(path.join(mineNoFile, 'notes.txt'), 'utf8')).toBe('mine');
    });

    it.each([
      ['the setting is off', false, true],
      ['the box has no Talyn MCP server', true, false],
    ])('removes the pack when %s, and leaves other skills alone', async (_label, setting, talynTools) => {
      await syncSkillPack(row, { talynTools: true });
      await fs.mkdir(home('.claude', 'skills', 'other-skill'), { recursive: true });
      await fs.writeFile(home('.claude', 'skills', 'other-skill', 'SKILL.md'), 'other');

      await setPack(setting);
      expect(await syncSkillPack(row, { talynTools })).toBe(false);

      for (const root of roots) {
        for (const name of TALYN_SKILL_PACK) expect(await exists(home(...root, name))).toBe(false);
      }
      expect(await fs.readFile(home('.claude', 'skills', 'other-skill', 'SKILL.md'), 'utf8')).toBe('other');

      await setPack(true);
      await syncSkillPack(row, { talynTools: true });
      expect(await exists(home('.claude', 'skills', 'talyn-delegate', 'SKILL.md'))).toBe(true);
    });

    it('removes a Talyn skill that left the pack, but not an unstamped talyn- directory', async () => {
      const stale = home('.claude', 'skills', 'talyn-old');
      await fs.mkdir(stale, { recursive: true });
      await fs.writeFile(path.join(stale, 'SKILL.md'), 'old');
      await fs.writeFile(path.join(stale, SKILL_PACK_STAMP), '');
      const userOwned = home('.codex', 'skills', 'talyn-mine');
      await fs.mkdir(userOwned, { recursive: true });
      await fs.writeFile(path.join(userOwned, 'SKILL.md'), 'mine');

      await syncSkillPack(row, { talynTools: true });

      expect(await exists(stale)).toBe(false);
      expect(await fs.readFile(path.join(userOwned, 'SKILL.md'), 'utf8')).toBe('mine');
    });

    it('works on a box whose agent homes do not exist yet when the pack is off', async () => {
      await setPack(false);
      expect(await syncSkillPack(row, { talynTools: true })).toBe(false);
      expect(sandbox.calls).toHaveLength(1);
    });
  });

  describe('the turn prompt', () => {
    const prompt = (talynTools: boolean, talynSkills: boolean) =>
      workbenchTurnPrompt({
        agent: 'claude',
        text: 'hi',
        planMode: false,
        createPr: { branch: 'b', baseBranch: 'main' },
        talynTools,
        talynSkills,
      }).appendSystemPrompt ?? '';

    it.each([
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ])('tools %j, skills %j: names the skills = %j', (tools, skills, named) => {
      const text = prompt(tools, skills);
      expect(text.includes(TALYN_SKILLS_NOTE)).toBe(named);
      expect(text.includes(TALYN_TOOLS_NOTE)).toBe(tools);
    });

    it('names every skill in the pack, in one sentence', () => {
      for (const name of TALYN_SKILL_PACK) expect(TALYN_SKILLS_NOTE).toContain(`\`${name}\``);
      expect(TALYN_SKILLS_NOTE.trim().split(/[.!?](\s|$)/).filter((s) => s.trim()).length).toBe(1);
    });
  });

  it('gives every turn and script the session id the skills ask for', () => {
    const env = sandboxScriptEnv({ id: 'wb-42', repoFullName: 'acme/app', name: 'tokyo', baseBranch: 'main' } as Loose);
    expect(env.TALYN_SESSION_ID).toBe('wb-42');
  });

  describe('the build', () => {
    it('keeps the source directory where the compiled module looks for it', () => {
      expect(path.relative(path.join(BACKEND_ROOT, 'src'), SKILL_PACK_SOURCE_DIR).split(path.sep).join('/')).toBe(
        'services/workbenches/skillPack',
      );
    });

    it('copies the pack into dist, and the copy loads', async () => {
      const pkg = JSON.parse(readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      expect(pkg.scripts.build).toContain('npm run build:copy-skill-pack');
      const inline = /^node -e "(.*)"$/s.exec(pkg.scripts['build:copy-skill-pack']);
      expect(inline).not.toBeNull();

      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-build-'));
      try {
        await fs.cp(SKILL_PACK_SOURCE_DIR, path.join(tmp, 'src', 'services', 'workbenches', 'skillPack'), { recursive: true });
        const r = spawnSync(process.execPath, ['-e', inline![1]], { cwd: tmp, encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        const copied = readSkillPack(path.join(tmp, 'dist', 'services', 'workbenches', 'skillPack'));
        expect(copied.map((s) => s.content)).toEqual(TALYN_SKILL_PACK.map(skillText));
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    it('keeps the Markdown in the Docker build context', () => {
      const ignore = readFileSync(path.join(BACKEND_ROOT, '..', '..', '.dockerignore'), 'utf8').split('\n');
      expect(ignore).toContain('!packages/backend/src/services/workbenches/skillPack/**');
      expect(ignore.indexOf('!packages/backend/src/services/workbenches/skillPack/**')).toBeGreaterThan(ignore.indexOf('*.md'));
    });
  });
});
