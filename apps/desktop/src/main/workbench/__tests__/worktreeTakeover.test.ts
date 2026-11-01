/** @jest-environment node */
import { promises as fs } from 'fs';
import path from 'path';
import { WorktreeManager } from '../git';
import { WorkbenchPaths } from '../paths';
import * as environment from '../environment';
import { runGit, temporaryRepo, testEnv } from '../testSupport';

jest.setTimeout(30_000);

let directory: string;
let repo: string;
let remote: string;
let paths: WorkbenchPaths;
let manager: WorktreeManager;

beforeEach(async () => {
  ({ directory, repo } = await temporaryRepo());
  jest.spyOn(environment, 'processEnv').mockResolvedValue(testEnv);
  remote = path.join(directory, 'remote.git');
  await runGit(directory, ['clone', '--bare', repo, remote]);
  await runGit(repo, ['remote', 'add', 'upstream', remote]);
  paths = new WorkbenchPaths(path.join(directory, 'state'), path.join(directory, 'managed'));
  manager = new WorktreeManager(paths);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

const input = () => ({
  repoPath: repo, repoFullName: 'owner/repo', workbenchId: 'session-1',
  name: 'lisbon', branch: 'tom/lisbon', baseBranch: 'main',
});

test('takes over a branch from the selected remote into a managed worktree', async () => {
  const sha = await runGit(repo, ['rev-parse', 'HEAD']);
  await runGit(repo, ['update-ref', 'refs/heads/tom/lisbon', sha]);
  await runGit(repo, ['push', 'upstream', 'refs/heads/tom/lisbon']);
  await runGit(repo, ['update-ref', '-d', 'refs/heads/tom/lisbon']);

  const result = await manager.takeOverWorktree(input());
  expect(result).toMatchObject({ ok: true, branch: 'tom/lisbon' });
  if (!result.ok || !result.path) throw new Error('No worktree');
  expect(result.path.startsWith(paths.root + path.sep)).toBe(true);
  expect(await runGit(result.path, ['rev-parse', 'HEAD'])).toBe(sha);
  expect(await paths.load(result.path)).toMatchObject({ workbenchId: 'session-1', rootPath: await fs.realpath(repo) });
  expect(await manager.takeOverWorktree(input())).toEqual(result);
});

test('keeps a branch that exists only on the other computer read-only', async () => {
  const result = await manager.takeOverWorktree(input());
  expect(result).toMatchObject({ ok: false, reason: 'branch_missing' });
  expect(await fs.readdir(paths.root).catch(() => [])).toEqual([]);
});
