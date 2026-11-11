/**
 * Split view — several sessions side by side, each pane a transcript and a
 * composer. Behind the `splitView` flag.
 *
 * The pane list is a view decision, kept on the device: these helpers are the
 * one set of rules both front ends apply to it, so web and desktop agree on
 * how many panes fit, which one is dropped, and how the grid is shaped.
 */

/** Panes beyond this are too narrow to read a transcript in. */
export const MAX_SPLIT_PANES = 4;

/** Draw split view: the flag is on, and so is the session surface it sits on. */
export function splitViewOffered(
  features: { splitView?: boolean; workbenches?: boolean } | null | undefined,
): boolean {
  return features?.splitView === true && features?.workbenches === true;
}

/**
 * Add a session to the panes. A session already open keeps its place. When
 * the panes are full, the oldest pane makes room, so the session asked for
 * always opens.
 */
export function addSplitPane(panes: readonly string[], id: string, max = MAX_SPLIT_PANES): string[] {
  if (!id) return [...panes];
  if (panes.includes(id)) return [...panes];
  const next = [...panes, id];
  return next.slice(Math.max(0, next.length - Math.max(1, max)));
}

/** Close a pane. */
export function removeSplitPane(panes: readonly string[], id: string): string[] {
  return panes.filter((pane) => pane !== id);
}

/** Swap a pane with its neighbour. Out of range is a no-op. */
export function moveSplitPane(panes: readonly string[], id: string, direction: -1 | 1): string[] {
  const from = panes.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= panes.length) return [...panes];
  const next = [...panes];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * The saved pane list, cleaned: strings only, no blanks, no repeats, at most
 * {@link MAX_SPLIT_PANES}. Anything else reads as no panes.
 */
export function parseSplitPanes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !value || out.includes(value)) continue;
    out.push(value);
  }
  return out.slice(0, MAX_SPLIT_PANES);
}

/**
 * The grid for `count` panes: side by side up to three, two by two for four.
 * Every pane keeps the full height up to three, because the transcript is
 * what a pane is for.
 */
export function splitGridShape(count: number): { columns: number; rows: number } {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 4) return { columns: 2, rows: 2 };
  return { columns: Math.min(count, 3), rows: Math.ceil(count / 3) };
}
