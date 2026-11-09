import type { WatchedRepo } from '@talyn/client/native';
import type { CreateSpaceSessionRequest, SpaceRepository, SpacesTeam, WorkbenchReadiness, Workspace } from '@talyn/shared';

import { blockedReason, type NewWorkForm, type NewWorkMode } from './model';

/**
 * A space's repositories in the shape the composer's repository sheet takes.
 * The full name is the id, like web, because the space create path takes the
 * name and adds the repository to my home workspace when it is missing.
 */
export function spaceRepositories(spaceId: string, repositories: readonly SpaceRepository[] | undefined): WatchedRepo[] {
  return (repositories ?? []).map((repo) => {
    const [owner = '', name = ''] = repo.repoFullName.split('/');
    return { id: repo.repoFullName, workspaceId: spaceId, owner, repo: name, fullName: repo.repoFullName, defaultBranch: '' };
  });
}

/** Why Start is off in a space: no home workspace first, then the personal rules. Mirrors web `SpaceComposer`. */
export function spaceBlockedReason(form: NewWorkForm, team: Pick<SpacesTeam, 'homeWorkspaceId'>,
  sandbox: WorkbenchReadiness['sandbox'] | null | undefined, offline: boolean): string | null {
  if (!team.homeWorkspaceId) return `You need a workspace of your own to start a ${form.mode} in a space.`;
  return blockedReason(form, sandbox, offline);
}

/** The space create request, like web: a thread takes no repository, and neither takes a base branch. */
export function spaceCreateBody(form: NewWorkForm): CreateSpaceSessionRequest {
  const prompt = form.prompt.trim() || undefined;
  if (form.mode === 'thread') return { kind: 'thread', agent: form.agent, model: form.model, prompt, internetAccess: form.internetAccess };
  if (!form.repository) throw new Error('Choose a repository.');
  return { repoFullName: form.repository.fullName, agent: form.agent, model: form.model, prompt, internetAccess: form.internetAccess };
}

/** "Adds owner/repo to Home" when a session would add the repository to my home workspace first. */
export function addsRepositoryNote(mode: NewWorkMode, repoFullName: string | undefined, home: Pick<Workspace, 'name' | 'repos'> | null | undefined): string | null {
  if (mode !== 'session' || !repoFullName || !home) return null;
  const wanted = repoFullName.toLowerCase();
  return home.repos.some((repo) => repo.name.toLowerCase() === wanted) ? null : `Adds ${repoFullName} to ${home.name}`;
}

/** Web's composer placeholder in a space. */
export function spacePlaceholder(mode: NewWorkMode, spaceName: string): string {
  return mode === 'thread'
    ? `Start a thread in ${spaceName}. It can work across repositories. Only you can see it.`
    : `Start a session in ${spaceName}. Your teammates can see it.`;
}
