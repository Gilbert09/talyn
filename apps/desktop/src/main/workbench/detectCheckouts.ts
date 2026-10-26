import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { repoFullNameFromRemote } from './repoPaths';

const SKIP = new Set([
  'Library', 'node_modules', 'Pictures', 'Music', 'Movies', 'Applications',
  'Desktop', 'Documents', 'Downloads', 'go', 'venv', 'vendor', 'dist',
  'build', 'target', 'Pods', 'DerivedData',
]);

// Network and removable volumes live here. Reading one can make macOS ask for permission.
const VOLUME_PARENTS = ['/Volumes', '/Network', '/mnt', '/media', '/run/media'];

function unescapeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * Mount points that do not hold the home folder. The scan never steps into one,
 * so it does not touch a network share or an external disk. The list comes from
 * the mount table, never from a stat of the mount point itself.
 */
export async function foreignMounts(home: string, platform = process.platform): Promise<Set<string>> {
  let points: string[] = [];
  try {
    if (platform === 'linux') {
      const table = await fs.readFile('/proc/self/mounts', 'utf8');
      points = table.split('\n').map((line) => line.split(' ')[1]).filter(Boolean).map(unescapeMountPath);
    } else if (platform === 'darwin') {
      const table = await new Promise<string>((resolve, reject) => {
        execFile('/sbin/mount', { timeout: 2000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
      });
      points = table.split('\n')
        .map((line) => line.match(/ on (.+) \([^()]*\)$/)?.[1])
        .filter((point): point is string => Boolean(point));
    }
  } catch {
    points = [];
  }
  const holdsHome = (point: string) => point === '/' || home === point || home.startsWith(point.endsWith('/') ? point : `${point}/`);
  return new Set(points.filter((point) => !holdsHome(point)).map((point) => path.resolve(point)));
}

function insideAny(dir: string, parents: Iterable<string>): boolean {
  for (const parent of parents) {
    if (dir === parent || dir.startsWith(`${parent}${path.sep}`)) return true;
  }
  return false;
}

interface Match {
  path: string;
  main: boolean;
  origin: boolean;
}

export async function readCheckoutConfig(checkout: string, main: boolean): Promise<string | null> {
  const dotGit = path.join(checkout, '.git');
  try {
    if (main) return await fs.readFile(path.join(dotGit, 'config'), 'utf8');
    const pointer = await fs.readFile(dotGit, 'utf8');
    const gitdir = pointer.match(/^gitdir:\s*(.+)\s*$/im)?.[1]?.trim();
    if (!gitdir) return null;
    const gitDirPath = path.resolve(checkout, gitdir);
    let commonDir = gitDirPath;
    try {
      const relative = (await fs.readFile(path.join(gitDirPath, 'commondir'), 'utf8')).trim();
      commonDir = path.resolve(gitDirPath, relative);
    } catch {
      // A gitdir can also point directly to the common directory.
    }
    return await fs.readFile(path.join(commonDir, 'config'), 'utf8');
  } catch {
    return null;
  }
}

export function matchingRemote(config: string, wanted: Set<string>): Map<string, boolean> {
  let remote = '';
  const matches = new Map<string, boolean>();
  for (const line of config.split(/\r?\n/)) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\s*\]/i);
    if (section) {
      remote = section[1].toLowerCase();
      continue;
    }
    if (/^\s*\[/.test(line)) {
      remote = '';
      continue;
    }
    const url = remote && line.match(/^\s*url\s*=\s*(.*?)\s*$/i);
    if (!url) continue;
    const name = repoFullNameFromRemote(url[1])?.toLowerCase();
    if (name && wanted.has(name)) matches.set(name, matches.get(name) || remote === 'origin');
  }
  return matches;
}

export async function detectCheckouts(
  repoFullNames: string[],
  opts: {
    roots?: string[];
    extraRoots?: string[];
    maxDepth?: number;
    timeBudgetMs?: number;
    /** The unprompted startup scan: also skip a chosen folder on another volume. */
    localOnly?: boolean;
    mounts?: Set<string>;
  } = {},
): Promise<Record<string, string[]>> {
  const wanted = new Map(repoFullNames.map((name) => [name.toLowerCase(), name]));
  const matches = new Map<string, Match[]>();
  const home = os.homedir();
  const roots = opts.roots ?? [home];
  const deadline = Date.now() + (opts.timeBudgetMs ?? 5000);
  const seen = new Map<string, number>();
  const maxDepth = Math.max(0, opts.maxDepth ?? 5);
  const mounts = opts.mounts ?? await foreignMounts(home);

  async function walk(dir: string, depth: number, limit: number): Promise<void> {
    const remaining = limit - depth;
    if (Date.now() >= deadline || (seen.get(dir) ?? -1) >= remaining) return;
    seen.set(dir, remaining);
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const gitEntry = entries.find((entry) => entry.name === '.git');
    if (gitEntry?.isDirectory() || gitEntry?.isFile()) {
      const main = gitEntry.isDirectory();
      const config = await readCheckoutConfig(dir, main);
      if (config) {
        const remotes = matchingRemote(config, new Set(wanted.keys()));
        for (const [name, origin] of remotes) {
          const list = matches.get(name) ?? [];
          if (!list.some((match) => match.path === dir)) list.push({ path: dir, main, origin });
          matches.set(name, list);
        }
      }
      return;
    }
    if (depth >= limit) return;
    for (const entry of entries) {
      if (Date.now() >= deadline) return;
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (mounts.has(child)) continue;
      await walk(child, depth + 1, limit);
    }
  }

  const scanRoots = [
    ...(opts.extraRoots ?? []).map((root) => ({ root, chosen: true })),
    ...roots.map((root) => ({ root, chosen: false })),
  ];
  for (const { root, chosen } of scanRoots) {
    if (Date.now() >= deadline) break;
    if (chosen && !path.isAbsolute(root)) continue;
    const absolute = path.resolve(root);
    if (chosen && (path.basename(absolute).startsWith('.')
        || (SKIP.has(path.basename(absolute))
          && !['Desktop', 'Documents', 'Downloads'].includes(path.basename(absolute))))) continue;
    if ((!chosen || opts.localOnly) && (insideAny(absolute, mounts) || insideAny(absolute, VOLUME_PARENTS))) continue;
    try {
      if (!(await fs.lstat(absolute)).isDirectory()) continue;
    } catch {
      continue;
    }
    await walk(absolute, 0, maxDepth);
  }

  const result: Record<string, string[]> = {};
  for (const [name, list] of matches) {
    result[wanted.get(name)!] = list
      .sort((a, b) => Number(b.main) - Number(a.main)
        || Number(b.origin) - Number(a.origin)
        || a.path.length - b.path.length
        || a.path.localeCompare(b.path))
      .map((match) => match.path);
  }
  return result;
}

export async function uniqueMainCheckouts(
  candidates: Record<string, string[]>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, paths] of Object.entries(candidates)) {
    const main = (await Promise.all(paths.map(async (candidate) => {
      try {
        return (await fs.lstat(path.join(candidate, '.git'))).isDirectory() ? candidate : null;
      } catch {
        return null;
      }
    }))).filter((candidate): candidate is string => candidate !== null);
    if (main.length === 1) result[name] = main[0];
  }
  return result;
}
