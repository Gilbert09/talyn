import {
  commitAllSteps,
  commitsAheadSteps,
  describePushFailure,
  gitStderrTail,
  isValidBranchName,
  nothingToOpenMessage,
  parseCommitsAhead,
  parsePrDetails,
  PR_TITLE_MAX,
  prCommitMessage,
  pullRequestOutcomeEvent,
  pushHeadStep,
  workingTreeStatus,
  type CreateWorkbenchPullRequestInput,
  type CreateWorkbenchPullRequestResult,
} from '@talyn/shared';
import { GitHubApiError, GitHubNotConnectedError, githubService } from '../github.js';
import { prMonitorService } from '../prMonitor.js';
import { emitWorkbenchUpdated } from './emit.js';
import { localRuntimeError, notReadyError, WorkbenchError } from './errors.js';
import { linkPullRequest, publicWorkbench } from './prLink.js';
import { recordWorkbenchEvent, refreshSandboxCredentials, runGitSteps } from './sandboxRuntime.js';
import { updateWorkbench, type WorkbenchRow } from './store.js';

/**
 * Create PR: the chat's agent writes the words in a Create PR turn, and Talyn
 * commits, pushes and opens the PR itself when that turn ends. See
 * `workbenchPullRequest.ts` in `@talyn/shared` for the instructions, the steps
 * and the parser both runtimes share.
 */

/** A push or a fetch through the fleet proxy; generous for a large first push. */
const PUSH_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 60_000;

function requireReadySandbox(row: WorkbenchRow): void {
  if (row.runtime === 'local') throw localRuntimeError();
  if (row.archivedAt) throw notReadyError('archived');
  if (row.status !== 'ready' || !row.sandboxId) throw notReadyError(row.status);
}

function requireBase(base: unknown, fallback: string): string {
  const value = typeof base === 'string' && base.trim() ? base.trim() : fallback;
  if (!isValidBranchName(value)) throw new WorkbenchError('The base branch is not a valid branch name.', 400, 'bad_base');
  return value;
}

// ============================================================================
// Create
// ============================================================================

/** The input, checked. Throws a 400 for anything a person must fix. */
export function normalisePullRequestInput(
  raw: Partial<CreateWorkbenchPullRequestInput> | undefined,
  row: Pick<WorkbenchRow, 'baseBranch'>,
): Required<Omit<CreateWorkbenchPullRequestInput, 'commitMessage'>> & { commitMessage: string } {
  const title = typeof raw?.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) throw new WorkbenchError('A pull request needs a title.', 400, 'bad_title');
  if (title.length > PR_TITLE_MAX) {
    throw new WorkbenchError(`The title is longer than ${PR_TITLE_MAX} characters.`, 400, 'bad_title');
  }
  if (raw?.body !== undefined && typeof raw.body !== 'string') throw new WorkbenchError('body must be a string', 400, 'bad_body');
  if (raw?.draft !== undefined && typeof raw.draft !== 'boolean') throw new WorkbenchError('draft must be a boolean', 400, 'bad_draft');
  if (raw?.commitMessage !== undefined && typeof raw.commitMessage !== 'string') {
    throw new WorkbenchError('commitMessage must be a string', 400, 'bad_commit_message');
  }
  return {
    title,
    body: raw?.body ?? '',
    base: requireBase(raw?.base, row.baseBranch),
    draft: raw?.draft === true,
    commitMessage: raw?.commitMessage ?? '',
    pushed: raw?.pushed === true,
  };
}

/** Commit what is uncommitted, check there is something to open, and push. */
async function commitAndPush(row: WorkbenchRow, input: { title: string; commitMessage: string; base: string }): Promise<void> {
  await refreshSandboxCredentials(row);
  const status = await runGitSteps(row, [workingTreeStatus()], { timeoutMs: GIT_TIMEOUT_MS });
  if (status.exitCode !== 0) {
    throw new WorkbenchError(`Could not read the git status.\n${gitStderrTail(status.stderr)}`.trim(), 409, 'git_failed');
  }
  if (status.stdout.trim()) {
    const commit = await runGitSteps(row, commitAllSteps(prCommitMessage(input)), { timeoutMs: GIT_TIMEOUT_MS });
    if (commit.exitCode !== 0) {
      throw new WorkbenchError(
        `Could not commit the changes.\n${gitStderrTail(commit.stderr || commit.stdout)}`.trim(),
        409,
        'commit_failed',
      );
    }
  }
  const ahead = parseCommitsAhead((await runGitSteps(row, commitsAheadSteps(input.base), { timeoutMs: GIT_TIMEOUT_MS })).stdout);
  if (ahead === 0) throw new WorkbenchError(nothingToOpenMessage(input.base), 409, 'nothing_to_open');
  const push = await runGitSteps(row, [pushHeadStep()], { timeoutMs: PUSH_TIMEOUT_MS });
  if (push.exitCode !== 0) {
    throw new WorkbenchError(
      describePushFailure({ stderr: push.stderr, runtime: 'sandbox', repoFullName: row.repoFullName }),
      409,
      'push_failed',
    );
  }
}

/** GitHub's own words, without the status-line prefix and the request id. */
function githubWords(err: GitHubApiError): string {
  return err.message
    .replace(/^GitHub API error \d+[^:]*:\s*/, '')
    .replace(/\s*\(GitHub request-id: [^)]*\)\s*$/, '')
    .trim();
}

/** Open the PR, or find the one that already exists for this branch. */
async function openOnGitHub(
  row: WorkbenchRow,
  input: { title: string; body: string; base: string; draft: boolean },
): Promise<{ number: number; url: string; existing: boolean }> {
  const [owner, repo] = row.repoFullName.split('/');
  try {
    const pr = await githubService.createPullRequest(row.workspaceId, owner, repo, {
      title: input.title,
      head: row.branch,
      base: input.base,
      body: input.body,
      draft: input.draft,
    });
    return { number: pr.number, url: pr.html_url, existing: false };
  } catch (err) {
    if (err instanceof GitHubNotConnectedError) {
      throw new WorkbenchError('GitHub is not connected for this workspace. Connect it in Settings.', 409, 'github_not_connected');
    }
    if (!(err instanceof GitHubApiError)) throw err;
    const words = githubWords(err);
    if (err.status === 422 && /pull request already exists/i.test(words)) {
      const found = await githubService.findOpenPullRequestForHead(row.workspaceId, owner, repo, row.branch);
      if (found) return { number: found.number, url: found.html_url, existing: true };
    }
    if (err.status === 422 && /no commits between/i.test(words)) {
      throw new WorkbenchError(nothingToOpenMessage(input.base), 409, 'nothing_to_open');
    }
    throw new WorkbenchError(
      `GitHub did not open the pull request: ${words || err.message}`,
      err.status === 422 ? 422 : 409,
      'github_refused',
    );
  }
}

/**
 * Commit, push and open the PR, then link it to the workbench.
 *
 * A sandbox does the git work in the box, through the fleet proxy. A local
 * workbench has already pushed from the desktop with the user's own git
 * credentials (`pushed: true`), so only the GitHub step runs here.
 */
export async function createWorkbenchPullRequest(
  row: WorkbenchRow,
  raw: Partial<CreateWorkbenchPullRequestInput> | undefined,
): Promise<CreateWorkbenchPullRequestResult> {
  const input = normalisePullRequestInput(raw, row);
  if (row.archivedAt) throw notReadyError('archived');
  if (row.runtime === 'local') {
    if (!input.pushed) throw localRuntimeError();
  } else {
    if (input.pushed) throw new WorkbenchError('Only a local session pushes for itself.', 400, 'sandbox_runtime');
    requireReadySandbox(row);
    await commitAndPush(row, input);
  }

  const opened = await openOnGitHub(row, input);
  recordWorkbenchEvent(row, 'pr_create', `${opened.existing ? 'linked' : 'opened'} #${opened.number}`);
  const linked = await trackAndLink(row, opened.number);
  const workbench = await publicWorkbench(linked);
  emitWorkbenchUpdated(workbench);
  return { workbench, pullRequest: { number: opened.number, url: opened.url }, existing: opened.existing };
}

/**
 * Put the PR in the workspace's list now rather than on the next poll, and
 * link it. Best effort: the PR is open either way, and the next GET or turn
 * links it by branch.
 */
async function trackAndLink(row: WorkbenchRow, number: number): Promise<WorkbenchRow> {
  const [owner, repo] = row.repoFullName.split('/');
  try {
    const watched = await prMonitorService.watchPullRequest({
      workspaceId: row.workspaceId,
      repo: {
        id: row.repositoryId,
        workspaceId: row.workspaceId,
        owner,
        repo,
        fullName: row.repoFullName,
        defaultBranch: row.baseBranch,
      },
      number,
    });
    if (watched.ok) {
      return (await updateWorkbench(row.id, { pullRequestId: watched.rowId })) ?? row;
    }
  } catch (err) {
    console.warn(`[workbench] tracking #${number} for ${row.id} failed:`, err);
  }
  return linkPullRequest(row).catch(() => row);
}

/**
 * The end of a sandbox Create PR turn: read the agent's ```talyn-pr block and
 * open the pull request from it. Never throws; the answer is the transcript
 * event that says what happened.
 */
export async function openPullRequestFromTurn(row: WorkbenchRow, finalText: string): Promise<Record<string, unknown>> {
  const parsed = parsePrDetails(finalText);
  if (!parsed.ok) {
    recordWorkbenchEvent(row, 'pr_create', 'no pull request block in the reply', false);
    return pullRequestOutcomeEvent({ ok: false, message: parsed.error });
  }
  try {
    const result = await createWorkbenchPullRequest(row, { ...parsed.details, base: row.baseBranch });
    return pullRequestOutcomeEvent({ ok: true, ...result.pullRequest, existing: result.existing });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof WorkbenchError)) console.warn(`[workbench] opening a PR for ${row.id} failed:`, err);
    recordWorkbenchEvent(row, 'pr_create', `failed: ${message.slice(0, 120)}`, false);
    return pullRequestOutcomeEvent({ ok: false, message });
  }
}
