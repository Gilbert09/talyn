import { execFile, type ChildProcess } from 'child_process';
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

export class WorktreeManager {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly paths: WorkbenchPaths) {}

  createWorktree(
    input: Parameters<WorkbenchLocalBridge['createWorktree']>[0],
  ): Promise<{ path: string }> {
    const pending = this.queue.then(() => this.create(input));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async create(
    input: Parameters<WorkbenchLocalBridge['createWorktree']>[0],
  ): Promise<{ path: string }> {
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
    const target = this.paths.worktree(repoDir, input.name);
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
    const existing = await exec(repository, [
      {
        argv: [
          'git',
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${input.branch}`,
        ],
      },
    ]);
    const remote = await exec(repository, [
      {
        argv: [
          'git',
          'show-ref',
          '--verify',
          '--quiet',
          `refs/remotes/origin/${input.branch}`,
        ],
      },
    ]);
    if (existing.exitCode === 0)
      await git(repository, 'worktree', 'add', '--', target, input.branch);
    else
      await git(
        repository,
        'worktree',
        'add',
        '-b',
        input.branch,
        '--',
        target,
        `origin/${remote.exitCode === 0 ? input.branch : input.baseBranch}`,
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
        const envFiles = (await fs.readdir(source)).filter((name) =>
          name.startsWith('.env'),
        );
        for (const relative of new Set([...envFiles, ...config.filesToCopy])) {
          if (relative.split('/').includes('.git'))
            throw new Error('Cannot copy Git metadata');
          const from = await safeFilePath(source, relative);
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
      return { path: target };
    } catch (error) {
      await git(repository, 'worktree', 'remove', '--force', '--', target);
      await git(repository, 'worktree', 'prune');
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
