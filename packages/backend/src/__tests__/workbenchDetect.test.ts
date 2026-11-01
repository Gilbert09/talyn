import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectWorkbenchScripts, detectedRunScript, detectedScriptsToToml, resolveWorkbenchConfig } from '@talyn/shared';

describe('detectWorkbenchScripts', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['bun.lock', 'bun install'],
    ['bun.lockb', 'bun install'],
    ['yarn.lock', 'yarn install'],
    ['package-lock.json', 'npm ci'],
    ['package.json', 'npm install'],
    ['uv.lock', 'uv sync'],
    ['poetry.lock', 'poetry install'],
    ['Gemfile.lock', 'bundle install'],
    ['Gemfile', 'bundle install'],
    ['go.mod', 'go mod download'],
    ['Cargo.lock', 'cargo fetch'],
    ['Cargo.toml', 'cargo fetch'],
  ])('detects setup from %s', (file, command) => {
    expect(detectWorkbenchScripts({ files: [file], packageJson: null })).toEqual({
      setup: { command, reason: `from ${file}` },
    });
  });

  it.each([
    [['package.json', 'package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock', 'pnpm-lock.yaml'], 'pnpm install --frozen-lockfile'],
    [['package-lock.json', 'yarn.lock', 'bun.lockb', 'bun.lock'], 'bun install'],
    [['package-lock.json', 'yarn.lock', 'bun.lockb'], 'bun install'],
    [['package-lock.json', 'yarn.lock'], 'yarn install'],
    [['package.json', 'package-lock.json'], 'npm ci'],
    [['poetry.lock', 'uv.lock'], 'uv sync'],
    [['Gemfile', 'Gemfile.lock'], 'bundle install'],
    [['Cargo.toml', 'Cargo.lock'], 'cargo fetch'],
    [
      ['Cargo.lock', 'go.mod', 'Gemfile', 'poetry.lock', 'uv.lock', 'package-lock.json'],
      'npm ci && uv sync && bundle install && go mod download && cargo fetch',
    ],
  ] as const)('combines %j in the required order', (files, command) => {
    expect(detectWorkbenchScripts({ files: [...files], packageJson: null }).setup?.command).toBe(command);
  });

  it.each([[], ['README.md'], ['nested/package.json'], ['uv.toml']])('detects nothing from %j', (...files) => {
    expect(detectWorkbenchScripts({ files, packageJson: null })).toEqual({});
  });

  it.each([
    null, '{', 'null', '[]', '42', '{}', '{"scripts":null}', '{"scripts":[]}',
    '{"scripts":{"test":"vitest"}}', '{"scripts":{"dev":42,"start":false}}', '{"scripts":{"dev":""}}',
  ])('handles a package file without a valid run script: %s', (packageJson) => {
    expect(detectWorkbenchScripts({ files: ['package.json'], packageJson }).run).toBeUndefined();
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['bun.lock', 'bun run'],
    ['bun.lockb', 'bun run'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm run'],
    ['package.json', 'npm run'],
  ])('uses the package manager from %s', (file, prefix) => {
    for (const name of ['dev', 'start']) {
      const result = detectWorkbenchScripts({
        files: [file, 'package.json'],
        packageJson: JSON.stringify({ scripts: { [name]: 'echo hello' } }),
      });
      expect(result.run).toEqual({
        command: `${prefix} ${name}`,
        reason: `from the ${name} script in package.json`,
      });
    }
  });

  it.each([
    [{ dev: 'vite', start: 'node index.js' }, 'dev'],
    [{ start: 'node index.js' }, 'start'],
    [{ dev: null, start: 'node index.js' }, 'start'],
  ])('selects a script from %j', (scripts, name) => {
    expect(detectWorkbenchScripts({
      files: ['package.json'], packageJson: JSON.stringify({ scripts }),
    }).run?.command).toBe(`npm run ${name}`);
  });
});

describe('detectedScriptsToToml', () => {
  it.each([
    [],
    ['package.json'],
    ['pnpm-lock.yaml', 'package.json', 'uv.lock', 'Gemfile.lock', 'go.mod', 'Cargo.toml'],
    ['poetry.lock'],
  ])('resolves the generated config for %j', (...files) => {
    const detected = detectWorkbenchScripts({
      files,
      packageJson: files.includes('package.json') ? '{"scripts":{"dev":"vite"}}' : null,
    });
    const toml = detectedScriptsToToml(detected);
    expect(toml.split('\n')[0]).toBe('# Talyn wrote this file from the detected files.');
    const config = resolveWorkbenchConfig({ talynToml: toml });
    expect(config.source).toBe('talyn');
    expect(config.errors).toEqual([]);
    expect(config.setup?.command).toBe(detected.setup?.command);
    expect(config.run[0]?.command).toBe(detected.run?.command);
  });

  it.each(['echo "hello"', 'echo \\\\path\nnext\tline', 'echo $(false) `false` # text'])('preserves %s', (command) => {
    const config = resolveWorkbenchConfig({
      talynToml: detectedScriptsToToml({ setup: { command, reason: 'test' }, run: { command, reason: 'test' } }),
    });
    expect(config.errors).toEqual([]);
    expect(config.setup?.command).toBe(command);
    expect(config.run[0]?.command).toBe(command);
  });
});

describe('detectedRunScript', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const workDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'talyn-detected-'));
    dirs.push(dir);
    return dir;
  };
  const run = (script: string, cwd: string) => {
    try {
      return { code: 0, out: execFileSync('bash', ['-c', script], { cwd, encoding: 'utf8' }) };
    } catch (err) {
      const e = err as { status: number; stdout: string };
      return { code: e.status, out: e.stdout };
    }
  };

  it('is null when no run command was detected', () => {
    expect(detectedRunScript({ setup: { command: 'npm install', reason: 'x' } })).toBeNull();
  });

  it('runs the detected command and says which one', () => {
    const dir = workDir();
    const script = detectedRunScript({ run: { command: 'echo serving', reason: "from the dev script in package.json" } })!;
    const { code, out } = run(script, dir);
    expect(code).toBe(0);
    expect(out).toContain('Talyn: this repository has no run script, so Talyn runs "echo serving" (from the dev script in package.json).');
    expect(out).toContain('serving');
  });

  it('runs the detected setup once per box, before the run command', () => {
    const dir = workDir();
    const marker = join(dir, 'setup-done');
    const script = detectedRunScript(
      { setup: { command: 'echo x >> installs', reason: 'from package.json' }, run: { command: 'echo serving', reason: 'r' } },
      marker,
    )!;
    expect(run(script, dir).code).toBe(0);
    expect(run(script, dir).code).toBe(0);
    expect(readFileSync(join(dir, 'installs'), 'utf8')).toBe('x\n');
  });

  it('stops before the run command when the setup fails, and tries the setup again next time', () => {
    const dir = workDir();
    const marker = join(dir, 'setup-done');
    const script = detectedRunScript(
      { setup: { command: 'exit 7', reason: 'r' }, run: { command: 'echo serving', reason: 'r' } },
      marker,
    )!;
    const first = run(script, dir);
    expect(first.code).toBe(7);
    expect(first.out.split('\n')).not.toContain('serving');
    expect(run(script, dir).code).toBe(7);
  });
});
