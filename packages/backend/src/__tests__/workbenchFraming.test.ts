import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  aliveMarkerScript,
  FLEET_PROXY_PRELUDE,
  frameCommand,
  FrameDemux,
  GUEST_MAX_LINE_BYTES,
  killMarkerScript,
  parseSections,
  pidFileFor,
  safeMarker,
  sectionsScript,
} from '../services/workbenches/execFraming.js';
import { encodePtyFrame, matchTerminalPath, PtyFrameDecoder } from '../services/workbenches/terminalBridge.js';
import { archiveRef, archiveSaveScript, restoreSavedWorkScript } from '../services/workbenches/lifecycle.js';
import {
  cloneScript,
  GOLDEN_REPO_DIR,
  MERGE_BASE_DEEPEN_TRIES,
  repoDirFor,
  sandboxGeneration,
  sandboxIdFor,
} from '../services/workbenches/sandboxRuntime.js';
import { assertRepoPath, looksBinary, mergeBaseLine } from '../services/workbenches/changes.js';
import { toPrSummary } from '../services/workbenches/prLink.js';
import { PTY_FRAME, QUIET_EXEC } from '../services/selfHosted/client.js';

const tag = (nonce: string, kind: string, body: string) => `@@talyn:${nonce}:${kind} ${body}`;

describe('exec framing', () => {
  it.each(['stream', 'capture'] as const)('frames a %s command with its script in the env, not the argv', (mode) => {
    const f = frameCommand('echo "$HOME"; exit 3', { mode, marker: 'talyn-turn-abc', env: { A: '1' } });
    expect(f.cmd[0]).toBe('bash');
    expect(f.cmd[3]).toBe('talyn-turn-abc');
    expect(f.cmd[2]).not.toContain('echo "$HOME"');
    expect(f.env).toEqual({ A: '1', TALYN_SCRIPT: 'echo "$HOME"; exit 3' });
    expect(f.cmd[2]).toContain(`@@talyn:${f.nonce}:${mode === 'stream' ? 'o' : 'O'} `);
    expect(f.cmd[2]).toContain(pidFileFor('talyn-turn-abc'));
  });

  it.each(['stream', 'capture'] as const)('a %s command sets FLEET_PROXY_URL before the script runs', (mode) => {
    const f = frameCommand('fleet-publish --help', { mode });
    const lines = f.cmd[2].split('\n');
    expect(lines.indexOf(FLEET_PROXY_PRELUDE)).toBeGreaterThan(-1);
    expect(lines.indexOf(FLEET_PROXY_PRELUDE)).toBeLessThan(lines.findIndex((l) => l.includes('bash -c "$s"')));
  });

  it.each<[string, Record<string, string>, string]>([
    ['session box: taken from HTTP_PROXY', { HTTP_PROXY: 'http://127.0.0.1:8080' }, 'http://127.0.0.1:8080'],
    ['box already sets it: kept', { HTTP_PROXY: 'http://127.0.0.1:8080', FLEET_PROXY_URL: 'http://10.0.0.1:9' }, 'http://10.0.0.1:9'],
    ['empty value counts as unset', { HTTP_PROXY: 'http://127.0.0.1:8080', FLEET_PROXY_URL: '' }, 'http://127.0.0.1:8080'],
    ['no proxy at all: stays unset', {}, '<unset>'],
    ['empty HTTP_PROXY: stays unset', { HTTP_PROXY: '' }, '<unset>'],
  ])('the proxy prelude: %s', (_name, env, expected) => {
    const res = spawnSync(
      'sh',
      ['-c', `${FLEET_PROXY_PRELUDE}\nsh -c 'printf %s "\${FLEET_PROXY_URL-<unset>}"'`],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(expected);
  });

  it('gives every exec a different nonce', () => {
    const a = frameCommand('true', { mode: 'stream' });
    const b = frameCommand('true', { mode: 'stream' });
    expect(a.nonce).not.toBe(b.nonce);
  });

  it.each([
    ['talyn-turn-abc', 'talyn-turn-abc'],
    ['talyn script/../x y', 'talyn_script____x_y'],
    ['a$(rm -rf /)', 'a__rm_-rf___'],
  ])('makes a marker safe: %s', (raw, safe) => {
    expect(safeMarker(raw)).toBe(safe);
  });

  it('keeps the marker out of the kill script text, so pkill cannot match itself', () => {
    const { script, env } = killMarkerScript('talyn-turn-abc');
    expect(script).not.toContain('talyn-turn-abc');
    expect(env).toEqual({ TALYN_MARKER: 'talyn-turn-abc' });
    expect(script).toMatch(/send INT.*\n.*send TERM.*\n.*send KILL/);
    expect(aliveMarkerScript('talyn-turn-abc').script).not.toContain('talyn-turn-abc');
  });

  describe('the demux', () => {
    it('keeps only its own lines out of an interleaved ring', () => {
      const lines: string[] = [];
      const d = new FrameDemux('aa11', (l) => lines.push(l));
      for (const l of [
        tag('aa11', 'o', '{"a":1}'),
        'a dev server log line',
        tag('bb22', 'o', '{"other":true}'),
        tag('aa11', 'e', 'warning: x'),
        tag('bb22', 'x', '9'),
        tag('aa11', 'o', '{"a":2}'),
        '',
        tag('aa11', 'x', '3'),
      ]) {
        d.pushLine(l);
      }
      expect(lines).toEqual(['{"a":1}', '{"a":2}']);
      expect(d.done).toBe(true);
      expect(d.result()).toMatchObject({ exitCode: 3, stderr: 'warning: x' });
    });

    it('reports no exit code when the trailer never arrived', () => {
      const d = new FrameDemux('aa11');
      d.pushLine(tag('aa11', 'o', 'half'));
      expect(d.done).toBe(false);
      expect(d.result().exitCode).toBeNull();
    });

    it('decodes capture mode byte for byte, NULs included', () => {
      const payload = 'a.ts\0b with space.ts\0';
      const b64 = Buffer.from(payload).toString('base64');
      const d = new FrameDemux('cc33');
      d.pushLine(tag('cc33', 'O', b64.slice(0, 7)));
      d.pushLine(tag('ff00', 'O', 'QUJD'));
      d.pushLine(tag('cc33', 'O', b64.slice(7)));
      d.pushLine(tag('cc33', 'E', Buffer.from('oops\n').toString('base64')));
      d.pushLine(tag('cc33', 'x', '0'));
      expect(d.result()).toEqual({ exitCode: 0, stdout: payload, stderr: 'oops\n' });
      expect(d.stdoutBytes().equals(Buffer.from(payload))).toBe(true);
    });

    it('joins a line the guest split because it was over its line cap', () => {
      const lines: string[] = [];
      const d = new FrameDemux('dd44', (l) => lines.push(l));
      const big = 'x'.repeat(GUEST_MAX_LINE_BYTES + 10);
      d.pushLine(tag('dd44', 'o', big));
      d.pushLine('-the-rest');
      d.pushLine(tag('dd44', 'o', 'next'));
      expect(lines).toEqual([`${big}-the-rest`, 'next']);
    });

    it('reads a quiet exec answer as text', () => {
      const d = new FrameDemux('ee55');
      d.pushText(`${tag('ee55', 'O', Buffer.from('hi').toString('base64'))}\n\n${tag('ee55', 'x', '0')}\n`);
      expect(d.result()).toMatchObject({ exitCode: 0, stdout: 'hi' });
    });

    it('ignores frames that are not exec output', () => {
      const d = new FrameDemux('aa11');
      d.pushEvents([
        { seq: 1, at: '', event: { type: 'exec_exit', raw: { exitCode: 0 } } },
        { seq: 2, at: '', event: { type: 'exec_output', raw: { stream: 'stdout', data: tag('aa11', 'x', '0') } } },
        { seq: 3, at: '', event: { type: 'assistant', raw: { data: tag('aa11', 'x', '7') } } },
      ]);
      expect(d.result().exitCode).toBe(0);
    });
  });

  it('round-trips sections, empty ones included', () => {
    const script = sectionsScript([
      { label: 'ONE', command: 'cat a' },
      { label: 'TWO', command: 'cat b' },
    ]);
    expect(script).toContain('| emit ONE');
    const out = `ONE ${Buffer.from('x\0y').toString('base64')}\nTWO \n`;
    expect(parseSections(out)).toEqual({ ONE: 'x\0y', TWO: '' });
    expect(() => sectionsScript([{ label: 'bad label', command: 'true' }])).toThrow();
  });
});

describe('the quiet exec answer', () => {
  it.each([
    [{ stdout: 'a', stderr: 'b', exit: { exitCode: 2, timedOut: true }, truncated: true }, { stdout: 'a', stderr: 'b', exitCode: 2, timedOut: true, truncated: true }],
    [{ stdout: '', stderr: '', exit: { exitCode: 0 }, truncated: false }, { stdout: '', stderr: '', exitCode: 0 }],
    [{ events: [], cursor: 3, terminal: true }, null],
    [{ stdout: 'a' }, null],
    [null, null],
  ])('parses %j', (body, expected) => {
    expect(QUIET_EXEC.parse(body)).toEqual(expected);
  });
});

describe('pty frames', () => {
  it('decodes frames split across chunks', () => {
    const bytes = Buffer.concat([
      encodePtyFrame(PTY_FRAME.DATA, Buffer.from('hello')),
      encodePtyFrame(PTY_FRAME.DATA, Buffer.alloc(0)),
      encodePtyFrame(PTY_FRAME.EXIT, Buffer.from('{"exitCode":0}')),
    ]);
    const decoder = new PtyFrameDecoder();
    const frames = [];
    for (let i = 0; i < bytes.length; i += 3) frames.push(...decoder.push(bytes.subarray(i, i + 3)));
    expect(frames.map((f) => [f.type, f.payload.toString()])).toEqual([
      [PTY_FRAME.DATA, 'hello'],
      [PTY_FRAME.DATA, ''],
      [PTY_FRAME.EXIT, '{"exitCode":0}'],
    ]);
  });

  it('refuses a frame over the protocol cap', () => {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(0x7fffffff, 1);
    expect(() => new PtyFrameDecoder().push(header)).toThrow(/cap/);
  });

  it.each([
    ['/api/v1/workbenches/abc/terminal', 'abc'],
    ['/api/v1/workbenches/a%20b/terminal', 'a b'],
    ['/api/v1/workbenches/abc/terminal/x', null],
    ['/ws', null],
    ['/api/v1/workbenches//terminal', null],
  ])('matches the terminal path %s', (path, id) => {
    expect(matchTerminalPath(path)).toBe(id);
  });
});

describe('sandbox naming and scripts', () => {
  it.each([
    [0, 'talyn-wb-w1'],
    [1, 'talyn-wb-w1-r1'],
    [4, 'talyn-wb-w1-r4'],
  ])('generation %i → %s, and back', (generation, id) => {
    expect(sandboxIdFor('w1', generation)).toBe(id);
    expect(sandboxGeneration(id)).toBe(generation);
  });

  it.each([0, 1, 999])('keeps a uuid id within the fleet limit at generation %i', (generation) => {
    const id = sandboxIdFor('b4e2e7f0-44d3-4475-91d0-cf2487b07765', generation);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(sandboxGeneration(id)).toBe(generation);
  });

  it('has no generation before a sandbox exists', () => {
    expect(sandboxGeneration(null)).toBe(-1);
  });

  it.each([
    ['PostHog/posthog', '/work/posthog'],
    ['a/b.c-d', '/work/b.c-d'],
    ['a/we ird', '/work/we_ird'],
  ])('clones %s into %s', (repoFullName, dir) => {
    expect(repoDirFor({ repoFullName })).toBe(dir);
  });

  it('checks out a local branch, then a remote one, then creates from the base', () => {
    const script = cloneScript({ repoFullName: 'a/b', branch: "fe'at", baseBranch: 'main' });
    expect(script).toContain('git clone --filter=blob:none https://github.com/a/b.git /work/b');
    const local = script.indexOf('git show-ref --verify --quiet');
    const remote = script.indexOf('elif [ -n "$remote_branch" ]');
    const create = script.indexOf('git checkout --no-track -b');
    expect(script.indexOf('git ls-remote --exit-code --heads origin')).toBeLessThan(local);
    expect(local).toBeGreaterThan(0);
    expect(remote).toBeGreaterThan(local);
    expect(create).toBeGreaterThan(remote);
    // A quote in a branch name is data, never shell.
    expect(script).toContain(`'fe'\\''at'`);
    expect(script).toContain('origin/main');
  });

  it('links the golden checkout only when its origin is this repository, and before any checkout', () => {
    const script = cloneScript({ repoFullName: 'Acme/App', branch: 'feat', baseBranch: 'main' });
    expect(GOLDEN_REPO_DIR).toBe('/work/repo');
    expect(script).toContain('git -C /work/repo remote get-url origin');
    // Lower-cased on both sides, with or without `.git`, https or scp form.
    expect(script).toContain(`tr '[:upper:]' '[:lower:]'`);
    expect(script).toContain(`*/acme/app|*/acme/app.git|*:acme/app|*:acme/app.git) golden_match=1`);
    expect(script).toContain('ln -s /work/repo /work/App');
    expect(script).not.toMatch(/\bmv\b/);
    const link = script.indexOf('ln -s');
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(script.indexOf('git clone --filter=blob:none'));
    expect(link).toBeLessThan(script.indexOf('git checkout'));
  });

  it('fetches the base and the session branch by explicit refspec, never the whole remote', () => {
    const script = cloneScript({ repoFullName: 'a/b', branch: 'feat/x', baseBranch: 'release' });
    expect(script).not.toContain('git fetch --prune origin');
    expect(script).not.toMatch(/git fetch origin\s*$/m);
    expect(script).toContain('ensure_refspec +refs/heads/release:refs/remotes/origin/release');
    expect(script).toContain('ensure_refspec +refs/heads/feat/x:refs/remotes/origin/feat/x');
    // The wildcard is recognised as covering, never added.
    expect(script).not.toMatch(/git config --add remote\.origin\.fetch '?\+refs\/heads\/\*/);
    expect(script).toContain('git checkout -b feat/x --track origin/feat/x');
    expect(script).toContain('git fetch --depth=200 origin "$@"');
    expect(script).toContain('git fetch origin "$@"');
  });

  it('deepens a shallow clone in bounded steps until the merge base appears, then unshallows', () => {
    const script = cloneScript({ repoFullName: 'a/b', branch: 'feat', baseBranch: 'main' });
    expect(script).toContain(`while [ "$(git rev-parse --is-shallow-repository)" = true ] && ! git merge-base HEAD origin/main`);
    expect(script).toContain(`if [ "$tries" -ge ${MERGE_BASE_DEEPEN_TRIES} ]; then git fetch --unshallow origin "$@"; break; fi`);
    expect(script).toContain('git fetch --deepen=500 origin "$@"');
    // After the checkout, so the merge base is HEAD's.
    expect(script.indexOf('git merge-base')).toBeGreaterThan(script.indexOf('git checkout --no-track'));
  });

  it('the diff merge base deepens a shallow repo once, then falls back to HEAD out loud', () => {
    const line = mergeBaseLine({ baseBranch: 'main' });
    expect(line).toMatch(/^mb=\$\(git merge-base HEAD origin\/main 2>\/dev\/null/);
    expect(line).toContain('git fetch -q --deepen=500 origin +refs/heads/main:refs/remotes/origin/main');
    expect(line).not.toContain('--unshallow');
    expect(line).toContain('no merge base with origin/main; diffing against HEAD');
    expect(line.indexOf('--deepen')).toBeLessThan(line.indexOf('git rev-parse HEAD'));
  });

  describe.skipIf(process.platform === 'win32')('the clone script against real git', () => {
    /** An origin with 400 commits on main, `feat` forked at 100 and `release` at 20. */
    function fixture(): { root: string; origin: string; run: (script: string, cwd?: string) => ReturnType<typeof spawnSync> } {
      const root = mkdtempSync(join(tmpdir(), 'talyn-clone-'));
      const origin = join(root, 'gh', 'acme', 'app.git');
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      const run = (script: string, cwd = root) => spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', env });
      const out: string[] = [];
      const commit = (ref: string, mark: number, parent: number | null, file: string) => {
        out.push(`commit ${ref}\nmark :${mark}\ncommitter t <t@t> ${1700000000 + mark} +0000\ndata 1\nc\n`);
        if (parent) out.push(`from :${parent}\n`);
        out.push(`M 644 inline ${file}\ndata ${String(mark).length + 1}\n${mark}\n\n`);
      };
      for (let i = 1; i <= 400; i++) commit('refs/heads/main', i, i > 1 ? i - 1 : null, 'f');
      commit('refs/heads/feat', 5000, 100, 'g');
      commit('refs/heads/release', 6000, 20, 'h');
      writeFileSync(join(root, 'stream'), out.join(''));
      expect(run(`git init -q --bare ${origin} && git -C ${origin} fast-import --quiet < stream`).status).toBe(0);
      return { root, origin, run };
    }

    function localScript(root: string, origin: string, branch: string, baseBranch: string): string {
      return cloneScript({ repoFullName: 'Acme/App', branch, baseBranch })
        .replaceAll('https://github.com/Acme/App.git', `file://${origin}`)
        .replaceAll('/work', join(root, 'work'));
    }

    it.each([
      ['a new branch from the default branch', 'newb', 'main', null],
      ['a pushed branch forked 300 commits back', 'feat', 'main', 'origin/feat'],
      ['a new branch from a non-default base', 'newc', 'release', null],
    ])('links a matching golden: %s', (_name, branch, baseBranch, upstream) => {
      const { root, origin, run } = fixture();
      try {
        expect(run(`git clone -q --depth 1 --branch main --single-branch file://${origin} work/repo`).status).toBe(0);
        const res = run(localScript(root, origin, branch, baseBranch));
        expect(res.status, String(res.stderr)).toBe(0);
        const dir = join(root, 'work', 'App');
        expect(run(`test -L ${dir}`).status).toBe(0);
        expect(run('git rev-parse --abbrev-ref HEAD', dir).stdout.trim()).toBe(branch);
        expect(run(`git merge-base HEAD origin/${baseBranch}`, dir).status).toBe(0);
        const specs = run('git config --get-all remote.origin.fetch', dir).stdout.trim().split('\n');
        expect(specs).not.toContain('+refs/heads/*:refs/remotes/origin/*');
        expect(specs).toContain(`+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`);
        if (upstream) expect(run('git rev-parse --abbrev-ref @{u}', dir).stdout.trim()).toBe(upstream);
        // A second run (a re-provision) is a no-op that still succeeds.
        expect(run(localScript(root, origin, branch, baseBranch)).status).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('clones instead when the golden is another repository', () => {
      const { root, origin, run } = fixture();
      try {
        expect(run(`git clone -q --depth 1 file://${origin} work/repo`).status).toBe(0);
        expect(run('git -C work/repo remote set-url origin https://github.com/acme/other.git').status).toBe(0);
        expect(run(localScript(root, origin, 'newd', 'main')).status).toBe(0);
        const dir = join(root, 'work', 'App');
        expect(run(`test -L ${dir}`).status).not.toBe(0);
        expect(run('git rev-parse --is-shallow-repository', dir).stdout.trim()).toBe('false');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('saves work on archive without ever forcing the branch', () => {
    const script = archiveSaveScript({ id: 'w1', branch: 'paris', baseBranch: 'main' });
    expect(script).toContain('git push origin HEAD:refs/heads/paris');
    expect(script).not.toMatch(/push --force origin HEAD:refs\/heads/);
    expect(script).toContain(`"$sha":${archiveRef('w1')}`);
    expect(script).toContain('exit 1');
    const restore = restoreSavedWorkScript({ id: 'w1', branch: 'paris' });
    expect(restore).toContain(`git fetch origin ${archiveRef('w1')}`);
    expect(restore).toContain('git read-tree "$sha"');
  });

  it.each(['a/b.ts', 'src/x y.ts', '.env'])('accepts the repository path %s', (p) => {
    expect(assertRepoPath(p)).toBe(p);
  });

  it.each(['', '/etc/passwd', '../x', 'a/../../b', 'a\0b', '   '])('refuses the path %j', (p) => {
    expect(() => assertRepoPath(p)).toThrow(/not inside the repository/);
  });

  it.each([
    [Buffer.from('plain text'), false],
    [Buffer.from([0x89, 0x50, 0x00, 0x01]), true],
    [Buffer.alloc(0), false],
  ])('detects binary content', (bytes, binary) => {
    expect(looksBinary(bytes)).toBe(binary);
  });
});

describe('the PR summary', () => {
  const base = { id: 'p', owner: 'o', repo: 'r', number: 7 };
  it.each([
    ['open', 'MERGEABLE', 'passing', { state: 'open', mergeable: 'mergeable', ciStatus: 'success' }],
    ['open', 'CONFLICTING', 'failing_required', { state: 'open', mergeable: 'conflicting', ciStatus: 'failure' }],
    ['open', 'UNKNOWN', 'running', { state: 'open', mergeable: 'unknown', ciStatus: 'pending' }],
    ['open', null, 'needs_human', { state: 'open', mergeable: 'unknown', ciStatus: 'pending' }],
    ['open', 'MERGEABLE', 'failing_optional', { state: 'open', mergeable: 'mergeable', ciStatus: 'success' }],
    ['open', 'MERGEABLE', 'none', { state: 'open', mergeable: 'mergeable', ciStatus: 'none' }],
    ['open', 'MERGEABLE', null, { state: 'open', mergeable: 'mergeable', ciStatus: 'pending' }],
    ['merged', 'MERGEABLE', 'passing', { state: 'merged', mergeable: 'mergeable', ciStatus: 'success' }],
    ['closed', null, null, { state: 'closed', mergeable: 'unknown', ciStatus: 'pending' }],
  ] as const)('maps state=%s mergeable=%s ci=%s', (state, mergeable, ciStatus, expected) => {
    expect(toPrSummary({ ...base, state, mergeable, ciStatus })).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      ...expected,
    });
  });
});
