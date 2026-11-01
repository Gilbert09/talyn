import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { KeptWorktree } from '@talyn/shared';

export interface WorkbenchState {
  workbenchId: string;
  path: string;
  rootPath: string;
  name: string;
  baseBranch: string;
  copiedFiles?: Record<string, string>;
  archiveChecked?: boolean;
  keptWorktree?: KeptWorktree | null;
}

/** A worktree an archive removed. Its path stays reserved, so a restore can use it again. */
export interface ArchivedWorktreeState extends WorkbenchState {
  /** The branch the worktree had checked out, or null when it could not be read. */
  branch: string | null;
}

export class WorkbenchPaths {
  readonly root: string;
  readonly stateDir: string;

  constructor(
    userData: string,
    root = path.join(os.homedir(), 'talyn', 'workbenches'),
  ) {
    this.root = root;
    this.stateDir = path.join(userData, 'workbenches');
  }

  repoDir(identity: string): string {
    const label =
      identity
        .replace(/\.git\/?$/, '')
        .split(/[/:\\]/)
        .filter(Boolean)
        .pop() ?? 'repo';
    const slug = label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'repo';
    return path.join(this.root, `${slug}-${this.key(identity).slice(0, 10)}`);
  }

  worktree(repoDir: string, name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(name))
      throw new Error('Invalid workbench name');
    return path.join(repoDir, name);
  }

  async tempIndex(): Promise<string> {
    const dir = path.join(this.stateDir, 'indexes');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return path.join(dir, randomUUID());
  }

  private key(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  async save(state: WorkbenchState): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(this.stateDir, `${this.key(state.path)}.json`),
      JSON.stringify(state),
      { mode: 0o600 },
    );
  }

  async load(worktree: string): Promise<WorkbenchState | null> {
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(this.stateDir, `${this.key(worktree)}.json`),
          'utf8',
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async forget(worktree: string): Promise<void> {
    await fs.rm(path.join(this.stateDir, `${this.key(worktree)}.json`), {
      force: true,
    });
  }

  private archivedFile(worktree: string): string {
    return path.join(this.stateDir, 'archived', `${this.key(worktree)}.json`);
  }

  /** Move a worktree's record to the archived records, after its folder is gone. */
  async archive(state: ArchivedWorktreeState): Promise<void> {
    await fs.mkdir(path.dirname(this.archivedFile(state.path)), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.archivedFile(state.path), JSON.stringify(state), { mode: 0o600 });
    await this.forget(state.path);
  }

  async loadArchived(worktree: string): Promise<ArchivedWorktreeState | null> {
    try {
      return JSON.parse(await fs.readFile(this.archivedFile(worktree), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async forgetArchived(worktree: string): Promise<void> {
    await fs.rm(this.archivedFile(worktree), { force: true });
  }

  /**
   * Refuse any folder that is not `<root>/<repository folder>/<session
   * folder>`, the only shape `worktree()` makes. Checked on the real paths
   * too, so a symlink cannot lead a removal out of the root.
   */
  async assertManagedPath(target: string): Promise<void> {
    const refuse = () => {
      throw new Error(`Talyn removes only the folders it made under ${this.root}.`);
    };
    if (typeof target !== 'string' || !path.isAbsolute(target) || path.resolve(target) !== target) refuse();
    if (!isSessionFolder(this.root, target)) refuse();
    const realRoot = await fs.realpath(this.root).catch(() => this.root);
    let real: string;
    try {
      real = await fs.realpath(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = await fs.realpath(path.dirname(target)).catch(() => path.dirname(target));
      real = path.join(parent, path.basename(target));
    }
    if (!isSessionFolder(realRoot, real)) refuse();
  }
}

function isSessionFolder(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  return parts.length === 2 && parts.every((part) => part && part !== '.' && part !== '..');
}
