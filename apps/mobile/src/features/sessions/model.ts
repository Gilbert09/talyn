import type { Workbench, WorkbenchReadiness } from '@talyn/shared';

import { groupByRepository } from '../../workflow/model';

export type ListItem = { type: 'section'; key: string; repo: string } | { type: 'row'; key: string; item: Workbench; last: boolean };

/** Rows grouped by repository with a section label per repository. Rows without one are not labelled. */
export function listItems(items: Workbench[]): ListItem[] {
  const groups = groupByRepository(items);
  return groups.flatMap((group) => [
    ...(group.repo ? [{ type: 'section' as const, key: `section:${group.repo}`, repo: group.repo }] : []),
    ...group.items.map((item, index) => ({ type: 'row' as const, key: item.id, item, last: index === group.items.length - 1 })),
  ]);
}

/** Only a real problem: the sandbox or this agent reports it cannot run. Null otherwise. */
export function readinessProblem(readiness: WorkbenchReadiness | undefined, agent: string): string | null {
  if (!readiness) return null;
  const agentReadiness = readiness.sandbox.agents[agent as keyof WorkbenchReadiness['sandbox']['agents']];
  if (agentReadiness && !agentReadiness.ok) return agentReadiness.reason?.message ?? 'This agent cannot run right now.';
  if (!readiness.sandbox.ok) return readiness.sandbox.reasons[0]?.message ?? 'Sessions cannot run right now.';
  return null;
}

// ---------------------------------------------------------------------------
// Detail tabs
// ---------------------------------------------------------------------------

export type SessionTab = 'chat' | 'changes' | 'pr' | 'jobs';

const isArchivedItem = (item: Pick<Workbench, 'status' | 'archivedAt'>) => item.status === 'archived' || Boolean(item.archivedAt);

/** Whether the branch has work against its base. Mirrors web `nextActionInput`. */
export function hasChanges(item: Pick<Workbench, 'diffStat' | 'committedStats'>): boolean {
  return (item.diffStat?.files ?? 0) > 0 || (item.committedStats?.files ?? 0) > 0;
}

/**
 * Why the sandbox cannot take a new turn now, or null. Mirrors web
 * `sandboxUnavailableReason`, with web's local-runtime message.
 */
export function sessionUnavailable(item: Workbench): string | null {
  if (item.runtime === 'local') return 'This session runs on a computer with the Talyn desktop app. Open it there.';
  if (isArchivedItem(item)) return 'This session is archived.';
  if (item.status === 'error' || item.sandboxState === 'error') return item.error || item.statusMessage || 'The sandbox failed to start.';
  if (item.sandboxState === 'lost') return 'The sandbox was lost. Talyn is starting a new one.';
  if (item.status === 'provisioning') return 'The sandbox is starting.';
  return null;
}

/** Why the changes cannot be read now, or null. An archived session still reads its stored copy. */
export function changesUnavailable(item: Workbench): string | null {
  if (item.runtime !== 'local' && isArchivedItem(item)) return null;
  return sessionUnavailable(item);
}

/** A session with no pull request yet and work on its branch. Web offers Create PR then. */
export function canCreatePullRequest(item: Workbench): boolean {
  return workbenchKindOf(item) === 'session' && !isArchivedItem(item) && !item.pullRequestId && item.runtime === 'sandbox' && hasChanges(item);
}

const workbenchKindOf = (item: Pick<Workbench, 'kind'>) => item.kind ?? 'session';

/**
 * The tabs of a detail screen. A thread keeps Chat only. The PR tab shows
 * when a PR is linked or one can be created, Jobs when the session has
 * background jobs.
 */
export function sessionTabs(item: Workbench, options: { jobs?: number } = {}): SessionTab[] {
  if (workbenchKindOf(item) === 'thread') return ['chat'];
  const tabs: SessionTab[] = ['chat', 'changes'];
  if (item.pullRequestId || canCreatePullRequest(item)) tabs.push('pr');
  if ((options.jobs ?? 0) > 0) tabs.push('jobs');
  return tabs;
}

export const SESSION_TAB_LABEL: Record<SessionTab, string> = { chat: 'Chat', changes: 'Changes', pr: 'PR', jobs: 'Jobs' };

/** Words after a Create PR send, like web's toast. */
export function createPrSentText(queued: boolean, item: Pick<Workbench, 'status'>): string {
  if (!queued) return 'Sent to the agent. It opens the pull request when its turn ends.';
  return item.status === 'provisioning' ? 'Queued. It runs when the sandbox is ready.' : 'Queued. It runs when the current turn ends.';
}
