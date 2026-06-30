import type { PRRow } from '../../../lib/api';
import { compareByCreated, type SortDir } from './filters';

/**
 * Per-row placement within a stacked-PR group, consumed by the table to render
 * indentation + the shared accent bar. A "stack" is a chain of PRs where one
 * PR's base branch is another PR's head branch (PR B is stacked on PR A when
 * `B.baseBranch === A.headBranch` in the same repo).
 */
export interface StackMeta {
  /** 0 = stack root, 1 = first dependent, … (used for indentation). */
  depth: number;
  /** True when the row belongs to a stack of more than one PR. */
  stacked: boolean;
  /** Palette index shared by every member of a stack; -1 when not stacked. */
  colorIndex: number;
}

/**
 * Re-order a list of PRs so stacked PRs are grouped together, root-first, with
 * dependents in dependency order beneath their parent. Returns the new ordering
 * plus per-row {@link StackMeta} keyed by row id.
 *
 * Only **open** PRs participate in linking — a merged/closed parent shouldn't
 * indent its child (in practice the child gets retargeted to `main` once the
 * parent merges). Linking is scoped per repository, so the same branch name in
 * two repos never connects.
 *
 * Roots and sibling dependents are ordered by {@link compareByCreated} so the
 * result respects the active sort direction; within a stack, a parent always
 * precedes its children regardless of sort.
 */
export function buildStackedRows(
  rows: PRRow[],
  sortDir: SortDir
): { ordered: PRRow[]; meta: Map<string, StackMeta> } {
  // Index open rows by repo + head branch so a child can find its parent by its
  // own base branch. First writer wins on the rare duplicate-head collision.
  const byHead = new Map<string, PRRow>();
  for (const r of rows) {
    if (r.state !== 'open') continue;
    const key = `${r.repositoryId}|${r.summary.headBranch}`;
    if (!byHead.has(key)) byHead.set(key, r);
  }

  const parentOf = (r: PRRow): PRRow | undefined => {
    if (r.state !== 'open') return undefined;
    const parent = byHead.get(`${r.repositoryId}|${r.summary.baseBranch}`);
    return parent && parent.id !== r.id ? parent : undefined;
  };

  // children[parentId] → its dependent rows, sorted by the active direction.
  const children = new Map<string, PRRow[]>();
  for (const r of rows) {
    const parent = parentOf(r);
    if (!parent) continue;
    const list = children.get(parent.id);
    if (list) list.push(r);
    else children.set(parent.id, [r]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => compareByCreated(a, b, sortDir));
  }

  // Roots = rows with no parent in the displayed set, ordered by the active sort.
  const roots = rows
    .filter((r) => !parentOf(r))
    .sort((a, b) => compareByCreated(a, b, sortDir));

  const ordered: PRRow[] = [];
  const meta = new Map<string, StackMeta>();
  const visited = new Set<string>();
  let nextColor = 0;

  const walk = (row: PRRow, depth: number, colorIndex: number) => {
    if (visited.has(row.id)) return; // cycle / diamond guard
    visited.add(row.id);
    ordered.push(row);
    meta.set(row.id, { depth, stacked: colorIndex >= 0, colorIndex });
    for (const child of children.get(row.id) ?? []) {
      walk(child, depth + 1, colorIndex);
    }
  };

  for (const root of roots) {
    if (visited.has(root.id)) continue;
    // A root only opens a stack (and claims a color) when it has dependents.
    const isStack = (children.get(root.id)?.length ?? 0) > 0;
    walk(root, 0, isStack ? nextColor++ : -1);
  }

  // Fallback: any row not reachable from a root (only possible via a base/head
  // cycle) is emitted as its own root so PRs never silently vanish. Preserves
  // input order, which `roots` already sorted upstream isn't guaranteed to, so
  // re-sort by the active direction.
  if (visited.size < rows.length) {
    const leftovers = rows
      .filter((r) => !visited.has(r.id))
      .sort((a, b) => compareByCreated(a, b, sortDir));
    for (const r of leftovers) {
      if (visited.has(r.id)) continue;
      walk(r, 0, -1);
    }
  }

  return { ordered, meta };
}
