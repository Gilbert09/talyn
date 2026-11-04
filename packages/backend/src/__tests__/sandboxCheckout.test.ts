import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boxLayerContextFrom, shellQuote } from '@talyn/shared';
import { describe, expect, it } from 'vitest';
import { cloneScript } from '../services/workbenches/sandboxRuntime.js';

type CheckoutRow = Parameters<typeof cloneScript>[0];
type CheckoutOptions = Parameters<typeof cloneScript>[1];

const row: CheckoutRow = {
  repoFullName: 'Acme/App', branch: "tom/new'branch", baseBranch: 'main',
  allocatedBranch: true, pushedHeadShas: [],
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'talyn checkout '));
  const origin = join(root, 'acme', 'app.git');
  const image = join(root, 'work', 'repo');
  const checkout = join(root, 'work', 'App');
  const env = {
    ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git(root, 'init', '--bare', origin);
  const stream: string[] = [];
  const commit = (ref: string, mark: number, parent: number | null) => {
    stream.push(`commit refs/heads/${ref}\nmark :${mark}\ncommitter Test <test@example.com> ${1700000000 + mark} +0000\ndata 1\nc\n`);
    if (parent) stream.push(`from :${parent}\n`);
    stream.push(`M 100644 inline f\ndata ${String(mark).length}\n${mark}\n\n`);
  };
  for (let i = 1; i <= 400; i++) commit('main', i, i > 1 ? i - 1 : null);
  commit('existing', 500, 100);
  commit('release', 600, 20);
  const imported = spawnSync('git', ['-C', origin, 'fast-import', '--quiet'], {
    env, input: stream.join(''), encoding: 'utf8',
  });
  expect(imported.status, imported.stderr).toBe(0);
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const base = git(origin, 'rev-parse', 'main');
  const old = git(origin, 'rev-parse', 'main~100');
  git(origin, 'update-ref', 'refs/heads/main', old);
  git(root, 'clone', '--depth=1', '--single-branch', '--branch=main', pathToFileURL(origin).href, image);
  git(origin, 'update-ref', 'refs/heads/main', base);
  git(origin, 'tag', 'do-not-fetch', base);
  const opts: CheckoutOptions = { boxLayer: boxLayerContextFrom({ layer: 'user', repoCommit: old }, []) };

  const run = (name: string, input = row, options = opts, prelude = '') => {
    const trace = join(root, 'trace.json');
    rmSync(trace, { force: true });
    const script = cloneScript(input, options)
      .replaceAll('/work', shellQuote(join(root, 'work')))
      .replaceAll('https://github.com/Acme/App.git', shellQuote(pathToFileURL(origin).href));
    const started = performance.now();
    const result = spawnSync('bash', ['-c', `${prelude}\n${script}`], {
      cwd: root, env: { ...env, GIT_TRACE2_EVENT: trace }, encoding: 'utf8', timeout: 15_000,
    });
    const elapsed = performance.now() - started;
    const commands = new Map<string, string[]>();
    const timings: string[] = [];
    for (const line of readFileSync(trace, 'utf8').trim().split('\n')) {
      const event = JSON.parse(line) as { event: string; sid: string; argv?: string[]; t_abs?: number };
      if (event.event === 'start' && event.argv?.[0] && basename(event.argv[0]) === 'git') {
        commands.set(event.sid, event.argv.slice(1));
      }
      if (event.event === 'exit' && commands.has(event.sid)) {
        timings.push(`${commands.get(event.sid)!.join(' ')}: ${(event.t_abs! * 1000).toFixed(1)} ms`);
      }
    }
    console.info(`[checkout] ${name}: ${elapsed.toFixed(1)} ms\n${timings.join('\n')}`);
    return { ...result, commands: [...commands.values()] };
  };
  return { root, origin, image, checkout, git, base, old, opts, run };
}

describe.skipIf(process.platform === 'win32')('checkout from an older image', () => {
  it.each([
    { name: 'a new allocated branch', moved: false },
    { name: 'a base that moved after the image', moved: true },
    { name: 'a non-default base', moved: true, baseBranch: 'release' },
    { name: 'a complete image clone', moved: true, complete: true },
  ])('checks out $name', (scenario) => {
    const f = fixture();
    try {
      if (!scenario.moved) f.git(f.origin, 'update-ref', 'refs/heads/main', f.old);
      if (scenario.complete) f.git(f.image, 'fetch', '--no-tags', '--unshallow', 'origin');
      const input = { ...row, baseBranch: scenario.baseBranch ?? 'main' };
      const expected = f.git(f.origin, 'rev-parse', input.baseBranch);
      const result = f.run(scenario.name, input);
      expect(result.status, result.stderr).toBe(0);
      expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(expected);
      expect(f.git(f.checkout, 'merge-base', 'HEAD', `origin/${input.baseBranch}`)).toBe(expected);
      expect(f.git(f.checkout, 'branch', '--show-current')).toBe(input.branch);
      expect(f.git(f.checkout, 'tag', '--list')).toBe('');
      expect(result.commands.some(([command]) => command === 'ls-remote')).toBe(false);
      const fetches = result.commands.filter(([command]) => command === 'fetch');
      expect(fetches).toHaveLength(1);
      expect(fetches[0]).toContain(`+refs/heads/${input.baseBranch}:refs/remotes/origin/${input.baseBranch}`);
      expect(fetches[0].filter((arg) => arg.startsWith('+refs/heads/'))).toHaveLength(1);
      expect(fetches[0].includes('--shallow-since=@1700000299')).toBe(!scenario.complete);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'an existing remote branch', allocatedBranch: false, pushedHeadShas: [] },
    { name: 'an allocated branch with pushed commits', allocatedBranch: true, pushedHeadShas: ['pushed'] },
    { name: 'a caller without allocation metadata', allocatedBranch: undefined, pushedHeadShas: undefined },
  ])('restores $name and its merge base', (scenario) => {
    const f = fixture();
    try {
      const result = f.run(scenario.name, { ...row, ...scenario, branch: 'existing' });
      expect(result.status, result.stderr).toBe(0);
      expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.git(f.origin, 'rev-parse', 'existing'));
      expect(f.git(f.checkout, 'merge-base', 'HEAD', 'origin/main')).toBe(f.git(f.origin, 'rev-parse', 'main~300'));
      expect(f.git(f.checkout, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/existing');
      expect(result.commands.some(([command]) => command === 'ls-remote')).toBe(true);
      expect(result.commands.some((args) => args.some((arg) => arg.startsWith('--deepen=')))).toBe(true);
      expect(f.run(`${scenario.name}: retry`, { ...row, ...scenario, branch: 'existing' }).status).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.each([null, '0'.repeat(40), 'not-a-commit', "'; touch bad; #"])(
    'uses the old fetch when the image commit is %s', (repoCommit) => {
      const f = fixture();
      try {
        const opts = { boxLayer: { ...f.opts.boxLayer!, repoCommit } };
        const result = f.run('missing image commit', row, opts);
        expect(result.status, result.stderr).toBe(0);
        expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.base);
        expect(result.commands.some(([command]) => command === 'ls-remote')).toBe(true);
        expect(result.commands.some((args) => args.includes('--depth=50'))).toBe(true);
        expect(result.commands.some((args) => args.some((arg) => arg.startsWith('--shallow-since=')))).toBe(false);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  it('preserves local commits and changes on a retry', () => {
    const f = fixture();
    try {
      f.git(f.image, 'checkout', '-b', row.branch);
      const local = f.git(f.image, '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
        'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Local work');
      f.git(f.image, 'reset', '--hard', local);
      writeFileSync(join(f.image, 'f'), 'Uncommitted work\n');
      const result = f.run('local work');
      expect(result.status, result.stderr).toBe(0);
      expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(local);
      expect(readFileSync(join(f.checkout, 'f'), 'utf8')).toBe('Uncommitted work\n');
      expect(f.git(f.checkout, 'merge-base', 'HEAD', 'origin/main')).toBe(f.old);
      expect(result.commands.some(([command]) => command === 'ls-remote')).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('retries a date-limited fetch when the base moves to an older commit', () => {
    const f = fixture();
    try {
      const older = f.git(f.origin, 'rev-parse', 'main~350');
      f.git(f.origin, 'update-ref', 'refs/heads/main', older);
      const result = f.run('base rewritten before image date');
      expect(result.status, result.stderr).toBe(0);
      expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(older);
      const fetches = result.commands.filter(([command]) => command === 'fetch');
      expect(fetches).toHaveLength(2);
      expect(fetches[1]).toContain('--depth=50');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('keeps the origin URL and uses the proxy rewrite for a private repository', () => {
    const f = fixture();
    try {
      // A local transport stands in for the fleet proxy. Credentials stay outside the checkout script.
      f.git(f.root, 'config', '--global', `url.${pathToFileURL(f.origin).href}.insteadOf`, 'https://github.com/Acme/App.git');
      f.git(f.image, 'remote', 'set-url', 'origin', 'https://github.com/Acme/App.git');
      const result = f.run('private repository with proxy rewrite');
      expect(result.status, result.stderr).toBe(0);
      expect(f.git(f.checkout, 'config', '--get', 'remote.origin.url')).toBe('https://github.com/Acme/App.git');
      expect(f.git(f.checkout, 'rev-parse', 'HEAD')).toBe(f.base);
      expect(result.commands.some(([command]) => command === 'clone')).toBe(false);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('fails before checkout when the remote cannot be fetched', () => {
    const f = fixture();
    try {
      f.git(f.image, 'remote', 'set-url', 'origin', pathToFileURL(join(f.root, 'missing', 'acme', 'app.git')).href);
      const result = f.run('unavailable remote');
      expect(result.status).not.toBe(0);
      expect(result.commands.some(([command]) => command === 'checkout')).toBe(false);
      expect(f.git(f.image, 'rev-parse', 'HEAD')).toBe(f.old);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('stops when the branch probe fails, even if the base could be fetched', () => {
    const f = fixture();
    try {
      const result = f.run('failed remote probe', { ...row, branch: 'existing', allocatedBranch: false }, f.opts,
        'git() { if [ "$1" = ls-remote ]; then return 128; fi; command git "$@"; }');
      expect(result.status).toBe(128);
      expect(result.commands.some(([command]) => command === 'checkout' || command === 'fetch')).toBe(false);
      expect(f.git(f.image, 'rev-parse', 'HEAD')).toBe(f.old);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
