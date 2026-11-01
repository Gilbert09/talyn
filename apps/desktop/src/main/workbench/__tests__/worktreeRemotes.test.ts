/** @jest-environment node */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { WorktreeManager } from '../git';
import { WorkbenchPaths } from '../paths';
import { chooseRemote } from '../remotes';
import { RepoPaths } from '../repoPaths';
import * as environment from '../environment';
import { runGit, temporaryRepo, testEnv } from '../testSupport';

jest.setTimeout(30_000);


let directory: string;
let repo: string;
let manager: WorktreeManager;

const commitOn = async (cwd: string, file: string, message: string) => {
  await fs.writeFile(path.join(cwd, file), file);
  await runGit(cwd, ['add', file]);
  await runGit(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
  return runGit(cwd, ['rev-parse', 'HEAD']);
};

/** A bare copy of the repository that `url` fetches from, as GitHub would serve it. */
const serve = async (name: string, url: string) => {
  const bare = path.join(directory, `${name}.git`);
  await runGit(directory, ['clone', '-q', '--bare', repo, bare]);
  await runGit(repo, ['config', `url.${bare}.insteadOf`, url]);
  return bare;
};

/** One more commit on `main` in a served copy, which the checkout has not fetched. */
const advance = async (bare: string) => {
  const other = path.join(directory, `work-${path.basename(bare)}`);
  await runGit(directory, ['clone', '-q', bare, other]);
  const sha = await commitOn(other, 'upstream.txt', 'Upstream');
  await runGit(other, ['push', '-q', 'origin', 'main']);
  return sha;
};

beforeEach(async () => {
  ({ directory, repo } = await temporaryRepo());
  jest.spyOn(environment, 'processEnv').mockResolvedValue(testEnv);
  manager = new WorktreeManager(new WorkbenchPaths(path.join(directory, 'state'), path.join(directory, 'workbenches')));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

const create = (over: Partial<Parameters<WorktreeManager['createWorktree']>[0]> = {}) =>
  manager.createWorktree({
    repoPath: repo,
    repoFullName: 'acme/app',
    workbenchId: 'wb',
    name: 'rome',
    branch: 'rome',
    baseBranch: 'main',
    newBranch: true,
    ...over,
  });

describe('creating a worktree in a checkout without origin', () => {
  test('fetches from the remote whose URL is the repository, not from origin', async () => {
    const upstream = await serve('upstream', 'https://github.com/acme/app.git');
    await serve('fork', 'https://github.com/me/app-fork.git');
    await runGit(repo, ['remote', 'add', 'origin', 'https://github.com/me/app-fork.git']);
    await runGit(repo, ['remote', 'add', 'upstream', 'https://github.com/acme/app.git']);
    const latest = await advance(upstream);

    const result = await create();
    expect(result.notice).toBeUndefined();
    expect(await runGit(result.path, ['rev-parse', 'HEAD'])).toBe(latest);
  });

  test('uses the only remote when its URL does not name the repository', async () => {
    const upstream = await serve('upstream', 'https://example.com/acme/app.git');
    await runGit(repo, ['remote', 'add', 'upstream', 'https://example.com/acme/app.git']);
    const latest = await advance(upstream);

    const result = await create();
    expect(await runGit(result.path, ['rev-parse', 'HEAD'])).toBe(latest);
  });

  test('a PR branch on a non-origin remote is checked out from that remote', async () => {
    const upstream = await serve('upstream', 'https://github.com/acme/app.git');
    await runGit(repo, ['remote', 'add', 'upstream', 'https://github.com/acme/app.git']);
    const other = path.join(directory, 'teammate');
    await runGit(directory, ['clone', '-q', upstream, other]);
    await runGit(other, ['checkout', '-q', '-b', 'pr-branch']);
    const sha = await commitOn(other, 'pr.txt', 'PR');
    await runGit(other, ['push', '-q', 'origin', 'pr-branch']);

    const result = await create({ branch: 'pr-branch', newBranch: false });
    expect(result.branch).toBe('pr-branch');
    expect(await runGit(result.path, ['rev-parse', 'HEAD'])).toBe(sha);
  });

  test('with no remote, makes the session from the local base without fetching, and says so', async () => {
    const local = await commitOn(repo, 'local.txt', 'Local only');
    const result = await create();
    expect(result.notice).toBe(
      'This repository has no remote, so Talyn made the session from your local main branch without fetching.',
    );
    expect(await runGit(result.path, ['rev-parse', 'HEAD'])).toBe(local);
    expect(await runGit(result.path, ['branch', '--show-current'])).toBe('rome');
  });

  test('with no remote and no local base, refuses clearly', async () => {
    await expect(create({ baseBranch: 'develop' })).rejects.toThrow(
      'This repository has no remote, and it has no local branch develop',
    );
  });

  test('a clean worktree with no remote reports no unpushed count', async () => {
    const { path: worktree } = await create();
    expect(await manager.inspectWorktree(worktree)).toMatchObject({ uncommittedCount: 0, unpushed: null });
  });
});

test.each([
  ['the remote that names the repository', [['origin', 'https://github.com/me/fork.git'], ['upstream', 'git@github.com:Acme/App.git']], 'acme/app', 'upstream'],
  ['the only remote', [['upstream', 'https://example.com/x.git']], 'acme/app', 'upstream'],
  ['origin among several that do not match', [['a', 'https://example.com/a.git'], ['origin', 'https://example.com/o.git']], 'acme/app', 'origin'],
  ['nothing among several without origin', [['a', 'https://example.com/a.git'], ['b', 'https://example.com/b.git']], 'acme/app', null],
  ['nothing without remotes', [], 'acme/app', null],
  ['the only remote with no repository given', [['up', 'https://github.com/acme/app.git']], undefined, 'up'],
] as const)('chooses %s', (_name, remotes, repoFullName, expected) => {
  expect(chooseRemote(remotes.map(([name, url]) => ({ name, url })), repoFullName)).toBe(expected);
});

describe('the folder picker', () => {
  let userData: string;
  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'talyn-userdata-'));
  });
  afterEach(() => fs.rm(userData, { recursive: true, force: true }));

  test('refuses a folder that is not a Git repository', async () => {
    const plain = path.join(directory, 'plain');
    await fs.mkdir(plain);
    await expect(new RepoPaths(userData).record(plain, 'acme/app')).rejects.toThrow(
      'That folder is not a Git repository.',
    );
  });

  test('refuses a checkout of another repository', async () => {
    await runGit(repo, ['remote', 'add', 'origin', 'https://github.com/other/thing.git']);
    await expect(new RepoPaths(userData).record(repo, 'acme/app')).rejects.toThrow(
      'That folder is a checkout of other/thing, not acme/app.',
    );
  });

  test('refuses a repository with no remote for it', async () => {
    await expect(new RepoPaths(userData).record(repo, 'acme/app')).rejects.toThrow(
      'That folder has no Git remote for acme/app.',
    );
  });

  test('accepts a fork whose upstream is the repository, from a subfolder', async () => {
    await runGit(repo, ['remote', 'add', 'origin', 'https://github.com/me/fork.git']);
    await runGit(repo, ['remote', 'add', 'upstream', 'https://github.com/acme/app.git']);
    const sub = path.join(repo, 'src');
    await fs.mkdir(sub);
    const store = new RepoPaths(userData);
    const root = await fs.realpath(repo);
    expect(await store.record(sub, 'acme/app')).toBe(root);
    expect(await store.get()).toEqual({ 'acme/app': root });
  });

  test('with no repository asked for, records the one origin names', async () => {
    await runGit(repo, ['remote', 'add', 'origin', 'git@github.com:acme/app.git']);
    const store = new RepoPaths(userData);
    expect(await store.record(repo)).toBe(await fs.realpath(repo));
    expect(await store.get()).toEqual({ 'acme/app': await fs.realpath(repo) });
  });
});
