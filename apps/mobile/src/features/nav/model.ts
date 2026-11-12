import type { Workbench } from '@talyn/shared';
import type { LegacyPanGesture } from 'react-native-gesture-handler';

import { workbenchState, type SessionStateKind } from '../../lib/status';
import type { PullsTab } from '../prs/lists';
import { compareWorkbenches, groupByRepository, workbenchTitle } from '../../workflow/model';

/** States that wait on the person: an answer, a permission or plan prompt, or a failure. */
export const NEEDS_YOU: ReadonlySet<SessionStateKind> = new Set(['needs_reply', 'failed']);

export function needsYou(item: Workbench): boolean {
  return !item.archivedAt && NEEDS_YOU.has(workbenchState(item).kind);
}

/** Lower case and trimmed, so a search ignores case and stray spaces. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Whether a session or thread matches a normalized search by its title, repository or branch. */
export function matchesQuery(item: Workbench, query: string): boolean {
  if (!query) return true;
  return [workbenchTitle(item), item.repoFullName, item.branch, item.name]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(query));
}

/** The label of a group of sessions with no repository. */
export const NO_REPOSITORY = 'No repository';

export type DrawerSection = 'needs' | 'threads' | 'sessions';
export type DrawerEntry =
  | { type: 'heading'; key: string; section: DrawerSection; title: string }
  | { type: 'group'; key: string; repo: string; expanded: boolean; hidden: number; attention: boolean }
  | { type: 'thread'; key: string; item: Workbench; expanded: boolean; childCount: number; running: number }
  | { type: 'row'; key: string; item: Workbench; indent: boolean }
  | { type: 'notice'; key: string; text: string }
  /** What a session is, and jobs to start one with. Shown when there are no sessions at all. */
  | { type: 'starters'; key: string }
  | { type: 'loading'; key: string };

export interface DrawerInput {
  sessions: Workbench[] | undefined;
  threads: Workbench[] | undefined;
  query: string;
  collapsedGroups: ReadonlySet<string>;
  collapsedThreads: ReadonlySet<string>;
}

const running = (item: Workbench) => (item.chats ?? []).some((chat) => chat.status === 'running' || (chat.queuedMessages?.length ?? 0) > 0);

/**
 * The drawer's lists as one flat array for a virtualised list, like web's
 * sidebar: Needs you, Threads with their sessions, then Sessions by repository.
 * A search keeps only the matches and opens every group and thread.
 */
export function drawerEntries({ sessions, threads, query: raw, collapsedGroups, collapsedThreads }: DrawerInput): DrawerEntry[] {
  const query = normalizeQuery(raw);
  const searching = query.length > 0;
  if (sessions === undefined && threads === undefined) return [{ type: 'loading', key: 'loading' }];
  const allSessions = (sessions ?? []).filter((item) => !item.archivedAt);
  const allThreads = (threads ?? []).filter((item) => !item.archivedAt);
  const entries: DrawerEntry[] = [];

  const waiting = [...allThreads, ...allSessions].filter((item) => needsYou(item) && matchesQuery(item, query)).sort(compareWorkbenches);
  if (waiting.length) {
    entries.push({ type: 'heading', key: 'heading:needs', section: 'needs', title: 'Needs you' });
    for (const item of waiting) entries.push({ type: 'row', key: `needs:${item.id}`, item, indent: false });
  }

  const threadEntries: DrawerEntry[] = [];
  for (const thread of [...allThreads].sort(compareWorkbenches)) {
    const children = allSessions.filter((item) => item.threadId === thread.id).sort(compareWorkbenches);
    const own = matchesQuery(thread, query);
    const shown = own ? children : children.filter((item) => matchesQuery(item, query));
    if (!own && !shown.length) continue;
    const expanded = searching || !collapsedThreads.has(thread.id);
    threadEntries.push({ type: 'thread', key: `thread:${thread.id}`, item: thread, expanded,
      childCount: shown.length, running: children.filter(running).length });
    if (expanded) for (const item of shown) threadEntries.push({ type: 'row', key: `child:${thread.id}:${item.id}`, item, indent: true });
  }
  if (threadEntries.length || (!searching && threads !== undefined)) {
    entries.push({ type: 'heading', key: 'heading:threads', section: 'threads', title: 'Threads' });
    entries.push(...threadEntries);
  }

  const matched = allSessions.filter((item) => matchesQuery(item, query));
  if (matched.length || !searching) {
    entries.push({ type: 'heading', key: 'heading:sessions', section: 'sessions', title: 'Sessions' });
    if (sessions === undefined) entries.push({ type: 'loading', key: 'loading:sessions' });
    else if (!matched.length) entries.push({ type: 'starters', key: 'starters:sessions' });
  }
  for (const group of groupByRepository(matched)) {
    const repo = group.repo || NO_REPOSITORY;
    const expanded = searching || !collapsedGroups.has(repo);
    entries.push({ type: 'group', key: `group:${repo}`, repo, expanded,
      hidden: expanded ? 0 : group.items.length, attention: !expanded && group.items.some(needsYou) });
    if (expanded) for (const item of group.items) entries.push({ type: 'row', key: `session:${item.id}`, item, indent: false });
  }

  if (searching && !entries.length) entries.push({ type: 'notice', key: 'notice:search', text: 'No sessions or threads match.' });
  return entries;
}

/** How many sessions and threads wait on the person. Drives the menu button's dot. */
export function needsYouCount(sessions: Workbench[] | undefined, threads: Workbench[] | undefined): number {
  return [...(threads ?? []), ...(sessions ?? [])].filter(needsYou).length;
}

/** A count for a badge: nothing for zero or unknown, and "99+" above 99. */
export function badgeText(count: number | null | undefined): string | null {
  if (!count || count < 0 || !Number.isFinite(count)) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

/** Toggle one key in a set, returning a new set. */
export function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}

export type DrawerTarget = 'home' | `pulls:${PullsTab}` | 'settings' | 'spaces' | 'integrations' | 'usage' | 'agents' | 'insights' | 'history' | null;

/** Which drawer entry the current route belongs to, so the drawer can mark it. */
export function activeTarget(pathname: string, tab?: string | string[] | null): DrawerTarget {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/home') return 'home';
  if (path === '/pulls') {
    const value = Array.isArray(tab) ? tab[0] : tab;
    return value === 'reviews' || value === 'queue' ? `pulls:${value}` : 'pulls:mine';
  }
  const first = path.split('/')[1];
  if (first === 'settings' || first === 'spaces' || first === 'integrations' || first === 'usage' || first === 'agents' || first === 'insights'
    || first === 'history') return first;
  return null;
}

/** The narrowest of 85% of the screen and 360 points. */
export function drawerWidth(screenWidth: number): number {
  return Math.round(Math.min(screenWidth * 0.85, 360));
}

/** The strip at the left edge of home where a swipe opens the drawer, in points. */
export const DRAWER_SWIPE_EDGE = 64;
/** A drag this far, or a quick flick, opens the drawer. Shorter, slow drags close it again. */
export const DRAWER_SWIPE_MIN_DISTANCE = 40;
/** Vertical drift that cancels the swipe before it moves 5 points across. */
export const DRAWER_SWIPE_VERTICAL_SLOP = 20;

/**
 * The drawer library cancels the swipe after 5 points of vertical drift. A thumb swipe
 * from the edge is rarely that straight, so many swipes did not open the drawer.
 */
export function configureDrawerSwipe(gesture: LegacyPanGesture): LegacyPanGesture {
  return gesture.failOffsetY([-DRAWER_SWIPE_VERTICAL_SLOP, DRAWER_SWIPE_VERTICAL_SLOP]);
}
