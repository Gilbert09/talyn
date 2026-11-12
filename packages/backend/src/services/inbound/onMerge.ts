import { eq } from 'drizzle-orm';
import type { IssueEventFacts } from '@talyn/shared';
import { ISSUE_MERGE_EVENT, issueMergeActions, workflowSubjectOf } from '@talyn/shared';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { pullRequests } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { domainEvents } from '../events.js';
import { githubRateGate } from '../githubRateGate.js';
import { githubService } from '../github.js';
import { linearBlockedUntil } from '../linear/api.js';
import { emitWorkflowRun } from '../websocket.js';
import { runWorkflowActions } from '../workflows/actions.js';
import { ownerOfWorkspace } from '../workflows/owner.js';
import { claimRun, settleRun, settlementFor } from '../workflows/runs.js';
import { getWorkflow } from '../workflows/store.js';
import { workflowsKillSwitchPulled, workspaceMayUseIssueRules } from '../workflowsAccess.js';
import { activeLinksForPullRequest, settleLink, type IssueLinkRow } from './issueLinks.js';

/**
 * The merge write-back. When a pull request that an issue rule's work opened
 * merges, Talyn comments on the issue with the pull request's link and, unless
 * the rule turned it off, moves the issue to done. A pull request that closes
 * without a merge releases the issue, so a later event can start again.
 *
 * Driven by `pr:snapshot`, which every path that writes a pull request's state
 * emits (the cache upsert, the monitor's close-out). The link is found by the
 * structured pull request id of the link, its task or its session.
 *
 * Exactly once: the link moves `active → done` with a compare-and-set before
 * anything is written, and the write-back is a workflow run claimed on
 * `(workflow_id, 'merge:<link>')`. A second snapshot of the same merge finds
 * no active link. A rate-limited write-back parks like any rule action and the
 * retry sweep finishes it.
 */

/** The pull request's web link, from its row. */
async function pullRequestUrl(pullRequestId: string): Promise<string> {
  const rows = await getPoolDbClient()
    .select({ owner: pullRequests.owner, repo: pullRequests.repo, number: pullRequests.number })
    .from(pullRequests)
    .where(eq(pullRequests.id, pullRequestId))
    .limit(1);
  const row = rows[0];
  return row ? `https://github.com/${row.owner}/${row.repo}/pull/${row.number}` : '';
}

async function writeBackMerge(link: IssueLinkRow, pullRequestId: string, prUrl: string): Promise<void> {
  if (!link.workflowId || !link.facts) return;
  const workflow = await getWorkflow(link.workflowId);
  const ownerId = await ownerOfWorkspace(link.workspaceId);
  if (!workflow || !ownerId) return;

  const facts: IssueEventFacts = {
    ...(link.facts as IssueEventFacts),
    event: ISSUE_MERGE_EVENT,
    mergedPrUrl: prUrl,
  };
  const claim = await claimRun({
    workflowId: workflow.id,
    workspaceId: link.workspaceId,
    repositoryId: null,
    facts,
    deliveryId: `merge:${link.id}`,
    pullRequestId,
  });
  if (!claim.claimed) return;

  const results = await runWorkflowActions(issueMergeActions(workflow), {
    workspaceId: link.workspaceId,
    ownerId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    runId: claim.run.id,
    integration: facts.integration,
    repositoryId: null,
    facts,
  });
  const blockedUntilMs =
    facts.integration === 'linear' && facts.connectionId
      ? linearBlockedUntil(facts.connectionId)
      : githubRateGate.blockedUntil(githubService.accountKeyFor(link.workspaceId), 'rest');
  const { status, retryAfter } = settlementFor(results.outcomes, { blockedUntilMs, attempts: 1 });
  const settled = await settleRun(claim.run.id, {
    status,
    actions: results.outcomes,
    pullRequestId,
    taskId: link.taskId,
    workbenchId: link.workbenchId,
    retryAfter,
  });
  if (settled) emitWorkflowRun(link.workspaceId, settled);
  debugBus.recordEvent({
    service: 'workflows',
    action: 'issue:merged',
    summary: `"${workflow.name}" wrote back to ${workflowSubjectOf(facts).label}: ${status}`,
    ok: status === 'succeeded',
    workspaceId: link.workspaceId,
  });
}

/**
 * One pull request reached a final state. Exported for tests; the listener
 * calls it for every `merged` or `closed` snapshot.
 */
export async function handlePullRequestSettled(
  workspaceId: string,
  pullRequestId: string,
  state: 'merged' | 'closed'
): Promise<number> {
  const links = await activeLinksForPullRequest(workspaceId, pullRequestId);
  if (links.length === 0) return 0;
  const writeBack = state === 'merged' && !workflowsKillSwitchPulled() && (await workspaceMayUseIssueRules(workspaceId));
  const prUrl = state === 'merged' ? await pullRequestUrl(pullRequestId) : '';
  let handled = 0;
  for (const link of links) {
    const won = await settleLink(
      link.id,
      state === 'merged' ? 'done' : 'failed',
      state === 'merged' ? 'the pull request merged' : 'the pull request closed without a merge'
    );
    if (!won) continue;
    handled += 1;
    if (!writeBack) continue;
    try {
      await writeBackMerge(link, pullRequestId, prUrl);
    } catch (err) {
      debugBus.recordEvent({
        service: 'workflows',
        action: 'issue:merge_failed',
        summary: `${link.externalKey}`,
        ok: false,
        error: err,
        workspaceId,
      });
    }
  }
  return handled;
}

let registered = false;

/** Listen for pull requests that merge or close. Called once at boot. */
export function initIssueMergeListener(): void {
  if (registered) return;
  registered = true;
  domainEvents.on('pr:snapshot', (evt) => {
    if (evt.state === 'open') return;
    void runWithoutScope(async () => {
      try {
        await handlePullRequestSettled(evt.workspaceId, evt.prId, evt.state as 'merged' | 'closed');
      } catch (err) {
        console.warn(`[issues] handling the ${evt.state} pull request ${evt.prId} failed:`, err);
      }
    });
  });
}
