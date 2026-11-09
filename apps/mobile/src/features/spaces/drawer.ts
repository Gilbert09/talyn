import type { SpacePresenceMember, SpaceSessionRow, SpaceTaskRow, Workbench } from '@talyn/shared';

import { workbenchState, type SessionState } from '../../lib/status';
import { NO_REPOSITORY, normalizeQuery } from '../nav/model';
import type { SpaceItems } from './data';
import { hiddenText, spaceSessionState, viewersOf } from './model';

export type SpaceDrawerEntry =
  | { type: 'heading'; key: string; section: 'threads' | 'sessions' | 'tasks'; title: string }
  | { type: 'group'; key: string; repo: string; expanded: boolean; hidden: number; attention: boolean }
  | { type: 'thread'; key: string; row: SpaceSessionRow; state: SessionState; expanded: boolean; childCount: number; running: number;
    viewers: SpacePresenceMember[] }
  | { type: 'row'; key: string; row: SpaceSessionRow; state: SessionState; indent: boolean; viewers: SpacePresenceMember[] }
  | { type: 'task'; key: string; task: SpaceTaskRow }
  | { type: 'notice'; key: string; text: string }
  | { type: 'loading'; key: string };

export interface SpaceDrawerInput {
  items: SpaceItems | undefined;
  failed: boolean;
  /** My own sessions and threads the app holds, by id, for their live state. */
  owned: ReadonlyMap<string, Workbench>;
  presence: readonly SpacePresenceMember[] | undefined;
  self: string | null;
  query: string;
  collapsedGroups: ReadonlySet<string>;
  collapsedThreads: ReadonlySet<string>;
}

/** The label of the group of sessions that are active now. Web calls it the same. */
export const ACTIVE_GROUP = 'Active';
const WORKING: SessionState = { kind: 'working', label: 'Working' };

/** Mirrors web `isActiveSessionState`. */
export function isActiveState(state: SessionState): boolean {
  return state.kind !== 'idle' && state.kind !== 'merged' && state.kind !== 'closed';
}

/** Mine from the live store when the app holds it, else from the space row. A running row is never idle. */
export function spaceRowState(row: SpaceSessionRow, owned: ReadonlyMap<string, Workbench>): SessionState {
  const mine = owned.get(row.id);
  const state = mine ? workbenchState(mine) : spaceSessionState(row);
  return row.running && !isActiveState(state) ? WORKING : state;
}

function matches(row: SpaceSessionRow, query: string): boolean {
  if (!query) return true;
  return [row.title, row.name, row.repoFullName, row.branch, row.creator.githubLogin]
    .some((value) => typeof value === 'string' && value.toLowerCase().includes(query));
}

const newest = (a: SpaceSessionRow, b: SpaceSessionRow) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

/**
 * The drawer in a space, like web's `SpaceSidebar`: my threads with their
 * sessions, then every member's sessions with the active ones first and the
 * rest by repository, then the space's tasks and what I cannot see. A search
 * keeps the matches and opens every group and thread.
 */
export function spaceDrawerEntries(input: SpaceDrawerInput): SpaceDrawerEntry[] {
  const { items, owned, presence, self, collapsedGroups, collapsedThreads } = input;
  if (!items) return input.failed ? [{ type: 'notice', key: 'notice:error', text: 'Could not load the sessions.' }] : [{ type: 'loading', key: 'loading' }];
  const query = normalizeQuery(input.query);
  const searching = query.length > 0;
  const live = items.sessions.items.filter((row) => !row.archivedAt && row.status !== 'archived' && !owned.get(row.id)?.archivedAt);
  const states = new Map(live.map((row) => [row.id, spaceRowState(row, owned)]));
  const viewersFor = (row: SpaceSessionRow) => viewersOf(presence, row.id, self);
  const active = (row: SpaceSessionRow) => isActiveState(states.get(row.id) as SessionState) || viewersFor(row).length > 0;
  const entry = (row: SpaceSessionRow, key: string, indent: boolean): SpaceDrawerEntry =>
    ({ type: 'row', key, row, state: states.get(row.id) as SessionState, indent, viewers: viewersFor(row) });
  const entries: SpaceDrawerEntry[] = [];

  const threads = live.filter((row) => row.kind === 'thread').sort(newest);
  const sessions = live.filter((row) => row.kind !== 'thread');
  const threadEntries: SpaceDrawerEntry[] = [];
  for (const thread of threads) {
    const children = sessions.filter((row) => row.threadId === thread.id).sort(newest);
    const own = matches(thread, query);
    const shown = own ? children : children.filter((row) => matches(row, query));
    if (!own && !shown.length) continue;
    const expanded = searching || !collapsedThreads.has(thread.id);
    threadEntries.push({ type: 'thread', key: `thread:${thread.id}`, row: thread, state: states.get(thread.id) as SessionState, expanded,
      childCount: shown.length, running: children.filter((row) => row.running).length, viewers: viewersFor(thread) });
    if (expanded) for (const row of shown) threadEntries.push(entry(row, `child:${thread.id}:${row.id}`, true));
  }
  if (threadEntries.length) {
    entries.push({ type: 'heading', key: 'heading:threads', section: 'threads', title: 'Threads' }, ...threadEntries);
  }

  const matched = sessions.filter((row) => matches(row, query)).sort(newest);
  const groups: { repo: string; rows: SpaceSessionRow[] }[] = [];
  const now = matched.filter(active);
  if (now.length) groups.push({ repo: ACTIVE_GROUP, rows: now });
  const byRepo = new Map<string, SpaceSessionRow[]>();
  for (const row of matched.filter((item) => !active(item))) {
    const repo = row.repoFullName || NO_REPOSITORY;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), row]);
  }
  groups.push(...[...byRepo.entries()].map(([repo, rows]) => ({ repo, rows })));
  if (matched.length) entries.push({ type: 'heading', key: 'heading:sessions', section: 'sessions', title: 'Sessions' });
  for (const group of groups) {
    const expanded = searching || !collapsedGroups.has(group.repo);
    entries.push({ type: 'group', key: `group:${group.repo}`, repo: group.repo, expanded,
      hidden: expanded ? 0 : group.rows.length, attention: false });
    if (expanded) for (const row of group.rows) entries.push(entry(row, `session:${row.id}`, false));
  }
  if (!searching && !threads.length && !sessions.length) {
    entries.push({ type: 'notice', key: 'notice:empty', text: 'No sessions in this space yet.' });
  }

  const tasks = items.tasks.items.filter((task) => !searching || task.title.toLowerCase().includes(query)
    || (task.repoFullName ?? '').toLowerCase().includes(query));
  if (tasks.length) {
    entries.push({ type: 'heading', key: 'heading:tasks', section: 'tasks', title: 'Tasks' });
    for (const task of tasks) entries.push({ type: 'task', key: `task:${task.id}`, task });
  }
  if (searching && !entries.length) entries.push({ type: 'notice', key: 'notice:search', text: 'No sessions or threads match.' });
  const hidden = hiddenText(items.sessions.hiddenCount + items.tasks.hiddenCount);
  if (hidden) entries.push({ type: 'notice', key: 'notice:hidden', text: hidden });
  return entries;
}
