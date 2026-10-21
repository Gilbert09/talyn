import {
  commitAllSteps,
  commitsAheadSteps,
  describePushFailure,
  gitStderrTail,
  headCommitSteps,
  nothingToOpenMessage,
  parseCommitsAhead,
  parseHeadCommit,
  prCommitMessage,
  pushHeadStep,
  workingTreeStatus,
  type AdoptWorkbenchPullRequestResult,
  type CreateWorkbenchPullRequestInput,
  type CreateWorkbenchPullRequestResult,
  type Workbench,
  type WorkbenchLocalBridge,
} from '@talyn/shared';

export interface PullRequestApi {
  createPullRequest(id: string, input: CreateWorkbenchPullRequestInput): Promise<CreateWorkbenchPullRequestResult>;
}

/**
 * Create PR for a local session: commit what is uncommitted and push with the
 * user's own git credentials, then ask the backend to open the PR.
 */
export async function openLocalPullRequest(
  bridge: Pick<WorkbenchLocalBridge, 'exec'>,
  api: PullRequestApi,
  workbench: Pick<Workbench, 'id' | 'localPath' | 'repoFullName'>,
  input: Omit<CreateWorkbenchPullRequestInput, 'pushed'>
): Promise<CreateWorkbenchPullRequestResult> {
  const path = workbench.localPath;
  if (!path) throw new Error('This session has no local path.');
  const status = await bridge.exec(path, [workingTreeStatus()]);
  if (status.exitCode !== 0) {
    throw new Error(`Could not read the git status.\n${gitStderrTail(status.stderr)}`.trim());
  }
  if (status.stdout.trim()) {
    const commit = await bridge.exec(path, commitAllSteps(prCommitMessage(input)));
    if (commit.exitCode !== 0) {
      throw new Error(`Could not commit the changes.\n${gitStderrTail(commit.stderr || commit.stdout)}`.trim());
    }
  }
  const ahead = await bridge.exec(path, commitsAheadSteps(input.base));
  if (parseCommitsAhead(ahead.stdout) === 0) throw new Error(nothingToOpenMessage(input.base));
  const push = await bridge.exec(path, [pushHeadStep()]);
  if (push.exitCode !== 0) {
    throw new Error(describePushFailure({ stderr: push.stderr, runtime: 'local', repoFullName: workbench.repoFullName }));
  }
  return api.createPullRequest(workbench.id, { ...input, pushed: true });
}

export interface AdoptPullRequestApi {
  adoptPullRequest(id: string, head: { sha?: string; branch?: string }): Promise<AdoptWorkbenchPullRequestResult>;
}

/**
 * The safety net after a Create PR turn with no talyn-pr block: the agent may
 * have opened the PR itself. Read the worktree's HEAD and ask the backend for
 * the one open PR at that commit (or from that branch). Null when none matched.
 */
export async function adoptLocalPullRequest(
  bridge: Pick<WorkbenchLocalBridge, 'exec'>,
  api: AdoptPullRequestApi,
  workbench: Pick<Workbench, 'id' | 'localPath'>
): Promise<AdoptWorkbenchPullRequestResult | null> {
  const path = workbench.localPath;
  if (!path) return null;
  const res = await bridge.exec(path, headCommitSteps());
  const head = parseHeadCommit(res.stdout);
  if (!head.sha && !head.branch) return null;
  const adopted = await api.adoptPullRequest(workbench.id, {
    ...(head.sha ? { sha: head.sha } : {}),
    ...(head.branch ? { branch: head.branch } : {}),
  });
  return adopted.pullRequest ? adopted : null;
}
