import { and, eq, sql } from 'drizzle-orm';
import type {
  WorkflowDefinition,
  WorkflowEventFacts,
  WorkflowFactField,
  WorkflowTriggerEvent,
} from '@talyn/shared';
import { workflowMatches } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
} from '../../db/schema.js';
import { workspaces as workspacesTable } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { githubService } from '../github.js';
import { classifyAutoMergeActor } from '../githubAutoMerge.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { emitWorkflowRun } from '../websocket.js';
import type { WatchTarget } from '../webhookIndex.js';
import type { WebhookDelivery } from '../webhookPayload.js';
import { workflowsEnabled } from '../workflowsAccess.js';
import { runWorkflowActions } from './actions.js';
import { workflowFactsFromDelivery } from './facts.js';
import { checkRateCap, claimRun, recordSkippedRun, settleRun, statusFromOutcomes } from './runs.js';
import { enabledWorkflowsFor } from './store.js';

/**
 * The workflow engine — one webhook delivery in, zero or more runs out.
 *
 * Called from `processWebhookDelivery` after the watching workspaces are
 * resolved and BEFORE the `isRefreshEvent` gate, because that predicate answers
 * "does this imply a PR data refresh" and narrows the vocabulary a workflow
 * legitimately cares about (a `check_suite completed` passes it and is then a
 * no-op).
 *
 * Reads the PAYLOAD, not a `pull_requests` row, so a workflow fires on every PR
 * in a watched repo — including PRs Talyn does not track and PRs somebody else
 * opened. Where the payload is short of a fact (`issue_comment` describes an
 * issue, which has no base branch), the row is consulted as an ENRICHMENT and a
 * condition on a fact still unknown afterwards fails rather than passes.
 */

/**
 * Events one of Talyn's own actions can produce, and which could therefore feed
 * back into a workflow that triggers on them.
 *
 * This set is the loop guard's whole scope, and what it EXCLUDES is the point:
 * `pr_merged` is not here, even though Talyn's merge queue merges PRs, because
 * "comment when it merges" is a rule people actually want and a merge cannot
 * re-trigger a merge — the PR is closed. Only the genuinely self-feeding
 * actions are suppressed.
 */
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
  'rate_gated',
  'no_cloud_provider',
  'task_already_running',
  'merge_queue_limit_reached',
  'not_open',
]);

const SELF_ECHO_EVENTS: ReadonlySet<WorkflowTriggerEvent> = new Set([
  'pr_labeled',
  'pr_unlabeled',
  'pr_assigned',
  'pr_unassigned',
  'pr_review_requested',
  'pr_review_request_removed',
  'pr_comment',
  'pr_review_submitted',
  'pr_ready_for_review',
]);

/**
 * Whether this delivery is Talyn hearing its own action back.
 *
 * An `add_labels` action produces a `pull_request/labeled` delivery, which is
 * itself a trigger event — a workflow on `pr_labeled` that adds a label would
 * loop until GitHub's rate limit stopped it. This is the direct fix, and it is
 * the same shape as the `event.type !== 'debug:event'` guard in `websocket.ts`.
 *
 * Scoped to the App bot only, never the connected user: a person labelling their
 * own PR is a completely legitimate trigger, and suppressing it would break the
 * most obvious rule anybody writes.
 */
export function isSelfEcho(facts: WorkflowEventFacts): boolean {
  if (!SELF_ECHO_EVENTS.has(facts.event)) return false;
  return classifyAutoMergeActor(facts.actor.login) === 'talyn';
}

/** Whether any workflow in the list constrains a fact this payload lacks. */
function needsEnrichment(workflows: WorkflowDefinition[], facts: WorkflowEventFacts): boolean {
  const missing = facts.unknownFields;
  if (!missing || missing.length === 0) return false;
  const wants = (f: WorkflowFactField): boolean => {
    if (!missing.includes(f)) return false;
    return workflows.some((w) => {
      const c = w.conditions;
      switch (f) {
        case 'baseBranch':
          return (c.baseBranches?.length ?? 0) > 0 || c.baseIsDefault !== undefined;
        case 'defaultBranch':
          return c.baseIsDefault !== undefined;
        case 'title':
          return !!c.titleContains;
        case 'draft':
          return c.draft !== undefined;
        case 'labels':
          return (
            (c.labelsAny?.length ?? 0) > 0 ||
            (c.labelsAll?.length ?? 0) > 0 ||
            (c.labelsNone?.length ?? 0) > 0
          );
        case 'author':
          return !!c.author && c.author.kind !== 'any';
        default:
          return false;
      }
    });
  };
  return (
    ['baseBranch', 'defaultBranch', 'title', 'draft', 'labels', 'author'] as WorkflowFactField[]
  ).some(wants);
}

/**
 * Fill in what the payload could not say, from the tracked PR row.
 *
 * Projected out of the `last_summary` jsonb with SQL expressions rather than by
 * selecting the blob: this runs on the webhook worker's path and the summary
 * carries the whole check breakdown, the stack and the unresolved-thread
 * counts, none of which a workflow condition reads. (DB egress rules — the same
 * reasoning as `prMonitor.fastPollWorkspace`.)
 *
 * Returns the facts unchanged when there is no row: honest, and the matcher then
 * fails any condition on a still-unknown fact rather than guessing.
 *
 * The query is exported so a test can assert on its SQL: every mention of
 * `last_summary` must be an accessor (`->`/`->>`), never the bare column. That
 * assertion is the regression guard — the projection is easy to "simplify" into
 * a plain select, and the cost would only show up as a bill.
 */
export function enrichmentQuery(target: WatchTarget, number: number) {
  return getDbClient()
    .select({
      title: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'title'`,
      author: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'author'`,
      baseBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'baseBranch'`,
      headBranch: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'headBranch'`,
      url: sql<string | null>`${pullRequestsTable.lastSummary} ->> 'url'`,
      // Not from the summary: the repository row is where the default branch
      // lives, and it is the cheaper read of the two.
      defaultBranch: repositoriesTable.defaultBranch,
      draft: sql<boolean | null>`(${pullRequestsTable.lastSummary} ->> 'draft')::boolean`,
      labels: sql<string[] | null>`${pullRequestsTable.lastSummary} -> 'labels'`,
    })
    .from(pullRequestsTable)
    .innerJoin(repositoriesTable, eq(repositoriesTable.id, pullRequestsTable.repositoryId))
    .where(
      and(
        eq(pullRequestsTable.workspaceId, target.workspaceId),
        eq(pullRequestsTable.repositoryId, target.repositoryId),
        eq(pullRequestsTable.number, number)
      )
    )
    .limit(1);
}

async function enrich(
  facts: WorkflowEventFacts,
  target: WatchTarget
): Promise<WorkflowEventFacts> {
  const rows = await enrichmentQuery(target, facts.number);
  const row = rows[0];
  if (!row) return facts;

  const filled = new Set(facts.unknownFields ?? []);
  const next: WorkflowEventFacts = { ...facts };

  const take = (field: WorkflowFactField, apply: () => boolean): void => {
    if (!filled.has(field)) return;
    if (apply()) filled.delete(field);
  };

  take('title', () => {
    if (!row.title) return false;
    next.title = row.title;
    return true;
  });
  take('url', () => {
    if (!row.url) return false;
    next.url = row.url;
    return true;
  });
  take('author', () => {
    if (!row.author) return false;
    // The summary stores a login, not a user object, so bot-ness has to be read
    // off the login shape alone. That is exactly what `[bot]` suffixes are for.
    next.author = { login: row.author, isBot: row.author.toLowerCase().endsWith('[bot]') };
    return true;
  });
  take('baseBranch', () => {
    if (!row.baseBranch) return false;
    next.baseBranch = row.baseBranch;
    return true;
  });
  take('defaultBranch', () => {
    if (!row.defaultBranch) return false;
    next.defaultBranch = row.defaultBranch;
    return true;
  });
  take('headBranch', () => {
    if (!row.headBranch) return false;
    next.headBranch = row.headBranch;
    return true;
  });
  take('draft', () => {
    if (row.draft === null || row.draft === undefined) return false;
    next.draft = row.draft;
    return true;
  });
  take('labels', () => {
    if (!Array.isArray(row.labels)) return false;
    next.labels = row.labels.filter((l): l is string => typeof l === 'string');
    return true;
  });

  next.unknownFields = [...filled];
  return next;
}

/** The workspace owner, for the plan gates the actions run behind. */
async function ownerOf(workspaceId: string): Promise<string | null> {
  const rows = await getDbClient()
    .select({ ownerId: workspacesTable.ownerId })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return rows[0]?.ownerId ?? null;
}

/**
 * Evaluate every workspace's workflows against one delivery.
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
  if (!workflowsEnabled()) return 0;

  const factsList = workflowFactsFromDelivery(delivery);
  if (factsList.length === 0) return 0;

  let ran = 0;
  for (const target of targets) {
    try {
      ran += await evaluateForWorkspace(delivery, target, factsList);
    } catch (err) {
      console.warn(
        `[workflows] evaluation failed for workspace ${target.workspaceId} on ` +
          `${delivery.eventType}/${delivery.action ?? '-'} ${delivery.repoFullName}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return ran;
}

async function evaluateForWorkspace(
  delivery: WebhookDelivery,
  target: WatchTarget,
  factsList: WorkflowEventFacts[]
): Promise<number> {
  // The kill switch is checked once by the caller, before any of this. What
  // used to sit here was a per-workspace allow-list lookup — a join against
  // `users` for every delivery, for every watching workspace — and releasing the
  // feature removed it rather than making it always answer true.
  const workflows = await enabledWorkflowsFor(target.workspaceId);
  if (workflows.length === 0) return 0;

  const ownerId = await ownerOf(target.workspaceId);
  if (!ownerId) return 0;

  // Only resolved when a workflow actually asks "…and it's me". Cached inside
  // githubService, so a repeat costs nothing.
  // Any `viewer` actor match needs to know who "I" am — on the author, the
  // actor, or the person the event named.
  const needsViewer = workflows.some((w) =>
    [w.conditions.author, w.conditions.actor, w.conditions.target].some(
      (m) => m?.kind === 'viewer'
    )
  );
  const viewerLogin = needsViewer
    ? await githubService.getViewerLogin(target.workspaceId).catch(() => null)
    : null;

  let ran = 0;
  for (const raw of factsList) {
    if (isSelfEcho(raw)) {
      debugBus.recordEvent({
        service: 'workflows',
        action: 'self-echo',
        summary: `${raw.repoFullName}#${raw.number} ${raw.event} was Talyn's own action — skipped`,
        workspaceId: target.workspaceId,
      });
      continue;
    }

    const facts = needsEnrichment(workflows, raw)
      ? await enrich(raw, target).catch(() => raw)
      : raw;

    for (const workflow of workflows) {
      if (!workflowMatches(workflow, facts, viewerLogin)) continue;
      const acted = await runOne(workflow, facts, delivery, target, ownerId);
      if (acted) ran += 1;
    }
  }
  return ran;
}

/** One matched workflow against one PR. Returns whether it acted. */
async function runOne(
  workflow: WorkflowDefinition,
  facts: WorkflowEventFacts,
  delivery: WebhookDelivery,
  target: WatchTarget,
  ownerId: string
): Promise<boolean> {
  const claimInput = {
    workflowId: workflow.id,
    workspaceId: target.workspaceId,
    repositoryId: target.repositoryId,
    facts,
    deliveryId: delivery.deliveryId,
  };

  // The rate cap first, so a loop costs one COUNT rather than a round of actions.
  const verdict = await checkRateCap({
    workflowId: workflow.id,
    repoFullName: facts.repoFullName,
    prNumber: facts.number,
    cap: workflow.maxRunsPerPrPerHour,
  });
  if (!verdict.allowed) {
    if (verdict.announce) {
      const run = await recordSkippedRun(claimInput, {
        type: workflow.actions[0]?.type ?? 'comment',
        ok: false,
        code: 'rate_capped',
        error:
          `"${workflow.name}" has already run ${workflow.maxRunsPerPrPerHour} times on this PR ` +
          `in the last hour, so it stood down. If that is not a loop, raise its limit.`,
      });
      if (run) emitWorkflowRun(target.workspaceId, run);
    }
    debugBus.recordEvent({
      service: 'workflows',
      action: 'rate-capped',
      summary: `"${workflow.name}" hit its per-PR cap on ${facts.repoFullName}#${facts.number}`,
      ok: false,
      workspaceId: target.workspaceId,
    });
    return false;
  }

  // The insert IS the idempotency claim — see runs.ts. A duplicate means this
  // delivery has already been handled, here or on another replica.
  const claim = await claimRun(claimInput);
  if (!claim.claimed) return false;

  const results = await runWorkflowActions(workflow.actions, {
    workspaceId: target.workspaceId,
    ownerId,
    repositoryId: target.repositoryId,
    owner: target.owner,
    repo: target.repo,
    facts,
    workflowId: workflow.id,
    runId: claim.run.id,
  });

  const status = statusFromOutcomes(results.outcomes);
  const settled = await settleRun(claim.run.id, {
    status,
    actions: results.outcomes,
    taskId: results.taskId,
    pullRequestId: results.pullRequestId,
  });
  if (settled) emitWorkflowRun(target.workspaceId, settled);

  debugBus.recordEvent({
    service: 'workflows',
    action: 'workflow:run',
    summary:
      `"${workflow.name}" ${status} on ${facts.repoFullName}#${facts.number} ` +
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
    event: facts.event,
    status,
    action_types: workflow.actions.map((a) => a.type),
    started_task: results.taskId !== null,
    repo: facts.repoFullName,
    pr_number: facts.number,
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
      event: facts.event,
      action_type: outcome.type,
      code: outcome.code ?? 'error',
      // Refusals are normal and expected; anything else wants looking at. Named
      // here rather than derived in the dashboard so the two never drift.
      refused: REFUSAL_CODES.has(outcome.code ?? 'error'),
      repo: facts.repoFullName,
      pr_number: facts.number,
    });
  }

  return true;
}
