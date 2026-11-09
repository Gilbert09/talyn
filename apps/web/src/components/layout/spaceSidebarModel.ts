import { useMemo } from 'react';
import type { SpacePresenceMember, SpaceSessionRow, Workbench, Workspace } from '@talyn/shared';
import { isActiveSessionState, spaceSessionState, type SessionState } from '../../lib/sessionState';
import { isWorkbenchOwner } from '../../lib/spaces';
import { isThread } from '../../lib/threads';
import { newestSessions } from '../../lib/sessionOrder';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useSessionBackgroundStore } from '../../stores/sessionBackground';
import { emptySpaceList, useSpacesStore } from '../../stores/spaces';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useWorkspaceStore } from '../../stores/workspace';
import {
  groupSidebarWorkbenches,
  isArchived,
  sidebarSessionStates,
  spaceGroupKeyPrefix,
  visibleGroupItems,
  type RepoGroup,
  type SidebarStateSources,
} from '../workbench/workbenchSelectors';

/** One row of the space sidebar. `workbench` is set when the session is mine and loaded, so it gets the full row. */
export interface SpaceSidebarItem {
  id: string;
  row: SpaceSessionRow;
  workbench: Workbench | null;
}

export interface SpaceSidebarThread {
  thread: SpaceSidebarItem;
  children: SpaceSidebarItem[];
}

export interface SpaceSidebarModel {
  /** My live threads, newest first, each with its live sessions. */
  threads: SpaceSidebarThread[];
  /** The sessions, grouped as in Personal. A thread's sessions show here too. */
  groups: RepoGroup<SpaceSessionRow>[];
  states: ReadonlyMap<string, SessionState>;
  owned: ReadonlyMap<string, Workbench>;
}

export interface SpaceSidebarInput extends SidebarStateSources {
  rows: SpaceSessionRow[];
  presence: SpacePresenceMember[] | undefined;
  selfUserId: string | null;
  workbenches: Record<string, Workbench>;
  workspaces: Workspace[];
  currentWorkspaceId: string | null;
  activeFirst: boolean;
}

const WORKING: SessionState = { kind: 'working', label: 'Working' };

/**
 * The space sidebar, the same shape as Personal. A session is active when it
 * is active in Personal's sense, or when a teammate has it open now. My own
 * loaded sessions get their state from the live store; the rest get it from
 * the space row.
 */
export function spaceSidebarModel(input: SpaceSidebarInput): SpaceSidebarModel {
  const owned = new Map<string, Workbench>();
  for (const row of input.rows) {
    const wb = input.workbenches[row.id];
    if (wb && isWorkbenchOwner(row, input.workspaces, input.currentWorkspaceId)) owned.set(row.id, wb);
  }
  const live = input.rows.filter((row) => {
    if (row.archivedAt || row.status === 'archived') return false;
    const wb = owned.get(row.id);
    return !wb || !isArchived(wb);
  });
  const own = sidebarSessionStates(
    live.flatMap((row) => owned.get(row.id) ?? []),
    input,
  );
  const viewed = new Set(
    (input.presence ?? [])
      .filter((m) => m.state === 'active' && m.sessionId && m.userId !== input.selfUserId)
      .map((m) => m.sessionId),
  );
  const states = new Map<string, SessionState>();
  const activeIds = new Set<string>();
  for (const row of live) {
    let state = own.states.get(row.id) ?? spaceSessionState(row);
    if (row.running && !isActiveSessionState(state)) state = WORKING;
    states.set(row.id, state);
    if (isActiveSessionState(state) || viewed.has(row.id) || own.activeIds.has(row.id)) activeIds.add(row.id);
  }

  const item = (row: SpaceSessionRow): SpaceSidebarItem => ({ id: row.id, row, workbench: owned.get(row.id) ?? null });
  const threads = newestSessions(live.filter((row) => isThread(row))).map((thread) => ({
    thread: item(thread),
    children: newestSessions(live.filter((row) => !isThread(row) && row.threadId === thread.id)).map(item),
  }));
  return {
    threads,
    groups: groupSidebarWorkbenches(live, activeIds, input.activeFirst),
    states,
    owned,
  };
}

/** The session ids the space sidebar shows, in its order: the ones ⌘⌥1–9 count. */
export function spaceSidebarSessionIds(
  model: Pick<SpaceSidebarModel, 'groups'>,
  spaceId: string,
  collapsed: Readonly<Record<string, true>>,
  openId: string | null,
): string[] {
  const prefix = spaceGroupKeyPrefix(spaceId);
  return model.groups.flatMap((group) => visibleGroupItems(group, collapsed, openId, prefix)).map((row) => row.id);
}

/** The model from the stores as they are now, for keyboard shortcuts. */
export function currentSpaceSidebarModel(spaceId: string): SpaceSidebarModel {
  const spaces = useSpacesStore.getState();
  const wbs = useWorkbenchStore.getState();
  const ws = useWorkspaceStore.getState();
  return spaceSidebarModel({
    rows: (spaces.sessions[spaceId] ?? emptySpaceList<SpaceSessionRow>()).items,
    presence: spaces.presence[spaceId],
    selfUserId: spaces.selfUserId,
    workbenches: wbs.workbenches,
    workspaces: ws.workspaces,
    currentWorkspaceId: ws.currentWorkspaceId,
    activeFirst: ws.sidebarOrder === 'active_first',
    prRows: usePullRequestStore.getState().rows,
    chats: wbs.chats,
    unread: wbs.unread,
    unseen: wbs.unseen,
    backgrounds: useSessionBackgroundStore.getState().byWorkbench,
  });
}

export function useSpaceSidebarModel(spaceId: string): SpaceSidebarModel {
  const rows = (useSpacesStore((s) => s.sessions[spaceId]) ?? emptySpaceList<SpaceSessionRow>()).items;
  const presence = useSpacesStore((s) => s.presence[spaceId]);
  const selfUserId = useSpacesStore((s) => s.selfUserId);
  const workbenches = useWorkbenchStore((s) => s.workbenches);
  const chats = useWorkbenchStore((s) => s.chats);
  const unread = useWorkbenchStore((s) => s.unread);
  const unseen = useWorkbenchStore((s) => s.unseen);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const sidebarOrder = useWorkspaceStore((s) => s.sidebarOrder);
  const prRows = usePullRequestStore((s) => s.rows);
  const backgrounds = useSessionBackgroundStore((s) => s.byWorkbench);
  return useMemo(
    () =>
      spaceSidebarModel({
        rows,
        presence,
        selfUserId,
        workbenches,
        workspaces,
        currentWorkspaceId,
        activeFirst: sidebarOrder === 'active_first',
        prRows,
        chats,
        unread,
        unseen,
        backgrounds,
      }),
    [rows, presence, selfUserId, workbenches, workspaces, currentWorkspaceId, sidebarOrder, prRows, chats, unread, unseen, backgrounds],
  );
}
