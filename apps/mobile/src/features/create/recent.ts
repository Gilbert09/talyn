import type { Workbench } from '@talyn/shared';

/** As many rows as web's home list. */
export const RECENT_LIMIT = 8;

/**
 * Web `RecentWorkbenches`: the newest live sessions and threads, newest first.
 * The held lists already leave out archived work.
 */
export function recentWork(sessions: readonly Workbench[] | undefined, threads: readonly Workbench[] | undefined, limit = RECENT_LIMIT): Workbench[] {
  const seen = new Set<string>();
  const live: Workbench[] = [];
  for (const item of [...(sessions ?? []), ...(threads ?? [])]) {
    if (item.archivedAt || seen.has(item.id)) continue;
    seen.add(item.id);
    live.push(item);
  }
  return live.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

/** Lines added and removed on the branch: the committed work plus what is not committed yet. Null when there is none. */
export function branchChanges(item: Pick<Workbench, 'diffStat'> & Partial<Pick<Workbench, 'uncommittedStats' | 'committedStats'>>):
  { added: number; removed: number } | null {
  const uncommitted = item.uncommittedStats === undefined ? item.diffStat : item.uncommittedStats;
  const added = (uncommitted?.added ?? 0) + (item.committedStats?.added ?? 0);
  const removed = (uncommitted?.removed ?? 0) + (item.committedStats?.removed ?? 0);
  return added || removed ? { added, removed } : null;
}

/** The repository name without its owner, which the row has no room for. */
export function shortRepository(fullName: string | null | undefined): string {
  if (!fullName) return '';
  const slash = fullName.indexOf('/');
  return slash === -1 ? fullName : fullName.slice(slash + 1);
}

/**
 * Where the composer sits. With nothing typed it waits in the middle of the
 * page with the recent work below. Typing, an image, or an open keyboard on a
 * focused field moves it to the bottom. Only an open keyboard counts as
 * focus, so a keyboard closed with Back (the field keeps focus on Android)
 * brings the list back.
 */
export function composerLayout(input: { prompt: string; images: number; focused: boolean; keyboardOpen: boolean; busy: boolean }):
  'centered' | 'docked' {
  if (input.prompt.trim() || input.images > 0 || input.busy) return 'docked';
  return input.focused && input.keyboardOpen ? 'docked' : 'centered';
}
