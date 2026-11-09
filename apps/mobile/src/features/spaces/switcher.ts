import type { Space, SpacesTeam } from '@talyn/shared';

import type { WorkspaceChoice } from '../../workspaces/controller';
import type { ActiveContext, AppContext } from '../../workspaces/context';

export interface SwitcherChoice { key: string; label: string; target: AppContext; selected: boolean; space?: Space }
export interface SwitcherSection { key: string; title: string; note?: string; choices: SwitcherChoice[] }

export interface SwitcherInput {
  workspaces: readonly WorkspaceChoice[];
  teams: readonly SpacesTeam[] | undefined;
  teamsFailed?: boolean;
  offered: boolean;
  context: ActiveContext;
}

/**
 * The switcher's sections, like web's `WorkspaceSwitcher`: my workspaces
 * ("Personal" once Spaces is offered), then one section per team with its
 * spaces. The current context has the check.
 */
export function switcherSections({ workspaces, teams, teamsFailed = false, offered, context }: SwitcherInput): SwitcherSection[] {
  const personal: SwitcherSection = {
    key: 'personal', title: offered ? 'Personal' : 'Workspaces',
    choices: workspaces.map((workspace) => ({ key: `workspace:${workspace.id}`, label: workspace.name,
      target: { kind: 'personal', workspaceId: workspace.id },
      selected: context.kind === 'personal' && context.workspaceId === workspace.id })),
  };
  if (!offered) return [personal];
  if (!teams) return [personal, { key: 'teams', title: 'Teams', note: teamsFailed ? 'Could not load your teams.' : 'Loading your teams.', choices: [] }];
  return [personal, ...teams.map((team): SwitcherSection => ({
    key: `team:${team.id}`, title: team.name, note: team.spaces.length ? undefined : 'No spaces yet.',
    choices: team.spaces.map((space) => ({ key: `space:${space.id}`, label: space.name, space,
      target: { kind: 'space', spaceId: space.id }, selected: context.kind === 'space' && context.spaceId === space.id })),
  }))];
}

/** What the drawer header shows: the space and its team, or the workspace. Mirrors web's trigger. */
export function switcherLabel(context: ActiveContext, workspaceName: string | undefined): { title: string; subtitle?: string } {
  if (context.kind === 'space') return { title: context.space.name, subtitle: context.team.name };
  return { title: workspaceName ?? 'Choose workspace' };
}
