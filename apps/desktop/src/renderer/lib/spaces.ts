import type {
  Features,
  SpacePresenceMember,
  SpaceSessionRow,
  SpacesTeam,
  Workbench,
  Workspace,
} from '@talyn/shared';
import { ApiError, api } from './api';
import { useNavigationStore } from '../stores/navigation';
import { useWorkbenchStore } from '../stores/workbenches';
import { findSpace, useSpacesStore, type SpaceRef } from '../stores/spaces';
import { contextsEqual, useWorkspaceStore, type AppContext } from '../stores/workspace';

export function spacesOffered(features: Pick<Features, 'spaces'> | null | undefined): boolean {
  return features?.spaces === true;
}

export function activeSpace(): SpaceRef | null {
  const ws = useWorkspaceStore.getState();
  if (!spacesOffered(ws.features) || ws.currentContext.kind !== 'space') return null;
  return findSpace(useSpacesStore.getState().teams, ws.currentContext.spaceId);
}

export function useActiveSpace(): SpaceRef | null {
  const offered = useWorkspaceStore((s) => spacesOffered(s.features));
  const context = useWorkspaceStore((s) => s.currentContext);
  const teams = useSpacesStore((s) => s.teams);
  if (!offered || context.kind !== 'space') return null;
  return findSpace(teams, context.spaceId);
}

export function contextEntries(workspaces: Workspace[], teams: SpacesTeam[] | null): AppContext[] {
  return [
    ...workspaces.map((w): AppContext => ({ kind: 'personal', workspaceId: w.id })),
    ...(teams ?? []).flatMap((t) => t.spaces.map((s): AppContext => ({ kind: 'space', spaceId: s.id }))),
  ];
}

export { contextsEqual };

export function switchContext(context: AppContext): void {
  const ws = useWorkspaceStore.getState();
  const current: AppContext = spacesOffered(ws.features)
    ? ws.currentContext
    : { kind: 'personal', workspaceId: ws.currentWorkspaceId };
  if (contextsEqual(current, context)) return;
  // Navigate first, so the history entry left behind keeps the old context.
  useNavigationStore.getState().navigate({ view: 'home' });
  ws.setContext(context);
}

/**
 * A session in a space shows in that space, not in Personal. It shows in
 * Personal when Spaces is off or its space is gone, so it is never lost.
 * While my teams load, it stays out, so it does not show and then go.
 */
export function inPersonalList(
  workbench: Pick<Workbench, 'spaceId'>,
  teams: SpacesTeam[] | null,
  offered: boolean,
): boolean {
  if (!workbench.spaceId || !offered) return true;
  return teams !== null && !findSpace(teams, workbench.spaceId);
}

export function isWorkbenchOwner(workbench: Pick<Workbench, 'workspaceId'>, workspaces: Workspace[], currentWorkspaceId: string | null): boolean {
  return workbench.workspaceId === currentWorkspaceId || workspaces.some((w) => w.id === workbench.workspaceId);
}

// Only sessions fetched outside the workspace need an ownership check.
export function useIsWorkbenchOwner(workbench: Pick<Workbench, 'id' | 'workspaceId'>): boolean {
  const extra = useWorkbenchStore((s) => Boolean(s.extraWorkbenchIds[workbench.id]));
  const mine = useWorkspaceStore((s) => extra && isWorkbenchOwner(workbench, s.workspaces ?? [], s.currentWorkspaceId));
  return !extra || mine;
}

/**
 * The context a session lives in: its space when I am in that team, else the
 * Personal workspace that owns it. Null for a teammate's session outside my
 * spaces, and while my teams load.
 */
export function contextForSession(
  workbench: Pick<Workbench, 'workspaceId' | 'spaceId'>,
  teams: SpacesTeam[] | null,
  workspaces: Workspace[],
  currentWorkspaceId: string | null,
): AppContext | null {
  if (teams === null) return null;
  if (workbench.spaceId && findSpace(teams, workbench.spaceId)) return { kind: 'space', spaceId: workbench.spaceId };
  if (!isWorkbenchOwner(workbench, workspaces, currentWorkspaceId)) return null;
  return { kind: 'personal', workspaceId: workbench.workspaceId };
}

/**
 * Move the app to the context of an open session, for example one opened by a
 * link. The route stays on the session. False until the features and my teams
 * load, so the caller can try again.
 */
export function followSessionContext(workbench: Pick<Workbench, 'workspaceId' | 'spaceId'>): boolean {
  const ws = useWorkspaceStore.getState();
  if (ws.features === null) return false;
  if (!spacesOffered(ws.features)) return true;
  const teams = useSpacesStore.getState().teams;
  if (teams === null) return false;
  const target = contextForSession(workbench, teams, ws.workspaces ?? [], ws.currentWorkspaceId);
  if (!target) return true;
  const current: AppContext =
    ws.currentContext.kind === 'personal'
      ? { kind: 'personal', workspaceId: ws.currentContext.workspaceId ?? ws.currentWorkspaceId }
      : ws.currentContext;
  if (!contextsEqual(current, target)) ws.setContext(target);
  return true;
}

export async function loadExtraWorkbench(id: string): Promise<Workbench | null> {
  const spaces = useSpacesStore.getState();
  spaces.setExtraLoad(id, 'loading');
  try {
    const wb = await api.workbenches.get(id);
    useWorkbenchStore.getState().addExtraWorkbench(wb);
    const chats = (wb as Workbench & { chats?: unknown }).chats;
    if (Array.isArray(chats)) useWorkbenchStore.getState().setChats(wb.id, wb.chats ?? []);
    useSpacesStore.getState().setExtraLoad(id, null);
    return wb;
  } catch {
    useSpacesStore.getState().setExtraLoad(id, 'failed');
    return null;
  }
}

export async function openSpaceSession(id: string): Promise<void> {
  const nav = useNavigationStore.getState();
  if (useWorkbenchStore.getState().workbenches[id]) {
    nav.navigate({ view: 'workbench', id });
    return;
  }
  const wb = await loadExtraWorkbench(id);
  if (wb) useNavigationStore.getState().navigate({ view: 'workbench', id });
}

export function openCreatedSession(wb: Workbench): void {
  const store = useWorkbenchStore.getState();
  if (store.workspaceId === wb.workspaceId) store.upsertWorkbench(wb);
  else store.addExtraWorkbench(wb);
  useNavigationStore.getState().navigate({ view: 'workbench', id: wb.id });
}

export function promptRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'payer_busy') return err.message || 'Waiting for the current turn to finish.';
  if (err.status === 403 || err.status === 409) return err.message || 'You cannot prompt this session.';
  return null;
}

export function viewersOf(members: SpacePresenceMember[] | undefined, sessionId: string, selfUserId: string | null): SpacePresenceMember[] {
  return (members ?? []).filter((m) => m.sessionId === sessionId && m.state === 'active' && m.userId !== selfUserId);
}

export function memberName(m: { githubLogin: string | null }): string {
  return m.githubLogin ?? 'A teammate';
}

export function presenceSentence(members: { githubLogin: string | null }[]): string | null {
  const names = members.map(memberName);
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is here`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? 'other' : 'others'} are here`;
}

export function groupSpaceSessions(
  rows: SpaceSessionRow[],
  presence: SpacePresenceMember[] | undefined,
  selfUserId: string | null,
): { active: SpaceSessionRow[]; recent: SpaceSessionRow[] } {
  const viewed = new Set(
    (presence ?? []).filter((m) => m.state === 'active' && m.sessionId && m.userId !== selfUserId).map((m) => m.sessionId),
  );
  const live = rows.filter((r) => !r.archivedAt && r.status !== 'archived');
  const at = (r: SpaceSessionRow) => r.lastActivityAt ?? r.updatedAt ?? r.createdAt;
  const sorted = live.slice().sort((a, b) => at(b).localeCompare(at(a)));
  return {
    active: sorted.filter((r) => r.running || viewed.has(r.id)),
    recent: sorted.filter((r) => !r.running && !viewed.has(r.id)),
  };
}
