import type { WorkbenchChangedFile, WorkbenchChanges, WorkbenchDiffScope } from '@talyn/shared';

import { relativeTimeLabel } from '../../lib/time';

export interface ChangeGroup { scope: WorkbenchDiffScope; label: string; files: WorkbenchChangedFile[]; empty: string }

/**
 * The file list in groups, like web `ChangesTab`: uncommitted and committed
 * when the server splits them, else one combined group.
 */
export function changeGroups(changes: WorkbenchChanges): ChangeGroup[] {
  if (changes.uncommitted && changes.committed) {
    return [
      { scope: 'uncommitted', label: 'Uncommitted', files: changes.uncommitted, empty: 'No uncommitted changes.' },
      { scope: 'committed', label: 'Committed on this branch', files: changes.committed, empty: 'No committed changes.' },
    ];
  }
  return [{ scope: 'combined', label: 'Changes against base', files: changes.files, empty: 'No changes against the base branch.' }];
}

export function groupTotals(files: readonly WorkbenchChangedFile[]) {
  return files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
}

export const FILE_STATUS_LETTER: Record<WorkbenchChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
export const FILE_STATUS_LABEL: Record<WorkbenchChangedFile['status'], string> = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed' };

/** The screen reader line for a changed file. */
export function fileLabel(file: WorkbenchChangedFile): string {
  const counts = file.binary ? 'Binary file' : `${file.added} added, ${file.removed} removed`;
  const path = file.oldPath ? `${file.oldPath} to ${file.path}` : file.path;
  return `${FILE_STATUS_LABEL[file.status]}: ${path}. ${counts}.`;
}

/** Splits a path into the directory and the file name, so a row can show the name first. */
export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/');
  return index < 0 ? { dir: '', name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

/** Says where a stored copy came from, like web `StoredBanner`. Null for a live read. */
export function storedText(changes: Pick<WorkbenchChanges, 'snapshotAt' | 'storedReason' | 'stale'>, now = Date.now()): string | null {
  if (!changes.snapshotAt) return null;
  const archived = changes.storedReason === 'archived';
  const ago = relativeTimeLabel(changes.snapshotAt, now) || 'earlier';
  const stale = changes.stale === 'list_newer' ? ' This copy is out of date: the session has newer changes.'
    : changes.stale === 'sandbox_replaced' ? ' This copy is from an earlier sandbox.' : '';
  return `${archived ? 'This session is archived.' : 'Sandbox is asleep.'} Showing changes from ${ago}.${stale}`;
}

/** True when a read was refused because the sandbox sleeps and Talyn has no stored copy. Mirrors web `needsWake`. */
export function needsWake(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'snapshot_unavailable');
}

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk' | 'header' | 'note';
export interface DiffLine { kind: DiffLineKind; text: string; oldLine: number | null; newLine: number | null }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A unified diff as lines with their old and new numbers. File headers
 * (`diff --git`, `index`, `---`, `+++`) are kind `header`, so a view can hide them.
 */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  const raw = patch.replace(/\r\n/g, '\n').split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of raw) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]); newNo = Number(hunk[2]); inHunk = true;
      out.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
    } else if (line.startsWith('diff --git ') || !inHunk) {
      inHunk = false;
      out.push({ kind: 'header', text: line, oldLine: null, newLine: null });
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newNo++ });
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), oldLine: oldNo++, newLine: null });
    } else if (line.startsWith('\\')) {
      out.push({ kind: 'note', text: line.slice(1).trim(), oldLine: null, newLine: null });
    } else {
      out.push({ kind: 'context', text: line.slice(1), oldLine: oldNo++, newLine: newNo++ });
    }
  }
  return out;
}

/** Lines a phone draws at once. A diff past this shows a "Show more" step, so a huge file cannot stall the screen. */
export const DIFF_PAGE_LINES = 400;
/** A single line past this is cut with a note saying how much is left out, since one minified line can be megabytes. */
export const DIFF_LINE_CHARS = 2000;

/** The lines to draw (headers left out) and how many are held back. */
export function visibleDiff(lines: readonly DiffLine[], limit: number): { shown: DiffLine[]; hidden: number } {
  const body = lines.filter((line) => line.kind !== 'header');
  return { shown: body.slice(0, limit), hidden: Math.max(0, body.length - limit) };
}

/** A line's text, cut when it is very long. `cut` is the count of characters left out. */
export function clipLine(text: string, max = DIFF_LINE_CHARS): { text: string; cut: number } {
  return text.length > max ? { text: text.slice(0, max), cut: text.length - max } : { text, cut: 0 };
}

/** Digits of the widest line number, for the gutter width. */
export function gutterDigits(lines: readonly DiffLine[]): number {
  let max = 0;
  for (const line of lines) max = Math.max(max, line.oldLine ?? 0, line.newLine ?? 0);
  return Math.max(2, String(max).length);
}
