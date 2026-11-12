import type { WorkflowDefinition, WorkflowFacts } from '@talyn/shared';
import {
  effectiveWorkflowActions,
  isIssueFacts,
  isSlackFacts,
  isWebhookFacts,
  workflowIntegrationOf,
  workflowMatches,
  workflowSubjectOf,
} from '@talyn/shared';
import { debugBus } from '../debugBus.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { emitWorkflowRun } from '../websocket.js';
import type { WatchTarget } from '../webhookIndex.js';
import type { WebhookDelivery } from '../webhookPayload.js';
import { workflowsKillSwitchPulled, workspaceMayUseWorkflows } from '../workflowsAccess.js';
import { ownerOfWorkspace } from './owner.js';
import { runWorkflowActions } from './actions.js';
import { checkRateCap, claimRun, recordSkippedRun, settleRun, settlementFor } from './runs.js';
import type { WorkflowSourceAdapter, WorkflowSourceTarget } from './source.js';
import { githubWorkflowSource } from './sources/github.js';
import { enabledWorkflowsFor } from './store.js';

/**
 * The workflow engine — one inbound event in, zero or more runs out.
 *
 * The core here is the same for every integration: the flag gates, the
 * enabled-rule read, the matcher, the rate cap, the claim, the action runner,
 * the settle and the analytics. What differs per integration lives in a
 * source adapter (`source.ts`): `sources/github.ts` for webhook deliveries.
 *
 * GitHub's entry point is {@link evaluateWorkflowsForDelivery}, called from
 * `processWebhookDelivery` after the watching workspaces are resolved and
 * BEFORE the `isRefreshEvent` gate, because that predicate answers "does this
 * imply a PR data refresh" and narrows the vocabulary a workflow legitimately
 * cares about (a `check_suite completed` passes it and is then a no-op).
 */

// The GitHub helpers tests and callers have always imported from here.
export { enrichmentQuery, isSelfEcho } from './sources/github.js';

/**
 * Failure codes that are a DECISION rather than a breakage.
 *
 * Talyn declining to act — the plan cap reached, GitHub rate-limiting the
 * account, a run already working this PR, a PR that closed before the workflow
 * got to it — is the system working. Lumping those in with a 500 from GitHub
 * makes a healthy workspace look broken and buries the failures worth reading.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'rate_capped',
  'task_limit_reached',
  'usage_exhausted',
  'box_limit_reached',
  'size_requires_pro',
  'rate_gated',
  'no_cloud_provider',
  'task_already_running',
  'session_active',
  'merge_queue_limit_reached',
  'not_open',
  'repository_unresolved',
  'issue_already_running',
]);

/**
 * Evaluate every workspace's GitHub rules against one webhook delivery.
 *
 * Never throws: the caller is the webhook worker, and a workflow failure must
 * not cost the delivery the PR refresh it was really about.
 *
 * Returns the number of runs that acted, for tests and for the debug counters.
 */
export async function evaluateWorkflowsForDelivery(
  delivery: WebhookDelivery,
  targets: WatchTarget[]
): Promise<number> {
  return evaluateWorkflows(githubWorkflowSource, { delivery, targets });
}

/**
 * Evaluate one integration's rules against one inbound event.
 *
 * Never throws. Returns the number of runs that acted.
 */
export async function evaluateWorkflows<
  Input,
  Target extends WorkflowSourceTarget,
  Facts extends WorkflowFacts,
>(source: WorkflowSourceAdapter<Input, Target, Facts>, input: Input): Promise<number> {
  // The deployment-wide break glass only. The per-workspace answer is asked
  // inside `evaluateForWorkspace`, where there is a workspace to ask about —
  // this is just the free early-out for a deployment that has pulled the
  // switch, and it stays subject-free so it costs nothing on the hot path.
  if (workflowsKillSwitchPulled()) return 0;

  let factsList: Facts[];
  let targets: Target[];
  try {
    factsList = source.facts(input);
    if (factsList.length === 0) return 0;
    targets = await source.targets(input, factsList);
  } catch (err) {
    console.warn(
      `[workflows] could not read ${source.integration} event ${source.describe(input)}:`,
      err instanceof Error ? err.message : err
    );
    return 0;
  }

  let ran = 0;
  for (const target of targets) {
    try {
      ran += await evaluateForWorkspace(source, input, target, factsList);
    } catch (err) {
      console.warn(
        `[workflows] evaluation failed for workspace ${target.workspaceId} on ` +
          `${source.describe(input)}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return ran;
}

async function evaluateForWorkspace<
  Input,
  Target extends WorkflowSourceTarget,
  Facts extends WorkflowFacts,
>(
  source: WorkflowSourceAdapter<Input, Target, Facts>,
  input: Input,
  target: Target,
  factsList: Facts[]
): Promise<number> {
  // The deployment-wide switch is checked once by the caller. This is the
  // per-workspace question, which came back when the audience moved to a
  // PostHog flag — but not the cost that made it go away. What used to sit here
  // was a `users` join per delivery per watching workspace; the owner lookup is
  // now cached, and with a personal API key configured the flag is evaluated
  // in-process, so the common case is neither a query nor a round trip.
  //
  // Asked BEFORE the workflow rows are read, so a workspace outside the
  // audience costs one cached lookup rather than a table scan.
  if (!(await workspaceMayUseWorkflows(target.workspaceId))) return 0;
  if (source.workspaceAllowed && !(await source.workspaceAllowed(target.workspaceId))) return 0;

  // One cached read serves every integration; the filter is in memory.
  const workflows = (await enabledWorkflowsFor(target.workspaceId)).filter(
    (w) => workflowIntegrationOf(w) === source.integration
  );
  if (workflows.length === 0) return 0;

  const ownerId = await ownerOfWorkspace(target.workspaceId);
  if (!ownerId) return 0;

  const prepared = await source.prepare(target, factsList, workflows);

  let ran = 0;
  for (const facts of prepared.facts) {
    for (const workflow of workflows) {
      if (!workflowMatches(workflow, facts, prepared.viewerLogin)) continue;
      const acted = await runOne(source, input, target, workflow, facts, ownerId);
      if (acted) ran += 1;
    }
  }
  return ran;
}

/**
 * What a run's analytics say about its subject. The repository and PR number
 * for GitHub, because a run without the thing it ran on cannot be debugged.
 * The Slack team and channel ids for Slack, never the message text.
 */
function subjectProps(facts: WorkflowFacts): Record<string, unknown> {
  if (isIssueFacts(facts)) return { issue_integration: facts.integration, issue_id: facts.externalId };
  if (isWebhookFacts(facts)) return { webhook_connection_id: facts.connectionId };
  if (isSlackFacts(facts)) {
    return { slack_team_id: facts.teamId, slack_channel_id: facts.channelId };
  }
  return { repo: facts.repoFullName, pr_number: facts.number };
}

/** One matched workflow against one subject. Returns whether it acted. */
async function runOne<Input, Target extends WorkflowSourceTarget, Facts extends WorkflowFacts>(
  source: WorkflowSourceAdapter<Input, Target, Facts>,
  input: Input,
  target: Target,
  workflow: WorkflowDefinition,
  facts: Facts,
  ownerId: string
): Promise<boolean> {
  const subject = workflowSubjectOf(facts);
  const claimInput = {
    workflowId: workflow.id,
    workspaceId: target.workspaceId,
    repositoryId: target.repositoryId,
    facts,
    deliveryId: source.deliveryId(input),
  };
  const capNoun = isIssueFacts(facts) ? 'issue' : isWebhookFacts(facts) ? 'webhook' : isSlackFacts(facts) ? 'channel' : 'PR';

  // The rate cap first, so a loop costs one COUNT rather than a round of actions.
  const verdict = await checkRateCap({
    workflowId: workflow.id,
    subjectKey: subject.key,
    cap: workflow.maxRunsPerPrPerHour,
  });
  if (!verdict.allowed) {
    if (verdict.announce) {
      const run = await recordSkippedRun(claimInput, {
        type: workflow.actions[0]?.type ?? 'comment',
        ok: false,
        code: 'rate_capped',
        error:
          `"${workflow.name}" has already run ${workflow.maxRunsPerPrPerHour} times on this ${capNoun} ` +
          `in the last hour, so it stood down. If that is not a loop, raise its limit.`,
      });
      if (run) emitWorkflowRun(target.workspaceId, run);
    }
    debugBus.recordEvent({
      service: 'workflows',
      action: 'rate-capped',
      summary: `"${workflow.name}" hit its per-${capNoun} cap on ${subject.label}`,
      ok: false,
      workspaceId: target.workspaceId,
    });
    return false;
  }

  // The insert IS the idempotency claim — see runs.ts. A duplicate means this
  // delivery has already been handled, here or on another replica.
  const claim = await claimRun(claimInput);
  if (!claim.claimed) return false;

  // The rule's actions, plus the "Talyn started" comment an issue rule adds.
  const results = await runWorkflowActions(
    effectiveWorkflowActions(workflow),
    source.actionContext(target, facts, {
      workspaceId: target.workspaceId,
      ownerId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      runId: claim.run.id,
    })
  );

  // A rate-limited action is PARKED, not failed. The gate holds the instant it
  // clears, so the retry is scheduled from the thing that knows rather than
  // guessed at, and the sweep re-runs only what has not already succeeded.
  const { status, retryAfter } = settlementFor(results.outcomes, {
    // The later of the rate gate and any box refusal: both say when they clear.
    blockedUntilMs: Math.max(source.blockedUntilMs(target), results.boxRetryAtMs),
    attempts: 1,
  });
  const settled = await settleRun(claim.run.id, {
    status,
    actions: results.outcomes,
    taskId: results.taskId,
    pullRequestId: results.pullRequestId,
    workbenchId: results.workbenchId,
    retryAfter,
  });
  if (settled) emitWorkflowRun(target.workspaceId, settled);

  debugBus.recordEvent({
    service: 'workflows',
    action: 'workflow:run',
    summary:
      `"${workflow.name}" ${status} on ${subject.label} ` +
      `(${facts.event}, ${results.outcomes.length} action${results.outcomes.length === 1 ? '' : 's'})`,
    ok: status === 'succeeded',
    workspaceId: target.workspaceId,
    meta: {
      workflowId: workflow.id,
      event: facts.event,
      actions: results.outcomes.map((o) => `${o.type}:${o.ok ? 'ok' : (o.code ?? 'failed')}`),
    },
  });

  const failed = results.outcomes.filter((o) => !o.ok);

  captureWorkspaceEvent(target.workspaceId, 'workflow_ran', {
    workflow_id: workflow.id,
    integration: source.integration,
    event: facts.event,
    status,
    action_types: workflow.actions.map((a) => a.type),
    started_task: results.taskId !== null,
    started_session: results.workbenchId !== null,
    ...subjectProps(facts),
    // The codes on the run itself, so "which workflows are failing and why" is
    // answerable without unpacking the per-action array.
    failed_count: failed.length,
    failure_codes: [...new Set(failed.map((o) => o.code ?? 'error'))],
  });

  // One FLAT event per failed action, on top of the run's summary.
  //
  // A dashboard question like "how often does GitHub's rate limit cost us an
  // action" is a one-line insight over this and an array-unpacking exercise over
  // `workflow_ran`. It also separates the two populations that matter and look
  // identical in a status column: a REFUSAL Talyn made on purpose (the plan cap,
  // a closed rate gate, a run already working the PR) and something that
  // actually broke.
  for (const outcome of failed) {
    captureWorkspaceEvent(target.workspaceId, 'workflow_action_failed', {
      workflow_id: workflow.id,
      integration: source.integration,
      event: facts.event,
      action_type: outcome.type,
      code: outcome.code ?? 'error',
      // Refusals are normal and expected; anything else wants looking at. Named
      // here rather than derived in the dashboard so the two never drift.
      refused: REFUSAL_CODES.has(outcome.code ?? 'error'),
      ...subjectProps(facts),
    });
  }

  return true;
}
