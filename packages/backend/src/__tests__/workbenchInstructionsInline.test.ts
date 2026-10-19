import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  inlineInstructionImports,
  instructionFileTooLargeMessage,
  parseWorkbenchInstructionKey,
  type InstructionImportHost,
} from '@talyn/shared';

/** An in-memory file system: `links` maps a symlink to its target. */
function memoryHost(files: Record<string, string>, links: Record<string, string> = {}): InstructionImportHost {
  const real = (p: string): string => {
    for (const [link, target] of Object.entries(links)) {
      if (p === link) return target;
      if (p.startsWith(`${link}/`)) return target + p.slice(link.length);
    }
    return p;
  };
  return {
    home: '/home/u',
    read: async (p) => files[real(p)] ?? null,
    realpath: async (p) => (files[real(p)] !== undefined ? real(p) : null),
    dirname: path.posix.dirname,
    join: (dir, rel) => path.posix.resolve(dir, rel),
    isAbsolute: path.posix.isAbsolute,
    display: (p) => (p.startsWith('/home/u/') ? `~/${p.slice('/home/u/'.length)}` : p),
  };
}

const wrap = (shown: string, body: string) => `<!-- imported from ${shown} -->\n${body}\n<!-- end of ${shown} -->`;

describe('inlineInstructionImports', () => {
  it.each([
    ['a relative import', '@RTK.md', { '/home/u/.claude/RTK.md': 'rtk rules\n' }, '~/.claude/RTK.md', 'rtk rules'],
    ['a nested relative path', '@docs/x.md', { '/home/u/.claude/docs/x.md': 'x' }, '~/.claude/docs/x.md', 'x'],
    ['a ./ path', '@./y.md', { '/home/u/.claude/y.md': 'y' }, '~/.claude/y.md', 'y'],
    ['a ~/ import', '@~/notes/z.md', { '/home/u/notes/z.md': 'z' }, '~/notes/z.md', 'z'],
    ['an absolute import', '@/etc/talyn.md', { '/etc/talyn.md': 'abs' }, '/etc/talyn.md', 'abs'],
  ])('inlines %s', async (_name, line, extra, shown, body) => {
    const host = memoryHost({ '/home/u/.claude/CLAUDE.md': `# Me\n${line}\n`, ...extra });
    const out = await inlineInstructionImports(`# Me\n${line}\n`, '/home/u/.claude/CLAUDE.md', host);
    expect(out.content).toBe(`# Me\n${wrap(shown, body)}\n`);
    expect(out.imports).toEqual([shown]);
    expect(out.missingImports).toEqual([]);
  });

  it('resolves against the listed folder first, then the real folder of a symlinked file', async () => {
    const host = memoryHost(
      { '/dots/claude/CLAUDE.md': '@RTK.md\n@only-in-dots.md', '/dots/claude/only-in-dots.md': 'dots', '/home/u/.claude/RTK.md': 'home' },
      { '/home/u/.claude/CLAUDE.md': '/dots/claude/CLAUDE.md' },
    );
    const out = await inlineInstructionImports('@RTK.md\n@only-in-dots.md', '/home/u/.claude/CLAUDE.md', host);
    expect(out.content).toBe(`${wrap('~/.claude/RTK.md', 'home')}\n${wrap('/dots/claude/only-in-dots.md', 'dots')}`);
  });

  it('inlines imports of imports, relative to the imported file', async () => {
    const host = memoryHost({
      '/home/u/.claude/a.md': 'A @sub/b.md',
      '/home/u/.claude/sub/b.md': 'B @c.md',
      '/home/u/.claude/sub/c.md': 'C',
    });
    const out = await inlineInstructionImports('@a.md', '/home/u/.claude/CLAUDE.md', host);
    expect(out.content).toBe(
      wrap('~/.claude/a.md', `A ${wrap('~/.claude/sub/b.md', `B ${wrap('~/.claude/sub/c.md', 'C')}`)}`),
    );
    expect(out.imports).toEqual(['~/.claude/a.md', '~/.claude/sub/b.md', '~/.claude/sub/c.md']);
  });

  it('leaves a cycle as text and does not call it missing', async () => {
    const host = memoryHost({ '/home/u/.claude/CLAUDE.md': '@a.md', '/home/u/.claude/a.md': 'A @CLAUDE.md' });
    const out = await inlineInstructionImports('@a.md', '/home/u/.claude/CLAUDE.md', host);
    expect(out.content).toBe(wrap('~/.claude/a.md', 'A @CLAUDE.md'));
    expect(out.missingImports).toEqual([]);
  });

  it('stops at the depth limit', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 7; i++) files[`/home/u/.claude/f${i}.md`] = i < 7 ? `${i} @f${i + 1}.md` : '7';
    const out = await inlineInstructionImports('@f1.md', '/home/u/.claude/CLAUDE.md', memoryHost(files));
    expect(out.imports).toEqual(['~/.claude/f1.md', '~/.claude/f2.md', '~/.claude/f3.md', '~/.claude/f4.md', '~/.claude/f5.md']);
    expect(out.content).toContain('5 @f6.md');
  });

  it.each([
    ['a fenced block', '```\n@RTK.md\n```'],
    ['a tilde fence', '~~~md\n@RTK.md\n~~~'],
    ['an inline code span', 'run `@RTK.md` here'],
    ['a double-backtick span', 'run ``x @RTK.md`` here'],
  ])('ignores an import inside %s', async (_name, text) => {
    const host = memoryHost({ '/home/u/.claude/RTK.md': 'rtk' });
    const out = await inlineInstructionImports(text, '/home/u/.claude/CLAUDE.md', host);
    expect(out.content).toBe(text);
    expect(out.imports).toEqual([]);
  });

  it('reads imports again after a fence closes', async () => {
    const host = memoryHost({ '/home/u/.claude/RTK.md': 'rtk' });
    const out = await inlineInstructionImports('```\n@RTK.md\n```\n@RTK.md', '/home/u/.claude/CLAUDE.md', host);
    expect(out.content).toBe(`\`\`\`\n@RTK.md\n\`\`\`\n${wrap('~/.claude/RTK.md', 'rtk')}`);
  });

  it('keeps a missing import as text and lists it', async () => {
    const out = await inlineInstructionImports('see @gone.md, then', '/home/u/.claude/CLAUDE.md', memoryHost({}));
    expect(out.content).toBe('see @gone.md, then');
    expect(out.missingImports).toEqual(['~/.claude/gone.md']);
  });

  it.each([
    ['a mention', 'ask @claude about it'],
    ['an email address', 'mail me@example.com'],
  ])('does not read %s as an import', async (_name, text) => {
    const out = await inlineInstructionImports(text, '/home/u/.claude/CLAUDE.md', memoryHost({}));
    expect(out).toEqual({ content: text, imports: [], missingImports: [] });
  });

  it('keeps trailing punctuation outside the import', async () => {
    const host = memoryHost({ '/home/u/.claude/RTK.md': 'rtk' });
    const out = await inlineInstructionImports('Read @RTK.md.', '/home/u/.claude/CLAUDE.md', host);
    expect(out.content).toBe(`Read ${wrap('~/.claude/RTK.md', 'rtk')}.`);
  });
});

describe('parseWorkbenchInstructionKey', () => {
  it.each([
    ['claude-user', { agent: 'claude', target: 'user' }],
    ['codex-user', { agent: 'codex', target: 'user' }],
    ['claude-rule:style.md', { agent: 'claude', target: 'user' }],
    ['claude-rule:team/review.md', { agent: 'claude', target: 'user' }],
    ['claude-local:acme/app', { agent: 'claude', target: 'repo', repoFullName: 'acme/app' }],
  ])('reads %s', (key, expected) => {
    expect(parseWorkbenchInstructionKey(key)).toEqual(expected);
  });

  it.each([
    '',
    'codex-rule:x.md',
    'claude-rule:x.txt',
    'claude-rule:../x.md',
    'claude-rule:/abs.md',
    'claude-rule:a//b.md',
    'claude-local:acme',
    'claude-local:acme/app/extra',
    'claude-local:../x',
    `claude-rule:${'a'.repeat(400)}.md`,
  ])('refuses %s', (key) => {
    expect(parseWorkbenchInstructionKey(key)).toBeNull();
  });
});

it('says why a file is too large', () => {
  expect(instructionFileTooLargeMessage(300 * 1024)).toBe(
    'Instruction files load into every turn; this one is 300 KB. Trim it below 256 KB.',
  );
});
