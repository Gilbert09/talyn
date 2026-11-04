import { createHash } from 'node:crypto';
import type {
  WorkbenchChanges,
  WorkbenchConfig,
  WorkbenchDiff,
  WorkbenchDiffScope,
  WorkbenchFileContent,
  WorkbenchFileList,
  WorkbenchStoredReason,
} from '@talyn/shared';
import { assertRepoPath, looksBinary } from './changes.js';
import { parseCapturedContents, type CapturedFile, type ContentsEntry } from './changesCaptureScript.js';
import { readChangesSnapshot } from './changesSnapshot.js';
import {
  changesConfigKey,
  contentsIndexKeyOf,
  indexKeyOf,
  listsKeyOf,
  readChangesMeta,
  readChangesObject,
  readGenerationJson,
  type ChangesMeta,
  type ChangesObjectName,
  type PatchIndex,
  type PatchIndexEntry,
} from './changesStore.js';
import { WorkbenchError } from './errors.js';
import type { WorkbenchRow } from './store.js';

/**
 * The read side of the stored changes (`changesCapture.ts` writes them):
 * what the Changes and Files tabs show while the box sleeps. Each function
 * answers null when nothing usable is stored; the caller then decides between
 * GitHub, a refusal and a wake.
 */

/** The largest file a read opens. Matches the live read's cap (`changes.ts`). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

const SCOPE_OBJECT: Record<WorkbenchDiffScope, ChangesObjectName> = {
  combined: 'patch',
  uncommitted: 'patch-uncommitted',
  committed: 'patch-committed',
};

/** The meta when its patches still describe the work: no later list read found other changes. */
async function usableMeta(row: WorkbenchRow): Promise<ChangesMeta | null> {
  const meta = await readChangesMeta(row);
  return meta && !meta.listNewer ? meta : null;
}

function staleOf(row: WorkbenchRow, meta: ChangesMeta): WorkbenchChanges['stale'] {
  if (meta.listNewer) return 'list_newer';
  return row.sandboxId && row.sandboxId !== meta.sandboxId ? 'sandbox_replaced' : undefined;
}

/** The stored changes list, newest first: the full copy, else the list-only copy. */
export async function storedChanges(row: WorkbenchRow, reason: WorkbenchStoredReason): Promise<WorkbenchChanges | null> {
  const meta = await readChangesMeta(row);
  if (meta && !meta.listNewer) {
    const lists = await readGenerationJson<WorkbenchChanges>(listsKeyOf(row, meta.generation));
    if (lists && Array.isArray(lists.files)) {
      const patch = meta.objects.patch;
      const stale = staleOf(row, meta);
      return {
        ...lists,
        snapshotAt: meta.takenAt,
        source: 'stored',
        storedReason: reason,
        etag: meta.etag,
        sandboxId: meta.sandboxId,
        mergeBase: meta.mergeBase,
        patch: patch ? ('parts' in patch ? { available: true } : { available: false, tooLarge: true }) : { available: false },
        fileList: { available: Boolean(meta.objects.files && 'parts' in meta.objects.files) },
        ...(stale ? { stale } : {}),
      };
    }
  }
  const snapshot = await readChangesSnapshot(row);
  if (!snapshot) return null;
  return {
    ...snapshot,
    source: 'stored',
    storedReason: reason,
    patch: { available: false },
    fileList: { available: false },
    ...(meta?.listNewer ? { stale: 'list_newer' as const } : {}),
  };
}

/** The stored patch of one scope, whole or for one file. Binary bodies are kept only when `keepBinary`. */
export async function storedPatch(
  row: WorkbenchRow,
  scope: WorkbenchDiffScope,
  path: string | undefined,
  opts: { keepBinary?: boolean } = {},
): Promise<(WorkbenchDiff & { mergeBase: string; headSha: string }) | { tooLarge: true } | null> {
  const meta = await usableMeta(row);
  if (!meta) return null;
  const object = SCOPE_OBJECT[scope];
  const stored = meta.objects[object];
  if (!stored) return null;
  if (!('parts' in stored)) return { tooLarge: true };
  let body: Buffer | null;
  try {
    body = await readChangesObject(row, meta, object);
  } catch (err) {
    console.warn(`[workbench] reading the stored ${object} of ${row.id} failed:`, err);
    return null;
  }
  if (!body) return null;
  const index = path ? (await readGenerationJson<PatchIndex>(indexKeyOf(row, meta.generation)))?.[scope] : undefined;
  const slice = path ? slicePatch(body, index, assertRepoPath(path)) : body;
  const text = slice.toString('utf8');
  return {
    patch: opts.keepBinary ? text : stripBinaryBodies(text),
    snapshotAt: meta.takenAt,
    source: 'stored',
    mergeBase: meta.mergeBase,
    headSha: meta.headSha,
  };
}

/** The part of `patch` about `path`: its blocks by the index, else by their `diff --git` headers. */
export function slicePatch(patch: Buffer, index: PatchIndexEntry[] | undefined, path: string): Buffer {
  if (index) {
    const hits = index.filter((e) => e.path === path || e.oldPath === path);
    return Buffer.concat(hits.map((e) => patch.subarray(e.offset, e.offset + e.length)));
  }
  const out: Buffer[] = [];
  for (const block of patchBlocks(patch.toString('utf8'))) {
    const { a, b } = headerPaths(block);
    if (a === path || b === path) out.push(Buffer.from(block));
  }
  return Buffer.concat(out);
}

function patchBlocks(text: string): string[] {
  const blocks: string[] = [];
  let start = text.startsWith('diff --git ') ? 0 : text.indexOf('\ndiff --git ');
  if (start < 0) return text ? [text] : [];
  if (start > 0) start += 1;
  while (start < text.length) {
    const next = text.indexOf('\ndiff --git ', start);
    const end = next < 0 ? text.length : next + 1;
    blocks.push(text.slice(start, end));
    start = end;
  }
  return blocks;
}

/** The two paths of a block's header. Exact for paths with no ` b/` in them, which is nearly all. */
function headerPaths(block: string): { a: string; b: string } {
  const header = block.slice(0, block.indexOf('\n') < 0 ? block.length : block.indexOf('\n')).replace(/^diff --git /, '');
  const split = header.lastIndexOf(' b/');
  if (!header.startsWith('a/') || split < 0) return { a: '', b: '' };
  return { a: header.slice(2, split), b: header.slice(split + 3) };
}

/**
 * Replace each `GIT binary patch` body with git's one line for a binary
 * file, as a live diff without `--binary` shows it. The viewer cannot draw
 * the body, and it can be megabytes.
 */
export function stripBinaryBodies(text: string): string {
  if (!text.includes('\nGIT binary patch\n')) return text;
  return patchBlocks(text).map((block) => {
    const at = block.indexOf('\nGIT binary patch\n');
    if (at < 0) return block;
    const { a, b } = headerPaths(block);
    const from = /\nnew file mode /.test(block.slice(0, at + 1)) ? '/dev/null' : `a/${a}`;
    const to = /\ndeleted file mode /.test(block.slice(0, at + 1)) ? '/dev/null' : `b/${b}`;
    return `${block.slice(0, at + 1)}Binary files ${from} and ${to} differ\n`;
  }).join('');
}

/** The repository's files at the time of the copy. */
export async function storedFileList(row: WorkbenchRow): Promise<WorkbenchFileList | null> {
  const meta = await usableMeta(row);
  if (!meta || !meta.objects.files || !('parts' in meta.objects.files)) return null;
  try {
    const body = await readChangesObject(row, meta, 'files');
    if (!body) return null;
    const paths = body.toString('utf8').split('\0').filter(Boolean);
    return { paths, snapshotAt: meta.takenAt, source: 'stored' };
  } catch (err) {
    console.warn(`[workbench] reading the stored file list of ${row.id} failed:`, err);
    return null;
  }
}

export type StoredFileAnswer =
  | { kind: 'file'; file: WorkbenchFileContent }
  /** Changed, but its content was not stored (too large, or past the budget). */
  | { kind: 'not_stored'; size: number }
  /**
   * Not changed since the merge base: read it there. `known` is false when
   * the file list was not stored, so only the changes list says it is not
   * changed, and it may not exist at all.
   */
  | { kind: 'unchanged'; mergeBase: string; known: boolean }
  | { kind: 'missing' }
  /** The session deleted it, or renamed it away. The merge base still has it, so GitHub must not answer. */
  | { kind: 'deleted' }
  /** The stored copy cannot say whether the file changed. Neither it nor GitHub may answer. */
  | { kind: 'unknown' }
  | null;

const contentsCache = new Map<string, { at: number; files: Map<string, CapturedFile> }>();

/** One file as the copy has it. */
export async function storedFile(row: WorkbenchRow, path: string): Promise<StoredFileAnswer> {
  const safePath = assertRepoPath(path);
  const meta = await usableMeta(row);
  if (!meta) return null;
  const contents = meta.objects.contents;
  if (!contents || !('parts' in contents)) return null;
  let files: Map<string, CapturedFile>;
  try {
    const key = `${row.id}:${meta.generation}`;
    const cached = contentsCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) {
      files = cached.files;
    } else {
      const body = await readChangesObject(row, meta, 'contents');
      const entries = await readGenerationJson<ContentsEntry[]>(contentsIndexKeyOf(row, meta.generation));
      if (!body || !entries) return null;
      files = parseCapturedContents(body, entries);
      contentsCache.set(key, { at: Date.now(), files });
      if (contentsCache.size > 50) contentsCache.delete(contentsCache.keys().next().value!);
    }
  } catch (err) {
    console.warn(`[workbench] reading the stored files of ${row.id} failed:`, err);
    return null;
  }
  const hit = files.get(safePath);
  if (hit) {
    if (hit.size > MAX_FILE_BYTES) throw new WorkbenchError(`${safePath} is too large to open here.`, 413, 'file_too_large');
    if (!hit.content) return { kind: 'not_stored', size: hit.size };
    const binary = looksBinary(hit.content);
    return {
      kind: 'file',
      file: {
        content: binary ? hit.content.toString('base64') : hit.content.toString('utf8'),
        binary,
        snapshotAt: meta.takenAt,
        source: 'stored',
      },
    };
  }
  // Not a changed file with content. The changes list tells a file the
  // session removed (its content is not captured) from one it did not touch.
  const lists = await readGenerationJson<WorkbenchChanges>(listsKeyOf(row, meta.generation));
  if (!lists || !Array.isArray(lists.files)) return { kind: 'unknown' };
  if (lists.files.some((f) => (f.status === 'deleted' && f.path === safePath) || (f.oldPath === safePath && f.path !== safePath))) {
    return { kind: 'deleted' };
  }
  // In the changes list but not in the contents: the two disagree, so neither proves anything.
  if (lists.files.some((f) => f.path === safePath)) return { kind: 'unknown' };
  // Not changed: the same as at the merge base, if it exists at all.
  const list = await storedFileList(row);
  if (!list) return { kind: 'unchanged', mergeBase: meta.mergeBase, known: false };
  return list.paths.includes(safePath) ? { kind: 'unchanged', mergeBase: meta.mergeBase, known: true } : { kind: 'missing' };
}

/** The combined patch with binary bodies, for the preview sync. Null when it is not stored. */
export async function storedPreviewPatch(row: WorkbenchRow): Promise<{ base: string; patch: string; snapshotAt?: string } | null> {
  const answer = await storedPatch(row, 'combined', undefined, { keepBinary: true });
  if (!answer || 'tooLarge' in answer) return null;
  return { base: answer.mergeBase, patch: answer.patch, ...(answer.snapshotAt ? { snapshotAt: answer.snapshotAt } : {}) };
}

/**
 * The HTTP ETag of a changes answer. The copy's own etag fixes its content,
 * but the answer also says why the copy answered and whether it is stale,
 * and a 304 must not keep a banner that no longer holds.
 */
export function changesResponseEtag(changes: WorkbenchChanges): string | null {
  if (!changes.etag) return null;
  const facts = [changes.etag, changes.source ?? '', changes.storedReason ?? '', changes.stale ?? '', changes.snapshotAt ?? ''];
  return `"${createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 24)}"`;
}

/** The last script config read from the box. */
export async function storedConfig(row: WorkbenchRow): Promise<WorkbenchConfig | null> {
  const stored = await readGenerationJson<{ version: number; config: WorkbenchConfig }>(changesConfigKey(row));
  return stored?.version === 1 && stored.config ? stored.config : null;
}

export function resetChangesStoredForTests(): void {
  contentsCache.clear();
}
