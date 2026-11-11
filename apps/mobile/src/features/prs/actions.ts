import type { CloudProviderInfo, MergeQueuePublic, PRCheckContext, PRRow, PRSummaryShape } from '@talyn/client/native';
import { buildMergeablePrompt, cloudAgentChoices, fixBlockedReason, mergeBlockerReason, promptTemplateFor, queueBlockNeedsHuman,
  TASK_STATUS_TERMINAL, type CloudAgentChoice, type CloudProviderType, type Environment, type FixBlockedReason,
  type TaskStatus, type Workspace } from '@talyn/shared';

import type { WorkflowStore } from '../../workflow/store';

/** Web shows Merge for an open PR GitHub reports as mergeable, optional failures included. */
export const canMerge = (row: Pick<PRRow, 'state' | 'summary'>) =>
  row.state === 'open' && (row.summary.blockingReason === 'mergeable' || row.summary.blockingReason === 'checks_failed_optional');

/** Re-submit a parked entry to its external queue. Mirrors web `canResubmitMergeQueue`. */
export function canResubmit(entry: MergeQueuePublic | null | undefined): boolean {
  return Boolean(entry && (entry.status === 'blocked' || entry.status === 'blocked_manual') &&
    (entry.external || entry.blockedCode === 'external_gate' || entry.blockedCode === 'external_queue_rejected'));
}
export const queueBlocked = (entry: MergeQueuePublic | null | undefined) => entry?.status === 'blocked' || entry?.status === 'blocked_manual';

export interface PrActionSet {
  /** Write actions are for PRs you opened, as on web. A reviewer only gets the link. */
  owner: boolean;
  merge: boolean;
  fix: boolean;
  /** Why the fix cannot run, from the shared rule. Pressing Fix explains it. */
  fixBlocked: FixBlockedReason | null;
  queue: boolean;
  autoKeep: boolean;
  resubmit: boolean;
  requeue: boolean;
}

export function prActions(row: PRRow, options: { posthogConnected: boolean; taskRunning?: boolean }): PrActionSet {
  const owner = row.authored;
  const open = row.state === 'open';
  const write = owner && open;
  const queued = row.mergeQueued || Boolean(row.mergeQueue);
  const resubmit = queued && canResubmit(row.mergeQueue);
  return {
    owner,
    merge: owner && canMerge(row),
    fix: write,
    fixBlocked: write ? fixBlockedReason(row.summary, { state: row.state, taskRunning: options.taskRunning === true }) : null,
    queue: write,
    autoKeep: write && options.posthogConnected,
    resubmit,
    requeue: queued && queueBlocked(row.mergeQueue) && !resubmit,
  };
}

/** One line for whether the PR can merge and, if not, why. */
export function mergeLine(row: Pick<PRRow, 'state' | 'mergedAt'>, summary: PRSummaryShape): string {
  if (row.state === 'merged') return 'Merged.';
  if (row.state === 'closed') return 'Closed without merging.';
  if (summary.draft) return 'Draft. Mark it ready for review on GitHub before it can merge.';
  switch (summary.blockingReason) {
    case 'mergeable': return 'Ready to merge.';
    case 'checks_failed_optional': return 'Ready to merge. Some optional checks fail.';
    case 'unknown': return 'GitHub has not said yet if this can merge.';
    case 'blocked': return 'Blocked by a branch rule, such as a required review.';
  }
  const reason = mergeBlockerReason(summary);
  return reason === 'needs attention' ? 'Needs attention before it can merge.' : `Blocked by ${reason}.`;
}

/** "14 checks: 12 passed, 1 failing, 1 running". Null when the PR has no checks. */
export function checksLine(checks: PRSummaryShape['checks'] | undefined): string | null {
  if (!checks?.total) return null;
  const parts = [`${checks.passed} passed`];
  if (checks.failed) parts.push(`${checks.failed} failing`);
  if (checks.inProgress) parts.push(`${checks.inProgress} running`);
  if (checks.skipped) parts.push(`${checks.skipped} skipped`);
  return `${checks.total} ${checks.total === 1 ? 'check' : 'checks'}: ${parts.join(', ')}`;
}

/** Failing checks from the live detail, required ones first. */
export function failingChecks(contexts: PRCheckContext[] | undefined): PRCheckContext[] {
  return (contexts ?? []).filter((check) => check.state === 'failure')
    .sort((a, b) => Number(b.required === true) - Number(a.required === true) || a.name.localeCompare(b.name));
}

/** The queue toggle's state, like the web button's label. */
export function queueStateLabel(row: Pick<PRRow, 'mergeQueued' | 'mergeQueue'>): string {
  if (!row.mergeQueued) return 'Not queued';
  const entry = row.mergeQueue;
  if (queueBlocked(entry)) return queueBlockNeedsHuman(entry?.blockedCode) ? 'Queue needs you' : 'Queue blocked';
  if (entry?.status === 'merging') return 'Merging';
  if (entry?.status === 'fixing') return 'Fixing';
  return entry?.position ? `Queued #${entry.position}` : 'Queued';
}

/** The autokeep toggle's state, like the web button's label. */
export function autoKeepLabel(row: Pick<PRRow, 'autoKeepMergeable' | 'autoMergeState'>): string {
  if (!row.autoKeepMergeable) return 'Off';
  return row.autoMergeState?.paused ? 'Auto-fix paused' : 'On';
}

/**
 * Which environment a fix dispatches to, like web `resolveTaskEnvId`: the
 * picked provider, else the workspace default when connected, else Talyn Fleet
 * and then PostHog Code. Null when nothing is connected.
 */
export function resolveTaskEnvironment(input: { providerType?: string; providers: CloudProviderInfo[]; environments: Environment[];
  defaultProvider?: string | null }): string | null {
  const connected = input.providers.filter((provider) => provider.connected);
  const envFor = (type: string) => input.environments.find((env) => env.type === type)?.id ?? null;
  if (input.providerType) return connected.some((provider) => provider.type === input.providerType) ? envFor(input.providerType) : null;
  const preferred = input.defaultProvider;
  if (preferred && preferred !== 'ask' && connected.some((provider) => provider.type === preferred)) {
    const id = envFor(preferred);
    if (id) return id;
  }
  for (const type of ['selfhosted', 'posthog_code']) {
    if (connected.some((provider) => provider.type === type)) {
      const id = envFor(type);
      if (id) return id;
    }
  }
  return null;
}

/** The agents to offer before a fix. Only when the workspace says "ask" and there is a real choice. */
export function fixAgentChoices(providers: CloudProviderInfo[], workspace: Pick<Workspace, 'settings'> | undefined): CloudAgentChoice[] {
  const choices = cloudAgentChoices(providers, workspace?.settings);
  return workspace?.settings?.defaultCloudProvider === 'ask' && choices.length > 1 ? choices : [];
}

/** Where a PR fix goes when a session works the PR, by the PR's real state. Mirrors web `sessionFixAction`. */
export function sessionFixAction(row: Pick<PRRow, 'summary'>): 'resolve_conflicts' | 'fix_checks' | 'address_review' {
  const s = row.summary;
  if (s.blockingReason === 'merge_conflicts' || s.mergeable === 'CONFLICTING') return 'resolve_conflicts';
  if (s.blockingReason === 'checks_failed' || s.ciStatus === 'failing_required') return 'fix_checks';
  if ((s.unresolvedReviewThreads ?? 0) > 0 || s.blockingReason === 'changes_requested' || s.reviewDecision === 'CHANGES_REQUESTED') return 'address_review';
  return 'fix_checks';
}

/** The session named by a 409 `pr_has_session`, or null. */
export function sessionFromConflict(error: unknown): { id: string; name: string } | null {
  const value = error as { status?: number; code?: string; details?: Record<string, unknown> } | null;
  if (value?.status !== 409 || value.code !== 'pr_has_session') return null;
  const id = value.details?.workbenchId;
  const name = value.details?.name;
  return typeof id === 'string' ? { id, name: typeof name === 'string' ? name : 'session' } : null;
}

export type FixOutcome = { kind: 'session'; id: string; name: string } | { kind: 'task' } | { kind: 'no_agent' } | { kind: 'blocked'; reason: FixBlockedReason };

/**
 * Whether the PR's linked run has not finished, and whether it is paused for CI
 * (`waiting_ci`, still running). A failed lookup counts as finished: the server
 * checks again.
 */
export async function linkedTaskState(store: WorkflowStore, row: Pick<PRRow, 'taskId'>): Promise<{ running: boolean; waitingCi: boolean }> {
  if (!row.taskId) return { running: false, waitingCi: false };
  try {
    const task = await store.api.tasks.get(row.taskId);
    return { running: !TASK_STATUS_TERMINAL[task.status as TaskStatus], waitingCi: task.status === 'waiting_ci' };
  } catch { return { running: false, waitingCi: false }; }
}

/** True when the PR's linked run has not finished. */
export async function linkedTaskRunning(store: WorkflowStore, row: Pick<PRRow, 'taskId'>): Promise<boolean> {
  return (await linkedTaskState(store, row)).running;
}

/**
 * Hand a PR to an agent, like web `createPostHogTask`. A session already on the
 * PR gets the fix in its chat, so two agents never push to one branch.
 */
export async function startPrFix(store: WorkflowStore, row: PRRow, context: {
  providers: CloudProviderInfo[]; environments: Environment[]; workspace: Workspace | undefined; choice?: CloudAgentChoice;
}): Promise<FixOutcome> {
  const sendToSession = async (session: { id: string; name: string }): Promise<FixOutcome> => {
    await store.api.workbenches.action(session.id, sessionFixAction(row));
    return { kind: 'session', id: session.id, name: session.name };
  };
  if (row.session) return sendToSession(row.session);
  const blocked = fixBlockedReason(row.summary, { state: row.state, taskRunning: await linkedTaskRunning(store, row) });
  if (blocked) return { kind: 'blocked', reason: blocked };
  const envId = resolveTaskEnvironment({ providerType: context.choice?.type, providers: context.providers,
    environments: context.environments, defaultProvider: context.workspace?.settings?.defaultCloudProvider });
  if (!envId) return { kind: 'no_agent' };
  const provider = (context.environments.find((env) => env.id === envId)?.type ?? 'posthog_code') as CloudProviderType;
  const ref = `${row.owner}/${row.repo}#${row.number}`;
  try {
    const created = await store.api.tasks.create({
      workspaceId: row.workspaceId, type: 'pr_response', title: `Get ${ref} mergeable`,
      description: `Take ${ref} ("${row.summary.title}") to a clean, mergeable state.`,
      prompt: buildMergeablePrompt({ owner: row.owner, repo: row.repo, number: row.number, summary: row.summary, provider,
        template: promptTemplateFor(context.workspace?.settings, 'mergeable') }),
      repositoryId: row.repositoryId, assignedEnvironmentId: envId, pullRequestId: row.id,
      ...(context.choice?.model ? { model: context.choice.model } : {}),
    });
    store.patchPr(row.id, { taskId: created.id });
    return { kind: 'task' };
  } catch (error) {
    const session = sessionFromConflict(error);
    if (!session) throw error;
    return sendToSession(session);
  }
}
