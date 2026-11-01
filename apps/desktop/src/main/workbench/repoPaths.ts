import { promises as fs } from 'fs';
import path from 'path';
import { git, listRemotes } from './git';
import { repoFullNameFromRemote } from './remotes';

export { repoFullNameFromRemote } from './remotes';

export type RepoPathMap = Record<string, string>;
interface RepoPathState {
  paths: RepoPathMap;
  scanRoots: string[];
}

/** The top of the Git repository at `folder`, or a clear refusal. */
export async function repositoryRoot(folder: string): Promise<string> {
  try {
    // Git prints forward slashes on Windows; store the platform's own form.
    return path.resolve(await git(folder, 'rev-parse', '--show-toplevel'));
  } catch {
    throw new Error('That folder is not a Git repository.');
  }
}

/**
 * Refuse a checkout that is not of `repoFullName`: some remote must point
 * to it. A fork's checkout passes when its `upstream` does.
 */
export async function assertCheckoutOf(root: string, repoFullName: string): Promise<void> {
  const names = (await listRemotes(root))
    .sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'))
    .map((remote) => repoFullNameFromRemote(remote.url));
  if (names.some((name) => name?.toLowerCase() === repoFullName.toLowerCase())) return;
  const other = names.find(Boolean);
  if (other) throw new Error(`That folder is a checkout of ${other}, not ${repoFullName}.`);
  throw new Error(`That folder has no Git remote for ${repoFullName}.`);
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
    const root = await repositoryRoot(input.path);
    await assertCheckoutOf(root, repoFullName);
    return this.mutate(({ paths }) => {
      const key = this.keyFor(paths, repoFullName);
      if (!input.ifMissing || !paths[key]) paths[key] = root;
      return paths;
    });
  }

  /**
   * A folder the person picked. With `expectRepo` it must be a checkout of
   * that repository, or this throws why not. Without it, the folder is
   * recorded for the GitHub repository its remote names, if any. Returns the
   * repository root.
   */
  async record(folder: string, expectRepo?: string): Promise<string> {
    const root = await repositoryRoot(folder);
    if (expectRepo) {
      await this.set({ repoFullName: expectRepo, path: root });
      return root;
    }
    const remotes = (await listRemotes(root)).sort(
      (a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'),
    );
    const repoFullName = remotes.map((remote) => repoFullNameFromRemote(remote.url)).find(Boolean);
    if (repoFullName) await this.set({ repoFullName, path: root }).catch(() => undefined);
    return root;
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
