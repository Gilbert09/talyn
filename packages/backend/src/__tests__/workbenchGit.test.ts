import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkpointCreateSteps,
  checkpointRef,
  checkpointRestoreSteps,
  countLines,
  diffNameStatus,
  diffNumstat,
  diffPatch,
  diffStatOf,
  isMergeInProgress,
  isValidBranchName,
  normaliseBranchPrefix,
  listCheckpointRefs,
  mergeBase,
  mergeChangedFiles,
  mergeInProgressFromExit,
  parseCheckpointRefs,
  parseNameStatus,
  parseNulList,
  parseNumstatZ,
  parsePorcelainV2,
  renameBranch,
  resolveStepArgv,
  shellQuote,
  splitUnifiedDiff,
  statusPorcelain,
  toShellScript,
  untrackedFilePatch,
  untrackedFiles,
  worktreeAdd,
  worktreeRemove,
  type GitStep,
} from '@talyn/shared';

describe('argv builders', () => {
  it.each<[string, GitStep, string[]]>([
    ['mergeBase', mergeBase('origin/main'), ['git', 'merge-base', 'HEAD', 'origin/main']],
    ['diffNumstat', diffNumstat('abc'), ['git', 'diff', '--numstat', '-z', '--find-renames', 'abc', '--']],
    ['diffNameStatus', diffNameStatus('abc'), ['git', 'diff', '--name-status', '-z', '--find-renames', 'abc', '--']],
    ['untrackedFiles', untrackedFiles(), ['git', 'ls-files', '--others', '--exclude-standard', '-z']],
    ['diffPatch all', diffPatch('abc'), ['git', 'diff', '--no-color', '--find-renames', 'abc', '--']],
    ['diffPatch one path', diffPatch('abc', '-weird name'), ['git', 'diff', '--no-color', '--find-renames', 'abc', '--', '-weird name']],
    ['statusPorcelain', statusPorcelain(), ['git', 'status', '--porcelain=v2', '-z', '--branch']],
    ['renameBranch', renameBranch('feat/x'), ['git', 'branch', '-m', 'feat/x']],
    ['worktreeAdd', worktreeAdd('/tmp/w', 'tokyo', 'origin/main'), ['git', 'worktree', 'add', '-b', 'tokyo', '/tmp/w', 'origin/main']],
    ['worktreeRemove', worktreeRemove('/tmp/w'), ['git', 'worktree', 'remove', '/tmp/w']],
    ['worktreeRemove force', worktreeRemove('/tmp/w', { force: true }), ['git', 'worktree', 'remove', '--force', '/tmp/w']],
    ['isMergeInProgress', isMergeInProgress(), ['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD']],
  ])('%s', (_name, step, argv) => {
    expect(step.argv).toEqual(argv);
  });

  it('a path that starts with a dash comes after --, so git never reads it as an option', () => {
    const argv = diffPatch('abc', '--output=/etc/passwd').argv;
    expect(argv.indexOf('--')).toBeLessThan(argv.indexOf('--output=/etc/passwd'));
  });

  it.each([[0, true], [1, false], [128, false]])('mergeInProgressFromExit(%d) → %s', (code, expected) => {
    expect(mergeInProgressFromExit(code)).toBe(expected);
    expect(isMergeInProgress().allowFailure).toBe(true);
  });

  it('untrackedFilePatch allows the exit code 1 that --no-index always returns', () => {
    expect(untrackedFilePatch('a.txt')).toEqual({
      argv: ['git', 'diff', '--no-color', '--no-index', '--', '/dev/null', 'a.txt'],
      allowFailure: true,
    });
  });
});

describe('isValidBranchName', () => {
  it.each([
    ['tokyo', true],
    ['feat/new-thing', true],
    ['tom/workbenches', true],
    ['v1.2', true],
    ['', false],
    ['-leading', false],
    ['/leading', false],
    ['trailing/', false],
    ['trailing.', false],
    ['a..b', false],
    ['a//b', false],
    ['has space', false],
    ['tilde~', false],
    ['caret^', false],
    ['colon:', false],
    ['star*', false],
    ['question?', false],
    ['bracket[', false],
    ['back\\slash', false],
    ['at@{brace', false],
    ['@', false],
    ['HEAD', false],
    ['x.lock', false],
    ['a/.hidden', false],
    ['a/b.lock/c', false],
    ['tab\tname', false],
    ['x'.repeat(256), false],
  ])('%j → %s', (name, expected) => {
    expect(isValidBranchName(name)).toBe(expected);
  });
});

describe('normaliseBranchPrefix', () => {
  it.each([
    ['', ''],
    ['   ', ''],
    ['tom/', 'tom/'],
    ['tom-', 'tom-'],
    ['  tom/  ', 'tom/'],
    ['feat/tom/', 'feat/tom/'],
  ])('accepts %j as %j', (raw, value) => {
    expect(normaliseBranchPrefix(raw)).toEqual({ ok: true, value });
  });

  it.each([['bad..'], ['has space'], ['~x'], ['/lead'], ['-lead'], ['a//'], ['x'.repeat(41)], ['a:'], [42], [null]])(
    'rejects %j',
    (raw) => {
      const res = normaliseBranchPrefix(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBeTruthy();
    },
  );

  it('accepts exactly 40 characters', () => {
    expect(normaliseBranchPrefix('x'.repeat(40))).toEqual({ ok: true, value: 'x'.repeat(40) });
  });
});

describe('shellQuote', () => {
  it.each([
    ['', "''"],
    ['plain', 'plain'],
    ['path/to-file_1.ts', 'path/to-file_1.ts'],
    ['a=b,c:d@e%f+g', 'a=b,c:d@e%f+g'],
    ['has space', "'has space'"],
    ["it's", "'it'\\''s'"],
    ['$HOME', "'$HOME'"],
    ['`whoami`', "'`whoami`'"],
    ['a\nb', "'a\nb'"],
    ['back\\slash', "'back\\slash'"],
    ['*', "'*'"],
    ['!', "'!'"],
  ])('%j → %s', (input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['single quotes', "'''"],
    ['mixed quotes', `he said "it's" ok`],
    ['dollar and backticks', '$(rm -rf /) `id` ${PATH}'],
    ['newlines and tabs', 'line1\nline2\tTab'],
    ['semicolons and pipes', 'a; b | c && d || e'],
    ['glob', '* ? [abc]'],
    ['unicode', 'héllo – 日本'],
    ['leading dash', '-n'],
  ])('round-trips %s through sh unchanged', (_name, input) => {
    const out = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(input)}`], { encoding: 'utf8' });
    expect(out).toBe(input);
  });

  // The quoting is for the Linux sandbox. Git Bash's sh on a Windows runner
  // collapses a doubled backslash in its arguments before printf sees them.
  it.skipIf(process.platform === 'win32')('round-trips backslashes through sh unchanged', () => {
    const input = '\\\\n \\t';
    const out = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(input)}`], { encoding: 'utf8' });
    expect(out).toBe(input);
  });
});

describe('toShellScript / resolveStepArgv', () => {
  it('quotes argv, prefixes env, handles captures and allowFailure', () => {
    const script = toShellScript([
      { argv: ['git', 'write-tree'], env: { GIT_INDEX_FILE: '/tmp/my index' }, capture: 'tree' },
      { argv: ['git', 'commit-tree', '{{tree}}', '-m', "it's"], capture: 'commit' },
      { argv: ['git', 'update-ref', 'refs/x', 'pre-{{commit}}-post'], allowFailure: true },
    ]);
    expect(script).toBe(
      [
        'set -eu',
        "talyn_tree=$(GIT_INDEX_FILE='/tmp/my index' git write-tree)",
        "talyn_commit=$(git commit-tree \"$talyn_tree\" -m 'it'\\''s')",
        'git update-ref refs/x pre-"$talyn_commit"-post || true',
        '',
      ].join('\n')
    );
  });

  it.each<[string, GitStep[]]>([
    ['empty argv', [{ argv: [] }]],
    ['bad env name', [{ argv: ['git'], env: { 'A-B': 'x' } }]],
    ['env name injection', [{ argv: ['git'], env: { 'X=1; rm -rf /; Y': 'x' } }]],
    ['bad capture name', [{ argv: ['git'], capture: 'a b' }]],
  ])('refuses %s', (_name, steps) => {
    expect(() => toShellScript(steps)).toThrow();
  });

  it('runs end to end in sh: capture, placeholder inside a word, env scoped to its step', () => {
    const script = toShellScript([
      { argv: ['printf', '%s', 'abc'], capture: 'x' },
      { argv: ['sh', '-c', 'printf "%s|" "$1" "$FOO"', 'sh', 'pre-{{x}}-post'], env: { FOO: "o'k $1" } },
      { argv: ['sh', '-c', 'printf "%s" "${FOO:-unset}"'] },
      { argv: ['false'], allowFailure: true },
    ]);
    const out = execFileSync('sh', ['-c', script], { encoding: 'utf8' });
    expect(out).toBe("pre-abc-post|o'k $1|unset");
  });

  it('stops at the first failing step without allowFailure', () => {
    const script = toShellScript([{ argv: ['printf', 'a'] }, { argv: ['false'] }, { argv: ['printf', 'b'] }]);
    const res = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('a');
  });

  it('resolveStepArgv fills placeholders and refuses unknown ones', () => {
    const step: GitStep = { argv: ['git', 'commit-tree', '{{tree}}', '-p', 'x{{tree}}y'] };
    expect(resolveStepArgv(step, { tree: 'T' })).toEqual(['git', 'commit-tree', 'T', '-p', 'xTy']);
    expect(() => resolveStepArgv(step, {})).toThrow(/tree/);
    expect(resolveStepArgv({ argv: ['git', '{{', '{{1x}}'] }, {})).toEqual(['git', '{{', '{{1x}}']);
  });
});

describe('parseNumstatZ', () => {
  it.each([
    ['empty', '', []],
    ['one file', '3\t1\tsrc/a.ts\0', [{ path: 'src/a.ts', added: 3, removed: 1, binary: false }]],
    ['binary', '-\t-\timg.png\0', [{ path: 'img.png', added: null, removed: null, binary: true }]],
    [
      'rename (-z puts both paths in their own fields)',
      '0\t0\t\0old/name.ts\0new/name.ts\0',
      [{ path: 'new/name.ts', oldPath: 'old/name.ts', added: 0, removed: 0, binary: false }],
    ],
    ['path with tab and newline', '1\t0\ta\tb\nc.txt\0', [{ path: 'a\tb\nc.txt', added: 1, removed: 0, binary: false }]],
    [
      'mixed',
      '1\t2\ta.ts\0' + '5\t0\t\0x.ts\0y.ts\0' + '-\t-\tbin.dat\0' + '0\t9\tz.ts\0',
      [
        { path: 'a.ts', added: 1, removed: 2, binary: false },
        { path: 'y.ts', oldPath: 'x.ts', added: 5, removed: 0, binary: false },
        { path: 'bin.dat', added: null, removed: null, binary: true },
        { path: 'z.ts', added: 0, removed: 9, binary: false },
      ],
    ],
    ['truncated rename is dropped', '1\t1\t\0only-old\0', []],
    ['garbage ignored', 'nonsense\0', []],
  ])('%s', (_name, input, expected) => {
    expect(parseNumstatZ(input)).toEqual(expected);
  });
});

describe('parseNameStatus', () => {
  it.each([
    ['empty', '', []],
    ['modified', 'M\0a.ts\0', [{ status: 'modified', path: 'a.ts' }]],
    ['added', 'A\0a.ts\0', [{ status: 'added', path: 'a.ts' }]],
    ['deleted', 'D\0a.ts\0', [{ status: 'deleted', path: 'a.ts' }]],
    ['type change', 'T\0a\0', [{ status: 'modified', path: 'a' }]],
    ['unmerged', 'U\0a\0', [{ status: 'modified', path: 'a' }]],
    ['rename', 'R087\0old.ts\0new.ts\0', [{ status: 'renamed', path: 'new.ts', oldPath: 'old.ts' }]],
    ['copy reads as added', 'C075\0src.ts\0dst.ts\0', [{ status: 'added', path: 'dst.ts' }]],
    [
      'mixed',
      'M\0a\0R100\0b\0c\0D\0d\0',
      [
        { status: 'modified', path: 'a' },
        { status: 'renamed', path: 'c', oldPath: 'b' },
        { status: 'deleted', path: 'd' },
      ],
    ],
  ])('%s', (_name, input, expected) => {
    expect(parseNameStatus(input)).toEqual(expected);
  });
});

describe('mergeChangedFiles / diffStatOf / countLines', () => {
  it('combines counts, kinds and untracked files, sorted by path', () => {
    const files = mergeChangedFiles({
      numstat: '3\t1\tb.ts\0' + '0\t4\tgone.ts\0' + '2\t2\t\0old.ts\0new.ts\0' + '-\t-\tlogo.png\0' + '7\t0\tadded.ts\0',
      nameStatus: 'M\0b.ts\0D\0gone.ts\0R090\0old.ts\0new.ts\0M\0logo.png\0A\0added.ts\0',
      untracked: 'z-new.txt\0a-new.txt\0b.ts\0',
      untrackedLineCounts: { 'z-new.txt': 12 },
    });
    expect(files).toEqual([
      { path: 'a-new.txt', status: 'added', added: 0, removed: 0, binary: false },
      { path: 'added.ts', status: 'added', added: 7, removed: 0, binary: false },
      { path: 'b.ts', status: 'modified', added: 3, removed: 1, binary: false },
      { path: 'gone.ts', status: 'deleted', added: 0, removed: 4, binary: false },
      { path: 'logo.png', status: 'modified', added: 0, removed: 0, binary: true },
      { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', added: 2, removed: 2, binary: false },
      { path: 'z-new.txt', status: 'added', added: 12, removed: 0, binary: false },
    ]);
    expect(diffStatOf(files)).toEqual({ added: 24, removed: 7, files: 7 });
  });

  it('falls back to renamed/modified when name-status is missing', () => {
    expect(mergeChangedFiles({ numstat: '1\t1\t\0a\0b\0' + '1\t0\tc\0', nameStatus: '' })).toEqual([
      { path: 'b', oldPath: 'a', status: 'renamed', added: 1, removed: 1, binary: false },
      { path: 'c', status: 'modified', added: 1, removed: 0, binary: false },
    ]);
  });

  it('diffStatOf of nothing is zero', () => {
    expect(diffStatOf([])).toEqual({ added: 0, removed: 0, files: 0 });
  });

  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\n', 2],
    ['\n', 1],
    ['\n\n', 2],
  ])('countLines(%j) → %d', (content, expected) => {
    expect(countLines(content)).toBe(expected);
  });

  it('parseNulList drops empties', () => {
    expect(parseNulList('a\0\0b c\0')).toEqual(['a', 'b c']);
  });
});

describe('splitUnifiedDiff', () => {
  const modified = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    ' same',
  ].join('\n');
  const added = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 000..333',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
  ].join('\n');
  const deleted = [
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');
  const renamed = [
    'diff --git a/old name.ts b/new name.ts',
    'similarity index 90%',
    'rename from old name.ts',
    'rename to new name.ts',
    '--- a/old name.ts',
    '+++ b/new name.ts',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');
  const pureRename = ['diff --git a/x b/y', 'similarity index 100%', 'rename from x', 'rename to y'].join('\n');
  const binary = ['diff --git a/img.png b/img.png', 'index 1..2 100644', 'Binary files a/img.png and b/img.png differ'].join('\n');
  const quoted = [
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    '--- "a/caf\\303\\251.txt"',
    '+++ "b/caf\\303\\251.txt"',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ].join('\n');
  const hunkLooksLikeHeader = [
    'diff --git a/doc.md b/doc.md',
    '--- a/doc.md',
    '+++ b/doc.md',
    '@@ -1 +1,2 @@',
    ' x',
    '+--- not a header',
  ].join('\n');

  it.each([
    ['modified', modified, 'src/a.ts', undefined],
    ['added', added, 'new.txt', undefined],
    ['deleted', deleted, 'gone.txt', undefined],
    ['renamed with spaces', renamed, 'new name.ts', 'old name.ts'],
    ['pure rename, no hunks', pureRename, 'y', 'x'],
    ['binary uses the header', binary, 'img.png', undefined],
    ['a hunk line that looks like a header is not read as one', hunkLooksLikeHeader, 'doc.md', undefined],
  ])('%s', (_name, patch, path, oldPath) => {
    const [file] = splitUnifiedDiff(patch);
    expect(file.path).toBe(path);
    expect(file.oldPath).toBe(oldPath);
    expect(file.patch).toBe(`${patch}\n`);
  });

  it('decodes C-quoted paths (octal utf-8 bytes)', () => {
    // Git writes the raw bytes as octal escapes; each byte becomes one char here.
    const [file] = splitUnifiedDiff(quoted);
    expect(file.path).toBe('cafÃ©.txt');
  });

  it('splits a multi-file patch in order and keeps each chunk whole', () => {
    const whole = [modified, added, deleted, renamed, binary].join('\n') + '\n';
    const files = splitUnifiedDiff(whole);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'new.txt', 'gone.txt', 'new name.ts', 'img.png']);
    expect(files.map((f) => f.patch).join('')).toBe(whole);
  });

  it.each([[''], ['   \n'], ['no diff here']])('nothing to split in %j', (patch) => {
    expect(splitUnifiedDiff(patch)).toEqual([]);
  });
});

describe('parsePorcelainV2', () => {
  it('reads headers and every entry kind', () => {
    const out = [
      '# branch.oid 0123456789abcdef0123456789abcdef01234567',
      '# branch.head tokyo',
      '# branch.upstream origin/tokyo',
      '# branch.ab +3 -2',
      '1 .M N... 100644 100644 100644 aaa bbb src/a b.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts',
      '? untracked file.txt',
      '! ignored.log',
      '',
    ].join('\0');
    expect(parsePorcelainV2(out)).toEqual({
      oid: '0123456789abcdef0123456789abcdef01234567',
      branch: 'tokyo',
      upstream: 'origin/tokyo',
      ahead: 3,
      behind: 2,
      conflicted: ['conflict.ts'],
      changed: ['src/a b.ts', 'new name.ts'],
      untracked: ['untracked file.txt'],
      dirty: true,
    });
  });

  it.each([
    ['clean', '# branch.oid abc\0# branch.head main\0', { branch: 'main', oid: 'abc', dirty: false, upstream: null, ahead: 0, behind: 0 }],
    ['detached', '# branch.oid abc\0# branch.head (detached)\0', { branch: null, dirty: false }],
    ['unborn', '# branch.oid (initial)\0# branch.head main\0? a\0', { oid: null, dirty: true }],
    ['only untracked is dirty', '? x\0', { dirty: true, untracked: ['x'] }],
    ['ignored is not dirty', '! x\0', { dirty: false, untracked: [] }],
  ])('%s', (_name, input, expected) => {
    expect(parsePorcelainV2(input)).toMatchObject(expected);
  });
});

describe('checkpoint refs', () => {
  it.each([
    ['chat-1', 3, 'refs/talyn/checkpoints/chat-1/3'],
    ['5f0c_A', 0, 'refs/talyn/checkpoints/5f0c_A/0'],
  ])('checkpointRef(%s, %d)', (chat, turn, ref) => {
    expect(checkpointRef(chat, turn)).toBe(ref);
  });

  it.each([
    ['../x', 1],
    ['a/b', 1],
    ['a b', 1],
    ['ok', -1],
    ['ok', 1.5],
  ])('refuses checkpointRef(%j, %d)', (chat, turn) => {
    expect(() => checkpointRef(chat, turn)).toThrow();
  });

  it('refuses a restore sha that is not hex', () => {
    expect(() => checkpointRestoreSteps({ sha: 'HEAD; rm -rf /', tmpIndexPath: '/tmp/i' })).toThrow();
  });

  it('parses for-each-ref output sorted by turn', () => {
    expect(
      parseCheckpointRefs(
        'bbb refs/talyn/checkpoints/c1/10\naaa refs/talyn/checkpoints/c1/2\nnoise\nccc refs/heads/main\n'
      )
    ).toEqual([
      { sha: 'aaa', ref: 'refs/talyn/checkpoints/c1/2', turn: 2 },
      { sha: 'bbb', ref: 'refs/talyn/checkpoints/c1/10', turn: 10 },
    ]);
    expect(listCheckpointRefs('c1').argv).toEqual([
      'git',
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      'refs/talyn/checkpoints/c1/',
    ]);
  });
});

/**
 * The checkpoint sequences against a real repository, run as the sandbox runs
 * them: one `sh` script. This is what proves "never touches the branch or the
 * index" rather than asserting the argv says so.
 */
describe('checkpoints in a real repository', () => {
  let dir: string;
  let tmp: string;
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const sh = (script: string) => execFileSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' });
  const read = (p: string) => readFileSync(join(dir, p), 'utf8');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-git-'));
    tmp = mkdtempSync(join(tmpdir(), 'wb-idx-'));
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.name', 'Test']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'commit.gpgsign', 'false']);
    // A Windows runner checks files out with CRLF unless told not to.
    run(['config', 'core.autocrlf', 'false']);
    writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    writeFileSync(join(dir, 'b.txt'), 'bee\n');
    run(['add', '-A']);
    run(['commit', '-q', '--no-verify', '-m', 'init']);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a checkpoint of the working tree without moving HEAD or the index, then restores it', () => {
    const head = run(['rev-parse', 'HEAD']).trim();
    // State at the checkpoint: a modified, b deleted, an untracked file, a staged
    // change, and an ignored file.
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    rmSync(join(dir, 'b.txt'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', "it's new.txt"), 'n\n');
    writeFileSync(join(dir, 'staged.txt'), 's\n');
    run(['add', 'staged.txt']);
    writeFileSync(join(dir, '.env'), 'SECRET=1\n');
    const indexBefore = run(['diff', '--cached', '--name-status']);

    const sha = sh(toShellScript(checkpointCreateSteps({ chatId: 'chat1', turn: 1, tmpIndexPath: join(tmp, 'i1') }))).trim();

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(run(['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(run(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main');
    expect(run(['diff', '--cached', '--name-status'])).toBe(indexBefore);
    expect(run(['rev-parse', 'refs/talyn/checkpoints/chat1/1']).trim()).toBe(sha);
    expect(run(['rev-parse', `${sha}^`]).trim()).toBe(head);
    expect(run(['ls-tree', '-r', '--name-only', sha]).split('\n').filter(Boolean).sort()).toEqual(
      ['.gitignore', 'a.txt', 'staged.txt', "sub/it's new.txt"].sort()
    );
    expect(existsSync(join(tmp, 'i1'))).toBe(false);

    // The agent keeps working: edits, deletes, recreates, adds files, commits nothing.
    writeFileSync(join(dir, 'a.txt'), 'three\n');
    writeFileSync(join(dir, 'b.txt'), 'back\n');
    rmSync(join(dir, 'staged.txt'));
    writeFileSync(join(dir, 'later.txt'), 'later\n');
    mkdirSync(join(dir, 'newdir'));
    writeFileSync(join(dir, 'newdir', 'x.txt'), 'x\n');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'dep.js'), 'dep\n');
    const indexMid = run(['diff', '--cached', '--name-status']);

    sh(toShellScript(checkpointRestoreSteps({ sha, tmpIndexPath: join(tmp, 'i2') })));

    expect(read('a.txt')).toBe('two\n');
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    expect(read('staged.txt')).toBe('s\n');
    expect(read("sub/it's new.txt")).toBe('n\n');
    expect(existsSync(join(dir, 'later.txt'))).toBe(false);
    expect(existsSync(join(dir, 'newdir'))).toBe(false);
    // Ignored files survive a restore.
    expect(read('.env')).toBe('SECRET=1\n');
    expect(read('node_modules/dep.js')).toBe('dep\n');
    // Branch, HEAD and the real index are untouched.
    expect(run(['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(run(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/main');
    expect(run(['diff', '--cached', '--name-status'])).toBe(indexMid);
    expect(existsSync(join(tmp, 'i2'))).toBe(false);
  });

  it('works step by step with resolveStepArgv, as the local runtime runs it', () => {
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const captures: Record<string, string> = {};
    let last = '';
    for (const step of checkpointCreateSteps({ chatId: 'c2', turn: 4, tmpIndexPath: join(tmp, 'i') })) {
      const [cmd, ...args] = resolveStepArgv(step, captures);
      const res = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...step.env } });
      if (res.status !== 0 && !step.allowFailure) throw new Error(`${cmd} ${args.join(' ')}: ${res.stderr}`);
      if (step.capture) captures[step.capture] = res.stdout.trim();
      last = res.stdout;
    }
    const sha = last.trim();
    expect(run(['rev-parse', 'refs/talyn/checkpoints/c2/4']).trim()).toBe(sha);
    expect(run(['show', `${sha}:a.txt`])).toBe('changed\n');
  });

  it('builds a diff of tracked and untracked changes against the merge base', () => {
    run(['checkout', '-q', '-b', 'tokyo']);
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
    run(['mv', 'b.txt', 'c.txt']);
    writeFileSync(join(dir, 'new.txt'), 'x\ny\nz\n');
    const base = run(mergeBase('main').argv.slice(1)).trim();
    const files = mergeChangedFiles({
      numstat: run(diffNumstat(base).argv.slice(1)),
      nameStatus: run(diffNameStatus(base).argv.slice(1)),
      untracked: run(untrackedFiles().argv.slice(1)),
      untrackedLineCounts: { 'new.txt': countLines(read('new.txt')) },
    });
    expect(files).toEqual([
      { path: 'a.txt', status: 'modified', added: 1, removed: 0, binary: false },
      { path: 'c.txt', oldPath: 'b.txt', status: 'renamed', added: 0, removed: 0, binary: false },
      { path: 'new.txt', status: 'added', added: 3, removed: 0, binary: false },
    ]);
    const patches = splitUnifiedDiff(run(diffPatch(base).argv.slice(1)));
    expect(patches.map((p) => [p.path, p.oldPath])).toEqual([
      ['a.txt', undefined],
      ['c.txt', 'b.txt'],
    ]);
    const status = parsePorcelainV2(run(statusPorcelain().argv.slice(1)));
    expect(status.branch).toBe('tokyo');
    expect(status.untracked).toEqual(['new.txt']);
    expect(status.dirty).toBe(true);
  });
});
