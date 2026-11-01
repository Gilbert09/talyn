import { execFile, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { constants, promises as fs } from 'fs';
import path from 'path';
import { TextDecoder } from 'util';
import {
  isValidBranchName,
  resolveStepArgv,
  type GitStep,
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
    // An archived session keeps its worktree, and a failed create can leave one:
    // a new session with the same name gets the next free directory.
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
      if (source) {
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
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error;
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

  async removeWorktree(
    input: Parameters<WorkbenchLocalBridge['removeWorktree']>[0],
  ): Promise<void> {
    const state = await this.paths.load(input.path);
    if (!state) throw new Error('This worktree is not managed by Talyn');
    await git(
      state.rootPath,
      'worktree',
      'remove',
      ...(input.force === false ? [] : ['--force']),
      '--',
      input.path,
    );
    await git(state.rootPath, 'worktree', 'prune');
    await this.paths.forget(input.path);
  }
}
