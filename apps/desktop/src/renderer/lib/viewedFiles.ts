import type { WorkbenchChangedFile } from '@talyn/shared';

/**
 * "Viewed" marks on the Changes tab, per workbench and path, kept in
 * localStorage. A mark remembers the file's diff it was set on, two ways:
 *
 * - `sig`, from the file list (status, rename, line counts). It is free on
 *   every refresh, so most edits unmark the file the moment the list shows them.
 * - `hash`, of the file's patch text. It catches an edit that keeps the line
 *   counts, and is checked whenever the patch is loaded anyway.
 *
 * Either one differing means the diff changed, and the file is unviewed.
 */

export interface ViewedMark {
  sig: string;
  hash: string;
}

export type ViewedMap = Record<string, ViewedMark>;

export const VIEWED_STORAGE_PREFIX = 'talyn.workbench.viewed.';

/** FNV-1a, 32-bit. A change detector, not a security boundary. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function fileSignature(file: WorkbenchChangedFile): string {
  return [file.status, file.oldPath ?? '', file.added, file.removed, file.binary ? 'b' : ''].join('|');
}

export function isViewed(map: ViewedMap, file: WorkbenchChangedFile): boolean {
  const mark = map[file.path];
  return Boolean(mark && mark.sig === fileSignature(file));
}

export function markViewed(map: ViewedMap, file: WorkbenchChangedFile, patch: string): ViewedMap {
  return { ...map, [file.path]: { sig: fileSignature(file), hash: hashText(patch) } };
}

export function unmarkViewed(map: ViewedMap, path: string): ViewedMap {
  if (!map[path]) return map;
  const next = { ...map };
  delete next[path];
  return next;
}

/**
 * Drop the marks the file list proves stale: a path no longer changed, or a
 * signature that moved. Returns `map` itself when nothing changed.
 */
export function reconcileViewed(map: ViewedMap, files: WorkbenchChangedFile[]): ViewedMap {
  const byPath = new Map(files.map((f) => [f.path, f]));
  let next: ViewedMap | null = null;
  for (const [path, mark] of Object.entries(map)) {
    const file = byPath.get(path);
    if (file && mark.sig === fileSignature(file)) continue;
    next ??= { ...map };
    delete next[path];
  }
  return next ?? map;
}

/** Drop a mark whose patch hash no longer matches. Returns `map` itself when it still holds. */
export function reconcileViewedPatch(map: ViewedMap, path: string, patch: string): ViewedMap {
  const mark = map[path];
  if (!mark || mark.hash === hashText(patch)) return map;
  return unmarkViewed(map, path);
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadViewed(workbenchId: string): ViewedMap {
  try {
    const raw = storage()?.getItem(VIEWED_STORAGE_PREFIX + workbenchId);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: ViewedMap = {};
    for (const [path, mark] of Object.entries(parsed as Record<string, unknown>)) {
      const m = mark as Partial<ViewedMark> | null;
      if (m && typeof m.sig === 'string' && typeof m.hash === 'string') out[path] = { sig: m.sig, hash: m.hash };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveViewed(workbenchId: string, map: ViewedMap): void {
  try {
    const s = storage();
    if (!s) return;
    if (Object.keys(map).length === 0) s.removeItem(VIEWED_STORAGE_PREFIX + workbenchId);
    else s.setItem(VIEWED_STORAGE_PREFIX + workbenchId, JSON.stringify(map));
  } catch {
    // Storage full or blocked: the marks last until the window closes.
  }
}
