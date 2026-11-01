import { execFile, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { constants, promises as fs } from 'fs';
import path from 'path';
import { TextDecoder } from 'util';
import {
  isValidBranchName,
  LOCAL_WORKTREE_STATUS_FILES_MAX,
  resolveStepArgv,
  type GitStep,
  type LocalWorktreeStatus,
  type RestoreWorktreeResult,
  type WorkbenchExecResult,
  type WorkbenchLocalBridge,
} from '@talyn/shared';
import { processEnv } from './environment';
import { readConfig } from './config';
import { WorkbenchPaths } from './paths';

const children = new Set<ChildProcess>();
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export async function readFileBase64(root: string, relative: string): Promise<string> {
  if (!/^\.context\/attachments\/[A-Za-z0-9._-]+$/.test(relative) || relative.includes('..')) {
    throw new Error('Invalid attachment path');
  }
  const target = await safeFilePath(root, relative);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Path is not a regular file');
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error('File exceeds the 10 MiB limit');
    const data = await handle.readFile();
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('File exceeds the 10 MiB limit');
    return data.toString('base64');
  } finally {
    await handle.close();
  }
}

/**
 * Write a pasted file to `.context/attachments/` in a worktree and return its
 * relative path. The data goes over IPC, never in an argv: a process argv
 * holds about 1 MiB on macOS, and a screenshot is often more.
 */
export async function writeAttachment(
  root: string,
  name: string,
  dataBase64: string,
): Promise<string> {
  if (typeof dataBase64 !== 'string' || dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4)
    throw new Error('File exceeds the 10 MiB limit');
  const data = Buffer.from(dataBase64, 'base64');
  if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('File exceeds the 10 MiB limit');
  const safe =
    String(name ?? '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+/, '')
      .slice(-100) || 'attachment';
  const realRoot = await fs.realpath(root);
  let parent = realRoot;
  for (const directory of ['.context', 'attachments']) {
    const next = path.join(parent, directory);
    await fs.mkdir(next, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(next)).isSymbolicLink())
      throw new Error('Attachment directory must not be a symlink');
    parent = next;
  }
  const relative = `.context/attachments/${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`;
  await fs.writeFile(path.join(realRoot, relative), data, { mode: 0o600, flag: 'wx' });
  return relative;
}

export async function exec(
  cwd: string,
  steps: GitStep[],
): Promise<WorkbenchExecResult> {
  const captures: Record<string, string> = Object.create(null);
  const result: WorkbenchExecResult = { exitCode: 0, stdout: '', stderr: '' };
  const env = await processEnv();
  for (const step of steps) {
    const [program, ...args] = resolveStepArgv(step, captures);
    if (!program) throw new Error('Git step has an empty argv');
    const stepEnv = Object.fromEntries(
      Object.entries(step.env ?? {}).map(([key, value]) => [
        key,
        resolveStepArgv({ argv: [value] }, captures)[0],
      ]),
    );
    const output = await new Promise<WorkbenchExecResult>((resolve) => {
      const child = execFile(
        program,
        args,
        {
          cwd,
          env: { ...env, ...stepEnv },
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 32 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          children.delete(child);
          resolve({
            exitCode: error
              ? typeof error.code === 'number'
                ? error.code
                : 1
              : 0,
            stdout,
            stderr: stderr || (error?.message ?? ''),
            ...(error?.killed ? { timedOut: true } : {}),
          });
        },
      );
      children.add(child);
    });
    if (step.capture) captures[step.capture] = output.stdout.trim();
    else result.stdout += output.stdout;
    result.stderr += output.stderr;
    result.exitCode = output.exitCode;
    if (output.timedOut) result.timedOut = true;
    if (output.exitCode !== 0 && !step.allowFailure) break;
  }
  return result;
}

export function stopGitProcesses(): void {
  for (const child of children) child.kill('SIGKILL');
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec(cwd, [{ argv: ['git', ...args] }]);
  if (result.exitCode !== 0)
    throw new Error(result.stderr || `Git exited with code ${result.exitCode}`);
  return result.stdout.trim();
}

export function relativePath(root: string, relative: string): string {
  if (
    !relative ||
    relative.includes('\0') ||
    relative.includes('\\') ||
    path.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative) ||
    relative.split('/').includes('..')
  )
    throw new Error('Invalid relative path');
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) throw new Error('Path escapes the worktree');
  return target;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

export async function safeFilePath(
  root: string,
  relative: string,
): Promise<string> {
  const realRoot = await fs.realpath(root);
  const target = await fs.realpath(relativePath(realRoot, relative));
  if (!isInside(realRoot, target)) throw new Error('Path escapes the worktree');
  return target;
}

export async function readFile(
  root: string,
  relative: string,
): Promise<{ content: string; binary: boolean }> {
  const target = await safeFilePath(root, relative);
  const before = await fs.stat(target);
  if (!before.isFile()) throw new Error('Path is not a regular file');
  if (before.size > MAX_FILE_BYTES)
    throw new Error('File exceeds the 2 MiB limit');
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Path is not a regular file');
    if (stat.size > MAX_FILE_BYTES)
      throw new Error('File exceeds the 2 MiB limit');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES)
      throw new Error('File exceeds the 2 MiB limit');
    const data = buffer.subarray(0, length);
    if (data.includes(0)) return { content: '', binary: true };
    try {
      return {
        content: new TextDecoder('utf-8', { fatal: true }).decode(data),
        binary: false,
      };
    } catch {
      return { content: '', binary: true };
    }
  } finally {
    await handle.close();
  }
}

export async function listFiles(worktree: string): Promise<string[]> {
  const result = await exec(worktree, [
    {
      argv: [
        'git',
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ],
    },
  ]);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return [...new Set(result.stdout.split('\0').filter(Boolean))];
}

async function hasRef(repository: string, ref: string): Promise<boolean> {
  const result = await exec(repository, [
    { argv: ['git', 'show-ref', '--verify', '--quiet', ref] },
  ]);
  return result.exitCode === 0;
}

async function isIgnored(repository: string, relative: string): Promise<boolean> {
  const result = await exec(repository, [
    { argv: ['git', 'check-ignore', '--quiet', '--', relative] },
  ]);
  return result.exitCode === 0;
}

/** `name`, else `name-2`, `name-3`, …: the first that is not a directory yet. */
async function freeWorktreeDir(
  paths: WorkbenchPaths,
  repoDir: string,
  name: string,
): Promise<string> {
  for (let suffix = 1; suffix < 1000; suffix++) {
    const candidate =
      suffix === 1 ? name : `${name.slice(0, 95)}-${suffix}`;
    const target = paths.worktree(repoDir, candidate);
    // An archived session keeps its folder name, so its restore can use it.
    if (await paths.loadArchived(target)) continue;
    try {
      await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target;
      throw error;
    }
  }
  throw new Error('No free directory for this session');
}

/** `wish`, else `wish-2`, `wish-3`, …: the first with no local or remote branch. */
export async function freeBranchName(
  repository: string,
  wish: string,
): Promise<string> {
  const match = /^(.*)-(\d+)$/.exec(wish);
  const stem = match ? match[1] : wish;
  const start = match ? Number(match[2]) : 1;
  for (let suffix = start; suffix < start + 1000; suffix++) {
    const candidate = suffix === start ? wish : `${stem}-${suffix}`;
    if (!isValidBranchName(candidate)) break;
    if (
      !(await hasRef(repository, `refs/heads/${candidate}`)) &&
      !(await hasRef(repository, `refs/remotes/origin/${candidate}`))
    )
      return candidate;
  }
  throw new Error(`No free branch name near ${wish}`);
}

/** The worktree that has `branch` checked out, or null. */
async function checkedOutAt(
  repository: string,
  branch: string,
): Promise<string | null> {
  // An entry whose directory was deleted is stale; prune drops it first.
  await exec(repository, [
    { argv: ['git', 'worktree', 'prune'], allowFailure: true },
  ]);
  const list = await exec(repository, [
    { argv: ['git', 'worktree', 'list', '--porcelain', '-z'] },
  ]);
  if (list.exitCode !== 0) return null;
  let current: string | null = null;
  for (const line of list.stdout.split('\0')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return null;
}

/**
 * Move a local branch up to `origin/<branch>` when that is a fast-forward. A
 * person's old copy of a PR branch must not start the session behind the PR.
 * A branch with commits of its own is left alone.
 */
async function fastForwardBranch(
  repository: string,
  branch: string,
): Promise<void> {
  const local = await exec(repository, [
    { argv: ['git', 'rev-parse', '--verify', `refs/heads/${branch}`] },
  ]);
  const remote = await exec(repository, [
    { argv: ['git', 'rev-parse', '--verify', `refs/remotes/origin/${branch}`] },
  ]);
  if (local.exitCode !== 0 || remote.exitCode !== 0) return;
  const from = local.stdout.trim();
  const to = remote.stdout.trim();
  if (from === to) return;
  const ancestor = await exec(repository, [
    { argv: ['git', 'merge-base', '--is-ancestor', from, to] },
  ]);
  if (ancestor.exitCode !== 0) return;
  // The old value makes this a compare-and-swap.
  await exec(repository, [
    { argv: ['git', 'update-ref', `refs/heads/${branch}`, to, from] },
  ]);
}

export class WorktreeManager {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly paths: WorkbenchPaths) {}

  createWorktree(
    input: Parameters<WorkbenchLocalBridge['createWorktree']>[0],
  ): Promise<{ path: string; branch: string }> {
    const pending = this.queue.then(() => this.create(input));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async create(
    input: Parameters<WorkbenchLocalBridge['createWorktree']>[0],
  ): Promise<{ path: string; branch: string }> {
    if (!input.repoPath && !input.cloneUrl)
      throw new Error('Select a repository or supply a clone URL');
    if (
      !isValidBranchName(input.branch) ||
      !isValidBranchName(input.baseBranch)
    )
      throw new Error('Invalid branch name');
    const source = input.repoPath
      ? await fs.realpath(
          await git(input.repoPath, 'rev-parse', '--show-toplevel'),
        )
      : undefined;
    const identity = source ?? input.cloneUrl!;
    const repoDir = this.paths.repoDir(identity);
    // A failed create can leave a folder, and an archived session keeps its
    // folder name: a new session with the same name gets the next free one.
    const target = await freeWorktreeDir(this.paths, repoDir, input.name);
    await fs.mkdir(repoDir, { recursive: true });
    let repository = source;
    if (!repository) {
      repository = path.join(repoDir, '.repo');
      try {
        await fs.access(repository);
      } catch {
        // A bare clone uses remote-tracking refs without a checked-out branch.
        await git(
          repoDir,
          'clone',
          '--bare',
          '--',
          input.cloneUrl!,
          repository,
        );
        await git(
          repository,
          'config',
          'remote.origin.fetch',
          '+refs/heads/*:refs/remotes/origin/*',
        );
      }
    }
    await git(repository, 'fetch', 'origin');
    // A name Talyn made up must never pick up a branch that already exists:
    // that branch holds other commits, maybe someone else's.
    const branch = input.newBranch
      ? await freeBranchName(repository, input.branch)
      : input.branch;
    const existing = await hasRef(repository, `refs/heads/${branch}`);
    const remote =
      !input.newBranch &&
      (await hasRef(repository, `refs/remotes/origin/${branch}`));
    if (existing) {
      const holder = await checkedOutAt(repository, branch);
      if (holder)
        throw new Error(
          `The branch ${branch} is checked out in ${holder}. Switch that checkout to another branch, then try again.`,
        );
      if (remote) await fastForwardBranch(repository, branch);
      await git(repository, 'worktree', 'add', '--', target, branch);
    } else
      await git(
        repository,
        'worktree',
        'add',
        '-b',
        branch,
        '--',
        target,
        `origin/${remote ? branch : input.baseBranch}`,
      );
    try {
      const common = await git(target, 'rev-parse', '--git-common-dir');
      const info = path.resolve(target, common, 'info');
      await fs.mkdir(info, { recursive: true });
      const exclude = path.join(info, 'exclude');
      let content = '';
      try {
        content = await fs.readFile(exclude, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!content.split(/\r?\n/).includes('.context/'))
        await fs.appendFile(exclude, '\n.context/\n');
      if (source) await copyLocalFiles(source, target);
      await this.paths.save({
        workbenchId: input.workbenchId,
        path: target,
        rootPath: repository,
        name: input.name,
        baseBranch: input.baseBranch,
      });
      return { path: target, branch };
    } catch (error) {
      await git(repository, 'worktree', 'remove', '--force', '--', target);
      await git(repository, 'worktree', 'prune');
      // The branch this attempt made has no commits of its own.
      if (!existing)
        await exec(repository, [
          { argv: ['git', 'branch', '-D', '--', branch], allowFailure: true },
        ]);
      throw error;
    }
  }

  /** What an archive of this worktree would lose. */
  async inspectWorktree(target: string): Promise<LocalWorktreeStatus> {
    const empty = { branch: null, uncommitted: [], uncommittedCount: 0, unpushed: null };
    const state = typeof target === 'string' ? await this.paths.load(target) : null;
    if (!state) return { managed: false, exists: await isDirectory(target), ...empty };
    await this.paths.assertManagedPath(target);
    if (!(await isDirectory(target))) return { managed: true, exists: false, ...empty };
    const status = await exec(target, [
      { argv: ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'] },
    ]);
    if (status.exitCode !== 0) throw new Error(status.stderr || 'git status failed');
    const files = parsePorcelainPaths(status.stdout);
    const branch = await exec(target, [{ argv: ['git', 'branch', '--show-current'] }]);
    let unpushed: number | null = null;
    if ((await listRemotes(target)).length) {
      const count = await exec(target, [
        { argv: ['git', 'rev-list', '--count', 'HEAD', '--not', '--remotes'] },
      ]);
      if (count.exitCode === 0) unpushed = Number(count.stdout.trim()) || 0;
    }
    return {
      managed: true,
      exists: true,
      branch: (branch.exitCode === 0 && branch.stdout.trim()) || null,
      uncommitted: files.slice(0, LOCAL_WORKTREE_STATUS_FILES_MAX),
      uncommittedCount: files.length,
      unpushed,
    };
  }

  /**
   * Archive: stop the session, remove its worktree, keep its branch. `stop`
   * gets the session id from the caller, because the id in the record is the
   * client id made before the session existed.
   */
  removeWorktree(
    input: Parameters<WorkbenchLocalBridge['removeWorktree']>[0],
    stop?: (workbenchId: string) => Promise<void>,
  ): Promise<void> {
    const pending = this.queue.then(() => this.remove(input, stop));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async remove(
    input: Parameters<WorkbenchLocalBridge['removeWorktree']>[0],
    stop?: (workbenchId: string) => Promise<void>,
  ): Promise<void> {
    if (typeof input?.workbenchId !== 'string' || !input.workbenchId)
      throw new Error('A session id is required.');
    const state = await this.paths.load(input.path);
    if (!state) throw new Error('This worktree is not managed by Talyn');
    await this.paths.assertManagedPath(input.path);
    await stop?.(input.workbenchId);
    let branch: string | null = null;
    if (await isDirectory(input.path)) {
      if (!(await isLinkedWorktree(state.rootPath, input.path)))
        throw new Error(
          `${input.path} is not a worktree of ${state.rootPath}, so Talyn did not remove it.`,
        );
      const status = await this.inspectWorktree(input.path);
      branch = status.branch;
      if (status.uncommittedCount > 0 && input.force !== true)
        throw new Error(
          'The worktree has uncommitted changes, so Talyn kept it. Archive the session again to see them.',
        );
      await git(
        state.rootPath,
        'worktree',
        'remove',
        ...(input.force === true ? ['--force'] : []),
        '--',
        input.path,
      );
    }
    await exec(state.rootPath, [
      { argv: ['git', 'worktree', 'prune'], allowFailure: true },
    ]);
    await this.paths.archive({ ...state, workbenchId: input.workbenchId, branch });
  }

  /** Restore: the worktree again, at the same path, from the session's branch. */
  restoreWorktree(
    input: Parameters<NonNullable<WorkbenchLocalBridge['restoreWorktree']>>[0],
  ): Promise<RestoreWorktreeResult> {
    const pending = this.queue.then(() => this.restore(input));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async restore(
    input: Parameters<NonNullable<WorkbenchLocalBridge['restoreWorktree']>>[0],
  ): Promise<RestoreWorktreeResult> {
    if (
      typeof input?.path !== 'string' ||
      typeof input.branch !== 'string' ||
      typeof input.workbenchId !== 'string' ||
      !input.workbenchId
    )
      throw new Error('A path, a branch and a session id are required.');
    const live = await this.paths.load(input.path);
    // An archive from before Talyn removed worktrees, or a removal that failed.
    if (live && (await isDirectory(input.path)))
      return { ok: true, branch: input.branch };
    const archived =
      (await this.paths.loadArchived(input.path)) ??
      (live ? { ...live, branch: null } : null);
    if (!archived)
      return {
        ok: false,
        reason: 'not_managed',
        message:
          'Talyn has no record of this worktree on this computer, so it cannot make it again.',
      };
    await this.paths.assertManagedPath(input.path);
    if (await pathExists(input.path))
      return {
        ok: false,
        reason: 'path_taken',
        message: `The folder ${input.path} already exists. Move it, then restore the session again.`,
      };
    const repository = archived.rootPath;
    if (!(await isDirectory(repository)))
      return {
        ok: false,
        reason: 'repository_missing',
        message: `The repository at ${repository} is gone, so Talyn cannot make the worktree again.`,
      };
    const wanted = [...new Set([input.branch, archived.branch])].filter(
      (name): name is string =>
        typeof name === 'string' && isValidBranchName(name),
    );
    let branch = '';
    let from: string | null = null;
    for (const name of wanted) {
      if (await hasRef(repository, `refs/heads/${name}`)) {
        branch = name;
        break;
      }
    }
    // A branch deleted here that a remote still has comes back from the remote.
    const remotes = branch ? [] : await listRemotes(repository);
    for (const name of branch ? [] : wanted) {
      const remote = await firstAsync(remotes, (r) =>
        hasRef(repository, `refs/remotes/${r.name}/${name}`),
      );
      if (remote) {
        branch = name;
        from = `${remote.name}/${name}`;
        break;
      }
    }
    if (!branch)
      return {
        ok: false,
        reason: 'branch_missing',
        message: `The branch ${input.branch} was deleted from ${repository}, so Talyn cannot make the worktree again. The session stays in History.`,
      };
    if (!from) {
      const holder = await checkedOutAt(repository, branch);
      if (holder)
        return {
          ok: false,
          reason: 'branch_busy',
          message: `The branch ${branch} is checked out in ${holder}. Switch that checkout to another branch, then restore the session again.`,
        };
    }
    await fs.mkdir(path.dirname(input.path), { recursive: true });
    if (from)
      await git(repository, 'worktree', 'add', '--no-track', '-b', branch, '--', input.path, from);
    else await git(repository, 'worktree', 'add', '--', input.path, branch);
    // The env files were in the folder the archive removed.
    if (!isBareClone(repository, input.path))
      await copyLocalFiles(repository, input.path).catch((error) =>
        console.warn('[workbench] restoring local files failed:', error),
      );
    await this.paths.save({
      workbenchId: input.workbenchId,
      path: input.path,
      rootPath: repository,
      name: archived.name,
      baseBranch: archived.baseBranch,
    });
    await this.paths.forgetArchived(input.path);
    return { ok: true, branch };
  }
}

async function firstAsync<T>(
  items: T[],
  test: (item: T) => Promise<boolean>,
): Promise<T | undefined> {
  for (const item of items) if (await test(item)) return item;
  return undefined;
}

/** The clone Talyn made when a session had no local checkout. */
function isBareClone(repository: string, worktree: string): boolean {
  return repository === path.join(path.dirname(worktree), '.repo');
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.lstat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** The paths `git status --porcelain=v1 -z` lists. A rename's old path is not counted. */
export function parsePorcelainPaths(stdout: string): string[] {
  const tokens = stdout.split('\0');
  const files: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    files.push(token.slice(3));
    if (token[0] === 'R' || token[0] === 'C') i++;
  }
  return files;
}

export async function listRemotes(
  repository: string,
): Promise<Array<{ name: string; url: string }>> {
  const result = await exec(repository, [
    {
      argv: ['git', 'config', '--get-regexp', '^remote\\..*\\.url$'],
      allowFailure: true,
    },
  ]);
  if (result.exitCode !== 0) return [];
  const remotes: Array<{ name: string; url: string }> = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
    if (match) remotes.push({ name: match[1], url: match[2] });
  }
  return remotes;
}

/** True when `target` is a linked worktree of `repository`, never its main checkout. */
async function isLinkedWorktree(
  repository: string,
  target: string,
): Promise<boolean> {
  const list = await exec(repository, [
    { argv: ['git', 'worktree', 'list', '--porcelain', '-z'] },
  ]);
  if (list.exitCode !== 0) return false;
  const realTarget = await fs.realpath(target);
  const listed = list.stdout
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
  for (const [index, entry] of listed.entries()) {
    const real = await fs.realpath(entry).catch(() => entry);
    // Git lists the main worktree first.
    if (real === realTarget) return index > 0;
  }
  return false;
}

/** Ignored env files and `filesToCopy`, from the person's checkout into a worktree. */
async function copyLocalFiles(source: string, target: string): Promise<void> {
  const config = await readConfig(source);
  // Only an env file git ignores: one it does not ignore shows up as a
  // new file in the session, and Create PR (`git add -A`) would push it.
  const envFiles: string[] = [];
  for (const name of await fs.readdir(source)) {
    if (name.startsWith('.env') && (await isIgnored(source, name)))
      envFiles.push(name);
  }
  for (const relative of new Set([...envFiles, ...config.filesToCopy])) {
    if (relative.split('/').includes('.git'))
      throw new Error('Cannot copy Git metadata');
    let from: string;
    try {
      from = await safeFilePath(source, relative);
    } catch (error) {
      // A missing file, or a link out of the checkout, is not copied. It
      // must not stop the session from being made.
      console.warn(`[workbench] not copying ${relative}:`, error);
      continue;
    }
    const destination = relativePath(target, relative);
    if (!(await fs.stat(from)).isFile()) continue;
    const realTarget = await fs.realpath(target);
    let parent = realTarget;
    const directories = path
      .relative(target, path.dirname(destination))
      .split(path.sep)
      .filter(Boolean);
    for (const directory of directories) {
      const next = path.join(parent, directory);
      try {
        await fs.mkdir(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      parent = await fs.realpath(next);
      if (!isInside(realTarget, parent))
        throw new Error('Copy path escapes the worktree');
    }
    // Remove a destination symlink before copying secrets into the worktree.
    await fs.rm(destination, { force: true });
    await fs.copyFile(from, destination);
  }
}
