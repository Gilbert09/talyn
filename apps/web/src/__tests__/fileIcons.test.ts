import { describe, it, expect } from 'vitest';
import data from '../lib/fileIconData.json';
import { createFileIconResolver, type FileIconData } from '../lib/fileIcons';

const resolver = createFileIconResolver(data as FileIconData);

describe('file icon resolver', () => {
  it.each([
    ['package.json', 'nodejs'],
    ['Dockerfile', 'docker'],
    ['.gitignore', 'git'],
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['Makefile', 'makefile'],
    ['README.md', 'readme'],
  ])('matches the exact name %s', (name, icon) => {
    expect(resolver.file(name, false)).toBe(icon);
  });

  it.each([
    ['a.ts', 'typescript'],
    ['a.tsx', 'react_ts'],
    ['x.py', 'python'],
    ['x.json', 'json'],
    ['x.yml', 'yaml'],
    ['main.rs', 'rust'],
    ['main.go', 'go'],
    ['main.tf', 'terraform'],
    ['run.sh', 'console'],
    ['a.css', 'css'],
    ['a.html', 'html'],
    ['a.png', 'image'],
  ])('matches the extension of %s', (name, icon) => {
    expect(resolver.file(name, false)).toBe(icon);
  });

  it.each([
    ['foo.d.ts', 'typescript-def'],
    ['a.test.tsx', 'test-jsx'],
    ['dir.name.with.dots/../x.ts', 'typescript'],
  ])('prefers the longest extension for %s', (name, icon) => {
    expect(resolver.file(name, false)).toBe(icon);
  });

  it.each(['FOO.TS', 'Foo.Ts', 'PACKAGE.JSON'])('ignores case in %s', (name) => {
    expect(resolver.file(name, false)).toBe(resolver.file(name.toLowerCase(), false));
    expect(resolver.file(name, false)).not.toBe('file');
  });

  it.each(['.env', '.env.local', '.env.production', '.env.example'])('gives %s the env icon', (name) => {
    expect(resolver.file(name, false)).toBe(resolver.file('.env', false));
    expect(resolver.file(name, false)).not.toBe('file');
  });

  it.each(['unknown.zzzz', 'noextension', '', 'constructor', '__proto__', 'toString.toString'])(
    'falls back to the default file icon for %j',
    (name) => {
      expect(resolver.file(name, false)).toBe('file');
    }
  );

  it('uses light variants only in the light theme', () => {
    expect(resolver.file('a.jinja', true)).toBe('jinja_light');
    expect(resolver.file('a.jinja', false)).not.toBe('jinja_light');
  });

  it.each([
    ['src', 'folder-src', 'folder-src-open'],
    ['docs', 'folder-docs', 'folder-docs-open'],
    ['tests', 'folder-test', 'folder-test-open'],
    ['.github', 'folder-github', 'folder-github-open'],
    ['node_modules', 'folder-node', 'folder-node-open'],
    ['SRC', 'folder-src', 'folder-src-open'],
    ['my-unknown-dir', 'folder', 'folder-open'],
    ['constructor', 'folder', 'folder-open'],
  ])('resolves the folder %s', (name, closed, open) => {
    expect(resolver.folder(name, false, false)).toBe(closed);
    expect(resolver.folder(name, true, false)).toBe(open);
  });
});
