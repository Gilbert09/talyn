/** @jest-environment node */
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { applyRepositoryInstructions } from '../repositoryInstructions';

describe('applyRepositoryInstructions', () => {
  let root: string;
  let repo: string;
  const file = (name: string) => path.join(repo, name);
  const read = (name: string) => fs.readFile(file(name), 'utf8');
  const exists = (name: string) => fs.access(file(name)).then(() => true, () => false);
  const status = () => execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' });

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-repoinstr-')));
    repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    execFileSync('git', ['init', '-q', repo]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes CLAUDE.local.md for Claude and keeps it out of git', async () => {
    await applyRepositoryInstructions(repo, 'claude', 'Use tabs.\n');
    await applyRepositoryInstructions(repo, 'claude', 'Use tabs.\n');
    expect(await read('CLAUDE.local.md')).toBe('Use tabs.');
    const exclude = await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((l) => l === 'CLAUDE.local.md')).toHaveLength(1);
    expect(status()).toBe('');
  });

  it('writes AGENTS.override.md for Codex after the repository AGENTS.md', async () => {
    await fs.writeFile(file('AGENTS.md'), '# Team\nBe kind.\n');
    await applyRepositoryInstructions(repo, 'codex', 'Prefer pnpm.');
    expect(await read('AGENTS.override.md')).toBe('# Team\nBe kind.\n\n## Talyn repository instructions\n\nPrefer pnpm.');
    expect(await read('AGENTS.md')).toBe('# Team\nBe kind.\n');
    expect(status()).toBe('?? AGENTS.md\n');
  });

  it('writes the Codex text alone when the repository has no AGENTS.md', async () => {
    await applyRepositoryInstructions(repo, 'codex', 'Prefer pnpm.');
    expect(await read('AGENTS.override.md')).toBe('Prefer pnpm.');
  });

  it('removes the file it wrote when the text no longer applies', async () => {
    await applyRepositoryInstructions(repo, 'claude', 'x');
    await applyRepositoryInstructions(repo, 'claude', null);
    expect(await exists('CLAUDE.local.md')).toBe(false);
    await applyRepositoryInstructions(repo, 'codex', 'x');
    await applyRepositoryInstructions(repo, 'codex', null);
    expect(await exists('AGENTS.override.md')).toBe(false);
  });

  it('never replaces or removes a file it did not write', async () => {
    await fs.writeFile(file('CLAUDE.local.md'), 'mine');
    await fs.writeFile(file('AGENTS.override.md'), 'committed');
    await applyRepositoryInstructions(repo, 'claude', 'x');
    await applyRepositoryInstructions(repo, 'codex', 'x');
    expect(await read('CLAUDE.local.md')).toBe('mine');
    expect(await read('AGENTS.override.md')).toBe('committed');
    await applyRepositoryInstructions(repo, 'claude', null);
    await applyRepositoryInstructions(repo, 'codex', null);
    expect(await read('CLAUDE.local.md')).toBe('mine');
    expect(await read('AGENTS.override.md')).toBe('committed');
  });

  it('works in a linked worktree', async () => {
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'init']);
    const tree = path.join(root, 'tree');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'topic', tree]);
    await applyRepositoryInstructions(tree, 'claude', 'in a worktree');
    expect(await fs.readFile(path.join(tree, 'CLAUDE.local.md'), 'utf8')).toBe('in a worktree');
    expect(execFileSync('git', ['-C', tree, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    await applyRepositoryInstructions(tree, 'claude', null);
    expect(await fs.access(path.join(tree, 'CLAUDE.local.md')).then(() => true, () => false)).toBe(false);
  });
});
