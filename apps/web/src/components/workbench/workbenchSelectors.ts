import { useEffect, useMemo, useState } from 'react';
import {
  codeCompleteBlockers,
  type CodeCompleteBlocker,
  type ContextAttentionReason,
  type Workbench,
  type WorkbenchBackground,
  type WorkbenchChat,
} from '@talyn/shared';
import { api, type PRRow } from '../../lib/api';
import { usePullRequestStore } from '../../stores/pullRequests';
import { isPrOnlyUnseen, useWorkbenchStore, type UnseenUpdates } from '../../stores/workbenches';
import { isActiveSessionState, sessionPr, sessionState, withServerAttention, type SessionState } from '../../lib/sessionState';
import { opsFor, sandboxUnavailableReason, type WorkbenchOps } from '../../lib/workbenchOps';
import { isThread, liveThreads, threadChildren } from '../../lib/threads';
import { newestSessions } from '../../lib/sessionOrder';
import { inPersonalList, spacesOffered } from '../../lib/spaces';
import { useSpacesStore } from '../../stores/spaces';
import { useWorkspaceStore } from '../../stores/workspace';
import { useRunningJobs } from '../../stores/sessionBackground';

/** What the sidebar groups need from a session: a workbench, or a space's session row. */
export type SidebarItem = Pick<Workbench, 'id' | 'kind' | 'repoFullName' | 'createdAt'>;

export interface RepoGroup<T extends SidebarItem = Workbench> {
  repo: string;
  items: T[];
  active?: boolean;
}

/** Live sessions grouped by repository, with the newest session first. The order does not change as sessions work. */
export function groupByRepository<T extends SidebarItem>(workbenches: T[]): RepoGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const wb of workbenches) {
    if (isThread(wb)) continue;
    const list = map.get(wb.repoFullName);
    if (list) list.push(wb);
    else map.set(wb.repoFullName, [wb]);
  }
  return [...map.entries()]
    .map(([repo, items]) => ({ repo, items: newestSessions(items) }))
    .sort((a, b) => b.items[0].createdAt.localeCompare(a.items[0].createdAt) || a.repo.localeCompare(b.repo));
}

/** Active sessions first in one group, then inactive sessions by repository. */
export function groupSidebarWorkbenches<T extends SidebarItem>(
  workbenches: T[],
  activeIds: ReadonlySet<string>,
  activeFirst: boolean,
): RepoGroup<T>[] {
  if (!activeFirst) return groupByRepository(workbenches);
  const active = newestSessions(workbenches.filter((workbench) => activeIds.has(workbench.id) && !isThread(workbench)));
  const inactive = groupByRepository(workbenches.filter((workbench) => !activeIds.has(workbench.id)));
  return active.length > 0 ? [{ repo: 'Active', items: active, active: true }, ...inactive] : inactive;
}

/**
 * The key a group's collapsed state is saved under. A repository name always
 * holds a slash, so 'active' cannot clash. A space passes its own prefix, so
 * it does not share collapsed groups with Personal.
 */
export function sessionGroupKey(group: Pick<RepoGroup<SidebarItem>, 'repo' | 'active'>, prefix = ''): string {
  return `${prefix}${group.active ? 'active' : group.repo}`;
}

export function spaceGroupKeyPrefix(spaceId: string): string {
  return `space:${spaceId}:`;
}

/**
 * The rows a group shows. A collapsed group hides its sessions, but it keeps
 * the open one so the sidebar still shows where you are.
 */
export function visibleGroupItems<T extends SidebarItem>(
  group: RepoGroup<T>,
  collapsed: Readonly<Record<string, true>>,
  openId: string | null,
  prefix = '',
): T[] {
  if (!collapsed[sessionGroupKey(group, prefix)]) return group.items;
  return group.items.filter((workbench) => workbench.id === openId);
}

/** What the sidebar reads to say what a session is doing. */
export interface SidebarStateSources {
  prRows: readonly PRRow[];
  chats: Record<string, WorkbenchChat[] | undefined>;
  unread: Record<string, true>;
  unseen: Record<string, UnseenUpdates | undefined>;
  backgrounds: Record<string, WorkbenchBackground | undefined>;
  /** The sessions that the context rail counts (`useAttentionSessions`). */
  attention?: Readonly<Record<string, ContextAttentionReason>>;
}

/**
 * Each session's sidebar state, and the ones that count as active: work now,
 * need you, or have an open pull request. A linked PR the store has not
 * loaded yet counts as open, so the row does not jump when it loads.
 */
export function sidebarSessionStates(
  workbenches: Workbench[],
  sources: SidebarStateSources,
): { activeIds: Set<string>; states: Map<string, SessionState> } {
  const rowById = new Map(sources.prRows.map((row) => [row.id, row]));
  const states = new Map<string, SessionState>();
  const activeIds = new Set<string>();
  for (const workbench of workbenches) {
    const pr = workbench.pullRequestId ? rowById.get(workbench.pullRequestId) : undefined;
    const resolvedPr = sessionPr(workbench, pr);
    const state = withServerAttention(
      sessionState(
        workbench,
        sources.chats[workbench.id] ?? workbench.chats ?? [],
        sources.unread,
        resolvedPr,
        isPrOnlyUnseen(sources.unseen[workbench.id]),
        sources.backgrounds[workbench.id],
      ),
      sources.attention?.[workbench.id],
      resolvedPr?.number,
    );
    states.set(workbench.id, state);
    if (isActiveSessionState(state) || (!resolvedPr && Boolean(workbench.pullRequestId))) activeIds.add(workbench.id);
  }
  return { activeIds, states };
}

export function isArchived(wb: Workbench): boolean {
  return wb.status === 'archived' || Boolean(wb.archivedAt);
}

/**
 * The workbenches of the current workspace, archived included. Viewed-only
 * extras are left out. Sessions in a space are left out too (see
 * `inPersonalList`), unless `withSpaceSessions` is set.
 */
export function useWorkspaceWorkbenches(opts: { withSpaceSessions?: boolean } = {}): Workbench[] {
  const map = useWorkbenchStore((s) => s.workbenches);
  const extra = useWorkbenchStore((s) => s.extraWorkbenchIds);
  const offered = useWorkspaceStore((s) => spacesOffered(s.features));
  const teams = useSpacesStore((s) => s.teams);
  const withSpaceSessions = Boolean(opts.withSpaceSessions);
  return useMemo(
    () => Object.values(map).filter((wb) => !extra[wb.id] && (withSpaceSessions || inPersonalList(wb, teams, offered))),
    [map, extra, teams, offered, withSpaceSessions],
  );
}

/** Live workbenches in sidebar order — the order ⌘1–9 counts in. */
export function useOrderedLiveWorkbenches(): Workbench[] {
  const all = useWorkspaceWorkbenches();
  return useMemo(() => groupByRepository(all.filter((w) => !isArchived(w))).flatMap((g) => g.items), [all]);
}

/** Live threads of the current workspace, oldest first. */
export function useLiveThreads(): Workbench[] {
  const all = useWorkspaceWorkbenches();
  return useMemo(() => liveThreads(all), [all]);
}

/** The sessions of a thread, archived ones too when asked. */
export function useThreadChildren(threadId: string, opts: { includeArchived?: boolean } = {}): Workbench[] {
  const all = useWorkspaceWorkbenches();
  const includeArchived = Boolean(opts.includeArchived);
  return useMemo(() => threadChildren(all, threadId, { includeArchived }), [all, threadId, includeArchived]);
}

export function useSelectedWorkbench(): Workbench | null {
  return useWorkbenchStore((s) => (s.selectedWorkbenchId ? (s.workbenches[s.selectedWorkbenchId] ?? null) : null));
}

/** The chat on screen: the remembered one, else the newest chat. */
export function useSelectedChat(workbenchId: string): WorkbenchChat | null {
  const chats = useWorkbenchStore((s) => s.chats[workbenchId]);
  const selectedId = useWorkbenchStore((s) => s.selectedChatByWorkbench[workbenchId]);
  return useMemo(() => {
    const list = chats ?? [];
    return list.find((c) => c.id === selectedId) ?? list[list.length - 1] ?? null;
  }, [chats, selectedId]);
}

export function useWorkbenchOps(workbench: Workbench): WorkbenchOps {
  // Rebuilt only when what the ops close over changes. `settings` is keyed by
  // its JSON: a WS frame hands back a new object each time, which would rebuild
  // the ops (and refetch the changes) on every frame.
  const settingsKey = JSON.stringify(workbench.settings ?? {});
  const reason = sandboxUnavailableReason(workbench);
  return useMemo(
    () => opsFor(workbench),
    [
      workbench.id,
      workbench.runtime,
      workbench.deviceId,
      workbench.baseBranch,
      workbench.branch,
      workbench.status,
      workbench.sandboxState,
      reason,
      settingsKey,
    ],
  );
}

/**
 * The PR this workbench opened. The open-PR store first; a merged or closed
 * PR has left that list, so it is fetched on its own.
 */
export function useWorkbenchPr(workbench: Workbench): PRRow | null {
  const id = workbench.pullRequestId;
  const row = usePullRequestStore((s) => (id ? s.rows.find((r) => r.id === id) : undefined));
  const [fetched, setFetched] = useState<PRRow | null>(null);
  useEffect(() => {
    if (!id || row) return undefined;
    let cancelled = false;
    api.pullRequests
      .get(id)
      .then((res) => {
        if (!cancelled) setFetched(res.row);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, row, workbench.updatedAt]);
  if (!id) return null;
  return row ?? (fetched?.id === id ? fetched : null);
}

/**
 * Why the session is not "code complete" (see `codeCompleteBlockers`). Empty
 * when its turns are done, nothing runs, the work is pushed and its pull
 * request is open. `pr` is the session's PR row; without it the workbench's PR
 * summary gives the state.
 */
export function useSessionCodeCompleteBlockers(
  workbench: Workbench | null | undefined,
  pr: PRRow | null | undefined,
): CodeCompleteBlocker[] {
  const id = workbench?.id ?? '';
  const storeChats = useWorkbenchStore((s) => (id ? s.chats[id] : undefined));
  const runningScripts = useWorkbenchStore(
    (s) => Object.values(s.scriptOutput[id] ?? {}).filter((output) => output.running).length,
  );
  const runningJobs = useRunningJobs(id).length;
  if (!workbench) return ['no_chat'];
  const pullRequestState = workbench.pullRequestId
    ? ((pr?.id === workbench.pullRequestId ? pr.state : null) ?? workbench.pr?.state ?? null)
    : null;
  return codeCompleteBlockers({
    kind: workbench.kind,
    archived: isArchived(workbench),
    chats: storeChats ?? workbench.chats ?? [],
    pullRequestState,
    runningBackgroundJobs: runningJobs,
    runningScripts,
    uncommittedFiles: workbench.uncommittedStats?.files ?? null,
    unpushedCommits: workbench.unpushedCommits ?? null,
  });
}

/** True when the session is "code complete" (see `isSessionCodeComplete`). */
export function useSessionCodeComplete(workbench: Workbench | null | undefined, pr: PRRow | null | undefined): boolean {
  return useSessionCodeCompleteBlockers(workbench, pr).length === 0;
}
