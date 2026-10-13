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

test('does not create copy directories through a worktree symlink', async () => {
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
