import { promises as fs } from 'fs';
import path from 'path';
import { git } from './git';

export type RepoPathMap = Record<string, string>;

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

  async get(): Promise<RepoPathMap> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as RepoPathMap)
        : {};
    } catch {
      return {};
    }
  }

  private mutate(change: (map: RepoPathMap) => void): Promise<RepoPathMap> {
    const run = async () => {
      const map = await this.get();
      change(map);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(map, null, 2), {
        mode: 0o600,
      });
      return map;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private keyFor(map: RepoPathMap, repoFullName: string): string {
    const lower = repoFullName.toLowerCase();
    return Object.keys(map).find((key) => key.toLowerCase() === lower) ?? repoFullName;
  }

  async set(input: { repoFullName: string; path: string }): Promise<RepoPathMap> {
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
      throw new Error('That repository has no origin remote');
    }
    const actual = repoFullNameFromRemote(remote);
    if (!actual || actual.toLowerCase() !== repoFullName.toLowerCase())
      throw new Error(
        `That repository's origin is ${actual ?? remote}, not ${repoFullName}`,
      );
    return this.mutate((map) => {
      map[this.keyFor(map, repoFullName)] = root;
    });
  }

  remove(repoFullName: string): Promise<RepoPathMap> {
    return this.mutate((map) => {
      delete map[this.keyFor(map, repoFullName)];
    });
  }
}
