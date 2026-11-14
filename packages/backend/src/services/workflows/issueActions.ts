import type {
  IssueEventFacts,
  WorkflowAction,
  WorkflowActionOutcome,
  WorkflowActionType,
  WorkflowTemplateExtras,
} from '@talyn/shared';
import { renderWorkflowTemplate, WORKFLOW_INTEGRATION_LABELS } from '@talyn/shared';
import { isBoxGateError } from '../billing/entitlements.js';
import { debugBus } from '../debugBus.js';
import { GitHubNotConnectedError, githubService } from '../github.js';
import { GitHubRateLimitError } from '../githubRateGate.js';
import {
  attachWork,
  claimIssue,
  latestLinkId,
  recordOurComment,
  settleLink,
  type IssueLinkRow,
  type LinkableFacts,
} from '../inbound/issueLinks.js';
import { buildInboundPrompt } from '../inbound/prompt.js';
import { LinearRateLimitError } from '../linear/api.js';
import { createLinearComment, fetchLinearIssue, RECENT_COMMENTS, setLinearIssueState } from '../linear/issues.js';
import { LinearConnectionUnavailableError } from '../linear/store.js';
import { resolveCloudEnv } from '../prCloudFix.js';
import { createCloudTask, TaskReferenceError } from '../taskCreate.js';
import { boxRefused, no, ok, type OneResult } from './actionResult.js';
import type { BaseActionContext, IssueActionContext } from './actions.js';
import { repositoryName } from './inboundActions.js';

/**
 * The actions of an issue rule (Linear, GitHub Issues): the start actions'
 * claim on the issue and their prompt, `start_task`, and the two write-backs.
 * `start_session` lives with the other session starts in `sessionAction.ts`
 * and uses {@link claimIssueForStart}, {@link issueRulePrompt} and
 * {@link finishIssueStart}.
 *
 * Write-back runs here, in the backend, with the connection's credential (the
 * GitHub App installation, or the Linear app token). The agent never holds it.
 */

type StartAction = Extract<WorkflowAction, { type: 'start_session' | 'start_task' }>;

/** The repository a start action works on: the rule's, or the issue's own on GitHub Issues. */
export async function issueRepository(
  action: StartAction,
  ctx: IssueActionContext
): Promise<{ id: string; name: string } | null> {
  const id = action.repositoryId ?? (ctx.integration === 'github_issues' ? ctx.repositoryId : null);
  if (!id) return null;
  const name = await repositoryName(ctx.workspaceId, id);
  return name ? { id, name } : null;
}

/** "The automation has no repository" as an outcome. */
export function noRepository(type: WorkflowActionType): OneResult {
  return {
    outcome: no(
      type,
      'repository_unresolved',
      'The automation has no repository in this workspace. Choose a repository on the automation.'
    ),
  };
}

/**
 * Claim the issue for this run's start. A refusal is the outcome to return:
 * work an earlier event started is still running.
 */
export async function claimIssueForStart(
  type: WorkflowActionType,
  ctx: Pick<BaseActionContext, 'workspaceId' | 'workflowId' | 'runId'> & { facts: LinkableFacts }
): Promise<{ ok: true; link: IssueLinkRow } | { ok: false; result: OneResult }> {
  const claim = await claimIssue({
    workspaceId: ctx.workspaceId,
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    facts: ctx.facts,
  });
  if (claim.claimed) return { ok: true, link: claim.link };
  const subject =
    ctx.facts.integration === 'posthog_inbox'
      ? `the report "${ctx.facts.title || ctx.facts.reportId}"`
      : ctx.facts.identifier || 'this issue';
  return {
    ok: false,
    result: {
      outcome: no(
        type,
        'issue_already_running',
        `Talyn is already working on ${subject}. It starts again when that work ends without a merge.`
      ),
    },
  };
}

/**
 * After the dispatch: attach the work to the claim, or release the claim when
 * the start failed for good. A parked start (a box refusal) keeps its claim:
 * the work is owed, and the retry finds the claim by its run id.
 */
export async function finishIssueStart(link: IssueLinkRow, result: OneResult): Promise<void> {
  try {
    if (result.outcome.ok) {
      await attachWork(link.id, {
        taskId: result.taskId ?? null,
        workbenchId: result.workbenchId ?? null,
        pullRequestId: result.pullRequestId ?? null,
      });
    } else if (!result.retryAt) {
      await settleLink(link.id, 'failed', result.outcome.error ?? 'the work did not start');
    }
  } catch (err) {
    // Best effort. A link with no work is released by the next event (see
    // `linkIsLive`), so a failure here costs at most a short wait.
    debugBus.recordEvent({
      service: 'workflows',
      action: 'issue_link_write_failed',
      summary: link.id,
      ok: false,
      error: err,
    });
  }
}

/** The issue's newest comments, oldest first. Empty when the tracker cannot be read. */
async function recentComments(ctx: IssueActionContext): Promise<Array<{ author: string | null; at: string | null; body: string }>> {
  const { facts } = ctx;
  try {
    if (facts.integration === 'linear') {
      if (!facts.connectionId) return [];
      const issue = await fetchLinearIssue(facts.connectionId, facts.externalId);
      return (issue?.comments ?? []).map((c) => ({ author: c.author, at: c.createdAt, body: c.body }));
    }
    const [owner, repo] = (facts.repoFullName ?? '').split('/');
    if (!owner || !repo || typeof facts.number !== 'number') return [];
    const rows = await githubService.listRecentIssueComments(ctx.workspaceId, owner, repo, facts.number, RECENT_COMMENTS);
    return rows.map((c) => ({ author: c.login, at: c.createdAt, body: c.body }));
  } catch {
    return [];
  }
}

/** The issue as the prompt quotes it: title, description, and the newest comments. */
export function issueText(
  facts: IssueEventFacts,
  comments: Array<{ author: string | null; at: string | null; body: string }>
): string {
  const parts = [`Title: ${facts.title}`, '', 'Description:', facts.body.trim() || '(none)'];
  if (facts.comment) {
    parts.push('', `New comment by ${facts.comment.author ?? 'someone'}:`, facts.comment.body);
  }
  const others = comments.filter((c) => c.body.trim() && c.body !== facts.comment?.body);
  if (others.length > 0) {
    parts.push('', 'Recent comments, oldest first:');
    for (const c of others) parts.push('', `${c.author ?? 'someone'}${c.at ? ` (${c.at})` : ''}:`, c.body.trim());
  }
  return parts.join('\n');
}

/**
 * The rule's prompt, with the issue quoted below it as untrusted text. The
 * identifier, the URL and the title render inline only when they pass the
 * identifier check; a title with spaces is quoted in the fence instead.
 */
export async function issueRulePrompt(instruction: string, ctx: IssueActionContext, repoName: string): Promise<string> {
  const { facts } = ctx;
  const comments = await recentComments(ctx);
  const tracker = WORKFLOW_INTEGRATION_LABELS[facts.integration];
  return buildInboundPrompt({
    instruction,
    sourceLabel: ctx.workflowName
      ? `a ${tracker} issue that the automation "${ctx.workflowName}" watches`
      : `a ${tracker} issue`,
    identifiers: {
      repo: repoName,
      'issue.identifier': facts.identifier,
      'issue.url': facts.url,
      'issue.title': facts.title,
    },
    fields: { 'issue.body': facts.body },
    payload: issueText(facts, comments),
    bodyLabel: 'issue',
    sourceUrl: facts.url,
  });
}

/** Start a cloud task for an issue. The claim comes first, then the dispatch. */
export async function startIssueTask(
  action: Extract<WorkflowAction, { type: 'start_task' }>,
  ctx: IssueActionContext
): Promise<OneResult> {
  const repo = await issueRepository(action, ctx);
  if (!repo) return noRepository('start_task');
  const env = await resolveCloudEnv(ctx.workspaceId);
  if (!env) {
    return { outcome: no('start_task', 'no_cloud_provider', 'this workspace has no connected cloud provider to run the task on') };
  }
  const claim = await claimIssueForStart('start_task', ctx);
  if (!claim.ok) return claim.result;

  const name = ctx.workflowName ?? `${WORKFLOW_INTEGRATION_LABELS[ctx.integration]} automation`;
  let result: OneResult;
  try {
    const task = await createCloudTask({
      workspaceId: ctx.workspaceId,
      type: 'code_writing',
      source: 'workflow',
      title: ctx.facts.identifier ? `${ctx.facts.identifier}: ${ctx.facts.title}`.slice(0, 200) : name,
      description: `Started by the "${name}" automation from ${ctx.facts.identifier || 'an issue'}.`,
      prompt: await issueRulePrompt(action.prompt, ctx, repo.name),
      repositoryId: repo.id,
      assignedEnvironmentId: env.envId,
      ...(action.model ? { model: action.model } : {}),
      ...(action.internetAccess ? { internetAccess: true } : {}),
      workflow: { workflowId: ctx.workflowId, runId: ctx.runId, event: ctx.facts.event },
    });
    result = { outcome: ok('start_task', `started task ${task.id}`), taskId: task.id };
  } catch (err) {
    if (isBoxGateError(err)) result = boxRefused('start_task', err, null, ctx);
    else if (err instanceof TaskReferenceError) result = { outcome: no('start_task', 'repository_unresolved', err.message) };
    else result = { outcome: no('start_task', 'error', err instanceof Error ? err.message : String(err)) };
  }
  await finishIssueStart(claim.link, result);
  return result;
}

// ---- Write-back -------------------------------------------------------------

/** A tracker refusal as an outcome. A rate limit is parked and retried. */
export function writeBackFailure(type: WorkflowActionType, err: unknown): WorkflowActionOutcome {
  if (err instanceof GitHubRateLimitError || err instanceof LinearRateLimitError) {
    const tracker = err instanceof LinearRateLimitError ? 'Linear' : 'GitHub';
    return no(type, 'rate_gated', `${tracker} is rate-limiting this account for another ${Math.round(err.retryAfterMs / 1000)}s`);
  }
  if (err instanceof LinearConnectionUnavailableError || err instanceof GitHubNotConnectedError) {
    return no(type, 'issue_unavailable', err.message || 'The tracker is not connected.');
  }
  return no(type, 'issue_error', err instanceof Error ? err.message : String(err));
}

function githubCoordinates(facts: IssueEventFacts): { owner: string; repo: string; number: number } | null {
  const [owner, repo] = (facts.repoFullName ?? '').split('/');
  if (!owner || !repo || typeof facts.number !== 'number') return null;
  return { owner, repo, number: facts.number };
}

/** Post a comment on the issue and remember its id. */
export async function postIssueComment(ctx: IssueActionContext, body: string): Promise<string | null> {
  const { facts } = ctx;
  let commentId: string | null;
  if (facts.integration === 'linear') {
    if (!facts.connectionId) throw new LinearConnectionUnavailableError('The Linear connection was removed. Connect Linear again.');
    commentId = await createLinearComment(facts.connectionId, facts.externalId, body);
  } else {
    const at = githubCoordinates(facts);
    if (!at) throw new Error('The issue has no repository or number.');
    const created = await githubService.createIssueComment(ctx.workspaceId, at.owner, at.repo, at.number, body);
    commentId = created.id !== null ? String(created.id) : null;
  }
  if (commentId) {
    const linkId = await latestLinkId(ctx.workspaceId, facts.integration, facts.externalId).catch(() => null);
    if (linkId) await recordOurComment(linkId, commentId).catch(() => undefined);
  }
  return commentId;
}

/**
 * `issue_comment`. The comment Talyn adds after a start (`afterStart`) links
 * the session or task, so it waits for one: when the start in this run did not
 * happen, it takes the start's code, and a parked start retries both.
 */
export async function issueComment(
  action: Extract<WorkflowAction, { type: 'issue_comment' }>,
  ctx: IssueActionContext,
  extras: WorkflowTemplateExtras,
  previous: WorkflowActionOutcome | undefined
): Promise<OneResult> {
  if (action.afterStart && !extras.sessionUrl && !extras.taskUrl) {
    if (previous && !previous.ok) {
      return { outcome: no('issue_comment', previous.code ?? 'error', 'Waits for the work to start.') };
    }
    return { outcome: no('issue_comment', 'error', 'No session or task started, so there is nothing to link.') };
  }
  const body = renderWorkflowTemplate(action.body, ctx.facts, extras);
  try {
    await postIssueComment(ctx, body);
    return { outcome: ok('issue_comment', `commented on ${ctx.facts.identifier || 'the issue'}`) };
  } catch (err) {
    return { outcome: writeBackFailure('issue_comment', err) };
  }
}

/** `issue_set_status`: `done`, a Linear state name, or `open` / `closed` on GitHub. */
export async function issueSetStatus(
  action: Extract<WorkflowAction, { type: 'issue_set_status' }>,
  ctx: IssueActionContext
): Promise<OneResult> {
  const { facts } = ctx;
  try {
    if (facts.integration === 'linear') {
      if (!facts.connectionId) throw new LinearConnectionUnavailableError('The Linear connection was removed. Connect Linear again.');
      let teamId = facts.teamId ?? null;
      if (!teamId) teamId = (await fetchLinearIssue(facts.connectionId, facts.externalId))?.teamId ?? null;
      if (!teamId) return { outcome: no('issue_set_status', 'issue_error', 'Linear did not say which team the issue is in.') };
      const name = await setLinearIssueState(facts.connectionId, facts.externalId, teamId, action.status);
      return { outcome: ok('issue_set_status', `moved ${facts.identifier || 'the issue'} to ${name}`) };
    }
    const at = githubCoordinates(facts);
    if (!at) return { outcome: no('issue_set_status', 'issue_error', 'The issue has no repository or number.') };
    const state = action.status === 'open' ? 'open' : 'closed';
    await githubService.setIssueState(ctx.workspaceId, at.owner, at.repo, at.number, state);
    return { outcome: ok('issue_set_status', state === 'open' ? `reopened ${facts.identifier}` : `closed ${facts.identifier} as completed`) };
  } catch (err) {
    return { outcome: writeBackFailure('issue_set_status', err) };
  }
}
