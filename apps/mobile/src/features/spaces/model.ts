import type { Space, SpacePresenceMember, SpaceSessionRow, SpacesTeam, Workbench } from '@talyn/shared';
import type { Href } from 'expo-router';

import { sessionState, type SessionState } from '../../lib/status';
import { sessionRoute, threadRoute } from '../../navigation/routes';

export interface SpaceRef { space: Space; team: SpacesTeam }

export function spacesOffered(features: { spaces?: boolean } | null | undefined): boolean {
  return features?.spaces === true;
}

export function findSpace(teams: readonly SpacesTeam[] | null | undefined, spaceId: string | null | undefined): SpaceRef | null {
  if (!teams || !spaceId) return null;
  for (const team of teams) {
    const space = team.spaces.find((item) => item.id === spaceId);
    if (space) return { space, team };
  }
  return null;
}

/**
 * A session or thread in a space shows in that space, not in Personal. It
 * shows in Personal when Spaces is off or its space is gone, so it is never
 * lost. While my teams load (null) it stays out, so it does not show and then
 * go. Mirrors web `inPersonalList`.
 */
export function inPersonalList(workbench: Pick<Workbench, 'spaceId'>, teams: readonly SpacesTeam[] | null, offered: boolean): boolean {
  if (!workbench.spaceId || !offered) return true;
  return teams !== null && !findSpace(teams, workbench.spaceId);
}

/** The Personal subset of a list, or undefined while the list loads. */
export function personalItems<T extends Pick<Workbench, 'spaceId'>>(items: T[] | undefined, teams: readonly SpacesTeam[] | null, offered: boolean): T[] | undefined {
  return items?.filter((item) => inPersonalList(item, teams, offered));
}

/** One or two letters for a space tile. Mirrors web `railInitials`. */
export function spaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? [...words[0]].slice(0, 1) : [[...words[0]][0], [...words[1]][0]];
  return letters.join('').toUpperCase();
}

export function memberName(member: { githubLogin: string | null }): string {
  return member.githubLogin ?? 'A teammate';
}

/** "Ana is here", "Ana and Ben are here", "Ana, Ben and 2 others are here". */
export function presenceSentence(members: readonly { githubLogin: string | null }[]): string | null {
  const names = members.map(memberName);
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is here`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are here`;
  const others = names.length - 2;
  return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? 'other' : 'others'} are here`;
}

/** Teammates with the session open now, me left out. */
export function viewersOf(members: readonly SpacePresenceMember[] | undefined, sessionId: string, self: string | null): SpacePresenceMember[] {
  return (members ?? []).filter((member) => member.sessionId === sessionId && member.state === 'active' && member.userId !== self);
}

/**
 * The GitHub logins active in the space now, lower case, me included. A
 * presence entry names a Talyn user and a team member a GitHub account, so
 * the member list matches them on the login.
 */
export function activeLogins(members: readonly SpacePresenceMember[] | undefined): Set<string> {
  return new Set((members ?? []).filter((member) => member.state === 'active' && member.githubLogin)
    .map((member) => (member.githubLogin as string).toLowerCase()));
}

/**
 * "Active now": a session a teammate has open, or with a turn running. The
 * rest is "Recent", newest activity first. Archived sessions are left out.
 * Mirrors web `groupSpaceSessions`.
 */
export function groupSpaceSessions(rows: readonly SpaceSessionRow[], presence: readonly SpacePresenceMember[] | undefined, self: string | null) {
  const viewed = new Set((presence ?? []).filter((member) => member.state === 'active' && member.sessionId && member.userId !== self)
    .map((member) => member.sessionId));
  const at = (row: SpaceSessionRow) => row.lastActivityAt ?? row.updatedAt ?? row.createdAt;
  const live = rows.filter((row) => !row.archivedAt && row.status !== 'archived').sort((a, b) => at(b).localeCompare(at(a)));
  return {
    active: live.filter((row) => row.running || viewed.has(row.id)),
    recent: live.filter((row) => !row.running && !viewed.has(row.id)),
  };
}

/** A space row's state mark, from what the row carries. Mirrors web `spaceSessionState`. */
export function spaceSessionState(row: Pick<SpaceSessionRow, 'id' | 'kind' | 'status' | 'sandboxState' | 'running' | 'pullRequest' | 'archivedAt'>): SessionState {
  const pr = row.pullRequest;
  return sessionState(
    { status: row.status, sandboxState: row.sandboxState, diffStat: null, committedStats: null, archivedAt: row.archivedAt, kind: row.kind },
    row.running ? [{ id: row.id, status: 'running' }] : [],
    pr ? { number: pr.number, state: pr.state === 'merged' ? 'merged' : pr.state === 'closed' ? 'closed' : 'open', summary: { mergeable: 'UNKNOWN', ciStatus: 'none' } } : null,
  );
}

/** "1 item you can't see", or null when nothing is hidden. */
export function hiddenText(hidden: number): string | null {
  if (hidden <= 0) return null;
  return hidden === 1 ? "1 item you can't see" : `${hidden} items you can't see`;
}

export type OpenTarget = { kind: 'route'; href: Href } | { kind: 'switch'; workspaceId: string; href: Href } | { kind: 'web'; path: string };

/**
 * Where tapping a space row goes. The app's detail screens read the selected
 * workspace only. Mine in another of my workspaces switches to it first. A
 * teammate's opens on the web, where the narrow teammate view lives.
 */
export function openTarget(row: Pick<SpaceSessionRow, 'id' | 'kind' | 'workspaceId'>, workspaceId: string | null,
  mine: readonly string[] = []): OpenTarget {
  const href = row.kind === 'thread' ? threadRoute(row.id) : sessionRoute(row.id);
  if (workspaceId && row.workspaceId === workspaceId) return { kind: 'route', href };
  if (mine.includes(row.workspaceId)) return { kind: 'switch', workspaceId: row.workspaceId, href };
  return { kind: 'web', path: `/s/${encodeURIComponent(row.id)}` };
}

/** "Thread", or the repository. Mirrors web `workbenchPlaceLabel`. */
export function placeLabel(row: Pick<SpaceSessionRow, 'kind' | 'repoFullName'>): string {
  return row.kind === 'thread' ? 'Thread' : row.repoFullName;
}

export interface MoveChoice { spaceId: string | null; label: string; team: string | null; selected: boolean }

/** Personal, then every space of every team, with the current place checked. */
export function moveChoices(teams: readonly SpacesTeam[], current: string | null): MoveChoice[] {
  return [
    { spaceId: null, label: 'Personal', team: null, selected: current === null },
    ...teams.flatMap((team) => team.spaces.map((space) => ({ spaceId: space.id, label: space.name, team: team.name, selected: space.id === current }))),
  ];
}

/**
 * Whether "Move to space" is offered for a session or thread: Spaces is on,
 * my teams have loaded, and it is mine (moving is owner only). Web shows it
 * in the menus of my own lists, so this checks the selected workspace.
 */
export function canMoveToSpace(workbench: Pick<Workbench, 'workspaceId' | 'archivedAt'>,
  context: { offered: boolean; teams: readonly SpacesTeam[] | null | undefined; workspaceId: string | null }): boolean {
  return context.offered && Boolean(context.teams) && Boolean(context.workspaceId)
    && workbench.workspaceId === context.workspaceId && !workbench.archivedAt;
}
