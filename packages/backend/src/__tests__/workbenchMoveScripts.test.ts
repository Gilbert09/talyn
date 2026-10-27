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
  moveReadChunkScript,
  moveRef,
  moveStagingDir,
  parseMoveManifest,
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
    // The only other files: the index copy, at the env's /dev/shm path.
    expect(script).toContain('cp -- "$real_index" "$GIT_INDEX_FILE"');
  });

  it('pushes HEAD to the hidden move ref, skipping hooks', () => {
    expect(moveRef(WB)).toBe(`refs/talyn/move/${WB}`);
    expect(script).toContain(`git push --no-verify --force --quiet origin "$head":refs/talyn/move/${WB} `);
  });

  it('reads the staged changes from the real index and the rest from a /dev/shm copy with intent-to-add', () => {
    expect(script).toContain('GIT_INDEX_FILE="$real_index" git diff --cached --binary');
    expect(script).toContain('xargs -0 -r git add -N --');
    expect(script.indexOf('git add -N')).toBeLessThan(script.indexOf('git diff --binary --no-ext-diff --no-textconv --no-color --'));
  });

  it.each(MOVE_SKIP_DIRS.map((d) => [d]))('skips the %s folder', (dir) => {
    expect(script).toContain(`*/${dir}/*`);
    expect(script).toContain(`-name ${dir} `);
  });

  it('caps ignored files per file and in total, and every staged file at the transfer cap', () => {
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
});

describe('the manifest', () => {
  const sha = 'f'.repeat(64);
  it('parses what the export prints', () => {
    const parsed = parseMoveManifest(
      [
        `HEAD ${'a'.repeat(40)}`,
        `BRANCH ${Buffer.from('feature/x').toString('base64')}`,
        'UPSTREAM ',
        `FILE staged.patch.gz 20 ${sha}`,
        `FILE agent.tgz 99 ${sha}`,
        `FILE evil.sh 1 ${sha}`,
        'FILE unstaged.patch.gz -1 abc',
        'SKIPPED_COUNT 3',
        `SKIPPED ${Buffer.from('a b/.env.big').toString('base64')}`,
        'MISSING_SESSION 4f1c',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      head: 'a'.repeat(40),
      branch: 'feature/x',
      upstream: '',
      files: [
        { name: 'staged.patch.gz', size: 20, sha256: sha },
        { name: 'agent.tgz', size: 99, sha256: sha },
      ],
      skipped: ['a b/.env.big'],
      skippedCount: 3,
      missingSessions: ['4f1c'],
    });
  });

  it('is null without a HEAD', () => {
    expect(parseMoveManifest('FILE agent.tgz 1 x')).toBeNull();
  });
});

describe('the import script', () => {
  const base: MoveManifest = {
    head: 'a'.repeat(40),
    branch: 'paris',
    upstream: 'origin/paris',
    files: [
      { name: 'staged.patch.gz', size: 1, sha256: '1'.repeat(64) },
      { name: 'unstaged.patch.gz', size: 1, sha256: '2'.repeat(64) },
      { name: 'ignored.tgz', size: 1, sha256: '3'.repeat(64) },
      { name: 'agent.tgz', size: 1, sha256: '4'.repeat(64) },
    ],
    skipped: [],
    skippedCount: 0,
    missingSessions: [],
  };

  it('checks every file, fetches the ref, then applies in order', () => {
    const script = moveImportScript({ workbenchId: WB, manifest: base });
    const order = [
      "sha256sum -c --status",
      `git fetch --no-tags --quiet origin refs/talyn/move/${WB} `,
      `git checkout --quiet -f -B paris ${'a'.repeat(40)} `,
      'git branch --quiet --set-upstream-to=origin/paris paris',
      'git apply --index --binary',
      'git apply --binary --whitespace=nowarn "$d/unstaged.patch"',
      'tar -xzf "$d/ignored.tgz" -C .',
      'tar -xzf "$d/agent.tgz" -C /',
    ];
    const positions = order.map((s) => script.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(script.match(/sha256sum -c/g)).toHaveLength(4);
  });

  it.each<[Partial<MoveManifest>, string, string]>([
    [{ upstream: '' }, 'git branch --unset-upstream paris', '--set-upstream-to'],
    [{ branch: '' }, '--detach', '-B'],
  ])('handles %o', (patch, present, absent) => {
    const script = moveImportScript({ workbenchId: WB, manifest: { ...base, ...patch } });
    expect(script).toContain(present);
    expect(script).not.toContain(absent);
  });

  it('skips a file the export did not make', () => {
    const script = moveImportScript({ workbenchId: WB, manifest: { ...base, files: [] } });
    expect(script).not.toContain('git apply');
    expect(script).not.toContain('tar ');
  });

  it('reads a chunk by byte offset', () => {
    expect(moveReadChunkScript('/dev/shm/x/agent.tgz', 2 * MIB, 5)).toBe(
      "dd if=/dev/shm/x/agent.tgz bs=1M iflag=skip_bytes,count_bytes skip=2097152 count=5 status=none",
    );
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
