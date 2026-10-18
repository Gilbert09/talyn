/** @jest-environment node */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { discoverInstructionFiles, displayPath } from '../instructionFiles';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('discoverInstructionFiles', () => {
  let root: string;
  let home: string;
  let dots: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-instr-')));
    home = path.join(root, 'home');
    dots = path.join(root, 'dotfiles');
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    await fs.mkdir(path.join(home, '.codex'), { recursive: true });
    await fs.mkdir(dots, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('finds nothing in an empty home', async () => {
    expect(await discoverInstructionFiles({}, home)).toEqual([]);
  });

  it('follows a symlinked CLAUDE.md and inlines an import that is also a symlink', async () => {
    await fs.writeFile(path.join(dots, 'CLAUDE.md'), '# Me\n@RTK.md\n@gone.md\n');
    await fs.writeFile(path.join(dots, 'RTK.md'), 'rtk rules\n');
    await fs.symlink(path.join(dots, 'CLAUDE.md'), path.join(home, '.claude', 'CLAUDE.md'));
    await fs.symlink(path.join(dots, 'RTK.md'), path.join(home, '.claude', 'RTK.md'));

    const [claude] = await discoverInstructionFiles({}, home);
    const content =
      '# Me\n<!-- imported from ~/.claude/RTK.md -->\nrtk rules\n<!-- end of ~/.claude/RTK.md -->\n@gone.md\n';
    expect(claude).toEqual({
      key: 'claude-user',
      agent: 'claude',
      target: 'user',
      displayPath: '~/.claude/CLAUDE.md',
      bytes: Buffer.byteLength(content),
      content,
      hash: sha(content),
      imports: ['~/.claude/RTK.md'],
      missingImports: ['~/.claude/gone.md'],
    });
  });

  it('lists rules recursively, Codex AGENTS.md as it is, and CLAUDE.local.md per known repo', async () => {
    await fs.mkdir(path.join(home, '.claude', 'rules', 'team'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude', 'rules', 'style.md'), 'tabs');
    await fs.writeFile(path.join(home, '.claude', 'rules', 'team', 'review.md'), 'be kind');
    await fs.writeFile(path.join(home, '.claude', 'rules', 'notes.txt'), 'not markdown');
    await fs.writeFile(path.join(home, '.codex', 'AGENTS.md'), 'codex @RTK.md');
    const repo = path.join(root, 'repos', 'app');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'CLAUDE.local.md'), 'local notes');
    const noFile = path.join(root, 'repos', 'other');
    await fs.mkdir(noFile, { recursive: true });

    const found = await discoverInstructionFiles({ 'acme/app': repo, 'acme/other': noFile }, home);
    expect(found.map((f) => [f.key, f.agent, f.target, f.displayPath])).toEqual([
      ['claude-rule:style.md', 'claude', 'user', '~/.claude/rules/style.md'],
      ['claude-rule:team/review.md', 'claude', 'user', '~/.claude/rules/team/review.md'],
      ['codex-user', 'codex', 'user', '~/.codex/AGENTS.md'],
      ['claude-local:acme/app', 'claude', 'repo', path.join(repo, 'CLAUDE.local.md')],
    ]);
    expect(found[2].content).toBe('codex @RTK.md');
    expect(found[3].repoFullName).toBe('acme/app');
  });

  it('follows a symlinked rules folder', async () => {
    await fs.mkdir(path.join(dots, 'rules'));
    await fs.writeFile(path.join(dots, 'rules', 'shared.md'), 'shared');
    await fs.symlink(path.join(dots, 'rules'), path.join(home, '.claude', 'rules'));
    const found = await discoverInstructionFiles({}, home);
    expect(found.map((f) => f.key)).toEqual(['claude-rule:shared.md']);
  });

  it('shows paths under home with ~ and others as they are', () => {
    expect(displayPath(path.join(home, '.claude', 'x.md'), home)).toBe('~/.claude/x.md');
    expect(displayPath(path.join(root, 'elsewhere.md'), home)).toBe(path.join(root, 'elsewhere.md'));
  });
});
