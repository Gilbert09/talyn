import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export interface WorkbenchState {
  workbenchId: string;
  path: string;
  rootPath: string;
  name: string;
  baseBranch: string;
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
}
