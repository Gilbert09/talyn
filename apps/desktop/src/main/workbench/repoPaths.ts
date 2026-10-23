import { promises as fs } from 'fs';
import path from 'path';
import { git } from './git';

export type RepoPathMap = Record<string, string>;
interface RepoPathState {
  paths: RepoPathMap;
  scanRoots: string[];
}

/** `owner/name` from an https or ssh GitHub remote URL, or null. */
export function repoFullNameFromRemote(remoteUrl: string): string | null {
  const match = remoteUrl
    .trim()
    .match(
      /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

export class RepoPaths {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(userData: string) {
    this.file = path.join(userData, 'workbench-repo-paths.json');
  }

  private async read(): Promise<RepoPathState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { paths: {}, scanRoots: [] };
      if (parsed.paths && typeof parsed.paths === 'object' && !Array.isArray(parsed.paths)) {
        return {
          paths: parsed.paths as RepoPathMap,
          scanRoots: Array.isArray(parsed.scanRoots)
            ? parsed.scanRoots.filter((root: unknown) => typeof root === 'string' && path.isAbsolute(root))
            : [],
        };
      }
      return { paths: parsed as RepoPathMap, scanRoots: [] };
    } catch {
      return { paths: {}, scanRoots: [] };
    }
  }

  async get(): Promise<RepoPathMap> {
    return (await this.read()).paths;
  }

  async getScanRoots(): Promise<string[]> {
    return (await this.read()).scanRoots;
  }

  private mutate<T>(change: (state: RepoPathState) => T): Promise<T> {
    const run = async () => {
      const state = await this.read();
      const result = change(state);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(state, null, 2), {
        mode: 0o600,
      });
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private keyFor(map: RepoPathMap, repoFullName: string): string {
    const lower = repoFullName.toLowerCase();
    return Object.keys(map).find((key) => key.toLowerCase() === lower) ?? repoFullName;
  }

  async set(input: { repoFullName: string; path: string; ifMissing?: boolean }): Promise<RepoPathMap> {
    const repoFullName = input.repoFullName.trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName))
      throw new Error('Invalid repository name');
    if (!path.isAbsolute(input.path)) throw new Error('The path must be absolute');
    let root: string;
    try {
      // Git prints forward slashes on Windows; store the platform's own form.
      root = path.resolve(await git(input.path, 'rev-parse', '--show-toplevel'));
    } catch {
      throw new Error('That folder is not a Git repository');
    }
    let remote: string;
    try {
      remote = await git(root, 'remote', 'get-url', 'origin');
    } catch {
      remote = '';
    }
    const actual = remote ? repoFullNameFromRemote(remote) : null;
    let matches = actual?.toLowerCase() === repoFullName.toLowerCase();
    if (!matches) {
      const remotes = (await git(root, 'remote')).split(/\r?\n/).filter(Boolean);
      for (const name of remotes) {
        if (name === 'origin') continue;
        const url = await git(root, 'remote', 'get-url', name);
        const candidate = repoFullNameFromRemote(url);
        if (candidate?.toLowerCase() === repoFullName.toLowerCase()) {
          matches = true;
          break;
        }
      }
    }
    if (!matches) {
      if (!remote) throw new Error('That repository has no origin or matching remote');
      throw new Error(
        `That repository's origin is ${actual ?? remote}, not ${repoFullName}`,
      );
    }
    return this.mutate(({ paths }) => {
      const key = this.keyFor(paths, repoFullName);
      if (!input.ifMissing || !paths[key]) paths[key] = root;
      return paths;
    });
  }

  remove(repoFullName: string): Promise<RepoPathMap> {
    return this.mutate(({ paths }) => {
      delete paths[this.keyFor(paths, repoFullName)];
      return paths;
    });
  }

  addScanRoot(root: string): Promise<string[]> {
    if (!path.isAbsolute(root)) throw new Error('The path must be absolute');
    const absolute = path.resolve(root);
    return this.mutate(({ scanRoots }) => {
      if (!scanRoots.includes(absolute)) scanRoots.push(absolute);
      return scanRoots;
    });
  }

  removeScanRoot(root: string): Promise<string[]> {
    return this.mutate((state) => {
      state.scanRoots = state.scanRoots.filter((saved) => saved !== root);
      return state.scanRoots;
    });
  }
}
