import type { PRRow, WatchedRepo } from '@talyn/client/native';
import type { CreateSpaceSessionRequest, SpaceRepository, SpacesTeam, WorkbenchReadiness, Workspace } from '@talyn/shared';

import { activePullRequest, blockedReason, type NewWorkForm, type NewWorkMode } from './model';

/**
 * A space's repositories in the shape the composer's repository sheet takes.
 * The full name is the id, like web, because the space create path takes the
 * name and adds the repository to my home workspace when it is missing.
 * The default branch comes from my home workspace, when it has the repository.
 */
export function spaceRepositories(spaceId: string, repositories: readonly SpaceRepository[] | undefined,
  homeRepos: readonly Pick<Workspace['repos'][number], 'name' | 'defaultBranch'>[] = []): WatchedRepo[] {
  return (repositories ?? []).map((repo) => {
    const [owner = '', name = ''] = repo.repoFullName.split('/');
    const wanted = repo.repoFullName.toLowerCase();
    const defaultBranch = homeRepos.find((item) => item.name.toLowerCase() === wanted)?.defaultBranch ?? '';
    return { id: repo.repoFullName, workspaceId: spaceId, owner, repo: name, fullName: repo.repoFullName, defaultBranch };
  });
}

/**
 * Pull request rows of the workspace shown, for the space's repositories.
 * A space repository id is its full name, so each kept row takes that id. Other rows drop out.
 */
export function spacePullRequestRows<T extends Pick<PRRow, 'owner' | 'repo' | 'repositoryId'>>(
  rows: readonly T[] | undefined, repos: readonly Pick<WatchedRepo, 'id' | 'fullName'>[]): T[] {
  const ids = new Map(repos.map((repo) => [repo.fullName.toLowerCase(), repo.id]));
  return (rows ?? []).flatMap((row) => {
    const id = ids.get(`${row.owner}/${row.repo}`.toLowerCase());
    return id ? [{ ...row, repositoryId: id }] : [];
  });
}

/** Why Start is off in a space: no home workspace first, then the personal rules. Mirrors web `SpaceComposer`. */
export function spaceBlockedReason(form: NewWorkForm, team: Pick<SpacesTeam, 'homeWorkspaceId'>,
  sandbox: WorkbenchReadiness['sandbox'] | null | undefined, offline: boolean): string | null {
  if (!team.homeWorkspaceId) return `You need a workspace of your own to start a ${form.mode} in a space.`;
  return blockedReason(form, sandbox, offline);
}

/**
 * The space create request, like web. A thread takes no repository or branch.
 * With images, the first message goes after the create, so the body has no prompt and the text names the session.
 */
export function spaceCreateBody(form: NewWorkForm, withImages = false): CreateSpaceSessionRequest {
  const text = form.prompt.trim() || undefined;
  const prompt = withImages ? undefined : text;
  const namingText = withImages ? text : undefined;
  if (form.mode === 'thread') return { kind: 'thread', agent: form.agent, model: form.model, prompt, namingText, internetAccess: form.internetAccess };
  if (!form.repository) throw new Error('Choose a repository.');
  const pr = activePullRequest(form.pullRequest, form.repository);
  return { repoFullName: form.repository.fullName, agent: form.agent, model: form.model,
    baseBranch: form.baseBranch.trim() || pr?.baseBranch || undefined,
    ...(pr ? { branch: pr.headBranch || undefined, fromPullRequestId: pr.id } : {}),
    prompt, namingText, internetAccess: form.internetAccess, autoCreatePr: true };
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
