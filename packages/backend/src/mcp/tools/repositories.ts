import { callApi, type GitHubRepo, type WatchedRepo } from '../api.js';
import {
  defineTool,
  linesOrNone,
  requireId,
  resolveWorkspace,
  str,
  textSchema,
  workspaceSchema,
} from './helpers.js';

const repoLine = (repo: WatchedRepo) => `${repo.id}  ${repo.fullName}  base: ${repo.defaultBranch}`;

export const REPOSITORIES = [
  defineTool(
    'list_repositories',
    'List the repositories watched by a workspace.',
    workspaceSchema,
    [],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const params = new URLSearchParams({ workspaceId: await resolveWorkspace(ownerId, args) });
      return linesOrNone(
        await callApi<WatchedRepo[]>(ownerId, 'GET', `/repositories?${params}`),
        repoLine
      );
    }
  ),
  defineTool(
    'add_repository',
    'Watch a repository. Pass repo as owner/name, or pass owner and repo separately.',
    { ...workspaceSchema, owner: textSchema, repo: textSchema },
    ['repo'],
    { openWorldHint: true },
    async (ownerId, args) => {
      const input = requireId(args, 'repo');
      const parts = input.split('/');
      const owner = parts.length === 2 ? parts[0] : requireId(args, 'owner');
      const repo = parts.length === 2 ? parts[1] : input;
      if (!owner || !repo || parts.length > 2)
        throw new Error('Use owner/name or separate owner and repo fields.');
      return repoLine(
        await callApi<WatchedRepo>(ownerId, 'POST', '/repositories', {
          workspaceId: await resolveWorkspace(ownerId, args),
          owner,
          repo,
        })
      );
    }
  ),
  defineTool(
    'remove_repository',
    'Stop watching a repository.',
    { repository_id: textSchema },
    ['repository_id'],
    { destructiveHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'repository_id');
      await callApi(ownerId, 'DELETE', `/repositories/${id}`);
      return `${id} removed.`;
    }
  ),
  defineTool(
    'list_github_repos',
    'Find accessible GitHub repositories to add. Use search to narrow the list.',
    { ...workspaceSchema, search: textSchema },
    [],
    { readOnlyHint: true, openWorldHint: true },
    async (ownerId, args) => {
      const params = new URLSearchParams({ workspaceId: await resolveWorkspace(ownerId, args) });
      const search = str(args.search)?.toLowerCase();
      const repos = (
        await callApi<GitHubRepo[]>(ownerId, 'GET', `/github/all-repos?${params}`)
      ).filter((repo) => !search || repo.full_name.toLowerCase().includes(search));
      const lines = repos
        .slice(0, 100)
        .map(
          (repo) =>
            `${repo.id}  ${repo.full_name}  ${repo.private ? 'private' : 'public'}  ${repo.html_url}`
        );
      if (repos.length > 100) lines.push(`${repos.length - 100} more — narrow with search`);
      return lines.join('\n') || 'No repositories.';
    }
  ),
];
