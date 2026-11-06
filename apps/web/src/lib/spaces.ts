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
import { useWorkspaceStore, type AppContext } from '../stores/workspace';

export function spacesOffered(features: Pick<Features, 'spaces'> | null | undefined): boolean {
  return features?.spaces === true;
}

/** The space the app is in, or null in Personal (or when the space is gone or not offered). */
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

/** Every context in switcher order: my workspaces, then each team's spaces. ⌘⌥⇧1–9 counts in this order. */
export function contextEntries(workspaces: Workspace[], teams: SpacesTeam[] | null): AppContext[] {
  return [
    ...workspaces.map((w): AppContext => ({ kind: 'personal', workspaceId: w.id })),
    ...(teams ?? []).flatMap((t) => t.spaces.map((s): AppContext => ({ kind: 'space', spaceId: s.id }))),
  ];
}

export function contextsEqual(a: AppContext, b: AppContext): boolean {
  if (a.kind === 'personal' && b.kind === 'personal') return a.workspaceId === b.workspaceId;
  if (a.kind === 'space' && b.kind === 'space') return a.spaceId === b.spaceId;
  return false;
}

/** Switch context and land on its home: a space's feed, or Personal's new-session page. */
export function switchContext(context: AppContext): void {
  const ws = useWorkspaceStore.getState();
  const current: AppContext = spacesOffered(ws.features)
    ? ws.currentContext
    : { kind: 'personal', workspaceId: ws.currentWorkspaceId };
  if (contextsEqual(current, context)) return;
  ws.setContext(context);
  useNavigationStore.getState().navigate({ view: 'home' });
}

/** The session belongs to one of my workspaces. A teammate's session does not. */
export function isWorkbenchOwner(workbench: Pick<Workbench, 'workspaceId'>, workspaces: Workspace[], currentWorkspaceId: string | null): boolean {
  return workbench.workspaceId === currentWorkspaceId || workspaces.some((w) => w.id === workbench.workspaceId);
}

/**
 * A workbench in the main list is in my current workspace. Only a viewed-only
 * extra can be a teammate's, so only those are checked against my workspaces.
 */
export function useIsWorkbenchOwner(workbench: Pick<Workbench, 'id' | 'workspaceId'>): boolean {
  const extra = useWorkbenchStore((s) => Boolean(s.extraWorkbenchIds[workbench.id]));
  const mine = useWorkspaceStore((s) => extra && isWorkbenchOwner(workbench, s.workspaces ?? [], s.currentWorkspaceId));
  return !extra || mine;
}

/** Fetch a workbench from outside the current workspace and hold it for viewing. */
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

/** Open a session of a space: mine opens at once, a teammate's is fetched first. */
export async function openSpaceSession(id: string): Promise<void> {
  const nav = useNavigationStore.getState();
  if (useWorkbenchStore.getState().workbenches[id]) {
    nav.navigate({ view: 'workbench', id });
    return;
  }
  const wb = await loadExtraWorkbench(id);
  if (wb) useNavigationStore.getState().navigate({ view: 'workbench', id });
}

/** Hold a session I just created in a space, then open it. */
export function openCreatedSession(wb: Workbench): void {
  const store = useWorkbenchStore.getState();
  if (store.workspaceId === wb.workspaceId) store.upsertWorkbench(wb);
  else store.addExtraWorkbench(wb);
  useNavigationStore.getState().navigate({ view: 'workbench', id: wb.id });
}

/**
 * The words to show inline under the composer when the backend would not take
 * a teammate's message: someone else's turn is running, or the person cannot
 * prompt (no agent account, no push access). Null for any other failure.
 */
export function promptRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'payer_busy') return err.message || 'Waiting for the current turn to finish.';
  if (err.status === 403 || err.status === 409) return err.message || 'You cannot prompt this session.';
  return null;
}

/** Teammates with the session open now, me left out. */
export function viewersOf(members: SpacePresenceMember[] | undefined, sessionId: string, selfUserId: string | null): SpacePresenceMember[] {
  return (members ?? []).filter((m) => m.sessionId === sessionId && m.state === 'active' && m.userId !== selfUserId);
}

export function memberName(m: { githubLogin: string | null }): string {
  return m.githubLogin ?? 'A teammate';
}

/** "Ana is here", "Ana and Ben are here", "Ana, Ben and 2 others are here". */
export function presenceSentence(members: { githubLogin: string | null }[]): string | null {
  const names = members.map(memberName);
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is here`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? 'other' : 'others'} are here`;
}

/**
 * "Active now": a session a teammate has open, or with a turn running. The
 * rest is "Recent", newest activity first. Archived sessions are left out.
 */
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
