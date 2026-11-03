import { formatDurationMs, type RepositorySetup, type SetupListStep } from '@talyn/shared';
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

/** "took 3m 12s (typical 2m 50s)". */
function stepTime(step: SetupListStep): string | null {
  if (step.lastDurationMs === null) return null;
  const typical = step.typicalDurationMs !== null && step.measuredBoxes > 1
    ? ` (typical ${formatDurationMs(step.typicalDurationMs)})`
    : '';
  return `Took ${formatDurationMs(step.lastDurationMs)}${typical}.`;
}

function stepLine(step: SetupListStep): string {
  const head = `  ${step.id}  ${step.status}  [${step.runOn}, ${step.origin}]  ${step.name}`;
  const extra = [
    step.name !== step.command ? `Command: ${step.command}` : null,
    stepTime(step),
    step.statusReason ?? step.verdictReason ?? null,
    step.imageFailureReason ? `Image build: ${step.imageFailureReason}` : null,
  ].filter((line): line is string => Boolean(line));
  return [head, ...extra.map((line) => `    ${line}`)].join('\n');
}

/** "Last setup took 9m 40s: repository setup 2m 5s, setup steps 7m 35s." */
function timingLine(setup: RepositorySetup): string | null {
  const t = setup.lastSetupTiming;
  if (!t) return null;
  const steps = t.setupBoxStepsMs ?? t.learnedMs;
  const parts = [t.repositoryMs !== null ? `repository setup ${formatDurationMs(t.repositoryMs)}` : null, `setup steps ${formatDurationMs(steps)}`];
  return `Last setup took ${formatDurationMs(t.totalMs)}: ${parts.filter(Boolean).join(', ')}.`;
}

function setupText(repositoryId: string, setup: RepositorySetup): string {
  const count = (status: SetupListStep['status']) => setup.steps.filter((s) => s.status === status).length;
  const repo = setup.repoSetup.command
    ? `Repository setup: ${setup.repoSetup.command} (on each box: ${setup.repoSetup.runOnBox}).`
    : 'The repository has no setup command of its own.';
  const head = [
    `Setup list of ${repositoryId}. Learning is ${setup.learningDisabled ? 'off' : 'on'}. ${count('active')} active, ${count('suggested')} suggested, ${count('disabled')} disabled, ${count('dismissed')} dismissed.`,
    repo,
    timingLine(setup),
  ].filter(Boolean).join('\n');
  return setup.steps.length ? [head, ...setup.steps.map(stepLine)].join('\n') : `${head}\nNo steps.`;
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
    "List the Setup list of a repository, in order. The first lines say if learning is on, the repository's own setup command, and how long the last setup took. Each step line has the step id, the status (active, suggested, dismissed or disabled), where it runs (image, box or both), who added it (user, learned or agent) and its name. Under it: the command, how long the step took, and why the step has its status.",
    { repository_id: textSchema },
    ['repository_id'],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'repository_id');
      return setupText(id, await callApi<RepositorySetup>(ownerId, 'GET', `/repositories/${encodeURIComponent(id)}/setup`));
    },
    FEATURE
  ),
  defineTool(
    'revert_setup_step',
    "Dismiss one learned setup step of a repository. The step stops running on new boxes and leaves the image. It stays in the list as dismissed, so Talyn does not suggest it again. Boxes that already ran it keep it. Talyn refuses to dismiss a person's own step: the person removes it from the list.",
    { repository_id: textSchema, step_id: textSchema },
    ['repository_id', 'step_id'],
    { destructiveHint: true, idempotentHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'repository_id');
      const stepId = requireId(args, 'step_id');
      const setup = await callApi<RepositorySetup>(
        ownerId,
        'POST',
        `/repositories/${encodeURIComponent(id)}/setup/steps/${encodeURIComponent(stepId)}/dismiss`
      );
      return [`Dismissed ${stepId}.`, setupText(id, setup)].join('\n');
    },
    FEATURE
  ),
];
