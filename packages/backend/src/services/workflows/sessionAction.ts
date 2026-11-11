import { eq } from 'drizzle-orm';
import type { WorkflowAction, WorkflowSessionSource } from '@talyn/shared';
import { fleetAgentForModel } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { users as usersTable } from '../../db/schema.js';
import { isBoxGateError } from '../billing/entitlements.js';
import { debugBus } from '../debugBus.js';
import type { PRSummary } from '../githubGraphql.js';
import { activePrTaskId } from '../prCloudFix.js';
import {
  authorOf,
  boundThread,
  buildSlackPrompt,
  fetchThread,
  namesFor,
  slackToPlainText,
  slackTsToTime,
  type QuotedMessage,
  type SlackMessage,
} from '../slack/context.js';
import { recordRepoUse, resolveRepository } from '../slack/repoResolver.js';
import { slackSessionDefaults } from '../slack/sessionDefaults.js';
import { moveStatusToMessage, scheduleSlackStatus, setThreadStatus } from '../slack/statusReactions.js';
import {
  beginThread,
  claimTriggerMessage,
  markThreadFailed,
  markThreadStarted,
} from '../slack/threads.js';
import { sessionLaunchUrl } from '../webApp.js';
import { createWorkbench } from '../workbenches/create.js';
import { userFacingError, WorkbenchError } from '../workbenches/errors.js';
import { liveWorkbenchForPr } from '../workbenches/prSessions.js';
import type { ReadinessUser } from '../workbenches/readiness.js';
import { boxRefused, no, ok, type OneResult } from './actionResult.js';
import type { GithubActionContext, SlackActionContext, WorkflowActionContext } from './actions.js';

/**
 * The `start_session` action: a rule starts a session, as the workspace owner.
 *
 * The same create path as the app, Slack and Loops (`createWorkbench`), so a
 * rule's session gets the same readiness refusal, plan gate, branch naming and
 * first message. The owner is the actor, because a rule run has no caller: a
 * webhook or a Slack message is not a Talyn user.
 *
 * A box refusal parks the run (`pending_retry`), and the retry sweep tries
 * again when the refusal says it clears. Anything else that refuses is final.
 */

type StartSessionAction = Extract<WorkflowAction, { type: 'start_session' }>;

/** What a GitHub rule's PR cache gives. Structural, so this module imports no class. */
export interface PrRowSource {
  get(): Promise<{ id: string; summary: PRSummary } | null>;
}

export async function startSession(
  action: StartSessionAction,
  ctx: WorkflowActionContext,
  prRow: PrRowSource | null
): Promise<OneResult> {
  if (ctx.integration === 'slack') return startSlackSession(action, ctx);
  if (!prRow) return { outcome: no('start_session', 'error', 'A GitHub automation ran without its pull request.') };
  return startGithubSession(action, ctx, prRow);
}

async function ownerActor(ownerId: string): Promise<ReadinessUser> {
  const rows = await getPoolDbClient()
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, ownerId))
    .limit(1);
  return { id: ownerId, email: rows[0]?.email ?? null };
}

interface SessionRequest {
  repositoryId: string;
  prompt: string;
  namingText: string;
  source: WorkflowSessionSource;
  fromPullRequestId?: string;
  /** The PR the run is recorded against, for the history link. */
  pullRequestId?: string | null;
}

type Created = { ok: true; workbenchId: string } | { ok: false; result: OneResult };

async function createRuleSession(
  action: StartSessionAction,
  ctx: WorkflowActionContext,
  req: SessionRequest
): Promise<Created> {
  const pullRequestId = req.pullRequestId ?? null;
  try {
    const actor = await ownerActor(ctx.ownerId);
    // The model carries the agent. With no model on the rule, the workspace's
    // own default, as a Slack trigger does.
    const { agent, model } = action.model
      ? { agent: fleetAgentForModel(action.model), model: action.model }
      : await slackSessionDefaults(ctx.workspaceId, actor);
    const wb = await createWorkbench(
      {
        workspaceId: ctx.workspaceId,
        repositoryId: req.repositoryId,
        runtime: 'sandbox',
        agent,
        model,
        prompt: req.prompt,
        namingText: req.namingText,
        internetAccess: action.internetAccess === true,
        autoCreatePr: true,
        ...(req.fromPullRequestId ? { fromPullRequestId: req.fromPullRequestId } : {}),
        source: req.source,
      },
      actor
    );
    return { ok: true, workbenchId: wb.id };
  } catch (err) {
    if (isBoxGateError(err)) {
      return { ok: false, result: boxRefused('start_session', err, pullRequestId, ctx) };
    }
    const code = err instanceof WorkbenchError ? 'session_unavailable' : 'error';
    return {
      ok: false,
      result: { outcome: no('start_session', code, userFacingError(err)), pullRequestId },
    };
  }
}

function started(workbenchId: string, pullRequestId: string | null = null): OneResult {
  return {
    outcome: ok('start_session', `started session ${workbenchId}`),
    workbenchId,
    sessionUrl: sessionLaunchUrl(workbenchId),
    pullRequestId,
  };
}

// ---- GitHub ---------------------------------------------------------------

/**
 * On the pull request's own repository. On the PR's branch while the PR is
 * open, so the session works on the change itself; a closed PR's branch may be
 * gone, so the session then starts from the default branch.
 *
 * Never beside a run or a live session on the same PR: both would push to the
 * one branch.
 */
async function startGithubSession(
  action: StartSessionAction,
  ctx: GithubActionContext,
  prRow: PrRowSource
): Promise<OneResult> {
  const resolved = await prRow.get();
  const open = resolved && resolved.summary.state === 'open' ? resolved : null;
  if (open) {
    if (await activePrTaskId(ctx.workspaceId, open.id)) {
      return {
        outcome: no('start_session', 'task_already_running', 'a run is already working this PR'),
        pullRequestId: open.id,
      };
    }
    const session = await liveWorkbenchForPr(ctx.workspaceId, open.id);
    if (session) {
      return {
        outcome: no(
          'start_session',
          'session_active',
          `The session "${session.name}" is already working on this pull request.`
        ),
        pullRequestId: open.id,
      };
    }
  }

  const ref = `${ctx.owner}/${ctx.repo}#${ctx.facts.number}`;
  const created = await createRuleSession(action, ctx, {
    repositoryId: ctx.repositoryId,
    prompt: `You are working on pull request ${ref} (${ctx.facts.url}).\n\n${action.prompt}`,
    namingText: action.prompt,
    source: { kind: 'workflow', workflowId: ctx.workflowId, runId: ctx.runId, integration: 'github' },
    ...(open ? { fromPullRequestId: open.id } : {}),
    pullRequestId: resolved?.id ?? null,
  });
  if (!created.ok) return created.result;
  return started(created.workbenchId, resolved?.id ?? null);
}

// ---- Slack ----------------------------------------------------------------

function quote(m: SlackMessage, names: Map<string, string>): QuotedMessage {
  return { author: authorOf(m, names), at: slackTsToTime(m.ts), text: slackToPlainText(m.text ?? '', names).trim() };
}

/**
 * From a Slack message. The rule's prompt comes first, as the instruction;
 * the message and its thread follow, quoted and marked UNTRUSTED
 * (`buildSlackPrompt`), because anybody in the channel wrote them.
 *
 * The repository is the rule's, or Talyn chooses it from the message with the
 * resolver the personal triggers use. When the resolver cannot choose, the run
 * fails with `repository_unresolved`. There is no pending request: nobody is
 * waiting in Talyn to pick one.
 *
 * The trigger message is registered on `slack_threads` before the create, so
 * the status reactions follow the session, and so a second rule or a personal
 * trigger in the same thread cannot start a second session there.
 */
async function startSlackSession(action: StartSessionAction, ctx: SlackActionContext): Promise<OneResult> {
  const { facts } = ctx;
  const threadTs = facts.threadTs ?? facts.ts;

  // The thread as Slack has it now. Unreadable (the bot left, a scope is
  // missing) still leaves the message itself, which the event carried.
  let messages: SlackMessage[] = [];
  try {
    messages = (await fetchThread(facts.teamId, facts.channelId, facts.ts)).messages;
  } catch (err) {
    debugBus.recordEvent({
      service: 'workflows',
      action: 'slack_thread_unreadable',
      summary: `${facts.teamId}/${facts.channelId}`,
      ok: false,
      error: err,
      workspaceId: ctx.workspaceId,
    });
  }
  let trigger = messages.find((m) => m.ts === facts.ts);
  if (!trigger) {
    trigger = { ts: facts.ts, user: facts.userId, text: facts.text };
    messages = [...messages, trigger];
  }
  const names = await namesFor(facts.teamId, messages, [facts.userId]);
  const request = quote(trigger, names);
  const others = boundThread(messages.filter((m) => m.ts !== facts.ts).map((m) => quote(m, names)));
  const prompt = buildSlackPrompt({
    instruction: action.prompt,
    request,
    requestedBy: names.get(facts.userId) ?? 'A teammate',
    channelName: facts.channelName ?? null,
    thread: others.kept,
    omitted: others.omitted,
    permalink: facts.permalink ?? null,
  });

  let repositoryId = action.repositoryId;
  let reason = 'picked';
  let detail = 'Set on the automation.';
  if (!repositoryId) {
    const { resolution } = await resolveRepository({
      workspaceId: ctx.workspaceId,
      userId: ctx.ownerId,
      teamId: facts.teamId,
      channelId: facts.channelId,
      request: [action.prompt, request.text].filter(Boolean).join('\n'),
      thread: others.kept.map((m) => m.text),
    });
    if (resolution.kind === 'ambiguous') {
      return {
        outcome: no(
          'start_session',
          'repository_unresolved',
          `Talyn could not tell which repository this message is about (${resolution.detail}). ` +
            'Choose a repository on the automation.'
        ),
      };
    }
    repositoryId = resolution.repositoryId;
    reason = resolution.reason;
    detail = resolution.detail;
  }

  // The run id is the claim's token: stable across this run's retries, and
  // different for any other rule or trigger on the same message.
  const claimed = await claimTriggerMessage({
    teamId: facts.teamId,
    channelId: facts.channelId,
    messageTs: facts.ts,
    eventId: `workflow:${ctx.runId}`,
  });
  if (!claimed) {
    return { outcome: no('start_session', 'session_active', 'A session already started from this Slack message.') };
  }
  const begun = await beginThread({
    teamId: facts.teamId,
    channelId: facts.channelId,
    threadTs,
    userId: ctx.ownerId,
    workspaceId: ctx.workspaceId,
    triggerMessageTs: facts.ts,
  });
  if (!begun) {
    return { outcome: no('start_session', 'session_active', 'A session is already working in this Slack thread.') };
  }
  const row = await moveStatusToMessage(begun, facts.ts);
  await setThreadStatus(row, 'starting');

  const created = await createRuleSession(action, ctx, {
    repositoryId,
    prompt,
    namingText: [action.prompt, request.text].filter(Boolean).join('\n'),
    source: { kind: 'workflow', workflowId: ctx.workflowId, runId: ctx.runId, integration: 'slack' },
  });
  if (!created.ok) {
    // Failed, so the retry of a parked run (or a later trigger) can take the
    // thread over. A parked run keeps its "starting" reaction: it is owed.
    await markThreadFailed(row.id, created.result.outcome.error ?? 'The session did not start.').catch(() => undefined);
    if (!created.result.retryAt) await setThreadStatus(row, 'failed');
    return created.result;
  }

  await markThreadStarted(row.id, { workbenchId: created.workbenchId, repoReason: reason, repoReasonDetail: detail });
  await recordRepoUse({
    teamId: facts.teamId,
    channelId: facts.channelId,
    repositoryId,
    corrected: false,
  }).catch(() => undefined);
  scheduleSlackStatus(created.workbenchId);
  return started(created.workbenchId);
}
