import { formatDurationMs, type SetupRecipe, type SetupRecipeStep } from '@talyn/shared';
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

const FEATURE = 'workbenches' as const;

const day = (iso: string) => iso.slice(0, 10);

function stepLine(step: SetupRecipeStep): string {
  const state = step.disabledAt
    ? `reverted ${day(step.disabledAt)}${step.disabledReason ? ` (${step.disabledReason})` : ''}`
    : step.appliedAt
      ? 'settled into the bake'
      : 'box setup only';
  const from = step.sourceWorkbenchId ? `session ${step.sourceWorkbenchId}` : 'no session';
  const line = `  ${step.id}  ${step.command}  [${step.kind}, ${step.phase}]  ${from}, ${step.source}, ${day(step.firstSeenAt)}  ${state}`;
  const extra = [stepTime(step), step.stateReason].filter(Boolean).join('. ');
  return extra ? `${line}\n    ${extra}` : line;
}

/** "took 3m 12s (typical 2m 50s)". */
function stepTime(step: SetupRecipeStep): string | null {
  if (step.lastDurationMs === null || step.lastDurationMs === undefined) return null;
  const typical = step.typicalDurationMs !== null && step.typicalDurationMs !== undefined && (step.measuredBoxes ?? 0) > 1
    ? ` (typical ${formatDurationMs(step.typicalDurationMs)})`
    : '';
  return `took ${formatDurationMs(step.lastDurationMs)}${typical}`;
}

/** "Last setup took 9m 40s: repository setup 2m 5s, learned steps 7m 35s." */
function timingLine(recipe: SetupRecipe): string | null {
  const t = recipe.lastSetupTiming;
  if (!t) return null;
  const parts = [t.repositoryMs !== null ? `repository setup ${formatDurationMs(t.repositoryMs)}` : null, `learned steps ${formatDurationMs(t.learnedMs)}`];
  return `Last setup took ${formatDurationMs(t.totalMs)}: ${parts.filter(Boolean).join(', ')}.`;
}

function recipeText(repositoryId: string, recipe: SetupRecipe): string {
  const live = recipe.steps.filter((s) => !s.disabledAt).length;
  const head = [
    `Setup steps of ${repositoryId}. Learning is ${recipe.learningDisabled ? 'off' : 'on'}. ${live} of ${recipe.maxSteps} live.`,
    timingLine(recipe),
  ].filter(Boolean).join('\n');
  return recipe.steps.length ? [head, ...recipe.steps.map(stepLine)].join('\n') : `${head}\nNo steps.`;
}

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
  defineTool(
    'list_setup_steps',
    'List the setup steps that sessions learned for a repository. Each line has the step id, the command, the session that recorded it, the first-seen date, and whether it is reverted, settled into the bake, or box setup only. Under it: how long the step took on the last box, and how many recent sessions needed it. The first lines say whether learning is on and how long the last setup took.',
    { repository_id: textSchema },
    ['repository_id'],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'repository_id');
      return recipeText(id, await callApi<SetupRecipe>(ownerId, 'GET', `/repositories/${encodeURIComponent(id)}/setup-recipe`));
    },
    FEATURE
  ),
  defineTool(
    'revert_setup_step',
    'Revert one learned setup step of a repository. The step stops running on new boxes. It stays listed as reverted, so Talyn does not learn it again. Boxes that already ran it keep it.',
    { repository_id: textSchema, step_id: textSchema },
    ['repository_id', 'step_id'],
    { destructiveHint: true, idempotentHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'repository_id');
      const stepId = requireId(args, 'step_id');
      const recipe = await callApi<SetupRecipe>(
        ownerId,
        'DELETE',
        `/repositories/${encodeURIComponent(id)}/setup-recipe/steps/${encodeURIComponent(stepId)}`
      );
      return [`Reverted ${stepId}.`, recipeText(id, recipe)].join('\n');
    },
    FEATURE
  ),
];
