import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetClient, FleetHttpError, resetFleetOptionalSupport } from '../services/selfHosted/client.js';
import {
  grownDiskMib,
  GROW_TARGET_FREE_BYTES,
  isDiskFullError,
  isDiskFullText,
  isGuestUnreachableBeforeStart,
  parseDiskProbe,
} from '../services/workbenches/execFailures.js';
import {
  MOVE_IGNORED_FILE_MAX_BYTES,
  MOVE_IGNORED_TOTAL_MAX_BYTES,
  MOVE_SKIP_DIRS,
  MOVE_TRANSFER_MAX_BYTES,
  moveExportEnv,
  moveExportScript,
  moveImportScript,
  movedNote,
  moveReadChunkScript,
  moveStagingDir,
  parseMoveManifest,
  skippedNote,
  type MoveManifest,
} from '../services/workbenches/move.js';
import {
  fleetClientFor,
  nextSandboxId,
  setGuestRetryDelaysForTests,
  setWorkbenchFleetClientForTests,
} from '../services/workbenches/sandboxRuntime.js';

const WB = '11111111-2222-4333-8444-555555555555';
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const GUEST_RESET =
  'exec: Post "http://guest/v1/exec": read CONNECT reply: read unix @->/fleet.vsock: read: connection reset by peer';

/** Every file a script writes with `>` or `>>`. `&2` and `/dev/null` are not files. */
function redirectTargets(script: string): string[] {
  return [...script.matchAll(/(?<![0-9&<>])>>?\s*("[^"]*"|[^\s;|&)]+)/g)]
    .map((m) => m[1])
    .filter((t) => !t.startsWith('&') && t !== '/dev/null');
}

describe('the export script', () => {
  const script = moveExportScript({
    workbenchId: WB,
    sessions: [
      { agent: 'claude', sessionId: '4f1c2b9e-1111-4222-8333-944455556666' },
      { agent: 'codex', sessionId: '0199aabb-ccdd-7eef-8000-112233445566' },
      { agent: 'claude', sessionId: 'x; rm -rf /' },
    ],
  });

  it('names its staging, index and temp files under /dev/shm', () => {
    expect(moveStagingDir(WB)).toBe(`/dev/shm/talyn-move-${WB}`);
    expect(moveExportEnv(WB)).toEqual({
      TMPDIR: '/dev/shm',
      GIT_INDEX_FILE: `/dev/shm/talyn-move-${WB}.index`,
      GIT_OPTIONAL_LOCKS: '0',
    });
    expect(script).toContain(`d=/dev/shm/talyn-move-${WB}\n`);
  });

  it('writes nothing outside the staging folder: no /tmp, and no file in the repository', () => {
    expect(script).not.toContain('/tmp');
    const targets = redirectTargets(script);
    expect(targets.length).toBeGreaterThan(5);
    for (const target of targets) expect(target).toMatch(/^"\$d\//);
    // The only other file: the index copy, at the env's /dev/shm path.
    expect(script).toContain('cp -- "$real_index" "$GIT_INDEX_FILE"');
  });

  it('never pushes: commits travel as a bundle of every branch, the stash and the checkpoints', () => {
    expect(script).not.toMatch(/git push/);
    expect(script).toContain(
      "git for-each-ref --format='%(objectname) %(refname) %(upstream:short)' refs/heads refs/stash refs/talyn/checkpoints",
    );
    expect(script).toContain('git bundle create - "${refs[@]}" --not --remotes | capped repo.bundle');
    // An empty bundle is an error in git, so the bundle is made only when there are new commits.
    expect(script).toContain('git rev-list --count "${refs[@]}" --not --remotes');
  });

  it.each(['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'])(
    'refuses with 41 while %s exists',
    (state) => {
      expect(script).toMatch(new RegExp(`for s in [^;]*\\b${state}\\b`));
      expect(script).toContain('exit 41');
    },
  );

  it('refuses with 42 for unpushed commits that add LFS pointers, before bundling', () => {
    expect(script.indexOf('exit 42')).toBeLessThan(script.indexOf('git bundle create'));
    expect(script).toContain('grep -q "^+version https://git-lfs.github.com/spec/v1"');
  });

  it('sends filtered paths as raw bytes and keeps them out of both patches', () => {
    expect(script).toContain('git check-attr -z --stdin filter');
    expect(script).toContain('excl+=(":(exclude,literal)$p")');
    expect(script).toContain('tar -czf - --null --no-recursion -T "$d/filtered.list" | capped filtered.tgz');
    expect(script.match(/-- \. \$\{excl\[@\]\+"\$\{excl\[@\]\}"\}/g)).toHaveLength(2);
  });

  it('reads the staged changes from the real index and the rest from a /dev/shm copy with intent-to-add', () => {
    expect(script).toContain('GIT_INDEX_FILE="$real_index" git diff --cached --binary');
    expect(script).toContain('xargs -0 -r git add -N --');
    expect(script.indexOf('git add -N')).toBeLessThan(script.indexOf('git diff --binary --no-ext-diff --no-textconv --no-color --'));
  });

  it.each(MOVE_SKIP_DIRS.map((d) => [d]))('skips and counts the %s folder', (dir) => {
    expect(script).toContain(`*/${dir}/*`);
    expect(script).toContain(`-name ${dir} `);
  });

  it('counts the files of each skipped folder, and caps ignored files per file and in total', () => {
    expect(script).toContain(`printf 'SKIPDIR %s %s\\n'`);
    expect(script).toContain(`[ "$size" -gt ${MOVE_IGNORED_FILE_MAX_BYTES} ]`);
    expect(script).toContain(`-gt ${MOVE_IGNORED_TOTAL_MAX_BYTES} ]`);
    expect(script).toContain(`cap=${MOVE_TRANSFER_MAX_BYTES}`);
    expect(script).toContain('head -c $((cap + 1))');
    expect(MOVE_IGNORED_FILE_MAX_BYTES).toBe(MIB);
    expect(MOVE_IGNORED_TOTAL_MAX_BYTES).toBe(16 * MIB);
  });

  it('finds each conversation file where its agent keeps it, and drops an unsafe session id', () => {
    expect(script).toContain('-name 4f1c2b9e-1111-4222-8333-944455556666.jsonl ');
    expect(script).toContain(`"\${CODEX_HOME:-$HOME/.codex}/sessions" -type f -name '*0199aabb-ccdd-7eef-8000-112233445566*.jsonl'`);
    expect(script).not.toContain('rm -rf /');
  });

  it('ends the manifest with END, after everything else', () => {
    expect(script.trimEnd().endsWith('echo END')).toBe(true);
  });
});

const SHA64 = 'f'.repeat(64);
const HEAD = 'a'.repeat(40);
const good = [
  `HEAD ${HEAD}`,
  `BRANCH ${b64('feature/x')}`,
  'UPSTREAM ',
  `REF ${HEAD} refs/heads/feature/x origin/feature/x`,
  `REF ${'b'.repeat(40)} refs/heads/other`,
  `REF ${'c'.repeat(40)} refs/stash`,
  `REF ${'d'.repeat(40)} refs/talyn/checkpoints/chat-1/3`,
  `FILE repo.bundle 7 ${SHA64}`,
  `FILE staged.patch.gz 20 ${SHA64}`,
  `FILE unstaged.patch.gz 20 ${SHA64}`,
  `FILTERED_DELETED ${b64('uv.lock')}`,
  `SKIPDIR ${b64('web/node_modules')} 4000`,
  `MISSING_SESSION 4f1c2b9e-1111-4222-8333-944455556666`,
  'SKIPPED_COUNT 3',
  `SKIPPED ${b64('a b/.env.big')}`,
  'END',
];

function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}

describe('the manifest', () => {
  it('parses what the export prints', () => {
    expect(parseMoveManifest(good.join('\n'))).toEqual({
      head: HEAD,
      branch: 'feature/x',
      upstream: '',
      refs: [
        { name: 'refs/heads/feature/x', sha: HEAD, upstream: 'origin/feature/x' },
        { name: 'refs/heads/other', sha: 'b'.repeat(40), upstream: '' },
        { name: 'refs/stash', sha: 'c'.repeat(40), upstream: '' },
        { name: 'refs/talyn/checkpoints/chat-1/3', sha: 'd'.repeat(40), upstream: '' },
      ],
      files: [
        { name: 'repo.bundle', size: 7, sha256: SHA64 },
        { name: 'staged.patch.gz', size: 20, sha256: SHA64 },
        { name: 'unstaged.patch.gz', size: 20, sha256: SHA64 },
      ],
      filteredDeleted: ['uv.lock'],
      skipped: ['a b/.env.big'],
      skippedCount: 3,
      skippedDirs: [{ path: 'web/node_modules', files: 4000 }],
      missingSessions: ['4f1c2b9e-1111-4222-8333-944455556666'],
    });
  });

  const without = (prefix: string) => good.filter((l) => !l.startsWith(prefix));
  const replace = (prefix: string, line: string) => good.map((l) => (l.startsWith(prefix) ? line : l));
  it.each<[string, string[]]>([
    ['no END', good.slice(0, -1)],
    ['a line after END', [...good, 'HEAD x']],
    ['an unknown line', ['WHAT 1', ...good]],
    ['no HEAD', without('HEAD')],
    ['two HEADs', [good[0], ...good]],
    ['no BRANCH', without('BRANCH')],
    ['no SKIPPED_COUNT', without('SKIPPED_COUNT')],
    ['no staged patch', without('FILE staged.patch.gz')],
    ['no unstaged patch', without('FILE unstaged.patch.gz')],
    ['an unknown file', [...good.slice(0, -1), `FILE evil.sh 1 ${SHA64}`, 'END']],
    ['a negative size', replace('FILE repo.bundle', `FILE repo.bundle -1 ${SHA64}`)],
    ['a short checksum', replace('FILE repo.bundle', 'FILE repo.bundle 7 abc')],
    ['a file twice', [...good.slice(0, -1), `FILE repo.bundle 7 ${SHA64}`, 'END']],
    ['a ref outside the carried ones', [...good.slice(0, -1), `REF ${HEAD} refs/remotes/origin/main`, 'END']],
    ['a ref with a bad sha', [...good.slice(0, -1), `REF xyz refs/heads/y`, 'END']],
    ['a branch with no ref at HEAD', replace('REF ' + HEAD, `REF ${'e'.repeat(40)} refs/heads/feature/x`)],
    ['bad base64', replace('SKIPPED ', 'SKIPPED !!!')],
    ['a skipped folder with no count', replace('SKIPDIR', `SKIPDIR ${b64('x')}`)],
  ])('is null with %s', (_name, lines) => {
    expect(parseMoveManifest(lines.join('\n'))).toBeNull();
  });
});

describe('the import script', () => {
  const base = parseMoveManifest(good.join('\n'))!;
  const withFiles = (names: string[]) => ({
    ...base,
    files: names.map((name) => ({ name, size: 9, sha256: SHA64 })) as MoveManifest['files'],
  });

  it('checks every file, brings the commits in, puts every ref back, then applies in order', () => {
    const script = moveImportScript({
      workbenchId: WB,
      manifest: withFiles(['repo.bundle', 'staged.patch.gz', 'unstaged.patch.gz', 'filtered.tgz', 'ignored.tgz', 'agent.tgz']),
    });
    const order = [
      `[ "$(stat -c %s -- "$d/repo.bundle" 2>/dev/null)" = 9 ]`,
      'sha256sum -c --status',
      `sed -n '/^$/q; s/^-`,
      `git fetch --quiet --no-tags "$d/repo.bundle" '+refs/*:refs/talyn-import/*'`,
      `have ${HEAD} || exit 21`,
      'git checkout --quiet --detach',
      `git update-ref refs/heads/feature/x ${HEAD}`,
      `git update-ref refs/heads/other ${'b'.repeat(40)}`,
      `git update-ref refs/talyn/checkpoints/chat-1/3 ${'d'.repeat(40)}`,
      `git stash store -q -m 'Moved from the old sandbox' ${'c'.repeat(40)}`,
      'refs/talyn-import | while read -r r; do git update-ref -d "$r"; done',
      'git config branch.feature/x.remote origin && git config branch.feature/x.merge refs/heads/feature/x',
      'git config --unset branch.other.remote',
      'git checkout --quiet -f feature/x',
      'git apply --index --binary',
      'git apply --binary --whitespace=nowarn "$d/unstaged.patch"',
      'tar -xzf "$d/filtered.tgz" -C .',
      'rm -f -- uv.lock',
      'tar -xzf "$d/ignored.tgz" -C .',
      'tar -xzf "$d/agent.tgz" -C /',
    ];
    const positions = order.map((s) => script.indexOf(s));
    expect(positions.filter((p) => p < 0)).toEqual([]);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(script.match(/sha256sum -c/g)).toHaveLength(6);
    expect(script).not.toContain('git update-ref refs/stash');
  });

  it('fetches a missing commit at depth 1 only in a shallow repository', () => {
    const script = moveImportScript({ workbenchId: WB, manifest: base });
    expect(script).toContain('depth=; if [ "$(git rev-parse --is-shallow-repository)" = true ]; then depth=--depth=1; fi');
    expect(script).toContain('git fetch --quiet --no-tags $depth origin "$1"');
  });

  it('checks out HEAD detached when there was no branch', () => {
    const script = moveImportScript({ workbenchId: WB, manifest: { ...base, branch: '' } });
    expect(script).toContain(`git checkout --quiet -f --detach ${HEAD}`);
  });

  it('fetches the current branch upstream so status works', () => {
    const script = moveImportScript({ workbenchId: WB, manifest: { ...base, upstream: 'origin/feature/x' } });
    expect(script).toContain('git fetch --quiet --no-tags origin +refs/heads/feature/x:refs/remotes/origin/feature/x');
  });

  it('uses no bundle and no tar it was not given', () => {
    const script = moveImportScript({ workbenchId: WB, manifest: withFiles(['staged.patch.gz', 'unstaged.patch.gz']) });
    expect(script).not.toContain('repo.bundle');
    expect(script).not.toContain('tar ');
  });

  it('reads a chunk by byte offset', () => {
    expect(moveReadChunkScript('/dev/shm/x/agent.tgz', 2 * MIB, 5)).toBe(
      'dd if=/dev/shm/x/agent.tgz bs=1M iflag=skip_bytes,count_bytes skip=2097152 count=5 status=none',
    );
  });
});

describe('the chat note', () => {
  const manifest = { skipped: ['data/big.bin'], skippedCount: 12, skippedDirs: [
    { path: 'node_modules', files: 100 },
    { path: 'web/node_modules', files: 50 },
    { path: 'api/.venv', files: 7 },
  ] };

  it.each<['carried' | 'missing' | 'none', string | null, string[]]>([
    ['carried', 'This conversation came along', ['starts fresh']],
    ['missing', 'could not be found, so the agent starts fresh', ['came along, so the agent']],
    ['none', null, ['conversation']],
  ])('with the conversation %s', (conversation, present, absent) => {
    const text = movedNote({ reason: 'stale_golden', conversation, stopped: false, manifest });
    if (present) expect(text).toContain(present);
    for (const a of absent) expect(text).not.toContain(a);
  });

  it('names what it left behind', () => {
    expect(skippedNote(manifest)).toBe(
      'Not copied, because setup makes them again: node_modules (2 folders, 150 files), .venv (1 folder, 7 files). ' +
        'Ignored files too large to copy (12): data/big.bin and 11 more.',
    );
    expect(skippedNote({ skipped: [], skippedCount: 0, skippedDirs: [] })).toBeNull();
  });
});

describe('sandbox ids', () => {
  it.each<[string | null, Record<string, unknown>, string]>([
    ['talyn-wb-111111112222433384445555', {}, 'talyn-wb-111111112222433384445555-r1'],
    ['talyn-wb-111111112222433384445555-r2', {}, 'talyn-wb-111111112222433384445555-r3'],
    ['talyn-wb-111111112222433384445555', { moveSandboxId: 'talyn-wb-111111112222433384445555-r1' }, 'talyn-wb-111111112222433384445555-r2'],
    ['talyn-wb-111111112222433384445555-r4', { moveSandboxId: 'talyn-wb-111111112222433384445555-r1' }, 'talyn-wb-111111112222433384445555-r5'],
  ])('after %s with %o the next is %s', (sandboxId, settings, next) => {
    expect(nextSandboxId({ id: WB, sandboxId, settings: settings as never })).toBe(next);
  });
});

describe('failure text', () => {
  it.each<[string, boolean]>([
    ['ENOSPC: no space left on device, write', true],
    ['mktemp: failed to create file via template: No space left on device', true],
    ['Talyn Fleet refused the request: Out of diskspace', true],
    ['no space left', false],
    ['exit status 1', false],
    ['', false],
  ])('%j is a full disk: %s', (text, expected) => {
    expect(isDiskFullText(text)).toBe(expected);
  });

  it('finds a full disk in the cause chain, and by errno code', () => {
    expect(isDiskFullError(new Error('Failed query', { cause: new Error('No space left on device') }))).toBe(true);
    expect(isDiskFullError(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe(true);
    expect(isDiskFullError(new Error('boom'))).toBe(false);
  });

  it.each<[string, unknown, boolean]>([
    ['the reported vsock reset', new FleetHttpError(GUEST_RESET, 502), true],
    ['the bare string', GUEST_RESET, true],
    ['a dial to the vsock', new Error('exec: Post "http://guest/v1/exec": dial unix /fleet.vsock: connect: no such file'), true],
    ['a reset after output started', new Error('read tcp 10.0.0.1:443: connection reset by peer'), false],
    ['a broken follow stream', new Error('The sandbox capture is incomplete.'), false],
    ['a non-zero exit', new Error('checkpoint exited 1: fatal'), false],
    ['a capacity refusal', new Error('The sandbox runners are all busy.'), false],
  ])('%s is a guest that never started the command: %s', (_name, err, expected) => {
    expect(isGuestUnreachableBeforeStart(err)).toBe(expected);
  });
});

describe('disk probe and grow size', () => {
  it.each<[string, { availBytes: number; sizeBytes: number } | null]>([
    ['TALYN_DISK 1073741824  17179869184', { availBytes: GIB, sizeBytes: 16 * GIB }],
    ['warning: x\nTALYN_DISK 5 10\n', { availBytes: 5, sizeBytes: 10 }],
    ['nothing', null],
  ])('parses %j', (stderr, expected) => {
    expect(parseDiskProbe(stderr)).toEqual(expected);
  });

  it.each<[number, number | undefined, number | null]>([
    [GIB, 16384, 16384 + 7 * 1024],
    [0, undefined, 16384 + 8 * 1024],
    [GROW_TARGET_FREE_BYTES, 16384, null],
    // A repo golden larger than the record: the measured 16 GiB wins over the record's 4096.
    [GIB, 4096, 16384 + 7 * 1024],
  ])('with %d free on %s MiB grows to %s MiB', (avail, current, expected) => {
    expect(grownDiskMib({ availBytes: avail, sizeBytes: 16 * GIB }, current)).toBe(expected);
  });
});

describe('fleet feature detection', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  let calls: string[];

  beforeEach(() => {
    calls = [];
    resetFleetOptionalSupport();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setWorkbenchFleetClientForTests(null);
    setGuestRetryDelaysForTests(null);
  });

  it.each<[number, 'grown' | 'unsupported']>([
    [200, 'grown'],
    [404, 'unsupported'],
    [405, 'unsupported'],
    [501, 'unsupported'],
  ])('a grow answered %d is %s, and "unsupported" is learned once', async (status, expected) => {
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return status === 200 ? json({ diskMib: 20000 }) : json({ error: 'not found', message: 'no route' }, status);
    });
    const client = new FleetClient('https://fleet.test', 'tok');
    expect(await client.growSandboxDisk('sb', 20000)).toBe(expected);
    expect(await client.growSandboxDisk('sb', 20000)).toBe(expected);
    expect(calls).toHaveLength(expected === 'unsupported' ? 1 : 2);
    expect(calls[0]).toBe('https://fleet.test/v1/sandboxes/sb/disk');
  });

  it('throws on any other refusal of a grow', async () => {
    vi.stubGlobal('fetch', async () => json({ error: 'disk_too_large', message: 'too large' }, 400));
    await expect(new FleetClient('https://fleet.test', 'tok').growSandboxDisk('sb', 1)).rejects.toBeInstanceOf(FleetHttpError);
  });

  it('retries an exec the guest never started, up to three times', async () => {
    setGuestRetryDelaysForTests([0, 0, 0]);
    let failures = 2;
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (failures-- > 0) return json({ error: 'exec_failed', message: GUEST_RESET }, 502);
      return json({ events: [], cursor: 1, terminal: true });
    });
    setWorkbenchFleetClientForTests(async () => new FleetClient('https://fleet.test', 'tok'));
    const client = await fleetClientFor('ws');
    expect(await client.exec('sb', { cmd: ['x'] })).toEqual({ events: [], cursor: 1, terminal: true });
    expect(calls).toHaveLength(3);
  });

  it('surfaces the error after the third retry', async () => {
    setGuestRetryDelaysForTests([0, 0, 0]);
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return json({ error: 'exec_failed', message: GUEST_RESET }, 502);
    });
    setWorkbenchFleetClientForTests(async () => new FleetClient('https://fleet.test', 'tok'));
    const client = await fleetClientFor('ws');
    await expect(client.exec('sb', { cmd: ['x'] })).rejects.toThrow('read CONNECT reply');
    expect(calls).toHaveLength(4);
  });

  it('does not retry any other exec failure', async () => {
    setGuestRetryDelaysForTests([0, 0, 0]);
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      return json({ error: 'exec_failed', message: 'read: connection reset by peer' }, 502);
    });
    setWorkbenchFleetClientForTests(async () => new FleetClient('https://fleet.test', 'tok'));
    const client = await fleetClientFor('ws');
    await expect(client.exec('sb', { cmd: ['x'] })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('retries a follow that failed before its first frame', async () => {
    setGuestRetryDelaysForTests([0, 0, 0]);
    let failures = 1;
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (failures-- > 0) return json({ error: 'exec_failed', message: GUEST_RESET }, 502);
      return new Response(`data: ${JSON.stringify({ events: [], cursor: 1, terminal: true })}\n\n`, { status: 200 });
    });
    setWorkbenchFleetClientForTests(async () => new FleetClient('https://fleet.test', 'tok'));
    const client = await fleetClientFor('ws');
    const frames = [];
    for await (const frame of client.execFollow('sb', { cmd: ['x'] }, new AbortController().signal)) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});
