import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchChanges } from '@talyn/shared';
import type { WorkbenchRow } from '../services/workbenches/store.js';

/**
 * The stored copy of a session's changes, end to end against a real
 * repository: the capture script runs as the box runs it, the backend reads
 * its objects out a part at a time into the memory store, and the read side
 * serves them back. Skipped on Windows, where `bash` can be WSL's.
 */

let current: WorkbenchRow;
/** Set when a case deletes the session: the store then answers as for a deleted row. */
let deleted = false;

vi.mock('../services/workbenches/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/store.js')>()),
  getWorkbench: vi.fn(async () => (deleted ? null : current)),
  updateWorkbench: vi.fn(async (_id: string, patch: Partial<WorkbenchRow>) => {
    if (deleted) return null;
    current = { ...current, ...patch };
    return current;
  }),
}));
vi.mock('../services/workbenches/emit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/emit.js')>()),
  emitWorkbenchUpdated: vi.fn(async () => undefined),
}));
vi.mock('../services/workbenches/prLink.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/prLink.js')>()),
  publicWorkbench: vi.fn(async (row: WorkbenchRow) => row),
}));
vi.mock('../services/workbenches/changes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/changes.js')>()),
  // As the real one does: it stores the list, which takes the changes lock (a capture must not hold it meanwhile).
  storeDiffStat: vi.fn(async (row: WorkbenchRow, changes: WorkbenchChanges) => {
    const { noteListRead } = await import('../services/workbenches/changesStore.js');
    await noteListRead(row, changes);
    return row;
  }),
}));
vi.mock('../services/workbenches/sandboxRuntime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/workbenches/sandboxRuntime.js')>()),
  recordWorkbenchEvent: vi.fn(),
}));

const { captureChanges, patchIndex, setCaptureRunnerForTests, setCaptureLimitsForTests, CAPTURE_PART_BYTES } = await import('../services/workbenches/changesCapture.js');
const {
  changesCaptureScript,
  parseCaptureOutput,
  contentsEntries,
  parseCapturedContents,
  parseListSections,
  captureReadChunkScript,
} = await import('../services/workbenches/changesCaptureScript.js');
const store_ = await import('../services/workbenches/changesStore.js');
const { changesMetaKey, changesPrefix, listsKey, noteListRead, readChangesMeta, resetChangesStoreForTests } = store_;
const { slicePatch, storedChanges, storedFile, storedFileList, storedPatch, storedPreviewPatch, stripBinaryBodies, resetChangesStoredForTests } =
  await import('../services/workbenches/changesStored.js');
const { getChanges, parseChangeLists, CHANGE_LIST_SECTIONS } = await import('../services/workbenches/changes.js');
const { memoryWorkObjectStore, setWorkObjectStoreForTests } = await import('../services/workbenches/workStorage.js');
const { emitWorkbenchUpdated } = await import('../services/workbenches/emit.js');
const { storeDiffStat } = await import('../services/workbenches/changes.js');

const WB = 'wb-cap-1111';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3, 0, 255]);

describe.skipIf(process.platform === 'win32')('the stored changes of a real repository', () => {
  let root: string;
  let box: string;
  let tmp: string;
  let store: ReturnType<typeof memoryWorkObjectStore>;
  let execs: string[];

  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    ...extra,
  });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: env() }).trim();
  const write = (path: string, body: string | Buffer) => {
    mkdirSync(join(box, path, '..'), { recursive: true });
    writeFileSync(join(box, path), body);
  };
  const commit = (message: string) => {
    git(box, 'add', '-A');
    git(box, 'commit', '-q', '--no-verify', '-m', message);
  };

  /** Run a script as the box does: bash, in the repository, or in `/` for a part read. */
  /** What the fleet says of the box when a cleanup asks. */
  let boxRuns = true;
  const runner = {
    get tmpDir() { return tmp; },
    isRunning: vi.fn(async () => boxRuns),
    run: async (_row: WorkbenchRow, script: string, opts: { cwd?: string; env?: Record<string, string> }) => {
      execs.push(script);
      const r = spawnSync('bash', ['-c', script], { cwd: opts.cwd ?? box, env: env(opts.env), maxBuffer: 256 * 1024 * 1024 });
      const stdoutBytes = r.stdout ?? Buffer.alloc(0);
      return { exitCode: r.status ?? 1, stdout: stdoutBytes.toString('utf8'), stdoutBytes, stderr: (r.stderr ?? Buffer.alloc(0)).toString('utf8') };
    },
  };

  const row = (extra: Partial<WorkbenchRow> = {}): WorkbenchRow => ({
    id: WB, workspaceId: 'ws-1', runtime: 'sandbox', kind: 'session', sandboxId: 'box-1', sandboxState: 'running',
    status: 'ready', baseBranch: 'main', branch: 'feat', repoFullName: 'acme/app', fleetHost: null, archivedAt: null,
    pullRequestId: null, pushedHeadShas: [], changesAt: null, changesEtag: null,
    ...extra,
  } as WorkbenchRow);

  const keys = () => [...store.objects.keys()].sort();
  const capture = async (r: WorkbenchRow = current) => {
    current = r;
    return captureChanges(r, 'test');
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'talyn-capture-'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    const dir = mkdtempSync(join(root, 'case-'));
    const origin = join(dir, 'origin.git');
    box = join(dir, 'box');
    tmp = join(dir, 'tmp');
    mkdirSync(tmp);
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(dir, 'clone', '-q', origin, box);
    git(box, 'checkout', '-q', '-b', 'main');
    write('a.txt', 'one\ntwo\nthree\n');
    write('b.txt', 'bee\n');
    write('old-name.txt', 'renamed content\nline 2\nline 3\n');
    write('gone.txt', 'to be deleted\n');
    write('same.txt', 'never changes\n');
    commit('base');
    git(box, 'push', '-q', 'origin', 'main');
    git(box, 'checkout', '-q', '-b', 'feat');
    // Committed on the branch: a change, a rename and a delete.
    write('a.txt', 'one\nTWO\nthree\n');
    git(box, 'mv', 'old-name.txt', 'new-name.txt');
    git(box, 'rm', '-q', 'gone.txt');
    commit('work');
    // Uncommitted: a change, an untracked text file and an untracked binary.
    write('b.txt', 'bee\nsting\n');
    write('dir/untracked.txt', 'fresh\n');
    write('img.png', PNG);
    store = memoryWorkObjectStore();
    setWorkObjectStoreForTests(store);
    setCaptureRunnerForTests(runner);
    resetChangesStoreForTests();
    resetChangesStoredForTests();
    execs = [];
    current = row();
    deleted = false;
    boxRuns = true;
    runner.isRunning.mockClear();
  });

  afterEach(() => {
    if (vi.isMockFunction(runner.run)) vi.mocked(runner.run).mockRestore();
    setWorkObjectStoreForTests(null);
    setCaptureRunnerForTests(null);
    setCaptureLimitsForTests(null);
    vi.mocked(emitWorkbenchUpdated).mockClear();
  });

  it('stores the list, three patches, the file list and the changed contents', async () => {
    const outcome = await capture();
    expect(outcome.kind).toBe('captured');
    if (outcome.kind !== 'captured') return;
    const { meta, changes } = outcome;
    expect(Object.keys(meta.objects).sort()).toEqual(['contents', 'files', 'patch', 'patch-committed', 'patch-uncommitted']);
    expect(meta).toMatchObject({ version: 2, sandboxId: 'box-1', headSha: git(box, 'rev-parse', 'HEAD'), mergeBase: git(box, 'rev-parse', 'main') });
    expect(meta.etag).toMatch(/^[0-9a-f]{16}$/);
    // The list is what a live read of the same work gives.
    expect(changes.files.map((f) => [f.path, f.status]).sort()).toEqual([
      ['a.txt', 'modified'], ['b.txt', 'modified'], ['dir/untracked.txt', 'added'], ['gone.txt', 'deleted'],
      ['img.png', 'added'], ['new-name.txt', 'renamed'],
    ]);
    expect(changes.uncommitted?.map((f) => f.path).sort()).toEqual(['b.txt', 'dir/untracked.txt', 'img.png']);
    expect(changes.committed?.map((f) => f.path).sort()).toEqual(['a.txt', 'gone.txt', 'new-name.txt']);
    // The row learns of the copy, and the clients are told.
    expect(current).toMatchObject({ changesEtag: meta.etag });
    expect(emitWorkbenchUpdated).toHaveBeenCalledTimes(1);
    // Nothing is left in tmpfs, and the real index is untouched.
    expect(spawnSync('ls', ['-A', tmp], { encoding: 'utf8' }).stdout.trim()).toBe('');
    expect(git(box, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('answers the list while the box sleeps, with what the copy holds', async () => {
    await capture();
    const answer = await storedChanges(current, 'asleep');
    expect(answer).toMatchObject({
      source: 'stored', storedReason: 'asleep', etag: current.changesEtag, sandboxId: 'box-1',
      patch: { available: true }, fileList: { available: true },
    });
    expect(answer?.stale).toBeUndefined();
    expect(answer?.files).toHaveLength(6);
  });

  it.each([
    ['combined', ['a.txt', 'b.txt', 'dir/untracked.txt', 'gone.txt', 'img.png', 'new-name.txt']],
    ['uncommitted', ['b.txt', 'dir/untracked.txt', 'img.png']],
    ['committed', ['a.txt', 'gone.txt', 'new-name.txt']],
  ] as const)('serves the %s patch', async (scope, paths) => {
    await capture();
    const answer = await storedPatch(current, scope, undefined);
    if (!answer || 'tooLarge' in answer) throw new Error('no patch');
    const headers = [...answer.patch.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]).sort();
    expect(headers).toEqual([...paths]);
    expect(answer.source).toBe('stored');
  });

  it.each([
    ['b.txt', /\+sting/],
    ['dir/untracked.txt', /new file mode[\s\S]*\+fresh/],
    ['new-name.txt', /rename from old-name\.txt\nrename to new-name\.txt/],
    ['old-name.txt', /rename from old-name\.txt/],
    ['gone.txt', /deleted file mode/],
  ])('slices the patch of one file: %s', async (path, pattern) => {
    await capture();
    const answer = await storedPatch(current, 'combined', path);
    if (!answer || 'tooLarge' in answer) throw new Error('no patch');
    expect(answer.patch).toMatch(pattern);
    expect(answer.patch.match(/^diff --git /gm)).toHaveLength(1);
  });

  it('shows a binary file as one line in the viewer, and keeps its body for the preview sync', async () => {
    await capture();
    const view = await storedPatch(current, 'combined', 'img.png');
    if (!view || 'tooLarge' in view) throw new Error('no patch');
    expect(view.patch).toContain('Binary files /dev/null and b/img.png differ');
    expect(view.patch).not.toContain('GIT binary patch');
    const sync = await storedPreviewPatch(current);
    expect(sync?.base).toBe(git(box, 'rev-parse', 'main'));
    expect(sync?.patch).toContain('GIT binary patch');
  });

  it('the stored patch applies to the merge base and gives the work tree', async () => {
    await capture();
    const sync = await storedPreviewPatch(current);
    const check = join(root, `apply-${Math.random().toString(36).slice(2)}`);
    git(root, 'clone', '-q', join(box, '..', 'origin.git'), check);
    writeFileSync(join(check, 'p.diff'), sync!.patch);
    git(check, 'apply', '--binary', 'p.diff');
    rmSync(join(check, 'p.diff'));
    for (const path of ['a.txt', 'b.txt', 'dir/untracked.txt', 'new-name.txt']) {
      expect(execFileSync('cat', [join(check, path)], { encoding: 'utf8' })).toBe(execFileSync('cat', [join(box, path)], { encoding: 'utf8' }));
    }
    expect(execFileSync('cmp', [join(check, 'img.png'), join(box, 'img.png')]).length).toBe(0);
  });

  it('lists every file of the work tree, untracked ones included and deleted ones not', async () => {
    write('ignored.log', 'x\n');
    write('.gitignore', '*.log\n');
    await capture();
    const list = await storedFileList(current);
    expect(list?.paths.sort()).toEqual(['.gitignore', 'a.txt', 'b.txt', 'dir/untracked.txt', 'img.png', 'new-name.txt', 'same.txt']);
    expect(list?.source).toBe('stored');
  });

  it.each([
    ['a changed text file', 'b.txt', { kind: 'file', file: { content: 'bee\nsting\n', binary: false, source: 'stored' } }],
    ['an untracked file', 'dir/untracked.txt', { kind: 'file', file: { content: 'fresh\n', binary: false } }],
    ['a binary file', 'img.png', { kind: 'file', file: { content: PNG.toString('base64'), binary: true } }],
    ['a file the session did not change', 'same.txt', { kind: 'unchanged', known: true }],
    ['a deleted file', 'gone.txt', { kind: 'deleted' }],
    ['the old path of a renamed file', 'old-name.txt', { kind: 'deleted' }],
    ['a file that never was', 'nope.txt', { kind: 'missing' }],
  ])('answers %s', async (_name, path, expected) => {
    await capture();
    expect(await storedFile(current, path)).toMatchObject(expected);
  });

  it('lists a changed file over the per-file cap without its content', async () => {
    write('big.txt', 'x'.repeat(1024 * 1024 + 10));
    await capture();
    expect(await storedFile(current, 'big.txt')).toEqual({ kind: 'not_stored', size: 1024 * 1024 + 10 });
    expect(await storedFile(current, 'b.txt')).toMatchObject({ kind: 'file' });
  });

  describe('with no stored file list', () => {
    const dropFileList = async () => {
      const meta = await readChangesMeta(current, { fresh: true });
      if (!meta) throw new Error('no meta');
      delete meta.objects.files;
      await store_.writeChangesMeta(current, meta);
      resetChangesStoredForTests();
    };

    it.each([
      ['a deleted file', 'gone.txt', { kind: 'deleted' }],
      ['the old path of a renamed file', 'old-name.txt', { kind: 'deleted' }],
      ['a changed file', 'b.txt', { kind: 'file' }],
      ['a file the lists show as not changed', 'same.txt', { kind: 'unchanged', known: false }],
      ['a file the lists do not name', 'nope.txt', { kind: 'unchanged', known: false }],
    ])('answers %s from the changes list', async (_name, path, expected) => {
      await capture();
      await dropFileList();
      expect(await storedFile(current, path)).toMatchObject(expected);
    });

    it.each(['gone.txt', 'same.txt'])('cannot say anything of %s when the changes list is unreadable', async (path) => {
      const outcome = await capture();
      if (outcome.kind !== 'captured') throw new Error(outcome.kind);
      await dropFileList();
      store.objects.delete(store_.listsKeyOf(current, outcome.meta.generation));
      resetChangesStoreForTests();
      expect(await storedFile(current, path)).toEqual({ kind: 'unknown' });
    });
  });

  it.each([
    ['the box still runs', true],
    ['the box went to sleep', false],
  ])('cleans the staging after the capture exec throws when %s', async (_name, runs, ) => {
    boxRuns = runs;
    const real = runner.run;
    vi.spyOn(runner, 'run').mockImplementation(async (r, script, opts) => {
      const answer = await real(r, script, opts);
      if (script.includes('echo "CAPTURE')) throw new Error('the exec timed out');
      return answer;
    });
    expect(await capture()).toMatchObject({ kind: 'failed', detail: expect.stringContaining('timed out') });
    expect(runner.isRunning).toHaveBeenCalledTimes(1);
    const cleanups = execs.filter((e) => e.startsWith('rm -rf --'));
    expect(cleanups).toHaveLength(runs ? 1 : 0);
    expect(spawnSync('ls', ['-A', tmp], { encoding: 'utf8' }).stdout.trim() === '').toBe(runs);
    expect(store.objects.has(changesMetaKey(current))).toBe(false);
  });

  it('cleans the staging without asking the fleet after a capture that failed on the box', async () => {
    const real = runner.run;
    vi.spyOn(runner, 'run').mockImplementation(async (r, script, opts) => {
      const answer = await real(r, script, opts);
      return script.includes('echo "CAPTURE') ? { ...answer, exitCode: 1, stderr: 'disk full' } : answer;
    });
    expect(await capture()).toMatchObject({ kind: 'failed' });
    expect(runner.isRunning).not.toHaveBeenCalled();
    expect(execs.filter((e) => e.startsWith('rm -rf --'))).toHaveLength(1);
  });

  it.each([
    ['with no copy before it', false],
    ['over an older copy', true],
  ])('removes the parts it uploaded when a capture fails half-way, %s', async (_name, withPrevious) => {
    const first = withPrevious ? await capture() : null;
    if (first && first.kind !== 'captured') throw new Error(first.kind);
    write('b.txt', 'moved on\n');
    const real = runner.run;
    vi.spyOn(runner, 'run').mockImplementation(async (r, script, opts) => {
      if (script.startsWith('tail -c') && script.includes('/files.gz')) throw new Error('the box went away');
      return real(r, script, opts);
    });
    expect(await capture()).toMatchObject({ kind: 'failed' });
    const generations = new Set(keys().filter((k) => k.startsWith(`${changesPrefix(current)}/`) && k.split('/').length > 4).map((k) => k.split('/')[3]));
    expect([...generations]).toEqual(first?.kind === 'captured' ? [first.meta.generation] : []);
    expect((await readChangesMeta(current, { fresh: true }))?.generation).toBe(first?.kind === 'captured' ? first.meta.generation : undefined);
  });

  it.each([
    ['while its parts are read', 'parts'],
    ['while the new copy is announced', 'announce'],
  ] as const)('puts nothing back for a session deleted %s', async (_name, when) => {
    const real = runner.run;
    if (when === 'parts') {
      vi.spyOn(runner, 'run').mockImplementation(async (r, script, opts) => {
        if (script.startsWith('tail -c') && script.includes('/lists.gz')) deleted = true;
        return real(r, script, opts);
      });
    } else {
      const { updateWorkbench } = await import('../services/workbenches/store.js');
      vi.mocked(updateWorkbench).mockImplementationOnce(async () => {
        deleted = true;
        return null;
      });
    }
    expect(await capture()).toEqual({ kind: 'skipped', reason: 'the session was deleted' });
    expect(keys().filter((k) => k.startsWith(changesPrefix(current)))).toEqual([]);
  });

  it('announces the new copy before it deletes the old one', async () => {
    const first = await capture();
    if (first.kind !== 'captured') throw new Error(first.kind);
    write('b.txt', 'next\n');
    const seen: boolean[] = [];
    vi.mocked(emitWorkbenchUpdated).mockImplementationOnce(async () => {
      seen.push(keys().some((k) => k.includes(`/${first.meta.generation}/`)));
    });
    const second = await capture();
    if (second.kind !== 'captured') throw new Error(second.kind);
    expect(seen).toEqual([true]);
    expect(keys().some((k) => k.includes(`/${first.meta.generation}/`))).toBe(false);
  });

  it('passes the time it read the box to the diff stat, so a newer stored list is kept', async () => {
    const before = Date.now();
    const outcome = await capture();
    if (outcome.kind !== 'captured') throw new Error(outcome.kind);
    const call = vi.mocked(storeDiffStat).mock.calls.at(-1);
    const observedAt = call?.[2]?.observedAt;
    expect(observedAt).toBeInstanceOf(Date);
    expect(observedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(observedAt!.getTime()).toBeLessThanOrEqual(Date.parse(outcome.meta.takenAt));
  });

  it.each([
    ['an older stored list', -60_000, true],
    ['no stored list', null, true],
    ['a newer stored list', 60_000, false],
  ] as const)('a capture writes its list over %s only when it is newer', async (_name, offset, writes) => {
    const actual = await vi.importActual<typeof import('../services/workbenches/changes.js')>('../services/workbenches/changes.js');
    const { readChangesSnapshot, resetChangesSnapshotsForTests, changesSnapshotKey } = await import('../services/workbenches/changesSnapshot.js');
    const { updateWorkbench } = await import('../services/workbenches/store.js');
    resetChangesSnapshotsForTests();
    const observedAt = new Date('2099-01-01T10:00:00Z');
    const newer = { files: [], base: 'b'.repeat(40), headSha: 'n'.repeat(40) } as unknown as WorkbenchChanges;
    if (offset !== null) {
      store.objects.set(changesSnapshotKey(current), Buffer.from(JSON.stringify({
        version: 1, takenAt: new Date(observedAt.getTime() + offset).toISOString(), changes: newer,
      })));
    }
    vi.mocked(updateWorkbench).mockClear();
    const older = {
      files: [{ path: 'a.txt', status: 'modified', added: 1, removed: 1, binary: false }],
      base: 'b'.repeat(40), headSha: 'o'.repeat(40),
      uncommittedStats: { added: 1, removed: 1, files: 1 }, committedStats: { added: 0, removed: 0, files: 0 },
    } as unknown as WorkbenchChanges;
    await actual.storeDiffStat(current, older, { observedAt });
    const stored = await readChangesSnapshot(current);
    expect(stored?.headSha).toBe(writes ? 'o'.repeat(40) : 'n'.repeat(40));
    expect(vi.mocked(updateWorkbench).mock.calls.length > 0).toBe(writes);
    if (writes) expect(stored?.snapshotAt).toBe(observedAt.toISOString());
  });

  it('marks a patch over its cap TOO_LARGE and stores the rest', async () => {
    setCaptureLimitsForTests({ maxPatchBytes: 200 });
    const outcome = await capture();
    if (outcome.kind !== 'captured') throw new Error(outcome.kind);
    expect(outcome.meta.objects.patch).toEqual({ tooLarge: 201 });
    expect(await storedPatch(current, 'combined', undefined)).toEqual({ tooLarge: true });
    expect(await storedChanges(current, 'asleep')).toMatchObject({ patch: { available: false, tooLarge: true } });
    expect(await storedFile(current, 'b.txt')).toMatchObject({ kind: 'file' });
  });

  it('reads a large object out in several parts and checks it', async () => {
    // Random bytes do not compress, so the contents object is over one part.
    for (let i = 0; i < 3; i++) write(`noise-${i}.bin`, Buffer.concat([Buffer.from([0]), randomBytes(900 * 1024)]));
    const outcome = await capture();
    if (outcome.kind !== 'captured') throw new Error(outcome.kind);
    const contents = outcome.meta.objects.contents;
    expect(contents && 'parts' in contents ? contents.parts : 0).toBeGreaterThan(1);
    expect(contents && 'bytes' in contents ? contents.bytes : 0).toBeGreaterThan(CAPTURE_PART_BYTES);
    expect(await storedFile(current, 'noise-2.bin')).toMatchObject({ kind: 'file', file: { binary: true } });
  });

  it('says UNCHANGED for the same work and reads nothing out', async () => {
    const first = await capture();
    const before = keys();
    execs = [];
    const second = await capture({ ...current });
    expect(second.kind).toBe('unchanged');
    expect(execs).toHaveLength(1);
    expect(keys()).toEqual(before);
    expect(first.kind === 'captured' && second.kind === 'unchanged' && second.meta.etag === first.meta.etag).toBe(true);
  });

  it('swaps the generation when the work moves, and deletes the old one', async () => {
    const first = await capture();
    if (first.kind !== 'captured') throw new Error(first.kind);
    write('b.txt', 'bee\nsting\nagain\n');
    const second = await capture();
    if (second.kind !== 'captured') throw new Error(second.kind);
    expect(second.meta.generation).not.toBe(first.meta.generation);
    expect(second.meta.etag).not.toBe(first.meta.etag);
    expect(keys().some((k) => k.includes(`/${first.meta.generation}/`))).toBe(false);
    expect(keys().filter((k) => k.includes(`/${second.meta.generation}/`)).length).toBeGreaterThan(5);
    const b = await storedPatch(current, 'combined', 'b.txt');
    expect(b && 'patch' in b ? b.patch : '').toContain('+again');
  });

  it('on another box with the same work, keeps the copy and changes only its sandbox and etag', async () => {
    const first = await capture();
    if (first.kind !== 'captured') throw new Error(first.kind);
    const before = keys();
    const moved = await capture({ ...current, sandboxId: 'box-2' });
    expect(moved.kind).toBe('unchanged');
    const meta = await readChangesMeta(current, { fresh: true });
    expect(meta).toMatchObject({ sandboxId: 'box-2', generation: first.meta.generation });
    expect(meta?.etag).not.toBe(first.meta.etag);
    expect(current.changesEtag).toBe(meta?.etag);
    expect(keys()).toEqual(before);
  });

  it('says the copy is from a replaced box until the next capture', async () => {
    await capture();
    current = { ...current, sandboxId: 'box-3' };
    expect((await storedChanges(current, 'asleep'))?.stale).toBe('sandbox_replaced');
  });

  it('says the copy is stale when the row stat is newer than the copy, and not when they agree', async () => {
    const first = await capture();
    if (first.kind !== 'captured') throw new Error(first.kind);
    const stat = (files: number) => ({ added: files, removed: 0, files });
    current = { ...current, diffStat: { ...first.changes.uncommittedStats!, uncommittedStats: first.changes.uncommittedStats!, committedStats: first.changes.committedStats! } };
    expect((await storedChanges(current, 'asleep'))?.stale).toBeUndefined();
    current = { ...current, diffStat: { ...stat(0), uncommittedStats: stat(0), committedStats: stat(first.changes.committedStats!.files + 2) } };
    expect((await storedChanges(current, 'asleep'))?.stale).toBe('list_newer');
    current = { ...current, diffStat: null };
    expect((await storedChanges(current, 'asleep'))?.stale).toBeUndefined();
  });

  it('captures again after the work moved, and moves changes_at (a capture never holds the lock its diff-stat write needs)', async () => {
    const first = await Promise.race([capture(), new Promise((r) => setTimeout(() => r('hung'), 5000))]);
    expect(first).toMatchObject({ kind: 'captured' });
    const at = current.changesAt;
    write('later.txt', 'committed after the first copy\n');
    commit('later');
    await new Promise((r) => setTimeout(r, 15));
    const second = await Promise.race([capture(), new Promise((r) => setTimeout(() => r('hung'), 5000))]);
    expect(second).toMatchObject({ kind: 'captured' });
    expect(current.changesAt!.getTime()).toBeGreaterThan(at!.getTime());
  }, 20_000);

  it('stops serving the patches when a later list read found other changes, and serves them again after a capture', async () => {
    const first = await capture();
    if (first.kind !== 'captured') throw new Error(first.kind);
    const moved: WorkbenchChanges = { ...first.changes, files: [...first.changes.files, { path: 'z.txt', status: 'added', added: 1, removed: 0, binary: false }] };
    await noteListRead(current, moved);
    expect((await readChangesMeta(current, { fresh: true }))?.listNewer).toBeTruthy();
    expect(await storedPatch(current, 'combined', undefined)).toBeNull();
    // The same list again is no news.
    await noteListRead(current, first.changes);
    expect(await capture()).toMatchObject({ kind: 'unchanged' });
    expect((await readChangesMeta(current, { fresh: true }))?.listNewer).toBeUndefined();
    expect(await storedPatch(current, 'combined', undefined)).not.toBeNull();
  });

  it('a list read of unchanged work does not mark the copy', async () => {
    const first = await capture();
    if (first.kind !== 'captured') throw new Error(first.kind);
    await noteListRead(current, first.changes);
    expect((await readChangesMeta(current, { fresh: true }))?.listNewer).toBeUndefined();
  });

  it('produces the same list as the live read script', async () => {
    const first = await capture();
    if (first.kind !== 'captured') throw new Error(first.kind);
    // The live read's sections, run with the same shell functions.
    const script = [
      `mb=${git(box, 'rev-parse', 'main')}`,
      'head=$(git rev-parse HEAD)',
      ...CHANGE_LIST_SECTIONS.map((s) => `{ ${s.command} ; } > "$OUT/${s.label}" 2>/dev/null`),
    ].join('\n');
    const out = join(root, `live-${Math.random().toString(36).slice(2)}`);
    mkdirSync(out);
    spawnSync('bash', ['-c', script], { cwd: box, env: env({ OUT: out }) });
    const sections: Record<string, string> = { MB: git(box, 'rev-parse', 'main'), HEAD: git(box, 'rev-parse', 'HEAD') };
    for (const s of CHANGE_LIST_SECTIONS) sections[s.label] = execFileSync('cat', [join(out, s.label)], { encoding: 'utf8' });
    expect(listsKey(parseChangeLists(sections))).toBe(first.meta.listsKey);
    void getChanges;
  });

  it('skips a thread, a box that is not ready and a session with no box', async () => {
    for (const r of [row({ kind: 'thread' }), row({ status: 'provisioning' }), row({ sandboxId: null }), row({ runtime: 'local' })]) {
      expect((await captureChanges(r, 'test')).kind).toBe('skipped');
    }
    expect(execs).toEqual([]);
  });

  it('skips when storage is not configured, without running anything on the box', async () => {
    setWorkObjectStoreForTests(null);
    expect(await captureChanges(current, 'test')).toEqual({ kind: 'skipped', reason: 'storage is not configured' });
    expect(execs).toEqual([]);
  });

  it('fails and stores nothing when the box cannot capture', async () => {
    rmSync(join(box, '.git'), { recursive: true, force: true });
    const outcome = await capture();
    expect(outcome.kind).toBe('failed');
    expect(store.objects.has(changesMetaKey(current))).toBe(false);
  });

  it('fails and keeps the old copy when a part does not match its checksum', async () => {
    const first = await capture();
    if (first.kind !== 'captured') throw new Error(first.kind);
    write('b.txt', 'changed again\n');
    const real = runner.run;
    vi.spyOn(runner, 'run').mockImplementation(async (r, script, opts) => {
      const answer = await real(r, script, opts);
      if (script.startsWith('tail -c') && script.includes('/patch.gz')) answer.stdoutBytes = Buffer.from(answer.stdoutBytes).fill(1);
      return answer;
    });
    const outcome = await capture();
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect((await readChangesMeta(current, { fresh: true }))?.generation).toBe(first.meta.generation);
    expect(spawnSync('ls', ['-A', tmp], { encoding: 'utf8' }).stdout.trim()).toBe('');
  });

  it('deletes every stored object with the session', async () => {
    await capture();
    expect(keys().length).toBeGreaterThan(0);
    await store_.deleteAllChanges(current);
    expect(keys().filter((k) => k.startsWith(changesPrefix(current)))).toEqual([]);
  });

  it('the part reader returns exact byte ranges', () => {
    const file = join(root, 'chunk.bin');
    writeFileSync(file, Buffer.from('0123456789'));
    const read = (offset: number, length: number) =>
      spawnSync('bash', ['-c', captureReadChunkScript(file, offset, length)]).stdout.toString();
    expect([read(0, 4), read(4, 4), read(8, 4)]).toEqual(['0123', '4567', '89']);
  });

  it('a script with a previous capture prints UNCHANGED from the shell alone', () => {
    const mb = git(box, 'rev-parse', 'main');
    const head = git(box, 'rev-parse', 'HEAD');
    const first = parseCaptureOutput(runSync(changesCaptureScript({ id: WB, baseBranch: 'main' })));
    if (first.kind !== 'capture') throw new Error(first.kind);
    const again = parseCaptureOutput(runSync(changesCaptureScript({ id: WB, baseBranch: 'main' }, {
      previous: { mergeBase: mb, headSha: head, treeSha: first.treeSha },
    })));
    expect(again).toEqual({ kind: 'unchanged', mergeBase: mb, headSha: head, treeSha: first.treeSha });
  });

  function runSync(script: string) {
    const r = spawnSync('bash', ['-c', script], { cwd: box, env: env({ TMPDIR: tmp }), encoding: 'utf8' });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  }
});

describe('the capture parsers', () => {
  it.each([
    ['a failed exit', { exitCode: 1, stdout: '', stderr: 'boom' }, { kind: 'failed', detail: 'boom' }],
    ['no manifest', { exitCode: 0, stdout: 'hello', stderr: '' }, { kind: 'failed', detail: 'the capture printed no manifest' }],
    ['an unknown line', { exitCode: 0, stdout: `CAPTURE ${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)}\nWAT`, stderr: '' }, { kind: 'failed' }],
    ['no lists', { exitCode: 0, stdout: `CAPTURE ${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)}`, stderr: '' }, { kind: 'failed', detail: 'the capture staged no lists' }],
  ])('refuses %s', (_name, r, expected) => {
    expect(parseCaptureOutput(r)).toMatchObject(expected);
  });

  it('reads objects and over-cap sections', () => {
    const sha = 'f'.repeat(64);
    const out = parseCaptureOutput({
      exitCode: 0,
      stderr: '',
      stdout: [`CAPTURE ${'a'.repeat(40)} ${'b'.repeat(40)} ${'c'.repeat(40)}`, `OBJ patch 10 ${sha} 30`, 'TOO_LARGE files 99', `OBJ lists 5 ${sha} 9`].join('\n'),
    });
    expect(out).toEqual({
      kind: 'capture', mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40), treeSha: 'c'.repeat(40),
      objects: [{ name: 'patch', bytes: 10, sha256: sha, raw: 30 }, { name: 'lists', bytes: 5, sha256: sha, raw: 9 }],
      tooLarge: [{ name: 'files', raw: 99 }],
    });
  });

  it('reads length-prefixed list sections, with NULs and newlines inside', () => {
    const body = Buffer.concat([Buffer.from('NAMES 6\n'), Buffer.from('M\0a\nb\0'), Buffer.from('MB 3\nabc')]);
    const sections = parseListSections(body);
    expect(sections.NAMES.toString()).toBe('M\0a\nb\0');
    expect(sections.MB.toString()).toBe('abc');
    expect(() => parseListSections(Buffer.from('NAMES 9\nshort'))).toThrow();
  });

  it('reads stored contents, kept and not kept, in the batch order', () => {
    const sha = 'a'.repeat(40);
    const entries = contentsEntries(Buffer.from('a.txt\0big\0z\0'), '1 3 blob\n0 999 blob\n1 2 blob\n');
    expect(entries).toEqual([
      { path: 'a.txt', size: 3, stored: true },
      { path: 'big', size: 999, stored: false },
      { path: 'z', size: 2, stored: true },
    ]);
    const body = Buffer.concat([Buffer.from(`${sha} blob 3\nxyz\n`), Buffer.from(`${sha} blob 2\n\0\x01\n`)]);
    const files = parseCapturedContents(body, entries);
    expect(files.get('a.txt')).toEqual({ path: 'a.txt', size: 3, content: Buffer.from('xyz') });
    expect(files.get('big')).toEqual({ path: 'big', size: 999, content: null });
    expect(files.get('z')?.content).toEqual(Buffer.from([0, 1]));
    expect(() => contentsEntries(Buffer.from('a\0b\0'), '1 3 blob\n')).toThrow();
    expect(() => parseCapturedContents(Buffer.from(`${sha} blob 9\nxyz\n`), [entries[0]])).toThrow();
  });

  it('pairs a name list with the patch offsets, and refuses a list that does not pair', () => {
    const names = Buffer.from('M\0a.txt\0R090\0old\0new\0A\0c\0');
    expect(patchIndex(names, '0\n40\n90\n', 120)).toEqual([
      { status: 'M', path: 'a.txt', offset: 0, length: 40 },
      { status: 'R', path: 'new', oldPath: 'old', offset: 40, length: 50 },
      { status: 'A', path: 'c', offset: 90, length: 30 },
    ]);
    expect(patchIndex(names, '0\n40\n', 120)).toBeNull();
    expect(patchIndex(Buffer.from('R100\0only\0'), '0\n', 10)).toBeNull();
  });

  it('slices by the headers when there is no index', () => {
    const patch = 'diff --git a/x b/x\n+1\ndiff --git a/y z b/y z\n+2\n';
    expect(slicePatch(Buffer.from(patch), undefined, 'y z').toString()).toBe('diff --git a/y z b/y z\n+2\n');
    expect(slicePatch(Buffer.from(patch), undefined, 'nope').toString()).toBe('');
  });

  it.each([
    ['an added binary', 'diff --git a/i.png b/i.png\nnew file mode 100644\nindex 0..1\nGIT binary patch\nliteral 3\nKcmZ\n\nliteral 0\n', 'Binary files /dev/null and b/i.png differ\n'],
    ['a deleted binary', 'diff --git a/i.png b/i.png\ndeleted file mode 100644\nindex 1..0\nGIT binary patch\nliteral 0\n', 'Binary files a/i.png and /dev/null differ\n'],
    ['a changed binary', 'diff --git a/i.png b/i.png\nindex 1..2\nGIT binary patch\nliteral 3\n', 'Binary files a/i.png and b/i.png differ\n'],
  ])('strips the body of %s', (_name, block, line) => {
    const text = `diff --git a/t b/t\n+x\n${block}`;
    const out = stripBinaryBodies(text);
    expect(out.startsWith('diff --git a/t b/t\n+x\n')).toBe(true);
    expect(out.endsWith(line)).toBe(true);
    expect(out).not.toContain('literal');
  });
});

describe('egress', () => {
  it('the workbench projection carries only the two small changes columns', async () => {
    const { createTestDb } = await import('./helpers/testDb.js');
    const { workbenches } = await import('../db/schema.js');
    const { WORKBENCH_COLUMNS, CHAT_COLUMNS } = await import('../services/workbenches/store.js');
    const { workbenchChats } = await import('../db/schema.js');
    const { STATUS_SCRIPT_COLUMNS } = await import('../services/workbenches/sandboxStatus.js');
    const { workbenchScriptRuns } = await import('../db/schema.js');
    const testDb = await createTestDb();
    try {
      const sql = testDb.db.select(WORKBENCH_COLUMNS).from(workbenches).toSQL().sql;
      expect([...sql.matchAll(/"changes_[a-z_]+"/g)].map((m) => m[0]).sort()).toEqual(['"changes_at"', '"changes_etag"']);
      expect(testDb.db.select(CHAT_COLUMNS).from(workbenchChats).toSQL().sql).not.toContain('changes_');
      expect(testDb.db.select(STATUS_SCRIPT_COLUMNS).from(workbenchScriptRuns).toSQL().sql).not.toContain('changes_');
    } finally {
      await testDb.cleanup();
    }
  });
});
