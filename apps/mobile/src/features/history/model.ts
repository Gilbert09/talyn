import type { Workbench } from '@talyn/shared';

import { isArchived } from '../sessions/actions';

export type HistoryKind = 'session' | 'thread';

/** When it was archived. An old row without the time falls back to its last change, like web. */
export const archivedAtOf = (item: Pick<Workbench, 'archivedAt' | 'updatedAt'>) => item.archivedAt ?? item.updatedAt;

/** The archived items of one kind that match the search, newest archived first. Matches title, name, branch and repository. */
export function archivedItems(all: readonly Workbench[], kind: HistoryKind, query: string): Workbench[] {
  const q = query.trim().toLowerCase();
  return all
    .filter((item) => isArchived(item) && (item.kind ?? 'session') === kind)
    .filter((item) => !q || [item.title ?? '', item.name, item.branch, item.repoFullName].some((text) => (text ?? '').toLowerCase().includes(q)))
    .sort((a, b) => archivedAtOf(b).localeCompare(archivedAtOf(a)) || a.id.localeCompare(b.id));
}

export type HistoryRow = { type: 'section'; key: string; repo: string } | { type: 'row'; key: string; item: Workbench; last: boolean };

/**
 * List rows for the screen. Sessions are grouped by repository in the order
 * the newest archive of each appears, like web `filterAndGroupArchived`.
 * Threads have no repository, so they are one plain list.
 */
export function historyRows(items: readonly Workbench[], kind: HistoryKind): HistoryRow[] {
  if (kind === 'thread') return items.map((item, index) => ({ type: 'row', key: item.id, item, last: index === items.length - 1 }));
  const groups = new Map<string, Workbench[]>();
  for (const item of items) {
    const list = groups.get(item.repoFullName);
    if (list) list.push(item); else groups.set(item.repoFullName, [item]);
  }
  return [...groups.entries()].flatMap(([repo, list]) => [
    ...(repo ? [{ type: 'section' as const, key: `section:${repo}`, repo }] : []),
    ...list.map((item, index) => ({ type: 'row' as const, key: item.id, item, last: index === list.length - 1 })),
  ]);
}

/** The empty-list words: nothing archived at all, or nothing that matches. */
export function emptyHistoryText(kind: HistoryKind, total: number, query: string): { title: string; detail: string } {
  const noun = kind === 'thread' ? 'threads' : 'sessions';
  if (total === 0) return { title: `No archived ${noun}`, detail: `Archived ${noun} in this workspace show here.` };
  return { title: 'No matches', detail: query.trim() ? `No archived ${noun} match your search.` : `No archived ${noun}.` };
}
