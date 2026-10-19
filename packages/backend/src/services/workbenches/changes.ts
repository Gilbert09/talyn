import {
  diffStatOf,
  mergeChangedFiles,
  parseNulList,
  shellQuote,
  type WorkbenchChanges,
  type WorkbenchDiffStat,
} from '@talyn/shared';
import { emitWorkbenchUpdated } from './emit.js';
import { FleetHttpError } from '../selfHosted/client.js';
import { WorkbenchError } from './errors.js';
import { parseSections, sectionsScript } from './execFraming.js';
import { publicWorkbench } from './prLink.js';
import { fleetClientFor, repoDirFor, runCapture } from './sandboxRuntime.js';
import { updateWorkbench, type WorkbenchRow } from './store.js';

/**
 * The diff panel, the file tree and the file viewer for a sandbox workbench.
 *
 * Each read tries the fleet's own route first (`/diff`, `/files`, `/file` on
 * the YAS workbench branch) and falls back to git through a quiet exec. The
 * client learns once per process whether a route exists, so a fleet without
 * them costs one 404 per feature, not one per request.
 */

/**
 * The largest file the viewer opens through the exec fallback. The content
 * crosses the fleet, the backend and the API as one JSON string; past this an
 * editor is the wrong tool anyway, and saying so beats a request that hangs.
 * Matches the fleet's own quiet-exec cap, so both paths refuse the same file.
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** Untracked files whose lines are counted for the diff stat. Beyond it they count 0 — a cosmetic number, not worth a slow diff. */
const MAX_COUNTED_UNTRACKED = 1000;

/** A path the user or the agent named, refused unless it stays inside the repository. */
export function assertRepoPath(path: string): string {
  const p = path.trim();
  if (!p || p.includes('\0') || p.startsWith('/') || p.split('/').some((seg) => seg === '..')) {
    throw new WorkbenchError('That path is not inside the repository.', 400, 'bad_path');
  }
  return p;
}

function baseRef(row: WorkbenchRow): string {
  return `origin/${row.baseBranch}`;
}

/** Shell that sets `$mb` to the merge-base with the base branch (HEAD itself on a branch with no base). */
function mergeBaseLine(row: WorkbenchRow): string {
  return `mb=$(git merge-base HEAD ${shellQuote(baseRef(row))} 2>/dev/null || git rev-parse HEAD)`;
}

export async function getChanges(row: WorkbenchRow): Promise<WorkbenchChanges> {
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  const fleet = await client.getDiff(row.sandboxId!, { base: baseRef(row), cwd: repoDirFor(row) });
  if (fleet.supported && fleet.data) {
    return {
      files: fleet.data.files.map((f) => ({
        path: f.path,
        ...(f.oldPath ? { oldPath: f.oldPath } : {}),
        status: f.status,
        added: f.added,
        removed: f.removed,
        binary: f.binary,
      })),
      base: fleet.data.mergeBase,
      headSha: fleet.data.headSha,
    };
  }

  const script = [
    mergeBaseLine(row),
    sectionsScript([
      { label: 'MB', command: 'printf %s "$mb"' },
      { label: 'HEAD', command: 'git rev-parse HEAD' },
      { label: 'NUMSTAT', command: 'git diff --numstat -z --find-renames "$mb" --' },
      { label: 'NAMES', command: 'git diff --name-status -z --find-renames "$mb" --' },
      { label: 'UNTRACKED', command: 'git ls-files --others --exclude-standard -z' },
      {
        label: 'COUNTS',
        command:
          `git ls-files --others --exclude-standard -z | head -z -n ${MAX_COUNTED_UNTRACKED} | ` +
          `while IFS= read -r -d '' f; do printf '%s\\t%s\\n' "$f" "$(awk 'END{print NR}' "$f" 2>/dev/null)"; done`,
      },
    ]),
  ].join('\n');
  const r = await runCapture(row, script, { quiet: true, timeoutMs: 60_000 });
  if (r.exitCode !== 0) {
    throw new Error(`git diff failed in the sandbox (exit ${r.exitCode}): ${r.stderr.slice(-500)}`);
  }
  const s = parseSections(r.stdout);
  const counts: Record<string, number> = {};
  for (const line of (s.COUNTS ?? '').split('\n')) {
    const tab = line.lastIndexOf('\t');
    if (tab > 0) counts[line.slice(0, tab)] = Number(line.slice(tab + 1)) || 0;
  }
  return {
    files: mergeChangedFiles({
      numstat: s.NUMSTAT ?? '',
      nameStatus: s.NAMES ?? '',
      untracked: s.UNTRACKED ?? '',
      untrackedLineCounts: counts,
    }),
    base: (s.MB ?? '').trim(),
    headSha: (s.HEAD ?? '').trim(),
  };
}

/** The unified patch vs the merge-base, untracked files included as additions. */
export async function getPatch(row: WorkbenchRow, path?: string): Promise<{ patch: string }> {
  const safePath = path ? assertRepoPath(path) : undefined;
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  const fleet = await client.getDiff(row.sandboxId!, {
    base: baseRef(row),
    patch: true,
    cwd: repoDirFor(row),
    ...(safePath ? { path: safePath } : {}),
  });
  if (fleet.supported && fleet.data) return { patch: fleet.data.patch ?? '' };

  const quotedPath = safePath ? shellQuote(safePath) : '';
  const untracked = safePath
    ? `git ls-files --others --exclude-standard -z -- ${quotedPath}`
    : 'git ls-files --others --exclude-standard -z';
  const script = [
    mergeBaseLine(row),
    `git diff --no-color --find-renames "$mb" --${safePath ? ` ${quotedPath}` : ''}`,
    // `--no-index` exits 1 when the files differ, which here is always.
    `${untracked} | while IFS= read -r -d '' f; do git diff --no-color --no-index -- /dev/null "$f" || true; done`,
  ].join('\n');
  const r = await runCapture(row, script, { quiet: true, timeoutMs: 60_000 });
  if (r.exitCode !== 0) {
    throw new Error(`git diff failed in the sandbox (exit ${r.exitCode}): ${r.stderr.slice(-500)}`);
  }
  return { patch: r.stdout };
}

/** Binary when the first 8000 bytes hold a NUL — git's own test. */
export function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/**
 * One file's content. Text comes back as UTF-8; a binary file comes back as
 * base64 with `binary: true`, so an image can still be previewed.
 */
export async function readRepoFile(row: WorkbenchRow, path: string): Promise<{ content: string; binary: boolean }> {
  const safePath = assertRepoPath(path);
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  const fleet = await client.readFile(row.sandboxId!, safePath, { cwd: repoDirFor(row) }).catch((err: unknown) => {
    if (err instanceof FleetHttpError && err.code === 'no_such_file') {
      throw new WorkbenchError(`${safePath} does not exist.`, 404, 'file_not_found');
    }
    throw err;
  });
  if (fleet.supported && fleet.data) {
    if (fleet.data.tooLarge) {
      throw new WorkbenchError(`${safePath} is too large to open here.`, 413, 'file_too_large');
    }
    const { content, encoding, binary } = fleet.data;
    if (binary) return { content: encoding === 'base64' ? content : Buffer.from(content).toString('base64'), binary };
    return { content: encoding === 'base64' ? Buffer.from(content, 'base64').toString('utf8') : content, binary };
  }

  const q = shellQuote(safePath);
  const script = [
    `[ -f ${q} ] || exit 3`,
    `[ "$(wc -c < ${q})" -le ${MAX_FILE_BYTES} ] || exit 4`,
    `cat ${q}`,
  ].join('\n');
  const r = await runCapture(row, script, { quiet: true, timeoutMs: 60_000 });
  if (r.exitCode === 3) throw new WorkbenchError(`${safePath} does not exist.`, 404, 'file_not_found');
  if (r.exitCode === 4) throw new WorkbenchError(`${safePath} is too large to open here.`, 413, 'file_too_large');
  if (r.exitCode !== 0) throw new Error(`reading ${safePath} failed (exit ${r.exitCode}): ${r.stderr.slice(-300)}`);
  const bytes = r.stdoutBytes;
  if (looksBinary(bytes)) return { content: bytes.toString('base64'), binary: true };
  return { content: bytes.toString('utf8'), binary: false };
}

/** Tracked and untracked files, gitignored ones excluded. */
export async function listRepoFiles(row: WorkbenchRow): Promise<{ paths: string[] }> {
  const client = await fleetClientFor(row.workspaceId, row.fleetHost);
  const fleet = await client.listFiles(row.sandboxId!, { cwd: repoDirFor(row) });
  if (fleet.supported && fleet.data) return { paths: fleet.data.paths };
  const r = await runCapture(row, 'git ls-files --cached --others --exclude-standard -z', {
    quiet: true,
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) throw new Error(`git ls-files failed (exit ${r.exitCode}): ${r.stderr.slice(-300)}`);
  return { paths: parseNulList(r.stdout) };
}

function sameStat(a: WorkbenchDiffStat | null, b: WorkbenchDiffStat): boolean {
  return Boolean(a) && a!.added === b.added && a!.removed === b.removed && a!.files === b.files;
}

/**
 * Recompute the diff stat and, when it moved, store it and tell the clients.
 * Best effort: a sandbox that cannot answer leaves the old number in place.
 */
export async function refreshDiffStat(row: WorkbenchRow): Promise<WorkbenchRow> {
  if (row.runtime !== 'sandbox' || !row.sandboxId) return row;
  try {
    const changes = await getChanges(row);
    const stat = diffStatOf(changes.files);
    if (sameStat(row.diffStat ?? null, stat)) return row;
    const updated = (await updateWorkbench(row.id, { diffStat: stat })) ?? row;
    emitWorkbenchUpdated(await publicWorkbench(updated));
    return updated;
  } catch (err) {
    console.warn(`[workbench] diff stat for ${row.id} failed:`, err instanceof Error ? err.message : err);
    return row;
  }
}
