/** @jest-environment node */
import { promises as fs } from 'fs';
import path from 'path';
import { parsePorcelainPaths, WorktreeManager } from '../git';
import { WorkbenchPaths } from '../paths';
import * as environment from '../environment';
import { runGit, temporaryRepo, testEnv } from '../testSupport';

jest.setTimeout(30_000);

let directory: string;
let repo: string;
let remote: string;
let paths: WorkbenchPaths;
let manager: WorktreeManager;

const commitOn = async (cwd: string, file: string, content: string, message: string) => {
  await fs.writeFile(path.join(cwd, file), content);
  await runGit(cwd, ['add', file]);
  await runGit(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
  return runGit(cwd, ['rev-parse', 'HEAD']);
};

const exists = (target: string) => fs.access(target).then(() => true, () => false);

beforeEach(async () => {
  ({ directory, repo } = await temporaryRepo());
  jest.spyOn(environment, 'processEnv').mockResolvedValue(testEnv);
  remote = path.join(directory, 'remote.git');
  await runGit(directory, ['clone', '--bare', repo, remote]);
  await runGit(repo, ['remote', 'add', 'origin', remote]);
  await runGit(repo, ['fetch', '-q', 'origin']);
  paths = new WorkbenchPaths(path.join(directory, 'state'), path.join(directory, 'workbenches'));
  manager = new WorktreeManager(paths);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

const create = (name = 'paris') =>
  manager.createWorktree({
    repoPath: repo,
    workbenchId: 'client-id',
    name,
    branch: `tom/${name}`,
    baseBranch: 'main',
    newBranch: true,
  });

describe('archiving a local worktree', () => {
  test('automatic archive removes a clean worktree once and keeps its branch', async () => {
    const { path: worktree, branch } = await create();
    const stop = jest.fn(async () => {});
    const input = { path: worktree, workbenchId: 'session-1' };

    expect(await manager.processArchivedWorktree(input, stop)).toEqual({ keptWorktree: null });
    expect(await manager.processArchivedWorktree(input, stop)).toEqual({ keptWorktree: null });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await exists(worktree)).toBe(false);
    expect(await runGit(repo, ['branch', '--list', branch])).toContain(branch);
  });

  test('automatic archive keeps a dirty worktree and saves its reason after restart', async () => {
    const { path: worktree } = await create();
    await fs.writeFile(path.join(worktree, 'draft.txt'), 'draft');
    const stop = jest.fn(async () => {});
    const input = { path: worktree, workbenchId: 'session-1' };
    const keptWorktree = { reason: 'uncommitted', files: 1, path: worktree, names: ['draft.txt'] };

    expect(await manager.processArchivedWorktree(input, stop)).toEqual({ keptWorktree });
    const restarted = new WorktreeManager(new WorkbenchPaths(path.join(directory, 'state'), path.join(directory, 'workbenches')));
    expect(await restarted.processArchivedWorktree(input, stop)).toEqual({ keptWorktree });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await exists(worktree)).toBe(true);
    expect(await paths.load(worktree)).toMatchObject({ archiveChecked: true, keptWorktree });
  });

  test('a session archived while closed is handled on the next start', async () => {
    const { path: worktree } = await create();
    const restarted = new WorktreeManager(new WorkbenchPaths(path.join(directory, 'state'), path.join(directory, 'workbenches')));
    const stop = jest.fn(async () => {});
    await restarted.processArchivedWorktree({ path: worktree, workbenchId: 'session-1' }, stop);
    expect(await exists(worktree)).toBe(false);
    expect(stop).toHaveBeenCalledWith('session-1');
  });

  test.each([false, true])('copied file changed after creation: %s', async (changed) => {
    await fs.writeFile(path.join(repo, 'copy.txt'), 'original');
    await fs.writeFile(path.join(repo, 'conductor.json'), JSON.stringify({ filesToCopy: ['copy.txt'] }));
    const { path: worktree } = await create();
    if (changed) await fs.writeFile(path.join(worktree, 'copy.txt'), 'changed');
    const status = await manager.inspectWorktree(worktree);
    expect(status.uncommittedCount).toBe(changed ? 1 : 0);
    expect(status.uncommitted).toEqual(changed ? ['copy.txt'] : []);
    const result = await manager.processArchivedWorktree({ path: worktree, workbenchId: 'session-1' }, async () => {});
    expect(result.keptWorktree?.files ?? 0).toBe(changed ? 1 : 0);
    expect(await exists(worktree)).toBe(changed);
  });

  test('an unchanged copy over a tracked file does not block a clean archive', async () => {
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'local content');
    await fs.writeFile(path.join(repo, 'conductor.json'), JSON.stringify({ filesToCopy: ['tracked.txt'] }));
    const { path: worktree } = await create();
    expect((await manager.inspectWorktree(worktree)).uncommittedCount).toBe(0);
    await manager.processArchivedWorktree({ path: worktree, workbenchId: 'session-1' }, async () => {});
    expect(await exists(worktree)).toBe(false);
  });

  (process.platform === 'win32' ? test.skip : test)('a copied path replaced by a link remains a change', async () => {
    await fs.writeFile(path.join(repo, 'copy.txt'), 'initial\n');
    await fs.writeFile(path.join(repo, 'conductor.json'), JSON.stringify({ filesToCopy: ['copy.txt'] }));
    const { path: worktree } = await create();
    await fs.unlink(path.join(worktree, 'copy.txt'));
    await fs.symlink('tracked.txt', path.join(worktree, 'copy.txt'));
    expect((await manager.inspectWorktree(worktree)).uncommitted).toEqual(['copy.txt']);
    await manager.processArchivedWorktree({ path: worktree, workbenchId: 'session-1' }, async () => {});
    expect(await fs.readFile(path.join(worktree, 'tracked.txt'), 'utf8')).toBe('initial\n');
  });

  test('a clean archive removes the worktree and keeps the branch and its commits', async () => {
    const { path: worktree, branch } = await create();
    const head = await commitOn(worktree, 'work.txt', 'work', 'Work');
    const stop = jest.fn(async () => {});

    await manager.removeWorktree({ path: worktree, workbenchId: 'session-1' }, stop);

    expect(await exists(worktree)).toBe(false);
    expect(await runGit(repo, ['rev-parse', `refs/heads/${branch}`])).toBe(head);
    expect(await runGit(repo, ['worktree', 'list', '--porcelain'])).not.toContain(worktree);
    expect(await paths.load(worktree)).toBeNull();
    expect(await paths.loadArchived(worktree)).toMatchObject({ workbenchId: 'session-1', branch });
  });

  test('stops processes under the session id, not the client id made at create', async () => {
    const { path: worktree } = await create();
    const stop = jest.fn(async () => {});
    await manager.removeWorktree({ path: worktree, workbenchId: 'session-1' }, stop);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('session-1');
  });

  test('reports uncommitted and untracked files, and unpushed commits', async () => {
    const { path: worktree, branch } = await create();
    await commitOn(worktree, 'one.txt', '1', 'One');
    await commitOn(worktree, 'two.txt', '2', 'Two');
    await fs.writeFile(path.join(worktree, 'tracked.txt'), 'changed');
    await fs.mkdir(path.join(worktree, 'src'));
    await fs.writeFile(path.join(worktree, 'src', 'new.ts'), 'new');
    // Ignored files are not changes: the archive deletes them without a word.
    await fs.writeFile(path.join(worktree, '.env.local'), 'SECRET=1');

    expect(await manager.inspectWorktree(worktree)).toEqual({
      managed: true,
      exists: true,
      branch,
      uncommitted: ['tracked.txt', 'src/new.ts'],
      uncommittedCount: 2,
      unpushed: 2,
    });
  });

  test('a dirty worktree is kept without force, and removed with it', async () => {
    const { path: worktree, branch } = await create();
    await fs.writeFile(path.join(worktree, 'draft.txt'), 'draft');

    await expect(manager.removeWorktree({ path: worktree, workbenchId: 'session-1' })).rejects.toThrow(
      'uncommitted changes',
    );
    expect(await fs.readFile(path.join(worktree, 'draft.txt'), 'utf8')).toBe('draft');
    expect(await paths.load(worktree)).not.toBeNull();

    await manager.removeWorktree({ path: worktree, workbenchId: 'session-1', force: true });
    expect(await exists(worktree)).toBe(false);
    expect(await runGit(repo, ['branch', '--list', branch])).toContain(branch);
  });

  test('a folder Talyn did not make is never removed', async () => {
    await expect(manager.removeWorktree({ path: repo, workbenchId: 'session-1' })).rejects.toThrow('not managed');
    expect(await exists(path.join(repo, 'tracked.txt'))).toBe(true);
  });

  test.each([
    ['the main checkout', () => repo],
    ['a folder above the root', () => directory],
    ['a deeper folder', () => path.join(directory, 'workbenches', 'a', 'b', 'c')],
    ['a relative path', () => 'workbenches/a/b'],
    ['a path with ..', () => path.join(directory, 'workbenches', 'a', '..', '..', 'source')],
  ])('refuses %s even with a record for it', async (_name, target) => {
    const folder = target();
    await paths.save({ workbenchId: 'x', path: folder, rootPath: repo, name: 'x', baseBranch: 'main' });
    await expect(manager.removeWorktree({ path: folder, workbenchId: 'session-1', force: true })).rejects.toThrow(
      'Talyn removes only the folders it made',
    );
    expect(await exists(path.join(repo, 'tracked.txt'))).toBe(true);
  });

  (process.platform === 'win32' ? test.skip : test)('refuses a session folder that is a link out of the root', async () => {
    const repoDir = path.join(directory, 'workbenches', 'source-abc');
    await fs.mkdir(repoDir, { recursive: true });
    const link = path.join(repoDir, 'linked');
    await fs.symlink(repo, link);
    await paths.save({ workbenchId: 'x', path: link, rootPath: repo, name: 'linked', baseBranch: 'main' });
    await expect(manager.removeWorktree({ path: link, workbenchId: 'session-1', force: true })).rejects.toThrow(
      'Talyn removes only the folders it made',
    );
    expect(await exists(path.join(repo, 'tracked.txt'))).toBe(true);
  });

  test('a managed folder that is not a worktree of the repository is not removed', async () => {
    const { path: worktree } = await create();
    const other = path.join(path.dirname(worktree), 'stray');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'keep.txt'), 'keep');
    await paths.save({ workbenchId: 'x', path: other, rootPath: repo, name: 'stray', baseBranch: 'main' });
    await expect(manager.removeWorktree({ path: other, workbenchId: 'session-1', force: true })).rejects.toThrow(
      'is not a worktree of',
    );
    expect(await fs.readFile(path.join(other, 'keep.txt'), 'utf8')).toBe('keep');
  });

  test('a new session does not take the folder of an archived one', async () => {
    const first = await create('paris');
    await manager.removeWorktree({ path: first.path, workbenchId: 'session-1' });
    const second = await create('paris');
    expect(second.path).not.toBe(first.path);
  });
});

describe('restoring a local worktree', () => {
  test('makes the worktree again at the same path, on the branch, with its commits and env files', async () => {
    await fs.writeFile(path.join(repo, '.env.local'), 'SECRET=local');
    const { path: worktree, branch } = await create();
    const head = await commitOn(worktree, 'work.txt', 'work', 'Work');
    await manager.removeWorktree({ path: worktree, workbenchId: 'session-1' });

    expect(await manager.restoreWorktree({ path: worktree, workbenchId: 'session-1', branch })).toEqual({ ok: true, branch });
    expect(await runGit(worktree, ['branch', '--show-current'])).toBe(branch);
    expect(await runGit(worktree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await fs.readFile(path.join(worktree, '.env.local'), 'utf8')).toBe('SECRET=local');
    expect(await paths.load(worktree)).toMatchObject({ workbenchId: 'session-1', rootPath: await fs.realpath(repo) });
    expect(await paths.loadArchived(worktree)).toBeNull();
  });

  test('a worktree an old archive kept is used as it is', async () => {
    const { path: worktree, branch } = await create();
    expect(await manager.restoreWorktree({ path: worktree, workbenchId: 'session-1', branch })).toEqual({ ok: true, branch });
  });

  test('a branch deleted meanwhile is reported clearly, and nothing is made', async () => {
    const { path: worktree, branch } = await create();
    await manager.removeWorktree({ path: worktree, workbenchId: 'session-1' });
    await runGit(repo, ['branch', '-D', branch]);

    const result = await manager.restoreWorktree({ path: worktree, workbenchId: 'session-1', branch });
    expect(result).toMatchObject({ ok: false, reason: 'branch_missing' });
    expect(!result.ok && result.message).toContain(`The branch ${branch} was deleted`);
    expect(await exists(worktree)).toBe(false);
    expect(await paths.loadArchived(worktree)).not.toBeNull();
  });

  test('a branch deleted here but pushed comes back from the remote', async () => {
    const { path: worktree, branch } = await create();
    const head = await commitOn(worktree, 'work.txt', 'work', 'Work');
    await runGit(worktree, ['push', '-q', 'origin', branch]);
    await manager.removeWorktree({ path: worktree, workbenchId: 'session-1' });
    await runGit(repo, ['fetch', '-q', 'origin']);
    await runGit(repo, ['branch', '-D', branch]);

    expect(await manager.restoreWorktree({ path: worktree, workbenchId: 'session-1', branch })).toEqual({ ok: true, branch });
    expect(await runGit(worktree, ['rev-parse', 'HEAD'])).toBe(head);
  });

  test('follows a branch the row renamed', async () => {
    const { path: worktree, branch } = await create();
    await manager.removeWorktree({ path: worktree, workbenchId: 'session-1' });
    await runGit(repo, ['branch', '-m', branch, 'tom/renamed']);
    expect(await manager.restoreWorktree({ path: worktree, workbenchId: 'session-1', branch: 'tom/renamed' })).toEqual({
      ok: true,
      branch: 'tom/renamed',
    });
  });

  test('refuses when something else now holds the folder', async () => {
    const { path: worktree, branch } = await create();
    await manager.removeWorktree({ path: worktree, workbenchId: 'session-1' });
    await fs.mkdir(worktree);
    expect(await manager.restoreWorktree({ path: worktree, workbenchId: 'session-1', branch })).toMatchObject({
      ok: false,
      reason: 'path_taken',
    });
  });

  test('refuses a path it has no record of', async () => {
    expect(
      await manager.restoreWorktree({ path: path.join(directory, 'workbenches', 'x', 'y'), workbenchId: 's', branch: 'main' }),
    ).toMatchObject({ ok: false, reason: 'not_managed' });
  });

  test('refuses a branch now checked out somewhere else', async () => {
    const { path: worktree, branch } = await create();
    await manager.removeWorktree({ path: worktree, workbenchId: 'session-1' });
    await runGit(repo, ['checkout', '-q', branch]);
    expect(await manager.restoreWorktree({ path: worktree, workbenchId: 'session-1', branch })).toMatchObject({
      ok: false,
      reason: 'branch_busy',
    });
  });
});

test.each([
  ['', []],
  [' M a.txt\0?? b/c.txt\0', ['a.txt', 'b/c.txt']],
  ['R  new.txt\0old.txt\0 D gone.txt\0', ['new.txt', 'gone.txt']],
  ['A  with space.txt\0', ['with space.txt']],
])('parses git status output %p', (stdout, files) => {
  expect(parsePorcelainPaths(stdout)).toEqual(files);
});
