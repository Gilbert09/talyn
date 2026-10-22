import {
  afterSignedPublishSteps,
  commitAllSteps,
  commitsAheadSteps,
  describePushFailure,
  describeSignedPublishFailure,
  gitStderrTail,
  headCommitSteps,
  isSignedCommitRefusal,
  isValidBranchName,
  newBranchBaseSteps,
  nothingToOpenMessage,
  parseCommitsAhead,
  parseHeadCommit,
  parsePrDetails,
  parseRemoteBranchHead,
  parseSha,
  PR_TITLE_MAX,
  prCommitMessage,
  pullRequestCheckoutSteps,
  pullRequestOutcomeEvent,
  pushHeadStep,
  remoteBranchHeadStep,
  remoteHeadContainedSteps,
  signedPublishStep,
  toShellScript,
  workingTreeStatus,
  type AdoptWorkbenchPullRequestResult,
  type CreateWorkbenchPullRequestInput,
  type CreateWorkbenchPullRequestResult,
  type LinkWorkbenchPullRequestResult,
  type WorkbenchPullRequestChoice,
} from '@talyn/shared';
import { GitHubApiError, GitHubNotConnectedError, githubService, type GitHubCommitPullRequest } from '../github.js';
import { prMonitorService } from '../prMonitor.js';
import { emitWorkbenchEvents, emitWorkbenchUpdated } from './emit.js';
import { localRuntimeError, notReadyError, WorkbenchError } from './errors.js';
import { linkPullRequest, prSummaries, publicWorkbench } from './prLink.js';
import { recordWorkbenchEvent, refreshSandboxCredentials, runCapture, runGitSteps } from './sandboxRuntime.js';
import { appendEvents, listChats, updateWorkbench, type WorkbenchRow } from './store.js';

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
  if (push.exitCode === 0) return;
  if (isSignedCommitRefusal(push.stderr)) {
    await publishSigned(row, { message: input.title, base: input.base });
    return;
  }
  throw new WorkbenchError(
    describePushFailure({ stderr: push.stderr, runtime: 'sandbox', repoFullName: row.repoFullName }),
    409,
    'push_failed',
  );
}

/**
 * The repository requires verified signatures and the sandbox has no key, so
 * publish the branch with `fleet-publish`: one commit, made and signed by
 * GitHub, on top of the branch's head on GitHub (or where HEAD left the base,
 * for a new branch). Then point the local branch at it.
 */
async function publishSigned(row: WorkbenchRow, input: { message: string; base: string }): Promise<void> {
  const remote = await runGitSteps(row, [remoteBranchHeadStep(row.branch)], { timeoutMs: GIT_TIMEOUT_MS });
  const remoteSha = parseRemoteBranchHead(remote.stdout, row.branch);
  let baseOid: string | null;
  if (remoteSha) {
    const contained = await runGitSteps(row, remoteHeadContainedSteps(row.branch, remoteSha), { timeoutMs: GIT_TIMEOUT_MS });
    if (contained.exitCode !== 0) {
      throw new WorkbenchError(
        'GitHub has commits on this branch that the session does not have. Pull or merge them first.',
        409,
        'push_failed',
      );
    }
    baseOid = remoteSha;
  } else {
    baseOid = parseSha((await runGitSteps(row, newBranchBaseSteps(input.base), { timeoutMs: GIT_TIMEOUT_MS })).stdout);
  }
  if (!baseOid) {
    throw new WorkbenchError(
      `The repository requires signed commits, and Talyn could not find where the branch starts on ${input.base}.`,
      409,
      'push_failed',
    );
  }
  const publish = await runGitSteps(row, [signedPublishStep({ branch: row.branch, message: input.message, baseOid })], {
    timeoutMs: PUSH_TIMEOUT_MS,
  });
  if (publish.exitCode !== 0) {
    throw new WorkbenchError(
      describeSignedPublishFailure({ stderr: publish.stderr || publish.stdout, exitCode: publish.exitCode }),
      409,
      'push_failed',
    );
  }
  recordWorkbenchEvent(row, 'pr_publish', `published ${row.branch} with fleet-publish`);
  // The branch is on GitHub now. A failure here leaves only the local history behind.
  const synced = await runGitSteps(row, afterSignedPublishSteps(row.branch), { timeoutMs: GIT_TIMEOUT_MS });
  if (synced.exitCode !== 0) {
    console.warn(`[workbench] syncing ${row.id} to its published branch failed: ${gitStderrTail(synced.stderr)}`);
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
async function trackAndLink(row: WorkbenchRow, number: number, strict = false): Promise<WorkbenchRow> {
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
      allowClosed: strict,
    });
    if (watched.ok) {
      return (await updateWorkbench(row.id, { pullRequestId: watched.rowId })) ?? row;
    }
    if (strict) throw new WorkbenchError('Pull request not found in this repository.', 404, 'pr_not_found');
  } catch (err) {
    if (strict) throw err;
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
    const adopted = await adoptFromSandbox(row);
    if (adopted) return pullRequestOutcomeEvent({ ok: true, ...adopted, existing: true, adopted: true });
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

// ============================================================================
// A PR the agent opened itself
// ============================================================================

/**
 * The open PR the agent opened itself, against the Create PR instructions.
 * Matched by structured GitHub data only, never by a URL in the agent's text:
 *
 * 1. an open PR in this repository whose head commit is the box's HEAD;
 * 2. else an open PR in this repository from the branch the box is on. This
 *    is the `fleet-publish` case: GitHub made a new commit, so the PR's head
 *    is not a commit the box has.
 *
 * Exactly one match, or null. Several open PRs are a guess, and a wrong link
 * reads as fact.
 */
export async function findAgentPullRequest(
  row: Pick<WorkbenchRow, 'workspaceId' | 'repoFullName'>,
  head: { sha: string | null; branch: string | null },
): Promise<GitHubCommitPullRequest | null> {
  const [owner, repo] = row.repoFullName.split('/');
  const sameRepo = (pr: GitHubCommitPullRequest) =>
    !pr.head.repo || pr.head.repo.full_name.toLowerCase() === row.repoFullName.toLowerCase();
  const unique = (prs: GitHubCommitPullRequest[]) => [...new Map(prs.map((pr) => [pr.number, pr])).values()];

  if (head.sha) {
    const sha = head.sha.toLowerCase();
    const byCommit = unique(
      (await githubService.listPullRequestsForCommit(row.workspaceId, owner, repo, sha)).filter(
        (pr) => pr.state === 'open' && pr.head.sha.toLowerCase() === sha && sameRepo(pr),
      ),
    );
    if (byCommit.length > 0) return byCommit.length === 1 ? byCommit[0] : null;
  }
  if (head.branch && isValidBranchName(head.branch)) {
    const byBranch = unique(
      (await githubService.listOpenPullRequestsForHead(row.workspaceId, owner, repo, head.branch)).filter(
        (pr) => pr.state === 'open' && pr.head.ref === head.branch && sameRepo(pr),
      ),
    );
    if (byBranch.length === 1) return byBranch[0];
  }
  return null;
}

/**
 * Link the PR the agent opened itself, the way a Create PR success links one,
 * and move the workbench to that PR's branch when the agent made a new one.
 * `pullRequest` is null when no single open PR matched.
 */
export async function adoptAgentPullRequest(
  row: WorkbenchRow,
  head: { sha: string | null; branch: string | null },
): Promise<AdoptWorkbenchPullRequestResult> {
  if (row.archivedAt) throw notReadyError('archived');
  let found: GitHubCommitPullRequest | null;
  try {
    found = await findAgentPullRequest(row, head);
  } catch (err) {
    if (err instanceof GitHubNotConnectedError) {
      throw new WorkbenchError('GitHub is not connected for this workspace. Connect it in Settings.', 409, 'github_not_connected');
    }
    throw err;
  }
  if (!found) return { workbench: await publicWorkbench(row), pullRequest: null };

  let current = row;
  if (found.head.ref !== row.branch && isValidBranchName(found.head.ref)) {
    current = (await updateWorkbench(row.id, { branch: found.head.ref })) ?? row;
  }
  recordWorkbenchEvent(current, 'pr_create', `adopted #${found.number} the agent opened`);
  const linked = await trackAndLink(current, found.number);
  const workbench = await publicWorkbench(linked);
  emitWorkbenchUpdated(workbench);
  return { workbench, pullRequest: { number: found.number, url: found.html_url, headRef: found.head.ref } };
}

/**
 * `POST /workbenches/:id/pull-request/adopt`. A local session sends its
 * worktree's HEAD (`sha`, `branch`); a sandbox session's HEAD is read in the box.
 */
export async function adoptPullRequestForWorkbench(
  row: WorkbenchRow,
  raw: { sha?: unknown; branch?: unknown } | undefined,
): Promise<AdoptWorkbenchPullRequestResult> {
  if (row.archivedAt) throw notReadyError('archived');
  let head: { sha: string | null; branch: string | null };
  if (row.runtime === 'local') {
    const sha = typeof raw?.sha === 'string' ? raw.sha.trim().toLowerCase() : '';
    const branch = typeof raw?.branch === 'string' ? raw.branch.trim() : '';
    if (sha && !/^[0-9a-f]{40}$/.test(sha)) throw new WorkbenchError('sha must be a full commit sha.', 400, 'bad_sha');
    if (branch && !isValidBranchName(branch)) throw new WorkbenchError('branch is not a valid branch name.', 400, 'bad_branch');
    if (!sha && !branch) throw new WorkbenchError('Send the sha or the branch of HEAD.', 400, 'bad_head');
    head = { sha: sha || null, branch: branch || null };
  } else {
    requireReadySandbox(row);
    head = parseHeadCommit((await runGitSteps(row, headCommitSteps(), { timeoutMs: GIT_TIMEOUT_MS })).stdout);
  }
  return adoptAgentPullRequest(row, head);
}

/** The sandbox side of the safety net: read the box's HEAD, then adopt. Null on no match or any failure. */
async function adoptFromSandbox(row: WorkbenchRow): Promise<{ number: number; url: string } | null> {
  if (row.runtime === 'local' || row.archivedAt || !row.sandboxId) return null;
  try {
    const head = parseHeadCommit((await runGitSteps(row, headCommitSteps(), { timeoutMs: GIT_TIMEOUT_MS })).stdout);
    if (!head.sha && !head.branch) return null;
    const adopted = await adoptAgentPullRequest(row, head);
    return adopted.pullRequest ? { number: adopted.pullRequest.number, url: adopted.pullRequest.url } : null;
  } catch (err) {
    console.warn(`[workbench] looking for a PR the agent opened for ${row.id} failed:`, err);
    return null;
  }
}

export async function openPullRequestsForWorkbench(
  row: WorkbenchRow,
  state: 'open' | 'all' = 'open',
): Promise<WorkbenchPullRequestChoice[]> {
  const [owner, repo] = row.repoFullName.split('/');
  const prs = await githubService.listPullRequests(row.workspaceId, owner, repo, {
    state, per_page: 50, sort: 'updated', direction: 'desc',
  });
  return prs.filter((pr) => state === 'all' || pr.state === 'open')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 50)
    .map((pr) => ({
      number: pr.number, title: pr.title, headRef: pr.head.ref,
      author: pr.user.login, updatedAt: pr.updated_at, draft: pr.draft,
      state: pr.merged_at ? 'merged' : pr.state,
    }));
}

async function recordPrLink(row: WorkbenchRow, number: number, linked: boolean): Promise<void> {
  recordWorkbenchEvent(row, linked ? 'pr_link' : 'pr_unlink', `${linked ? 'Linked' : 'Unlinked'} PR #${number}`);
  for (const chat of (await listChats(row.id)).filter((item) => !item.closedAt)) {
    const events = await appendEvents(chat.id, [{
      turn: chat.turnCount, event: { type: 'talyn_pr_link', number, linked },
    }]);
    emitWorkbenchEvents(row.workspaceId, chat.id, events);
  }
}

export async function linkWorkbenchPullRequest(row: WorkbenchRow, number: unknown): Promise<LinkWorkbenchPullRequestResult> {
  if (row.pullRequestId) throw new WorkbenchError('Unlink the current pull request first.', 409, 'pr_already_linked');
  if (row.archivedAt) throw notReadyError('archived');
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    throw new WorkbenchError('Enter a pull request number.', 400, 'bad_number');
  }
  const [owner, repo] = row.repoFullName.split('/');
  const missing = () => new WorkbenchError('Pull request not found in this repository.', 404, 'pr_not_found');
  const pr = await githubService.getPullRequest(row.workspaceId, owner, repo, number).catch((err: unknown) => {
    if (err instanceof GitHubApiError && err.status === 404) throw missing();
    throw err;
  });
  if (pr.base.repo?.full_name.toLowerCase() !== row.repoFullName.toLowerCase()) throw missing();
  const isOpen = pr.state === 'open' && !pr.merged_at;
  if (isOpen && !isValidBranchName(pr.head.ref)) throw new WorkbenchError('The PR branch name is not valid.', 409, 'bad_branch');
  const checkout = {
    branch: pr.head.ref,
    remoteRef: pr.head.repo?.full_name.toLowerCase() === row.repoFullName.toLowerCase()
      ? `refs/heads/${pr.head.ref}` : `refs/pull/${number}/head`,
  };
  let current = row;
  const changesBranch = isOpen && pr.head.ref !== row.branch;
  if (changesBranch && (await listChats(row.id)).some((chat) => chat.status === 'running')) {
    throw new WorkbenchError('Wait for the current turn to finish first.', 409, 'turn_running');
  }
  if (changesBranch && row.runtime !== 'local') {
    requireReadySandbox(row);
    await refreshSandboxCredentials(row);
    const status = await runCapture(row, toShellScript([workingTreeStatus()]), { timeoutMs: GIT_TIMEOUT_MS });
    if (status.exitCode !== 0) throw new WorkbenchError('Could not read the git status.', 409, 'git_failed');
    if (status.stdout.trim()) {
      throw new WorkbenchError('Commit or discard the changes in this session first.', 409, 'dirty_worktree');
    }
    const result = await runCapture(row, toShellScript(pullRequestCheckoutSteps(checkout)), { timeoutMs: PUSH_TIMEOUT_MS });
    if (result.exitCode !== 0) throw new WorkbenchError('Could not check out the PR branch.', 409, 'checkout_failed');
    current = (await updateWorkbench(row.id, { branch: checkout.branch })) ?? row;
  }
  current = await trackAndLink(current, number, true);
  const settings = { ...current.settings };
  delete settings.prUnlinked;
  current = (await updateWorkbench(row.id, { settings })) ?? current;
  await recordPrLink(current, number, true);
  const workbench = await publicWorkbench(current);
  emitWorkbenchUpdated(workbench);
  return { workbench, ...(changesBranch && row.runtime === 'local' ? { needsCheckout: checkout } : {}) };
}

export async function unlinkWorkbenchPullRequest(row: WorkbenchRow) {
  if (!row.pullRequestId) return publicWorkbench(row);
  const pr = (await prSummaries([row.pullRequestId])).get(row.pullRequestId);
  const current = (await updateWorkbench(row.id, {
    pullRequestId: null,
    settings: { ...row.settings, ...(pr ? { prUnlinked: pr.number } : {}) },
  })) ?? row;
  if (pr) await recordPrLink(current, pr.number, false);
  const workbench = await publicWorkbench(current);
  emitWorkbenchUpdated(workbench);
  return workbench;
}
