import type { PRRow } from '@talyn/client/native';
import { linkStack } from '@talyn/shared';

import { compareByCreated, type SortDir } from './lists';

export interface StackMeta {
  /** 0 for a stack root or a lone PR, 1 for its first dependent, and so on. */
  depth: number;
  /** The row is part of a stack of more than one PR. */
  stacked: boolean;
  /** The number of the PR this one is stacked on, when it is shown in the list. */
  parentNumber: number | null;
}

/**
 * Web `buildStackedRows`: stacked PRs stay together, root first, with each
 * dependent after its parent. Roots and siblings follow the sort; a parent is
 * always above its children. Only open PRs link, and only inside one repository.
 */
export function buildStackedRows(rows: PRRow[], sortDir: SortDir): { ordered: PRRow[]; meta: Map<string, StackMeta> } {
  const links = linkStack(rows.map((row) => ({ id: row.id, repositoryId: row.repositoryId, state: row.state,
    headBranch: row.summary.headBranch, baseBranch: row.summary.baseBranch })));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const parentOf = (row: PRRow) => row.state === 'open' ? byId.get(links.parentOf.get(row.id)?.id ?? '') : undefined;
  const sort = (list: PRRow[]) => list.sort((a, b) => compareByCreated(a, b, sortDir));

  const children = new Map<string, PRRow[]>();
  for (const row of rows) {
    const parent = parentOf(row);
    if (!parent) continue;
    const list = children.get(parent.id);
    if (list) list.push(row); else children.set(parent.id, [row]);
  }
  for (const list of children.values()) sort(list);

  const ordered: PRRow[] = [];
  const meta = new Map<string, StackMeta>();
  const visited = new Set<string>();
  const walk = (row: PRRow, depth: number, stacked: boolean, parent: PRRow | null) => {
    if (visited.has(row.id)) return;
    visited.add(row.id);
    ordered.push(row);
    meta.set(row.id, { depth, stacked, parentNumber: parent?.number ?? null });
    for (const child of children.get(row.id) ?? []) walk(child, depth + 1, stacked, row);
  };
  for (const root of sort(rows.filter((row) => !parentOf(row)))) walk(root, 0, (children.get(root.id)?.length ?? 0) > 0, null);
  // Only a base and head cycle leaves rows unreached. Show them as roots so no PR vanishes.
  for (const row of sort(rows.filter((item) => !visited.has(item.id)))) walk(row, 0, false, null);
  return { ordered, meta };
}
