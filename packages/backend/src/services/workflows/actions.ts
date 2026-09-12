import { eq } from 'drizzle-orm';
import type {
  WorkflowAction,
  WorkflowActionFailureCode,
  WorkflowActionOutcome,
  WorkflowActionType,
  WorkflowEventFacts,
} from '@talyn/shared';
import {
  buildSkillPrompt,
  renderWorkflowComment,
  SKILL_MAX_BYTES,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { pullRequests as pullRequestsTable, skills as skillsTable } from '../../db/schema.js';
import { githubService } from '../github.js';
import { GitHubRateLimitError } from '../githubRateGate.js';
import { prMonitorService } from '../prMonitor.js';
import { getOrFetchPRSummary } from '../prCache.js';
import { activePrTaskId, resolveCloudEnv } from '../prCloudFix.js';
import { createCloudTask } from '../taskCreate.js';
import { TaskLimitError } from '../billing/entitlements.js';
import { MergeQueueLimitError } from '../billing/entitlements.js';
import { setQueueMembership } from '../mergeQueue/membership.js';
import { getRepoSkillContent } from '../skills.js';
import { workspacePromptTemplate } from '../promptTemplates.js';
import { captureWorkspaceEvent } from '../analytics.js';
import type { PRSummary } from '../githubGraphql.js';

/**
 * Executing a matched workflow's actions.
 *
 * # Nothing here throws
 *
 * Every handler returns an outcome, including for its own failures. A workflow
 * with four actions must not lose the last three because the second one named a
 * reviewer who left the org — the run lands `partial` and the history says which
 * action failed and why. The only thing that propagates is a programming error,
 * and the engine catches that too.
 *
 * # A machine code on every refusal
 *
 * The plan cap, a closed rate gate, a missing cloud provider and "a run is
 * already working this PR" are all NORMAL, and none of them is an error the user
 * should read as a bug. They carry a `WorkflowActionFailureCode` so the history
 * can style a refusal apart from a breakage, and so a test can assert on it
 * rather than on prose.
 */

/** Everything an action needs, resolved once per run. */
export interface ActionContext {
  workspaceId: string;
  /** The workspace's owner — the identity every plan gate is keyed on. */
  ownerId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  facts: WorkflowEventFacts;
  workflowId: string;
  runId: string;
}

/** What one run produced beyond its outcomes. */
export interface ActionResults {
  outcomes: WorkflowActionOutcome[];
  /** The last task an action started, for `workflow_runs.task_id`. */
  taskId: string | null;
  /** The PR row, if any action had cause to materialise one. */
  pullRequestId: string | null;
}

function ok(type: WorkflowActionType, detail: string): WorkflowActionOutcome {
  return { type, ok: true, detail };
}

function no(
  type: WorkflowActionType,
  code: WorkflowActionFailureCode,
  error: string
): WorkflowActionOutcome {
  return { type, ok: false, code, error };
}

/**
 * The PR row and its authoritative summary, fetched at most once per run.
 *
 * Three actions need it: both task actions (for the `tasks.pull_request_id`
 * link, the "already running" guard, and the branch names the prompt quotes)
 * and the merge-queue action (which is defined on the row).
 *
 * `getOrFetchPRSummary` rather than `watchPullRequest`: the latter also sets
 * `watching` and arms the commit-pushing auto-keep watcher, which would be a
 * side effect nobody asked for on a PR that merely got a comment.
 */
class PrRowCache {
  private resolved: { id: string; summary: PRSummary } | null | undefined;

  constructor(private readonly ctx: ActionContext) {}

  async get(): Promise<{ id: string; summary: PRSummary } | null> {
    if (this.resolved !== undefined) return this.resolved;
    try {
      const result = await getOrFetchPRSummary({
        workspaceId: this.ctx.workspaceId,
        repositoryId: this.ctx.repositoryId,
        owner: this.ctx.owner,
        repo: this.ctx.repo,
        number: this.ctx.facts.number,
      });
      this.resolved = result ? { id: result.rowId, summary: result.summary } : null;
    } catch (err) {
      console.warn(
        `[workflows] could not resolve ${this.ctx.owner}/${this.ctx.repo}#${this.ctx.facts.number}:`,
        err instanceof Error ? err.message : err
      );
      this.resolved = null;
    }
    return this.resolved;
  }
}

/**
 * Run a workflow's actions in order.
 *
 * In ORDER, and never in parallel: a workflow that labels a PR and then queues
 * it is expressing a sequence, and the queue's `decide()` reads labels. Two
 * actions racing against the same PR would also multiply this workflow's load
 * against the account's single shared GitHub budget.
 */
export async function runWorkflowActions(
  actions: WorkflowAction[],
  ctx: ActionContext
): Promise<ActionResults> {
  const prRow = new PrRowCache(ctx);
  const outcomes: WorkflowActionOutcome[] = [];
  let taskId: string | null = null;
  let pullRequestId: string | null = null;

  for (const action of actions) {
    let outcome: WorkflowActionOutcome;
    try {
      const result = await runOne(action, ctx, prRow);
      outcome = result.outcome;
      if (result.taskId) taskId = result.taskId;
      if (result.pullRequestId) pullRequestId = result.pullRequestId;
    } catch (err) {
      // A handler that throws is a bug, not a refusal — record it as one rather
      // than letting it take the rest of the workflow down.
      outcome = no(
        action.type,
        'error',
        err instanceof Error ? err.message : String(err)
      );
    }
    outcomes.push(outcome);
  }

  return { outcomes, taskId, pullRequestId };
}

interface OneResult {
  outcome: WorkflowActionOutcome;
  taskId?: string | null;
  pullRequestId?: string | null;
}

async function runOne(
  action: WorkflowAction,
  ctx: ActionContext,
  prRow: PrRowCache
): Promise<OneResult> {
  switch (action.type) {
    case 'add_labels':
      return { outcome: await addLabels(action.labels, ctx) };
    case 'remove_labels':
      return { outcome: await removeLabels(action.labels, ctx) };
    case 'request_reviewers':
      return { outcome: await requestReviewers(action, ctx) };
    case 'assign':
      return { outcome: await assign(action.users, ctx) };
    case 'comment':
      return { outcome: await comment(action.body, ctx) };
    case 'watch_pr':
      return watchPr(ctx);
    case 'enqueue_merge_queue':
      return enqueue(action.method, ctx, prRow);
    case 'run_skill':
    case 'run_prompt':
      return startTask(action, ctx, prRow);
  }
}

// ---- GitHub-calling actions ----------------------------------------------

/**
 * Turn a GitHub failure into an outcome, waiting out a short rate-limit gate.
 *
 * There used to be a `gateClosed()` pre-check here that refused the moment the
 * account was gated at all. That was strictly worse than doing nothing:
 * `apiRequest` already calls `githubRateGate.waitIfBlocked`, which SLEEPS OUT any
 * block shorter than `MAX_GATE_WAIT_MS` (60s) and only throws beyond it. The
 * pre-check jumped in front of that and dropped actions that a two-second wait
 * would have completed.
 *
 * So the gate is no longer consulted up front. A short throttle now costs the
 * action a pause and it still happens; a long one throws
 * `GitHubRateLimitError`, which becomes a `rate_gated` outcome carrying how long
 * GitHub asked for.
 *
 * 60s is the codebase's existing bound and the right one here: these run in the
 * webhook worker's six-wide slow lane, so waiting out a 300s backoff would pin a
 * slot for five minutes and starve the PR refreshes queued behind it.
 */
function githubOutcome(type: WorkflowActionType, err: unknown): WorkflowActionOutcome {
  if (err instanceof GitHubRateLimitError) {
    return no(
      type,
      'rate_gated',
      `GitHub is rate-limiting this account for another ${Math.round(
        err.retryAfterMs / 1000
      )}s, so the action was skipped`
    );
  }
  return no(type, 'github_error', err instanceof Error ? err.message : String(err));
}

async function addLabels(labels: string[], ctx: ActionContext): Promise<WorkflowActionOutcome> {
  try {
    await githubService.addPullRequestLabels(
      ctx.workspaceId,
      ctx.owner,
      ctx.repo,
      ctx.facts.number,
      labels
    );
    return ok('add_labels', `added ${labels.join(', ')}`);
  } catch (err) {
    return githubFailure('add_labels', err);
  }
}

async function removeLabels(labels: string[], ctx: ActionContext): Promise<WorkflowActionOutcome> {
  const removed: string[] = [];
  const absent: string[] = [];
  for (const label of labels) {
    try {
      const result = await githubService.removePullRequestLabel(
        ctx.workspaceId,
        ctx.owner,
        ctx.repo,
        ctx.facts.number,
        label
      );
      (result === 'removed' ? removed : absent).push(label);
    } catch (err) {
      return githubFailure('remove_labels', err);
    }
  }
  // "Already absent" is success — see removePullRequestLabel. Reported anyway,
  // because a workflow that never finds its label is worth noticing.
  const parts = [
    removed.length ? `removed ${removed.join(', ')}` : '',
    absent.length ? `${absent.join(', ')} already absent` : '',
  ].filter(Boolean);
  return ok('remove_labels', parts.join('; ') || 'nothing to remove');
}

async function requestReviewers(
  action: { users?: string[]; teams?: string[] },
  ctx: ActionContext
): Promise<WorkflowActionOutcome> {
  // GitHub 422s the WHOLE request when it is asked to make the PR's author a
  // reviewer, which would take the other reviewers down with it. Drop the
  // author here — asking is meaningless, and a rule that names a team of
  // reviewers should still work on a PR opened by one of them.
  const author = ctx.facts.author.login.toLowerCase();
  const users = (action.users ?? []).filter((u) => u.toLowerCase() !== author);
  const teams = action.teams ?? [];
  if (users.length === 0 && teams.length === 0) {
    return ok('request_reviewers', 'nobody left to ask (the PR author was the only name)');
  }
  try {
    await githubService.requestPullRequestReviewers(
      ctx.workspaceId,
      ctx.owner,
      ctx.repo,
      ctx.facts.number,
      { users, teams }
    );
    return ok('request_reviewers', `asked ${[...users, ...teams].join(', ')}`);
  } catch (err) {
    return githubFailure('request_reviewers', err);
  }
}

async function assign(users: string[], ctx: ActionContext): Promise<WorkflowActionOutcome> {
  try {
    const assigned = await githubService.addPullRequestAssignees(
      ctx.workspaceId,
      ctx.owner,
      ctx.repo,
      ctx.facts.number,
      users
    );
    // GitHub silently ignores a login it cannot assign, so compare what came
    // back — otherwise the history claims an assignment that did not happen.
    const missing = users.filter(
      (u) => !assigned.some((a) => a.toLowerCase() === u.toLowerCase())
    );
    if (missing.length > 0) {
      return {
        type: 'assign',
        ok: false,
        code: 'github_error',
        error: `GitHub would not assign ${missing.join(', ')} (not a collaborator on ${ctx.owner}/${ctx.repo}?)`,
        detail: assigned.length ? `assigned ${assigned.join(', ')}` : undefined,
      };
    }
    return ok('assign', `assigned ${users.join(', ')}`);
  } catch (err) {
    return githubFailure('assign', err);
  }
}

async function comment(body: string, ctx: ActionContext): Promise<WorkflowActionOutcome> {
  const rendered = renderWorkflowComment(body, ctx.facts);
  try {
    await githubService.createIssueComment(
      ctx.workspaceId,
      ctx.owner,
      ctx.repo,
      ctx.facts.number,
      rendered
    );
    return ok('comment', `commented (${rendered.length} chars)`);
  } catch (err) {
    return githubFailure('comment', err);
  }
}

/** Kept as the name every call site already uses. */
const githubFailure = githubOutcome;

// ---- watch_pr -------------------------------------------------------------

/**
 * Put the PR on My PRs.
 *
 * This is the one action that goes through `watchPullRequest` rather than the
 * summary cache: `watching` is a deliberate, user-facing relationship, and the
 * watch path is what sets it, primes the head index and arms the workspace's
 * auto-keep default — the same thing pasting a PR's URL does.
 */
async function watchPr(ctx: ActionContext): Promise<OneResult> {
  const repos = await prMonitorService.getWatchedRepos(ctx.workspaceId);
  const repo = repos.find((r) => r.id === ctx.repositoryId);
  if (!repo) {
    return {
      outcome: no('watch_pr', 'error', 'the repository is no longer in this workspace'),
    };
  }
  try {
    const result = await prMonitorService.watchPullRequest({
      workspaceId: ctx.workspaceId,
      repo,
      number: ctx.facts.number,
    });
    if (!result.ok) {
      // A merged or closed PR cannot be watched — the list holds open rows only.
      return {
        outcome: no(
          'watch_pr',
          result.reason === 'not_open' ? 'not_open' : 'error',
          result.reason === 'not_open'
            ? 'the PR is already closed or merged, so there is nothing to watch'
            : 'GitHub does not know this PR'
        ),
      };
    }
    return {
      outcome: ok('watch_pr', result.alreadyTracked ? 'already on your list' : 'added to My PRs'),
      pullRequestId: result.rowId,
    };
  } catch (err) {
    return { outcome: githubFailure('watch_pr', err) };
  }
}

// ---- enqueue_merge_queue -------------------------------------------------

/**
 * The merge action.
 *
 * Deliberately the QUEUE and not a direct `mergePullRequest`: the queue already
 * handles a base branch governed by an external merge system (posthog/posthog's
 * `master`, where our merge 405s "Cannot update this protected ref"), trunk
 * submission, commit signing, stacks and GitHub auto-merge arming. A workflow
 * that called merge directly would work on a personal repo and silently fail on
 * the repo the user actually lives in.
 */
async function enqueue(
  method: string | undefined,
  ctx: ActionContext,
  prRow: PrRowCache
): Promise<OneResult> {
  const resolved = await prRow.get();
  if (!resolved) {
    return {
      outcome: no(
        'enqueue_merge_queue',
        'pr_not_tracked',
        'Talyn could not read this PR from GitHub, so it cannot be queued'
      ),
    };
  }
  const rows = await getDbClient()
    .select({
      id: pullRequestsTable.id,
      workspaceId: pullRequestsTable.workspaceId,
      taskId: pullRequestsTable.taskId,
      repositoryId: pullRequestsTable.repositoryId,
      owner: pullRequestsTable.owner,
      repo: pullRequestsTable.repo,
      number: pullRequestsTable.number,
      state: pullRequestsTable.state,
      lastSummary: pullRequestsTable.lastSummary,
      mergeQueuedAt: pullRequestsTable.mergeQueuedAt,
      mergeMethod: pullRequestsTable.mergeMethod,
      mergeQueued: pullRequestsTable.mergeQueued,
    })
    .from(pullRequestsTable)
    .where(eq(pullRequestsTable.id, resolved.id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      outcome: no('enqueue_merge_queue', 'pr_not_tracked', 'the PR row disappeared mid-run'),
    };
  }
  if (row.state !== 'open') {
    return {
      outcome: no('enqueue_merge_queue', 'not_open', 'the PR is already closed or merged'),
    };
  }
  if (row.mergeQueued) {
    return {
      outcome: ok('enqueue_merge_queue', 'already in the merge queue'),
      pullRequestId: row.id,
    };
  }

  try {
    await setQueueMembership({
      row,
      enabled: true,
      method: method ?? row.mergeMethod,
      trigger: 'workflow:enqueue',
      ownerId: ctx.ownerId,
    });
    return {
      outcome: ok('enqueue_merge_queue', 'added to the merge queue'),
      pullRequestId: row.id,
    };
  } catch (err) {
    if (err instanceof MergeQueueLimitError) {
      recordDeferral(ctx, 'merge_queue_limit_reached');
      return {
        outcome: no(
          'enqueue_merge_queue',
          'merge_queue_limit_reached',
          'the free plan allows 3 PRs in the merge queue at once'
        ),
        pullRequestId: row.id,
      };
    }
    return { outcome: githubFailure('enqueue_merge_queue', err), pullRequestId: row.id };
  }
}

// ---- run_skill / run_prompt ----------------------------------------------

async function startTask(
  action: Extract<WorkflowAction, { type: 'run_skill' | 'run_prompt' }>,
  ctx: ActionContext,
  prRow: PrRowCache
): Promise<OneResult> {
  const resolved = await prRow.get();
  if (!resolved) {
    return {
      outcome: no(
        action.type,
        'pr_not_tracked',
        'Talyn could not read this PR from GitHub, so it has nothing to point a run at'
      ),
    };
  }

  // Never two runs at one PR. This is the Session 111 bug: three concurrent
  // runs at one PR filled the plan's task cap and starved a real fix run.
  const inFlight = await activePrTaskId(ctx.workspaceId, resolved.id);
  if (inFlight) {
    return {
      outcome: no(
        action.type,
        'task_already_running',
        'a run is already working this PR'
      ),
      pullRequestId: resolved.id,
    };
  }

  const env = await resolveCloudEnv(ctx.workspaceId);
  if (!env) {
    return {
      outcome: no(
        action.type,
        'no_cloud_provider',
        'this workspace has no connected cloud provider to run the task on'
      ),
      pullRequestId: resolved.id,
    };
  }

  const summary = resolved.summary;
  const ref = `${ctx.owner}/${ctx.repo}#${ctx.facts.number}`;
  let prompt: string;
  let title: string;
  let skill: { key: string; name: string; source: 'repo' | 'platform'; repositoryId?: string; platformSkillId?: string } | undefined;

  if (action.type === 'run_skill') {
    const loaded = await loadSkill(action.skillKey, ctx);
    if (!loaded.ok) return { outcome: loaded.outcome, pullRequestId: resolved.id };
    prompt = buildSkillPrompt({
      owner: ctx.owner,
      repo: ctx.repo,
      number: ctx.facts.number,
      pr: {
        url: summary.url,
        title: summary.title,
        headBranch: summary.headBranch,
        baseBranch: summary.baseBranch,
      },
      skill: loaded.skill,
      provider: env.provider,
      template: await workspacePromptTemplate(ctx.workspaceId, 'skill'),
    });
    title = `Run skill "${loaded.skill.name}" on ${ref}`;
    skill = loaded.info;
  } else {
    // A freeform prompt is handed over verbatim, with the PR named up front so
    // the agent does not have to guess which one it is on.
    prompt = `You are working on pull request ${ref} (${summary.url}).\n\n${action.prompt}`;
    title = `Workflow run on ${ref}`;
  }

  try {
    const task = await createCloudTask({
      workspaceId: ctx.workspaceId,
      type: 'pr_response',
      title,
      description: `Started by the "${ctx.workflowId}" workflow on ${ref}.`,
      prompt,
      repositoryId: ctx.repositoryId,
      assignedEnvironmentId: env.envId,
      pullRequestId: resolved.id,
      model: action.model,
      ...(skill ? { skill } : {}),
      workflow: { workflowId: ctx.workflowId, runId: ctx.runId, event: ctx.facts.event },
    });
    return {
      outcome: ok(action.type, `started task ${task.id}`),
      taskId: task.id,
      pullRequestId: resolved.id,
    };
  } catch (err) {
    if (err instanceof TaskLimitError) {
      // Same treatment the merge-queue and auto-keep watchers give it: there is
      // no request to answer, so nothing can 402 and no modal can open. Capture
      // it server-side or the deferral is invisible (Session 116).
      recordDeferral(ctx, 'task_limit_reached');
      return {
        outcome: no(
          action.type,
          'task_limit_reached',
          'the free plan allows 3 tasks in flight at once'
        ),
        pullRequestId: resolved.id,
      };
    }
    return { outcome: githubFailure(action.type, err), pullRequestId: resolved.id };
  }
}

type LoadedSkill =
  | {
      ok: true;
      skill: { name: string; description: string; content: string; source: 'repo' | 'platform'; repoPath?: string };
      info: { key: string; name: string; source: 'repo' | 'platform'; repositoryId?: string; platformSkillId?: string };
    }
  | { ok: false; outcome: WorkflowActionOutcome };

/**
 * Resolve a skill key to its SKILL.md.
 *
 * Only `repo:` and `platform:` are reachable. A `local:` skill lives in the
 * user's `~/.claude/skills` and is read by the desktop's main process over IPC
 * — the backend cannot see it, which is why `validateWorkflow` refuses one at
 * save time. This is the second line of that defence, for a rule stored before
 * the check existed.
 */
async function loadSkill(key: string, ctx: ActionContext): Promise<LoadedSkill> {
  const unavailable = (reason: string): LoadedSkill => ({
    ok: false,
    outcome: no('run_skill', 'skill_unavailable', reason),
  });

  if (key.startsWith('platform:')) {
    const id = key.slice('platform:'.length);
    const rows = await getDbClient()
      .select({
        id: skillsTable.id,
        workspaceId: skillsTable.workspaceId,
        name: skillsTable.name,
        description: skillsTable.description,
        content: skillsTable.content,
      })
      .from(skillsTable)
      .where(eq(skillsTable.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.workspaceId !== ctx.workspaceId) {
      return unavailable('that saved skill no longer exists in this workspace');
    }
    if (Buffer.byteLength(row.content, 'utf8') > SKILL_MAX_BYTES) {
      return unavailable(`"${row.name}" is too large to run`);
    }
    return {
      ok: true,
      skill: {
        name: row.name,
        description: row.description,
        content: row.content,
        source: 'platform',
      },
      info: { key, name: row.name, source: 'platform', platformSkillId: row.id },
    };
  }

  if (key.startsWith('repo:')) {
    // repo:<owner>/<repo>:<name> — the name may itself contain no colon, so
    // splitting from the RIGHT is wrong; take everything after the second colon.
    const rest = key.slice('repo:'.length);
    const sep = rest.indexOf(':');
    if (sep < 0) return unavailable('that skill key is malformed');
    const fullName = rest.slice(0, sep);
    const name = rest.slice(sep + 1);
    if (fullName.toLowerCase() !== `${ctx.owner}/${ctx.repo}`.toLowerCase()) {
      // A repo skill belongs to ONE repository. A workflow spanning several
      // repos and naming a repo skill can only run it where it lives.
      return unavailable(`"${name}" is a skill in ${fullName}, not in ${ctx.owner}/${ctx.repo}`);
    }
    const found = await getRepoSkillContent(ctx.workspaceId, ctx.repositoryId, name);
    if (!found?.content) {
      return unavailable(`${ctx.owner}/${ctx.repo} no longer has a skill called "${name}"`);
    }
    if (Buffer.byteLength(found.content, 'utf8') > SKILL_MAX_BYTES) {
      return unavailable(`"${name}" is too large to run`);
    }
    return {
      ok: true,
      skill: {
        name: found.name,
        description: found.description,
        content: found.content,
        source: 'repo',
        ...(found.repoPath ? { repoPath: found.repoPath } : {}),
      },
      info: { key, name: found.name, source: 'repo', repositoryId: ctx.repositoryId },
    };
  }

  return unavailable(
    'Talyn runs workflows on the server, so it cannot reach a skill stored on your machine'
  );
}

/**
 * A plan limit hit with nobody watching.
 *
 * Captured server-side for the reason Session 116 gives: a workflow run has no
 * request behind it, so there is no 402 to answer and no UpgradeModal to open.
 * The population that hits this hardest is exactly the one whose clients report
 * nothing.
 */
function recordDeferral(ctx: ActionContext, gate: WorkflowActionFailureCode): void {
  captureWorkspaceEvent(ctx.workspaceId, 'paywall_deferred', {
    source: 'workflow',
    gate,
    workflow_id: ctx.workflowId,
    repo: `${ctx.owner}/${ctx.repo}`,
    pr_number: ctx.facts.number,
  });
}
