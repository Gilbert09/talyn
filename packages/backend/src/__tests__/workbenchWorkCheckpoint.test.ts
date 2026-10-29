import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFleet } from './helpers/fakeFleet.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workbenches, workspaces } from '../db/schema.js';
import * as changes from '../services/workbenches/changes.js';
import * as prLink from '../services/workbenches/prLink.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import * as sandboxRun from '../services/selfHosted/sandboxRun.js';
import { provisionWorkbench } from '../services/workbenches/lifecycle.js';
import { AGENT_MEMORY_RECAP_NOTE } from '../services/workbenches/recovery.js';
import { getWorkbench, insertChat, insertWorkbench, listEvents, recordWorkCheckpoint, updateWorkbench } from '../services/workbenches/store.js';
import {
  checkpointWork,
  CHECKPOINT_DURING_TURN_MS,
  createThrottle,
  DIFF_STAT_DURING_TURN_MS,
  draftsMayChangeFiles,
  noteTurnActivity,
  setWorkCheckpointClockForTests,
  settleTurnActivity,
  WORK_PART_BYTES,
  type ThrottleClock,
} from '../services/workbenches/workCheckpoint.js';
import {
  archiveRestoreNote,
  checkpointTime,
  NO_CHECKPOINT_NOTE,
  parseWorkRestore,
  parseWorkSave,
  recoveryWorkNote,
  tooLargeNote,
  WORK_BUNDLE_MAX_BYTES,
  workRestoreBundle,
  workRestoreScript,
  workSaveScript,
  type WorkRestore,
} from '../services/workbenches/workCheckpointScripts.js';
import { memoryWorkObjectStore, setWorkObjectStoreForTests } from '../services/workbenches/workStorage.js';

const WB = 'wb-11111111-2222';
/** Fixed far-future instants, so no assertion depends on today's date. */
const T0 = Date.parse('2099-01-01T10:00:00Z');
const EPOCH = T0 / 1000;
const SHA = 'c'.repeat(40);
const SUM = 'f'.repeat(64);

const toolUse = (name: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input: {} }] } });

// ============================================================================
// The scripts, against real repositories
// ============================================================================

/**
 * The save and restore scripts run as the sandbox runs them, against a
 * working clone and a bare "GitHub" next to it. The bundle travels between
 * them as a file, the way Talyn carries it. Skipped on Windows: the restore
 * script calls `bash`, and a Windows runner's `bash` can be WSL's.
 */
describe.skipIf(process.platform === 'win32')('saved work in real repositories', () => {
  let root: string;
  let origin: string;
  let box: string;
  const env = () => ({
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    TMPDIR: join(root, 'tmp'),
    GIT_OPTIONAL_LOCKS: '0',
  });
  const gitRaw = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: env() });
  const git = (cwd: string, ...args: string[]) => gitRaw(cwd, ...args).trim();
  const run = (cwd: string, script: string) => {
    const r = spawnSync('bash', ['-c', script], { cwd, encoding: 'utf8', env: env() });
    return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  };
  const write = (dir: string, path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
  const commit = (dir: string, message: string) => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--no-verify', '-m', message);
  };
  const staged = () => join(root, 'tmp', `talyn-work-${WB}`, 'work.bundle');
  const save = (dir: string, previousSha: string | null = null, maxBytes?: number) =>
    parseWorkSave(run(dir, workSaveScript({ id: WB, baseBranch: 'main' }, { kind: 'checkpoint', previousSha, maxBytes })));
  /** What a replacement box holds right after `cloneScript`: a clone with the branch checked out. */
  const replacementBox = (branch: string) => {
    const dir = join(root, `box-${Math.random().toString(36).slice(2)}`);
    git(root, 'clone', '-q', origin, dir);
    if (git(dir, 'ls-remote', 'origin', `refs/heads/${branch}`)) git(dir, 'checkout', '-q', '-b', branch, '--track', `origin/${branch}`);
    else git(dir, 'checkout', '-q', '--no-track', '-b', branch, 'origin/main');
    return dir;
  };
  /** Carry the staged bundle to the new box, as Talyn does, and run the restore. */
  const restoreOn = (dir: string, branch: string, saved: ReturnType<typeof save>) => {
    if (saved.kind !== 'bundle') throw new Error(`nothing to restore: ${JSON.stringify(saved)}`);
    copyFileSync(staged(), workRestoreBundle(WB));
    return parseWorkRestore(run(dir, workRestoreScript({ id: WB, branch }, saved)));
  };
  /** Somebody else pushes to `branch` from their own clone. */
  const pushElsewhere = (branch: string, file: string) => {
    const dir = join(root, `other-${Math.random().toString(36).slice(2)}`);
    git(root, 'clone', '-q', '-b', branch, origin, dir);
    write(dir, file, 'theirs\n');
    commit(dir, `their ${file}`);
    git(dir, 'push', '-q', 'origin', branch);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const snapshot = (dir: string) => ({
    head: git(dir, 'rev-parse', 'HEAD'),
    branch: git(dir, 'symbolic-ref', 'HEAD'),
    staged: git(dir, 'diff', '--cached', '--name-status'),
    index: git(dir, 'ls-files', '-s'),
    status: git(dir, 'status', '--porcelain', '--untracked-files=all'),
    stash: git(dir, 'stash', 'list'),
    heads: git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
    remote: git(dir, 'ls-remote', 'origin'),
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wb-work-'));
    mkdirSync(join(root, 'tmp'));
    origin = join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    box = join(root, 'box');
    git(root, 'clone', '-q', origin, box);
    git(box, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    write(box, '.gitignore', 'node_modules/\n.env\n');
    write(box, 'a.txt', 'one\n');
    write(box, 'gone.txt', 'bye\n');
    commit(box, 'init');
    git(box, 'push', '-q', 'origin', 'main');
    git(box, 'checkout', '-q', '-b', 'feat');
    git(box, 'push', '-q', '-u', 'origin', 'feat');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(workRestoreBundle(WB), { force: true });
  });

  /** Work in every state a save must keep apart: modified, deleted, staged, untracked, ignored. */
  const makeWork = (dir: string) => {
    write(dir, 'a.txt', 'two\n');
    rmSync(join(dir, 'gone.txt'));
    write(dir, 'staged.txt', 'staged\n');
    git(dir, 'add', 'staged.txt');
    write(dir, "sub/it's new.txt", 'new\n');
    write(dir, '.env', 'SECRET=1\n');
    write(dir, 'node_modules/x.js', 'x\n');
  };

  it('writes a bundle without touching the branch, the index, the work tree or GitHub', () => {
    makeWork(box);
    const before = snapshot(box);
    const saved = save(box);
    expect(saved).toMatchObject({ kind: 'bundle', base: git(box, 'rev-parse', 'origin/main') });
    const { sha, size, sha256 } = saved as Extract<typeof saved, { kind: 'bundle' }>;
    expect(snapshot(box)).toEqual(before);
    expect(readFileSync(staged()).length).toBe(size);
    expect(createHash('sha256').update(readFileSync(staged())).digest('hex')).toBe(sha256);
    expect(git(box, 'bundle', 'list-heads', staged())).toBe(`${sha} refs/talyn/work/${WB}`);
    expect(git(box, 'rev-parse', `${sha}^`)).toBe(before.head);
    expect(git(box, 'ls-tree', '-r', '--name-only', sha).split('\n').sort()).toEqual(
      ['.gitignore', 'a.txt', 'staged.txt', "sub/it's new.txt"].sort(),
    );
    expect(existsSync(join(root, 'tmp', `talyn-work-${WB}.index`))).toBe(false);
  });

  it('says CLEAN when everything is on GitHub, and UNCHANGED when nothing moved since the last save', () => {
    expect(save(box)).toEqual({ kind: 'clean' });
    makeWork(box);
    const first = save(box);
    const sha = (first as { sha: string }).sha;
    expect(save(box, sha)).toEqual({ kind: 'unchanged', sha });
    // A commit with the same tree still moves HEAD, so it is a change.
    commit(box, 'local commit');
    expect(save(box, sha).kind).toBe('bundle');
    write(box, 'a.txt', 'three\n');
    expect(save(box, sha).kind).toBe('bundle');
  });

  it('refuses a bundle over the limit, and stages nothing', () => {
    makeWork(box);
    const saved = save(box, null, 10);
    expect(saved).toMatchObject({ kind: 'too_large', size: expect.any(Number) });
    expect((saved as { size: number }).size).toBeGreaterThan(10);
    expect(existsSync(join(root, 'tmp', `talyn-work-${WB}`))).toBe(false);
  });

  it('writes a full bundle when the base branch is unknown', () => {
    makeWork(box);
    const saved = parseWorkSave(run(box, workSaveScript({ id: WB, baseBranch: 'no-such-base' }, { kind: 'archive', previousSha: null })));
    expect(saved).toMatchObject({ kind: 'bundle', base: null });
    expect(git(box, 'bundle', 'verify', staged())).toContain('');
  });

  it('restores the work and the commits that were not pushed onto a replacement box', () => {
    write(box, 'local.txt', 'mine\n');
    commit(box, 'not pushed');
    const unpushed = git(box, 'rev-parse', 'HEAD');
    makeWork(box);
    const saved = save(box);

    const fresh = replacementBox('feat');
    const restore = restoreOn(fresh, 'feat', saved);
    expect(restore).toMatchObject({ kind: 'restored', sha: (saved as { sha: string }).sha, commits: 1, at: expect.any(Date) });
    expect(git(fresh, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feat');
    expect(git(fresh, 'rev-parse', 'HEAD')).toBe(unpushed);
    expect(read(fresh, 'local.txt')).toBe('mine\n');
    expect(read(fresh, 'a.txt')).toBe('two\n');
    expect(existsSync(join(fresh, 'gone.txt'))).toBe(false);
    expect(read(fresh, "sub/it's new.txt")).toBe('new\n');
    expect(read(fresh, 'staged.txt')).toBe('staged\n');
    // Ignored files never travel: they were not saved.
    expect(existsSync(join(fresh, '.env'))).toBe(false);
    // As uncommitted changes: nothing staged, nothing committed for the user.
    expect(git(fresh, 'diff', '--cached', '--name-only')).toBe('');
    expect(gitRaw(fresh, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual(
      [' D gone.txt', ' M a.txt', '?? staged.txt', '?? sub/'].sort(),
    );
    expect(existsSync(workRestoreBundle(WB))).toBe(false);
    // The next save on the new box finds nothing new.
    expect(save(fresh, (saved as { sha: string }).sha)).toEqual({ kind: 'unchanged', sha: (saved as { sha: string }).sha });
  });

  it('restores a branch that was never pushed, even after its base moved on', () => {
    git(box, 'checkout', '-q', '-b', 'fresh-branch', 'main');
    const base = git(box, 'rev-parse', 'HEAD');
    makeWork(box);
    const saved = save(box);
    pushElsewhere('main', 'upstream.txt');

    const fresh = replacementBox('fresh-branch');
    expect(git(fresh, 'rev-parse', 'HEAD')).not.toBe(base);
    expect(restoreOn(fresh, 'fresh-branch', saved)).toMatchObject({ kind: 'restored', commits: 0 });
    expect(git(fresh, 'rev-parse', 'HEAD')).toBe(base);
    expect(read(fresh, 'a.txt')).toBe('two\n');
  });

  it('leaves the saved work alone when the branch moved on GitHub after it', () => {
    makeWork(box);
    const saved = save(box);
    const theirs = pushElsewhere('feat', 'pushed-later.txt');

    const fresh = replacementBox('feat');
    expect(restoreOn(fresh, 'feat', saved)).toMatchObject({ kind: 'stale', sha: (saved as { sha: string }).sha });
    expect(git(fresh, 'rev-parse', 'HEAD')).toBe(theirs);
    expect(git(fresh, 'status', '--porcelain')).toBe('');
  });

  it('refuses a bundle that did not arrive whole', () => {
    makeWork(box);
    const saved = save(box) as Extract<ReturnType<typeof save>, { kind: 'bundle' }>;
    const fresh = replacementBox('feat');
    writeFileSync(workRestoreBundle(WB), readFileSync(staged()).subarray(0, 10));
    const restore = parseWorkRestore(run(fresh, workRestoreScript({ id: WB, branch: 'feat' }, saved)));
    expect(restore).toEqual({ kind: 'failed', detail: 'the saved work did not arrive whole' });
    expect(git(fresh, 'status', '--porcelain')).toBe('');
  });
});

// ============================================================================
// Parsers and notes
// ============================================================================

describe('parsing the scripts', () => {
  it.each([
    [{ exitCode: 0, stdout: 'CLEAN\n', stderr: '' }, { kind: 'clean' }],
    [{ exitCode: 0, stdout: `UNCHANGED ${SHA}\n`, stderr: '' }, { kind: 'unchanged', sha: SHA }],
    [{ exitCode: 0, stdout: 'TOO_LARGE 123\n', stderr: '' }, { kind: 'too_large', size: 123 }],
    [{ exitCode: 0, stdout: `noise\nBUNDLE ${SHA} ${EPOCH} - 42 ${SUM}\n`, stderr: '' },
      { kind: 'bundle', sha: SHA, at: new Date(T0), base: null, size: 42, sha256: SUM }],
    [{ exitCode: 0, stdout: `BUNDLE ${SHA} ${EPOCH} ${'a'.repeat(40)} 42 ${SUM}`, stderr: '' },
      { kind: 'bundle', sha: SHA, at: new Date(T0), base: 'a'.repeat(40), size: 42, sha256: SUM }],
    [{ exitCode: 1, stdout: '', stderr: 'a\nb\ncould not stage the work\n' }, { kind: 'failed', detail: 'a b could not stage the work' }],
    [{ exitCode: 0, stdout: '', stderr: '' }, { kind: 'failed', detail: 'saving the work exited 0' }],
    [{ exitCode: 1, stdout: 'CLEAN', stderr: '' }, { kind: 'failed', detail: 'saving the work exited 1' }],
  ])('save answer %#', (r, expected) => {
    expect(parseWorkSave(r)).toEqual(expected);
  });

  it.each([
    [{ exitCode: 0, stdout: `RESTORED ${SHA} ${EPOCH} 3\n`, stderr: '' }, { kind: 'restored', sha: SHA, at: new Date(T0), commits: 3 }],
    [{ exitCode: 0, stdout: `STALE ${SHA} ${EPOCH}\n`, stderr: '' }, { kind: 'stale', sha: SHA, at: new Date(T0) }],
    [{ exitCode: 21, stdout: '', stderr: 'could not read the saved work' }, { kind: 'failed', detail: 'could not read the saved work' }],
    [{ exitCode: 0, stdout: 'garbage', stderr: '' }, { kind: 'failed', detail: 'the restore exited 0' }],
  ])('restore answer %#', (r, expected) => {
    expect(parseWorkRestore(r)).toEqual(expected);
  });

  it('refuses ids and metadata that are not safe in a script', () => {
    expect(() => workSaveScript({ id: '../x', baseBranch: 'main' }, { kind: 'checkpoint', previousSha: null })).toThrow();
    expect(() => workRestoreScript({ id: WB, branch: 'b' }, { sha: 'x; rm -rf /', size: 1, sha256: SUM })).toThrow();
    expect(() => workRestoreScript({ id: WB, branch: 'b' }, { sha: SHA, size: 1.5, sha256: SUM })).toThrow();
    // A previous sha that is not a sha is ignored, never interpolated.
    expect(workSaveScript({ id: WB, baseBranch: 'main' }, { kind: 'checkpoint', previousSha: '$(reboot)' })).not.toContain('reboot');
  });

  it('never pushes', () => {
    expect(workSaveScript({ id: WB, baseBranch: 'main' }, { kind: 'archive', previousSha: SHA })).not.toMatch(/git push/);
    expect(workRestoreScript({ id: WB, branch: 'b' }, { sha: SHA, size: 1, sha256: SUM })).not.toMatch(/git push/);
  });

  it('caps the bundle at what a move carries', () => {
    expect(WORK_BUNDLE_MAX_BYTES).toBe(96 * 1024 * 1024);
    expect(WORK_PART_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('the notes', () => {
  const at = new Date(T0);
  it.each<[string, WorkRestore, Date, string[]]>([
    ['none', { kind: 'none' }, new Date(T0), [NO_CHECKPOINT_NOTE]],
    ['restored, 12 minutes behind', { kind: 'restored', sha: SHA, at, commits: 0 }, new Date(T0 + 12 * 60_000),
      ['restored the work from a checkpoint taken at 2099-01-01 10:00 UTC.', 'up to 12 minutes of work, are missing.']],
    ['restored with one commit', { kind: 'restored', sha: SHA, at, commits: 1 }, new Date(T0 + 61_000),
      ['with 1 commit that had not been pushed', 'up to 2 minutes of work']],
    ['restored with commits', { kind: 'restored', sha: SHA, at, commits: 3 }, new Date(T0 + 60_000),
      ['with 3 commits that had not been pushed', 'in the last minute before the loss may be missing']],
    ['restored, the clock behind', { kind: 'restored', sha: SHA, at, commits: 0 }, new Date(T0 - 60_000),
      ['in the last minute before the loss']],
    ['stale', { kind: 'stale', sha: SHA, at }, new Date(T0), ['did not apply it', 'Talyn keeps the checkpoint', '2099-01-01 10:00 UTC']],
    ['failed', { kind: 'failed', detail: 'could not read the saved work' }, new Date(T0),
      ['could not apply the last checkpoint (taken at 2099-01-01 10:00 UTC): could not read the saved work', 'may still be recoverable']],
  ])('after a loss: %s', (_label, restore, lostAt, parts) => {
    const text = recoveryWorkNote(restore, { lostAt, recordedAt: at });
    for (const part of parts) expect(text).toContain(part);
    expect(text).not.toMatch(/refs\/talyn/);
    if (restore.kind !== 'none') expect(text).not.toBe(NO_CHECKPOINT_NOTE);
  });

  it.each<[WorkRestore, string]>([
    [{ kind: 'none' }, 'This session was restored onto a new sandbox.'],
    [{ kind: 'restored', sha: SHA, at, commits: 2 }, 'put back the work saved when it was archived, with 2 commits that had not been pushed.'],
    [{ kind: 'stale', sha: SHA, at }, 'did not apply the saved work'],
    [{ kind: 'failed', detail: 'boom' }, 'could not put back the work saved when it was archived: boom.'],
  ])('after an archive: %j', (restore, part) => {
    expect(archiveRestoreNote(restore)).toContain(part);
  });

  it('names the time zone, and says honestly that nothing was saved', () => {
    expect(checkpointTime(new Date(T0))).toBe('2099-01-01 10:00 UTC');
    expect(NO_CHECKPOINT_NOTE).toContain('had no checkpoint');
    expect(tooLargeNote(200 * 1024 * 1024)).toContain('200 MB compressed, more than the 96 MB Talyn keeps');
  });
});

// ============================================================================
// The cheap check and the throttles
// ============================================================================

function fakeClock(start = T0) {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: ThrottleClock = {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++nextId; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id as number); },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  };
  return { clock, advance, pending: () => timers.size };
}

describe('the cheap "did files change" check', () => {
  it.each([
    [[toolUse('Edit')], true],
    [[toolUse('Write')], true],
    [[toolUse('Bash')], true],
    [[toolUse('Task')], true],
    [[toolUse('Read'), toolUse('Grep'), toolUse('TodoWrite')], false],
    [[toolUse('mcp__linear__get_issue')], false],
    [[{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }], false],
    [[{ type: 'assistant', message: { content: [{ type: 'text', text: 'Edit the file' }] } }], false],
    [[{ type: 'result' }], false],
    [[], false],
  ])('%j → %s', (drafts, expected) => {
    expect(draftsMayChangeFiles(drafts)).toBe(expected);
  });
});

describe('the throttle', () => {
  it('runs at once, then once more at the end of the interval, however often it is poked', async () => {
    const { clock, advance, pending } = fakeClock();
    const run = vi.fn();
    const t = createThrottle(1000, run, clock);
    t.poke('a');
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    advance(100); t.poke('a'); advance(100); t.poke('a');
    expect(pending()).toBe(1);
    advance(799);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    advance(1);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    t.poke('b');
    await Promise.resolve();
    expect(run).toHaveBeenLastCalledWith('b');
  });

  it('waits a full interval after a floor or a mark, and a cancel drops the trailing run', async () => {
    const { clock, advance, pending } = fakeClock();
    const run = vi.fn();
    const t = createThrottle(1000, run, clock);
    t.poke('a', T0 - 200);
    expect(pending()).toBe(1);
    t.cancel('a');
    expect(pending()).toBe(0);
    t.mark('a');
    t.poke('a');
    advance(999);
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    advance(1);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never lets a failed run escape', async () => {
    const { clock } = fakeClock();
    const t = createThrottle(1000, () => Promise.reject(new Error('boom')), clock);
    expect(() => t.poke('a')).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// ============================================================================
// Against the database and a fake store
// ============================================================================

describe('saved work in a session', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let scripts: string[];
  let reply: (script: string) => { exitCode?: number; stdout?: string; stderr?: string } | null;
  let clock: ReturnType<typeof fakeClock>;
  let store: ReturnType<typeof memoryWorkObjectStore>;
  /** What the fake box "staged": three parts' worth, so a save reads it in pieces. */
  let bundle: Buffer;
  const saves = () => scripts.filter((s) => s.includes('talyn work checkpoint'));
  const meta = () => {
    const raw = store.objects.get(`ws/${WB}/checkpoint/meta.json`);
    return raw ? JSON.parse(raw.toString()) : null;
  };
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const bundleLine = (sha = SHA) => `BUNDLE ${sha} ${EPOCH} - ${bundle.length} ${createHash('sha256').update(bundle).digest('hex')}\n`;

  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
  });

  afterAll(async () => { await testDb.cleanup(); });

  beforeEach(async () => {
    await testDb.db.delete(workbenches);
    await insertWorkbench({
      id: WB, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', name: 'paris',
      branch: 'feat', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      sandboxId: 'box', sandboxState: 'running',
    });
    await insertChat({ id: 'chat', workbenchId: WB, workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    bundle = Buffer.alloc(2 * WORK_PART_BYTES + 7, 'b');
    scripts = [];
    reply = (script) => (script.includes('talyn work checkpoint') ? { stdout: bundleLine() } : null);
    vi.spyOn(runtime, 'runCapture').mockImplementation(async (_wb, script) => {
      scripts.push(script);
      const chunk = /^dd if=\S+ bs=1M iflag=skip_bytes,count_bytes skip=(\d+) count=(\d+)/.exec(script);
      if (chunk) {
        const bytes = bundle.subarray(Number(chunk[1]), Number(chunk[1]) + Number(chunk[2]));
        return { exitCode: 0, stdout: '', stderr: '', stdoutBytes: bytes };
      }
      const r = reply(script) ?? {};
      const stdout = r.stdout ?? '';
      return { exitCode: r.exitCode ?? 0, stdout, stderr: r.stderr ?? '', stdoutBytes: Buffer.from(stdout) };
    });
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (row) => row);
    store = memoryWorkObjectStore();
    setWorkObjectStoreForTests(store);
    clock = fakeClock();
    setWorkCheckpointClockForTests(clock.clock);
  });

  afterEach(() => {
    setWorkCheckpointClockForTests(null);
    setWorkObjectStoreForTests(null);
    vi.restoreAllMocks();
  });

  it('streams the bundle into storage a part at a time and records it on the row', async () => {
    expect(await checkpointWork((await getWorkbench(WB))!, 'turn_end')).toEqual({ kind: 'saved', sha: SHA, at: new Date(T0), size: bundle.length });
    const m = meta();
    expect(m).toMatchObject({ version: 1, kind: 'checkpoint', sha: SHA, base: null, branch: 'feat', size: bundle.length, parts: 3, takenAt: '2099-01-01T10:00:00.000Z' });
    const parts = [0, 1, 2].map((i) => store.objects.get(`ws/${WB}/checkpoint/${m.generation}/part-0000${i}`)!);
    expect(parts.map((p) => p.length)).toEqual([WORK_PART_BYTES, WORK_PART_BYTES, 7]);
    expect(Buffer.concat(parts).equals(bundle)).toBe(true);
    expect(scripts.filter((s) => s.startsWith('dd if=/dev/shm/talyn-work-'))).toHaveLength(3);
    expect(scripts.some((s) => s.includes('git push'))).toBe(false);
    expect(await getWorkbench(WB)).toMatchObject({ workCheckpointSha: SHA, workCheckpointAt: new Date(T0), workCheckpointBytes: bundle.length });
  });

  it('replaces the previous checkpoint and removes its parts', async () => {
    await checkpointWork((await getWorkbench(WB))!, 'turn_end');
    const first = meta().generation;
    bundle = Buffer.from('smaller');
    reply = (script) => (script.includes('talyn work checkpoint') ? { stdout: bundleLine('d'.repeat(40)) } : null);
    clock.advance(1);
    await checkpointWork((await getWorkbench(WB))!, 'turn_end');
    const second = meta();
    expect(second).toMatchObject({ sha: 'd'.repeat(40), parts: 1 });
    expect(second.generation).not.toBe(first);
    expect([...store.objects.keys()].filter((k) => k.includes(first))).toEqual([]);
  });

  it('keeps the last checkpoint when a new one fails half-way', async () => {
    await checkpointWork((await getWorkbench(WB))!, 'turn_end');
    const before = meta();
    let puts = 0;
    const put = store.put;
    store.put = async (key, body) => { if (++puts === 2) throw new Error('storage is down'); return put(key, body); };
    reply = (script) => (script.includes('talyn work checkpoint') ? { stdout: bundleLine('d'.repeat(40)) } : null);
    expect(await checkpointWork((await getWorkbench(WB))!, 'turn_end')).toMatchObject({ kind: 'failed', detail: 'storage is down' });
    expect(meta()).toEqual(before);
    expect((await getWorkbench(WB))?.workCheckpointSha).toBe(SHA);
  });

  it('passes the recorded sha so an unchanged box saves nothing', async () => {
    await updateWorkbench(WB, { workCheckpointSha: SHA, workCheckpointAt: new Date(T0) });
    reply = (script) => (script.includes('talyn work checkpoint') ? { stdout: `UNCHANGED ${SHA}` } : null);
    expect(await checkpointWork((await getWorkbench(WB))!, 'turn_end')).toEqual({ kind: 'unchanged', sha: SHA });
    expect(saves()[0]).toContain(`prev=${SHA}`);
    expect(store.objects.size).toBe(0);
  });

  it('drops the checkpoint when everything is on GitHub', async () => {
    await checkpointWork((await getWorkbench(WB))!, 'turn_end');
    reply = (script) => (script.includes('talyn work checkpoint') ? { stdout: 'CLEAN' } : null);
    expect(await checkpointWork((await getWorkbench(WB))!, 'turn_end')).toEqual({ kind: 'clean' });
    expect(store.objects.size).toBe(0);
    expect(await getWorkbench(WB)).toMatchObject({ workCheckpointSha: null, workCheckpointAt: null, workCheckpointBytes: null });
  });

  it('says once in the chat that the work is too large, and again only after a save worked', async () => {
    reply = (script) => (script.includes('talyn work checkpoint') ? { stdout: `TOO_LARGE ${200 * 1024 * 1024}` } : null);
    await checkpointWork((await getWorkbench(WB))!, 'turn_end');
    await checkpointWork((await getWorkbench(WB))!, 'turn_end');
    const notes = async () => (await listEvents('chat', 0, 20)).events.filter((e) => e.event.subtype === 'work_checkpoint_too_large');
    expect(await notes()).toHaveLength(1);
    expect((await notes())[0].event.text).toBe(tooLargeNote(200 * 1024 * 1024));
    expect(store.objects.size).toBe(0);
    reply = (script) => (script.includes('talyn work checkpoint') ? { stdout: bundleLine() } : null);
    await checkpointWork((await getWorkbench(WB))!, 'turn_end');
    reply = (script) => (script.includes('talyn work checkpoint') ? { stdout: `TOO_LARGE ${200 * 1024 * 1024}` } : null);
    await checkpointWork((await getWorkbench(WB))!, 'turn_end');
    expect(await notes()).toHaveLength(2);
  });

  it('never throws, and records nothing, when the box or storage fails', async () => {
    reply = (script) => (script.includes('talyn work checkpoint') ? { exitCode: 1, stderr: 'could not stage the work' } : null);
    expect(await checkpointWork((await getWorkbench(WB))!, 'turn_end')).toMatchObject({ kind: 'failed', detail: 'could not stage the work' });
    vi.mocked(runtime.runCapture).mockRejectedValueOnce(new Error('offline'));
    expect(await checkpointWork((await getWorkbench(WB))!, 'turn_end')).toMatchObject({ kind: 'failed', detail: 'offline' });
    setWorkObjectStoreForTests(null);
    vi.stubEnv('SUPABASE_URL', '');
    reply = (script) => (script.includes('talyn work checkpoint') ? { stdout: bundleLine() } : null);
    expect(await checkpointWork((await getWorkbench(WB))!, 'turn_end')).toMatchObject({ kind: 'failed', detail: expect.stringContaining('Talyn storage is not configured') });
    vi.unstubAllEnvs();
    expect(await getWorkbench(WB)).toMatchObject({ workCheckpointSha: null, workCheckpointAt: null });
  });

  it.each([
    ['provisioning', { status: 'provisioning' }],
    ['archived', { archivedAt: new Date(T0) }],
    ['without a box', { sandboxId: null }],
  ])('skips a session that is %s', async (_label, patch) => {
    await updateWorkbench(WB, patch);
    expect(await checkpointWork((await getWorkbench(WB))!, 'turn_end')).toBeNull();
    expect(scripts).toHaveLength(0);
  });

  it('runs one checkpoint at a time per session', async () => {
    const row = (await getWorkbench(WB))!;
    const [a, b] = await Promise.all([checkpointWork(row, 'turn_end'), checkpointWork(row, 'during_turn')]);
    expect(a).toEqual(b);
    expect(saves()).toHaveLength(1);
  });

  it('ignores a late checkpoint from a box the session no longer names', async () => {
    await updateWorkbench(WB, { sandboxId: 'box-r1' });
    expect(await recordWorkCheckpoint(WB, 'box', SHA, new Date(T0), 1)).toBe(false);
    expect(await recordWorkCheckpoint(WB, 'box-r1', SHA, new Date(T0), 1)).toBe(true);
    expect(await getWorkbench(WB)).toMatchObject({ workCheckpointSha: SHA, workCheckpointBytes: 1 });
  });

  describe('during a turn', () => {
    beforeEach(() => {
      bundle = Buffer.from('small');
      reply = (script) => (script.includes('talyn work checkpoint') ? { stdout: bundleLine() } : null);
    });

    it('checkpoints at most every five minutes', async () => {
      const row = (await getWorkbench(WB))!;
      noteTurnActivity(row, [toolUse('Read')]);
      await flush();
      expect(saves()).toHaveLength(0);

      noteTurnActivity(row, [toolUse('Edit')]);
      await flush();
      expect(saves()).toHaveLength(1);

      clock.advance(60_000);
      noteTurnActivity(row, [toolUse('Write')]);
      clock.advance(CHECKPOINT_DURING_TURN_MS - 60_000 - 1);
      await flush();
      expect(saves()).toHaveLength(1);
      clock.advance(1);
      await flush();
      expect(saves()).toHaveLength(2);
    });

    it('refreshes the diff stat at most every 20 seconds', async () => {
      const row = (await getWorkbench(WB))!;
      for (let i = 0; i < 5; i++) {
        noteTurnActivity(row, [toolUse('Edit')]);
        clock.advance(1_000);
      }
      await flush();
      expect(changes.refreshDiffStat).toHaveBeenCalledTimes(1);
      clock.advance(DIFF_STAT_DURING_TURN_MS - 5_000);
      await flush();
      expect(changes.refreshDiffStat).toHaveBeenCalledTimes(2);
      noteTurnActivity(row, [toolUse('Read')]);
      clock.advance(DIFF_STAT_DURING_TURN_MS);
      await flush();
      expect(changes.refreshDiffStat).toHaveBeenCalledTimes(2);
    });

    it('waits five minutes from the last recorded checkpoint, and a turn end drops what was waiting', async () => {
      await updateWorkbench(WB, { workCheckpointSha: SHA, workCheckpointAt: new Date(T0 - 60_000) });
      const row = (await getWorkbench(WB))!;
      noteTurnActivity(row, [toolUse('Edit')]);
      await flush();
      expect(saves()).toHaveLength(0);
      settleTurnActivity(WB);
      clock.advance(CHECKPOINT_DURING_TURN_MS);
      await flush();
      expect(saves()).toHaveLength(0);
    });
  });

  describe('a replacement box', () => {
    beforeEach(() => {
      const fleet = new FakeFleet();
      vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'test' }, githubToken: 'test' });
      vi.spyOn(sandboxRun, 'resolveRepository').mockResolvedValue({ slug: 'o/r', defaultBranch: 'main' });
      vi.spyOn(sandboxRun, 'buildSandboxCreateBody').mockImplementation(async (input) => ({ ok: true, body: { id: input.id, workspaceId: input.workspaceId } }));
      vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client: fleet.asClient() });
      vi.spyOn(runtime, 'loadWorkbenchConfig').mockResolvedValue(null);
      vi.spyOn(prLink, 'linkPullRequest').mockImplementation(async (row) => row);
    });

    /** Store a saved bundle of `kind` in two parts. */
    const stored = async (kind: 'checkpoint' | 'archive') => {
      const body = Buffer.from('saved bundle bytes');
      await store.put(`ws/${WB}/${kind}/g1/part-00000`, body.subarray(0, 5));
      await store.put(`ws/${WB}/${kind}/g1/part-00001`, body.subarray(5));
      await store.put(`ws/${WB}/${kind}/meta.json`, Buffer.from(JSON.stringify({
        version: 1, kind, sha: SHA, base: null, branch: 'feat', takenAt: new Date(T0).toISOString(),
        size: body.length, sha256: createHash('sha256').update(body).digest('hex'), parts: 2, generation: 'g1',
      })));
      return body;
    };
    const restoreScripts = () => scripts.filter((s) => s.includes('git read-tree "$cp"'));
    /** The bytes the restore wrote into the box, from the base64 env chunks. */
    const written = (calls: Array<[unknown, string, { env?: Record<string, string> }?]>) =>
      Buffer.concat(calls.flatMap(([, , opts]) => Object.entries(opts?.env ?? {})
        .filter(([k]) => k.startsWith('TALYN_F')).map(([, v]) => Buffer.from(v, 'base64'))));
    const lose = () => updateWorkbench(WB, {
      status: 'provisioning', sandboxState: 'lost', memoryRestorePending: 'lost', sandboxId: 'box-r1',
      workCheckpointSha: SHA, workCheckpointAt: new Date(T0),
    });
    const firstNote = async () => (await listEvents('chat', 0, 10)).events.map((e) => e.event)[0];

    it.each([
      ['restored', `RESTORED ${SHA} ${EPOCH} 2\n`, ['Talyn restored the work from a checkpoint taken at 2099-01-01 10:00 UTC, with 2 commits that had not been pushed.']],
      ['stale', `STALE ${SHA} ${EPOCH}\n`, ['did not apply it', 'Talyn keeps the checkpoint']],
    ])('streams the checkpoint in after the clone and says what came back: %s', async (_label, stdout, parts) => {
      const body = await stored('checkpoint');
      await lose();
      reply = (script) => (script.includes('git read-tree "$cp"') ? { stdout } : null);
      await provisionWorkbench(WB);
      expect(await getWorkbench(WB)).toMatchObject({ status: 'ready', sandboxState: 'running', memoryRestorePending: null });
      expect(restoreScripts()).toHaveLength(1);
      const clone = scripts.findIndex((s) => s.includes('git clone --filter=blob:none'));
      expect(clone).toBeGreaterThanOrEqual(0);
      expect(scripts.indexOf(restoreScripts()[0])).toBeGreaterThan(clone);
      expect(written(vi.mocked(runtime.runCapture).mock.calls as never).equals(body)).toBe(true);
      const note = await firstNote();
      expect(note).toMatchObject({ type: 'system', subtype: 'sandbox_recovered' });
      for (const part of parts) expect(note.text).toContain(part);
      expect(note.text).toContain(AGENT_MEMORY_RECAP_NOTE);
    });

    it('says honestly that nothing was saved when storage holds no checkpoint', async () => {
      await lose();
      await provisionWorkbench(WB);
      expect(restoreScripts()).toHaveLength(0);
      expect((await firstNote()).text).toBe(`${NO_CHECKPOINT_NOTE} ${AGENT_MEMORY_RECAP_NOTE}`);
    });

    it('reports a part missing from storage, with the time Talyn recorded', async () => {
      await stored('checkpoint');
      store.objects.delete(`ws/${WB}/checkpoint/g1/part-00001`);
      await lose();
      await provisionWorkbench(WB);
      expect(restoreScripts()).toHaveLength(0);
      expect((await firstNote()).text).toContain('could not apply the last checkpoint (taken at 2099-01-01 10:00 UTC): part 2 of 2 of the saved work is missing');
      expect((await getWorkbench(WB))?.status).toBe('ready');
    });

    it('puts the archive back on a restore and makes it the checkpoint', async () => {
      await stored('archive');
      await updateWorkbench(WB, { status: 'provisioning', sandboxState: 'creating', memoryRestorePending: 'archive', sandboxId: 'box-r1' });
      reply = (script) => (script.includes('git read-tree "$cp"') ? { stdout: `RESTORED ${SHA} ${EPOCH} 0\n` }
        : script.includes('talyn work checkpoint') ? { stdout: `UNCHANGED ${SHA}` } : null);
      await provisionWorkbench(WB, { restore: true });
      expect(restoreScripts()).toHaveLength(1);
      expect(await firstNote()).toMatchObject({
        subtype: 'sandbox_restored', text: expect.stringContaining('Talyn put back the work saved when it was archived.'),
      });
      await flush();
      expect(saves()).toHaveLength(1);
    });

    it('does not restore anything on a plain first provision', async () => {
      await stored('checkpoint');
      await updateWorkbench(WB, { status: 'provisioning', sandboxState: 'creating' });
      await provisionWorkbench(WB);
      expect(restoreScripts()).toHaveLength(0);
      expect((await listEvents('chat', 0, 10)).events).toHaveLength(0);
    });
  });
});
