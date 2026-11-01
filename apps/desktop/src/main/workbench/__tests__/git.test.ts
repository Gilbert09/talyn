/** @jest-environment node */
import { promises as fs } from 'fs';
import path from 'path';
import { checkpointCreateSteps, checkpointRestoreSteps } from '@talyn/shared';
import { exec, listFiles, readFile, WorktreeManager } from '../git';
import { WorkbenchPaths } from '../paths';
import * as environment from '../environment';
import { runGit, temporaryRepo, testEnv } from '../testSupport';

let directory: string;
let repo: string;
beforeEach(async () => {
  ({ directory, repo } = await temporaryRepo());
  jest.spyOn(environment, 'processEnv').mockResolvedValue(testEnv);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

test.each([
  '../secret',
  'a/../../secret',
  '/etc/passwd',
  'C:\\Windows\\file',
  'C:/file',
  'C:file',
  '\\\\host\\file',
  '..\\secret',
  'a\0b',
  '',
  '.',
  'a/..',
])('rejects unsafe path %p', async (relative) => {
  await expect(readFile(repo, relative)).rejects.toThrow();
});

test('rejects symlinks outside the worktree and accepts links inside it', async () => {
  await fs.writeFile(path.join(directory, 'secret'), 'secret');
  await fs.symlink(path.join(directory, 'secret'), path.join(repo, 'outside'));
  await fs.symlink(directory, path.join(repo, 'outside-dir'));
  await fs.symlink(path.join(repo, 'tracked.txt'), path.join(repo, 'inside'));
  await expect(readFile(repo, 'outside')).rejects.toThrow('escapes');
  await expect(readFile(repo, 'outside-dir/secret')).rejects.toThrow('escapes');
  await expect(readFile(repo, 'inside')).resolves.toEqual({
    content: 'initial\n',
    binary: false,
  });
});

test.each([
  [Buffer.from([0, 1]), true],
  [Buffer.from([0xff]), true],
  [Buffer.from('hello 🌍'), false],
] as const)('detects binary data %p', async (data, binary) => {
  await fs.writeFile(path.join(repo, 'file'), data);
  expect((await readFile(repo, 'file')).binary).toBe(binary);
});

test('enforces the size cap and rejects directories', async () => {
  await fs.writeFile(
    path.join(repo, 'large'),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  );
  await expect(readFile(repo, 'large')).rejects.toThrow('2 MiB');
  await fs.mkdir(path.join(repo, 'folder'));
  await expect(readFile(repo, 'folder')).rejects.toThrow('regular file');
});

test('resolves captures and environment without a shell', async () => {
  const result = await exec(repo, [
    { argv: ['git', 'rev-parse', 'HEAD'], capture: 'head' },
    { argv: ['git', 'rev-parse', '{{head}}'] },
    {
      argv: [process.execPath, '-e', 'process.stdout.write(process.env.VALUE)'],
      env: { VALUE: '{{head}}; $(bad)' },
    },
  ]);
  const head = await runGit(repo, ['rev-parse', 'HEAD']);
  expect(result).toEqual({
    exitCode: 0,
    stdout: `${head}\n${head}; $(bad)`,
    stderr: '',
  });
  await expect(exec(repo, [{ argv: ['git', '{{missing}}'] }])).rejects.toThrow(
    'before any step captured',
  );
});

test.each([false, true])('honours allowFailure=%p', async (allowFailure) => {
  const result = await exec(repo, [
    { argv: ['git', 'rev-parse', '--verify', 'missing'], allowFailure },
    { argv: [process.execPath, '-e', 'process.stdout.write("continued")'] },
  ]);
  expect(result.stdout).toBe(allowFailure ? 'continued' : '');
  expect(result.exitCode === 0).toBe(allowFailure);
});

test('creates and restores checkpoints without changing HEAD or the index', async () => {
  const head = await runGit(repo, ['rev-parse', 'HEAD']);
  const index = await fs.readFile(path.join(repo, '.git/index'));
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'changed');
  await fs.writeFile(path.join(repo, 'untracked.txt'), 'new');
  const tmpIndexPath = path.join(directory, 'temporary-index');
  const result = await exec(
    repo,
    checkpointCreateSteps({ chatId: 'chat', turn: 1, tmpIndexPath }),
  );
  expect(result.exitCode).toBe(0);
  const sha = result.stdout.trim();
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'later');
  await fs.writeFile(path.join(repo, 'later.txt'), 'later');
  expect(
    (await exec(repo, checkpointRestoreSteps({ sha, tmpIndexPath }))).exitCode,
  ).toBe(0);
  expect(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe(
    'changed',
  );
  expect(await listFiles(repo)).toContain('untracked.txt');
  expect(await listFiles(repo)).not.toContain('later.txt');
  expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(head);
  expect(await fs.readFile(path.join(repo, '.git/index'))).toEqual(index);
});

test.each(['local', 'clone'] as const)(
  'creates a worktree from a %s repository',
  async (source) => {
    const remote = path.join(directory, 'remote.git');
    await runGit(directory, ['clone', '--bare', repo, remote]);
    await runGit(repo, ['remote', 'add', 'origin', remote]);
    await fs.writeFile(path.join(repo, '.env.local'), 'SECRET=local');
    await fs.writeFile(path.join(repo, 'copy.txt'), 'copy me');
    await fs.writeFile(
      path.join(repo, 'conductor.json'),
      JSON.stringify({ filesToCopy: ['copy.txt'] }),
    );
    const paths = new WorkbenchPaths(
      path.join(directory, 'state'),
      path.join(directory, 'workbenches'),
    );
    const manager = new WorktreeManager(paths);
    const input = {
      workbenchId: 'wb',
      name: 'london',
      branch: 'tom/london',
      baseBranch: 'main',
      ...(source === 'local' ? { repoPath: repo } : { cloneUrl: remote }),
    };
    const result = await manager.createWorktree(input);
    expect(await runGit(result.path, ['branch', '--show-current'])).toBe(
      'tom/london',
    );
    if (source === 'local') {
      expect(
        await fs.readFile(path.join(result.path, '.env.local'), 'utf8'),
      ).toBe('SECRET=local');
      expect(
        await fs.readFile(path.join(result.path, 'copy.txt'), 'utf8'),
      ).toBe('copy me');
    }
    await fs.mkdir(path.join(result.path, '.context'));
    await fs.writeFile(path.join(result.path, '.context/file'), 'ignored');
    expect(await listFiles(result.path)).not.toContain('.context/file');
    await manager.removeWorktree({ path: result.path });
    await expect(fs.access(result.path)).rejects.toThrow();
    // The existing branch must be reusable after removal.
    const again = await manager.createWorktree(input);
    expect(await runGit(again.path, ['branch', '--show-current'])).toBe(
      'tom/london',
    );
    await manager.removeWorktree({ path: again.path });
  },
);

// Git for Windows checks a symlink out as a plain file (core.symlinks is off).
(process.platform === 'win32' ? test.skip : test)('does not create copy directories through a worktree symlink', async () => {
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(repo, 'settings'));
  await runGit(repo, ['add', 'settings']);
  const tree = await runGit(repo, ['write-tree']);
  const commit = await runGit(
    repo,
    ['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nSymlink fixture\n`,
  );
  await runGit(repo, ['update-ref', 'refs/heads/main', commit]);
  const remote = path.join(directory, 'remote.git');
  await runGit(directory, ['clone', '--bare', repo, remote]);
  await runGit(repo, ['remote', 'add', 'origin', remote]);
  await fs.unlink(path.join(repo, 'settings'));
  await fs.mkdir(path.join(repo, 'settings/nested'), { recursive: true });
  await fs.writeFile(path.join(repo, 'settings/nested/secret'), 'secret');
  await fs.writeFile(
    path.join(repo, 'conductor.json'),
    JSON.stringify({ filesToCopy: ['settings/nested/secret'] }),
  );
  const manager = new WorktreeManager(
    new WorkbenchPaths(
      path.join(directory, 'state'),
      path.join(directory, 'workbenches'),
    ),
  );
  await expect(
    manager.createWorktree({
      repoPath: repo,
      workbenchId: 'wb',
      name: 'london',
      branch: 'tom/london',
      baseBranch: 'main',
    }),
  ).rejects.toThrow('Copy path escapes');
  expect(await fs.readdir(outside)).toEqual([]);
});

describe('creating a local worktree', () => {
  let remote: string;
  let manager: WorktreeManager;

  const commitOn = async (cwd: string, file: string, content: string, message: string) => {
    await fs.writeFile(path.join(cwd, file), content);
    await runGit(cwd, ['add', file]);
    await runGit(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
    return runGit(cwd, ['rev-parse', 'HEAD']);
  };

  /** A second clone that pushes `branch` with one commit, as a teammate would. */
  const pushFromOther = async (branch: string, file: string) => {
    const other = path.join(directory, 'other');
    await runGit(directory, ['clone', '-q', remote, other]);
    await runGit(other, ['checkout', '-q', '-b', branch]);
    await commitOn(other, file, file, `Add ${file}`);
    await runGit(other, ['push', '-q', 'origin', branch]);
    return other;
  };

  beforeEach(async () => {
    remote = path.join(directory, 'remote.git');
    await runGit(directory, ['clone', '--bare', repo, remote]);
    await runGit(repo, ['remote', 'add', 'origin', remote]);
    await runGit(repo, ['fetch', '-q', 'origin']);
    manager = new WorktreeManager(
      new WorkbenchPaths(path.join(directory, 'state'), path.join(directory, 'workbenches')),
    );
  });

  const create = (overrides: Partial<Parameters<WorktreeManager['createWorktree']>[0]> = {}) =>
    manager.createWorktree({
      repoPath: repo,
      workbenchId: 'wb',
      name: 'fix-lint',
      branch: 'fix-lint',
      baseBranch: 'main',
      newBranch: true,
      ...overrides,
    });

  test.each([
    ['a local branch', async () => runGit(repo, ['branch', 'fix-lint', 'main'])],
    ['a remote branch', async () => pushFromOther('fix-lint', 'theirs.txt')],
  ])('a new branch never reuses %s of the same name', async (_label, setup) => {
    await setup();
    const result = await create();
    expect(result.branch).toBe('fix-lint-2');
    expect(await runGit(result.path, ['branch', '--show-current'])).toBe('fix-lint-2');
    expect(await runGit(result.path, ['rev-parse', 'HEAD'])).toBe(await runGit(repo, ['rev-parse', 'main']));
    await expect(fs.access(path.join(result.path, 'theirs.txt'))).rejects.toThrow();
  });

  test('a second session with the same name gets its own directory and branch', async () => {
    const first = await create();
    const second = await create();
    expect(first).toEqual({ path: path.join(path.dirname(first.path), 'fix-lint'), branch: 'fix-lint' });
    expect(second).toEqual({ path: path.join(path.dirname(first.path), 'fix-lint-2'), branch: 'fix-lint-2' });
    expect(await runGit(second.path, ['branch', '--show-current'])).toBe('fix-lint-2');
  });

  test('a suffixed wish counts up from its own number', async () => {
    await runGit(repo, ['branch', 'fix-3', 'main']);
    expect((await create({ branch: 'fix-3' })).branch).toBe('fix-4');
  });

  test('a branch the person chose is used as it is', async () => {
    await runGit(repo, ['branch', 'feature', 'main']);
    const result = await create({ branch: 'feature', newBranch: false });
    expect(result.branch).toBe('feature');
    expect(await runGit(result.path, ['branch', '--show-current'])).toBe('feature');
  });

  test('a stale local copy of a PR branch is fast-forwarded to the remote', async () => {
    const other = await pushFromOther('pr-branch', 'one.txt');
    await runGit(repo, ['fetch', '-q', 'origin']);
    await runGit(repo, ['branch', '--no-track', 'pr-branch', 'origin/pr-branch']);
    const latest = await commitOn(other, 'two.txt', '2', 'Two');
    await runGit(other, ['push', '-q', 'origin', 'pr-branch']);

    const result = await create({ branch: 'pr-branch', newBranch: false });
    expect(result.branch).toBe('pr-branch');
    expect(await runGit(result.path, ['rev-parse', 'HEAD'])).toBe(latest);
  });

  test('a local PR branch with commits of its own is left alone', async () => {
    const other = await pushFromOther('pr-branch', 'one.txt');
    await runGit(repo, ['fetch', '-q', 'origin']);
    await runGit(repo, ['checkout', '-q', '--no-track', '-b', 'pr-branch', 'origin/pr-branch']);
    const mine = await commitOn(repo, 'mine.txt', 'mine', 'Mine');
    await runGit(repo, ['checkout', '-q', 'main']);
    await commitOn(other, 'two.txt', '2', 'Two');
    await runGit(other, ['push', '-q', 'origin', 'pr-branch']);

    const result = await create({ branch: 'pr-branch', newBranch: false });
    expect(await runGit(result.path, ['rev-parse', 'HEAD'])).toBe(mine);
  });

  test("a branch checked out in the person's checkout gets a clear refusal", async () => {
    await runGit(repo, ['checkout', '-q', '-b', 'busy']);
    await expect(create({ branch: 'busy', newBranch: false })).rejects.toThrow(
      `The branch busy is checked out in ${await fs.realpath(repo)}`,
    );
  });

  test('copies ignored env files only, and skips a missing file to copy', async () => {
    await fs.writeFile(path.join(repo, '.gitignore'), '.env.local\n.context/\n');
    await fs.writeFile(path.join(repo, '.env.local'), 'SECRET=ignored');
    await fs.writeFile(path.join(repo, '.envrc'), 'export SECRET=not-ignored');
    await fs.writeFile(path.join(repo, 'conductor.json'), JSON.stringify({ filesToCopy: ['missing.txt'] }));
    const result = await create();
    expect(await fs.readFile(path.join(result.path, '.env.local'), 'utf8')).toBe('SECRET=ignored');
    await expect(fs.access(path.join(result.path, '.envrc'))).rejects.toThrow();
  });

  (process.platform === 'win32' ? test.skip : test)('skips an env file that links out of the checkout', async () => {
    await fs.writeFile(path.join(directory, 'shared.env'), 'SECRET=shared');
    await fs.symlink(path.join(directory, 'shared.env'), path.join(repo, '.env'));
    const result = await create();
    await expect(fs.access(path.join(result.path, '.env'))).rejects.toThrow();
  });

  test('a failed create removes the branch it made', async () => {
    await fs.writeFile(path.join(repo, 'conductor.json'), JSON.stringify({ filesToCopy: ['.git/config'] }));
    await expect(create()).rejects.toThrow('Git metadata');
    expect(await runGit(repo, ['branch', '--list', 'fix-lint'])).toBe('');
  });
});
