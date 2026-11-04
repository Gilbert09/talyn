import type { WorkbenchChanges, WorkbenchDiff, WorkbenchDiffScope, WorkbenchFileContent } from '@talyn/shared';
import { githubService } from '../github.js';
import { GitHubRateLimitError } from '../githubRateGate.js';
import { looksBinary } from './changes.js';
import type { WorkbenchRow } from './store.js';

/**
 * What GitHub can answer for a sleeping session with no stored copy of it:
 *
 *  - the diff, when the work is all pushed: no uncommitted file, and the
 *    head commit is one Talyn pushed or the branch's pull request has;
 *  - a file the session did not change, at the merge base.
 *
 * Each answer is cached, and a rate limit is a "no" rather than a wait: a
 * read that GitHub cannot answer now offers a wake instead.
 */

const CACHE_MS = 10 * 60_000;
/** The contents API answers a base64 body up to 1 MB. */
const GITHUB_FILE_MAX_BYTES = 1024 * 1024;

const diffCache = new Map<string, { at: number; files: CompareFile[] | null }>();
const fileCache = new Map<string, { at: number; file: { bytes: Buffer | null; size: number } | null }>();

type CompareFile = { filename: string; previous_filename?: string; status: string; patch?: string };

export function resetChangesGithubForTests(): void {
  diffCache.clear();
  fileCache.clear();
}

function ownerRepo(row: Pick<WorkbenchRow, 'repoFullName'>): [string, string] | null {
  const [owner, repo, extra] = row.repoFullName.split('/');
  return owner && repo && !extra ? [owner, repo] : null;
}

function bounded<V>(cache: Map<string, V>, key: string, value: V): void {
  cache.set(key, value);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
}

/** True when GitHub has the work that the list describes: nothing uncommitted, and the head commit is pushed. */
export function workIsOnGithub(row: Pick<WorkbenchRow, 'pullRequestId' | 'pushedHeadShas'>, changes: Pick<WorkbenchChanges, 'uncommitted' | 'headSha' | 'base'>): boolean {
  if (!changes.headSha || !changes.base || !changes.uncommitted || changes.uncommitted.length > 0) return false;
  return (row.pushedHeadShas ?? []).includes(changes.headSha) || Boolean(row.pullRequestId);
}

/** One file of a compare answer as a git patch block. */
function block(f: CompareFile): string {
  const path = f.filename;
  const old = f.previous_filename ?? path;
  const lines = [`diff --git a/${old} b/${path}`];
  if (f.status === 'added') lines.push('new file mode 100644');
  if (f.status === 'removed') lines.push('deleted file mode 100644');
  if (f.status === 'renamed') lines.push(`rename from ${old}`, `rename to ${path}`);
  const from = f.status === 'added' ? '/dev/null' : `a/${old}`;
  const to = f.status === 'removed' ? '/dev/null' : `b/${path}`;
  if (!f.patch) {
    // GitHub sends no patch for a binary file, or for one too large to show.
    if (f.status !== 'renamed') lines.push(`Binary files ${from} and ${to} differ`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(`--- ${from}`, `+++ ${to}`, f.patch);
  return `${lines.join('\n')}\n`;
}

/**
 * The diff between the merge base and the head commit, from GitHub. Null
 * when GitHub does not have it, cannot say now, or the work is not all pushed.
 */
export async function githubDiff(
  row: WorkbenchRow,
  changes: Pick<WorkbenchChanges, 'uncommitted' | 'headSha' | 'base' | 'snapshotAt'>,
  scope: WorkbenchDiffScope,
  path: string | undefined,
): Promise<WorkbenchDiff | null> {
  if (!workIsOnGithub(row, changes)) return null;
  const meta = { snapshotAt: changes.snapshotAt, source: 'github' as const, mergeBase: changes.base, headSha: changes.headSha };
  // Nothing is uncommitted, so that scope is empty and the other two are the same diff.
  if (scope === 'uncommitted') return { patch: '', ...meta };
  const repo = ownerRepo(row);
  if (!repo) return null;
  const key = `${row.workspaceId}:${row.repoFullName}:${changes.base}:${changes.headSha}`;
  let files: CompareFile[] | null;
  const hit = diffCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    files = hit.files;
  } else {
    try {
      files = (await githubService.compareCommits(row.workspaceId, repo[0], repo[1], changes.base, changes.headSha))?.files ?? null;
    } catch (err) {
      if (!(err instanceof GitHubRateLimitError)) {
        console.warn(`[workbench] reading the diff of ${row.id} from GitHub failed:`, err instanceof Error ? err.message : err);
      }
      return null;
    }
    bounded(diffCache, key, { at: Date.now(), files });
  }
  if (!files) return null;
  const picked = path ? files.filter((f) => f.filename === path || f.previous_filename === path) : files;
  return { patch: picked.map(block).join(''), ...meta };
}

/** A file the session did not change, read at the merge base. Null when GitHub cannot answer. */
export async function githubFileAt(
  row: WorkbenchRow,
  mergeBase: string,
  path: string,
  snapshotAt: string | undefined,
): Promise<WorkbenchFileContent | { missing: true } | { tooLarge: true } | null> {
  const repo = ownerRepo(row);
  if (!repo || !/^[0-9a-f]{40,64}$/.test(mergeBase)) return null;
  const key = `${row.workspaceId}:${row.repoFullName}:${mergeBase}:${path}`;
  let file: { bytes: Buffer | null; size: number } | null;
  const hit = fileCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    file = hit.file;
  } else {
    try {
      const answer = await githubService.getFileContent(row.workspaceId, repo[0], repo[1], path, mergeBase, GITHUB_FILE_MAX_BYTES);
      file = answer ? { bytes: answer.bytes ?? null, size: answer.size } : null;
    } catch (err) {
      if (!(err instanceof GitHubRateLimitError)) {
        console.warn(`[workbench] reading ${path} of ${row.id} from GitHub failed:`, err instanceof Error ? err.message : err);
      }
      return null;
    }
    bounded(fileCache, key, { at: Date.now(), file });
  }
  if (!file) return { missing: true };
  if (!file.bytes) return { tooLarge: true };
  const binary = looksBinary(file.bytes);
  return {
    content: binary ? file.bytes.toString('base64') : file.bytes.toString('utf8'),
    binary,
    source: 'github',
    ref: mergeBase,
    ...(snapshotAt ? { snapshotAt } : {}),
  };
}
