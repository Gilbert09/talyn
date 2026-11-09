import type { MergeQueuePublic, PRRow, PRSummaryShape } from '@talyn/client/native';
import { buildPRPriorityMap, comparePRByPriority, externalQueueStateLabel, externalQueueStatusFromLabels, linkStack,
  QUEUE_SESSION_BADGE_LABEL, queueBlockNeedsHuman, queueSessionBadge, queueSessionBadgeTooltip,
  type PRPriorityVerdict } from '@talyn/shared';
import type { Href } from 'expo-router';

import type { StatusTone } from '../../lib/status';
import { queueLabel } from '../../workflow/model';

// ---------------------------------------------------------------------------
// The three pages. Each one mirrors a web panel and its own cohort rule.
// ---------------------------------------------------------------------------

export type PullsTab = 'mine' | 'reviews' | 'queue';
export const PULLS_TABS: readonly PullsTab[] = ['mine', 'reviews', 'queue'];
export const PULLS_TITLES: Record<PullsTab, string> = { mine: 'Pull requests', reviews: 'Review requests', queue: 'Merge queue' };

/** The `tab` search param, with `mine` for anything else. */
export function pullsTab(value: unknown): PullsTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && (PULLS_TABS as readonly string[]).includes(raw) ? raw as PullsTab : 'mine';
}

export const pullsRoute = (tab: PullsTab) => ({ pathname: '/pulls', params: { tab } }) satisfies Href;

/** Web `compareByCreated`: by when GitHub opened the PR, newest first. */
export function compareByCreated(a: Pick<PRRow, 'summary' | 'createdAt' | 'id'>, b: Pick<PRRow, 'summary' | 'createdAt' | 'id'>): number {
  const at = (row: Pick<PRRow, 'summary' | 'createdAt'>) => Date.parse((row.summary as { createdAt?: string }).createdAt || row.createdAt) || 0;
  return at(b) - at(a) || a.id.localeCompare(b.id);
}

/** A blocking issue the author owns. Web `isNeedsAttention`. */
export function isNeedsAttention(row: Pick<PRRow, 'summary'>): boolean {
  const reason = row.summary.blockingReason;
  return reason === 'changes_requested' || reason === 'checks_failed' || reason === 'merge_conflicts' || reason === 'needs_human' || reason === 'behind';
}

/** Still waiting on a required review. Web `isAwaitingReview`. */
export function isAwaitingReview(row: Pick<PRRow, 'summary'>): boolean {
  if (row.summary.draft) return false;
  return (row.summary.effectiveReviewDecision ?? row.summary.reviewDecision) === 'REVIEW_REQUIRED';
}

/** Otherwise ready, and only a bare `blocked` from a ruleset holds it. Web `isHeldOnlyByBranchProtection`. */
export function isHeldOnlyByBranchProtection(s: PRSummaryShape): boolean {
  return s.blockingReason === 'blocked' && s.mergeable === 'MERGEABLE' && (s.checks?.failed ?? 0) === 0 &&
    (s.checks?.inProgress ?? 0) === 0 && !['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(s.effectiveReviewDecision ?? s.reviewDecision ?? '');
}

/** Nothing left to do but merge. Web `isReadyToMerge`. */
export function isReadyToMerge(row: Pick<PRRow, 'summary' | 'mergeQueue'>): boolean {
  const s = row.summary;
  if (s.draft) return false;
  const state = row.mergeQueue?.external?.state ?? externalQueueStatusFromLabels(s.labels)?.state;
  if (state && !['failed', 'cancelled', 'not_submitted'].includes(state)) return false;
  if (s.blockingReason !== 'mergeable' && s.blockingReason !== 'checks_failed_optional' && !isHeldOnlyByBranchProtection(s)) return false;
  if ((s.checks?.inProgress ?? 0) > 0) return false;
  return (s.effectiveReviewDecision ?? s.reviewDecision) !== 'REVIEW_REQUIRED';
}

/** My PRs holds what you opened and what you asked to watch. */
export const mineCohort = (rows: PRRow[]) => rows.filter((row) => row.authored || row.watching);
/** Review requests you have not hidden. Web `visibleReviewCohort`. */
export const reviewCohort = (rows: PRRow[]) => rows.filter((row) => row.reviewRequested && !row.reviewHiddenAt);
/** Hidden review requests, the most recently hidden first. Web `hiddenReviewCohort`. */
export const hiddenReviewCohort = (rows: PRRow[]) => rows.filter((row) => row.reviewRequested && row.reviewHiddenAt)
  .sort((a, b) => (b.reviewHiddenAt ?? '').localeCompare(a.reviewHiddenAt ?? ''));
export const queueCohort = (rows: PRRow[]) => rows.filter((row) => row.mergeQueued);

export interface PrSection { key: string; title: string; rows: PRRow[] }

const MINE_SECTIONS = [
  { key: 'attention', title: 'Needs attention', test: isNeedsAttention },
  { key: 'ready', title: 'Ready to merge', test: isReadyToMerge },
  { key: 'review', title: 'Waiting for review', test: isAwaitingReview },
] as const;

/**
 * My PRs on a phone: the web filter chips become sections, the one that needs
 * you first. A PR sits in the first section it matches. Newest first inside each.
 */
export function mineSections(rows: PRRow[]): PrSection[] {
  const buckets = new Map<string, PRRow[]>([...MINE_SECTIONS.map(({ key }) => [key, []] as [string, PRRow[]]), ['other', []]]);
  for (const row of mineCohort(rows)) {
    const match = MINE_SECTIONS.find(({ test }) => test(row));
    buckets.get(match?.key ?? 'other')!.push(row);
  }
  return [...MINE_SECTIONS, { key: 'other', title: 'Open' }]
    .map(({ key, title }) => ({ key, title, rows: buckets.get(key)!.sort(compareByCreated) }))
    .filter((section) => section.rows.length > 0);
}

/**
 * Review requests in web's order: the server's priority verdicts when the
 * account has Priority, newest first otherwise. One clock for the whole sort.
 */
export function sortReviews(rows: PRRow[], options: { priority: boolean; now: number }): PRRow[] {
  if (!options.priority) return rows.slice().sort(compareByCreated);
  const verdicts = new Map<string, PRPriorityVerdict>();
  const unscored: PRRow[] = [];
  for (const row of rows) {
    if (row.priority) verdicts.set(row.id, row.priority); else unscored.push(row);
  }
  if (unscored.length) for (const [id, verdict] of buildPRPriorityMap(unscored, { now: options.now })) verdicts.set(id, verdict);
  return rows.slice().sort((a, b) => comparePRByPriority(a, b, verdicts));
}

/** How you were asked to review. Web `reviewRequestLabel`, with "you" for a direct request. */
export function reviewRequestLabel(summary: Pick<PRSummaryShape, 'reviewRequestVia'>): { label: string; extra: number; direct: boolean } | null {
  const via = summary.reviewRequestVia;
  if (!via) return null;
  if (via.direct) return { label: 'You', extra: 0, direct: true };
  if (via.teams.length) return { label: `@${via.teams[0]}`, extra: via.teams.length - 1, direct: false };
  return null;
}

// ---------------------------------------------------------------------------
// Merge queue. Ports web `queueGroups.ts` and the queue cell's labels.
// ---------------------------------------------------------------------------

export type QueueGroup = { key: string; owner: string; repo: string; base: string; rows: PRRow[] }
  & ({ kind: 'base' } | { kind: 'stack'; size: number; stalledAt: PRRow | null });

const queueBlocked = (row: PRRow) => row.mergeQueue?.status === 'blocked' || row.mergeQueue?.status === 'blocked_manual';

/**
 * Queued rows grouped where they land: one group per repository and base, and
 * one group per stack. Ordered by name, stacks first, so the list is stable.
 */
export function buildQueueGroups(rows: PRRow[]): QueueGroup[] {
  const { parentOf } = linkStack(rows.map((row) => ({ id: row.id, repositoryId: row.repositoryId, state: row.state,
    headBranch: row.summary.headBranch, baseBranch: row.summary.baseBranch })));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const walk = (row: PRRow) => {
    const seen = new Set([row.id]);
    let cursor = row; let depth = 0;
    for (;;) {
      const parent = byId.get(parentOf.get(cursor.id)?.id ?? '');
      if (!parent || seen.has(parent.id)) return { root: cursor, depth };
      seen.add(parent.id); cursor = parent; depth++;
    }
  };
  const buckets = new Map<string, { root: PRRow; rows: PRRow[] }>();
  for (const row of rows) {
    const { root } = walk(row);
    const key = `${row.repositoryId}|${root.summary.baseBranch ?? ''}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.rows.push(row); else buckets.set(key, { root, rows: [row] });
  }
  const groups: QueueGroup[] = [];
  for (const [key, { root, rows: members }] of buckets) {
    const base = root.summary.baseBranch ?? '';
    const stacked = members.some((row) => byId.has(parentOf.get(row.id)?.id ?? ''));
    if (stacked) {
      const ordered = members.slice().sort((a, b) => walk(a).depth - walk(b).depth);
      groups.push({ kind: 'stack', key, owner: root.owner, repo: root.repo, base, rows: ordered, size: ordered.length,
        stalledAt: ordered.find(queueBlocked) ?? null });
    } else {
      groups.push({ kind: 'base', key, owner: root.owner, repo: root.repo, base,
        rows: members.slice().sort((a, b) => (a.mergeQueue?.position ?? 0) - (b.mergeQueue?.position ?? 0)) });
    }
  }
  return groups.sort((a, b) => `${a.owner}/${a.repo}/${a.base}`.localeCompare(`${b.owner}/${b.repo}/${b.base}`)
    || (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind === 'stack' ? -1 : 1));
}

/** The status each queued row's parent holds, so a stacked row can say its stack is stuck. */
export function queueParentStatus(rows: PRRow[]): Map<string, MergeQueuePublic['status']> {
  const byNumber = new Map<string, MergeQueuePublic['status']>();
  for (const row of rows) if (row.mergeQueue) byNumber.set(`${row.repositoryId}|${row.number}`, row.mergeQueue.status);
  const out = new Map<string, MergeQueuePublic['status']>();
  for (const row of rows) {
    const parent = row.mergeQueue?.stackParentNumber;
    const status = parent != null ? byNumber.get(`${row.repositoryId}|${parent}`) : undefined;
    if (status) out.set(row.id, status);
  }
  return out;
}

export type QueueChipIcon = 'zap' | 'merge' | 'clock' | 'review' | 'stack' | 'session' | 'spinner' | 'person' | 'warning' | 'none';
export interface QueueChip { label: string; tone: StatusTone; icon: QueueChipIcon }

/** A queued row's status chip. Ports web `QueueCell`'s labels. */
export function queueChip(row: Pick<PRRow, 'mergeQueue' | 'summary'>, parentStatus?: MergeQueuePublic['status']): QueueChip {
  const entry = row.mergeQueue;
  if (!entry) return { label: 'Waiting', tone: 'muted', icon: 'none' };
  switch (entry.status) {
    case 'automerge_armed': return { label: 'Auto-merge armed', tone: 'success', icon: 'zap' };
    case 'awaiting_external': {
      const where = entry.external?.state ?? externalQueueStatusFromLabels(row.summary.labels)?.state ?? null;
      return { label: where ? `Queue: ${externalQueueStateLabel(where).toLowerCase()}` : 'Submitted to queue', tone: 'success', icon: 'merge' };
    }
    case 'awaiting_ci': return { label: 'Waiting for CI', tone: 'information', icon: 'clock' };
    case 'awaiting_review': return { label: 'Waiting for a required review', tone: 'muted', icon: 'review' };
    case 'awaiting_stack': {
      if (entry.stackCoveredBy != null) return { label: `Queued with #${entry.stackCoveredBy}`, tone: 'information', icon: 'stack' };
      const below = entry.stackParentNumber;
      if (parentStatus === 'blocked' || parentStatus === 'blocked_manual') {
        return { label: below ? `Blocked below #${below}` : 'Blocked below', tone: 'warning', icon: 'stack' };
      }
      return { label: below ? `Waiting for #${below}` : 'Waiting for its stack', tone: 'muted', icon: 'stack' };
    }
    case 'fixing': {
      const budgets = entry.budgets;
      if (entry.fixKind === 'session') {
        const [used, max] = budgets?.fixRuns ?? [0, 3];
        return { label: `${QUEUE_SESSION_BADGE_LABEL.fixing} (${Math.min(used + 1, max)}/${max})`, tone: 'muted', icon: 'session' };
      }
      const resign = entry.fixKind === 'resign';
      const [used, max] = resign ? budgets?.resigns ?? [0, 3] : budgets?.fixRuns ?? [0, 3];
      const attempt = resign ? Math.max(used, 1) : Math.min(used + 1, max);
      return { label: `${resign ? 'Re-signing' : 'Fixing'} (${attempt}/${max})`, tone: 'merged', icon: 'spinner' };
    }
    case 'merging': return { label: 'Merging', tone: 'information', icon: 'spinner' };
    case 'blocked':
      if (queueSessionBadge(entry) === 'working') return { label: QUEUE_SESSION_BADGE_LABEL.working, tone: 'muted', icon: 'session' };
      if (queueBlockNeedsHuman(entry.blockedCode)) return { label: 'Needs you', tone: 'warning', icon: 'person' };
      return { label: 'Blocked', tone: 'warning', icon: 'warning' };
    case 'blocked_manual': return { label: 'Needs you', tone: 'destructive', icon: 'warning' };
    default: return { label: 'Waiting', tone: 'muted', icon: 'none' };
  }
}

/** The reason under a blocked queue row, or the web tooltip's fallback. Null when the entry is not blocked. */
export function queueBlockedReason(entry: MergeQueuePublic | null | undefined): string | null {
  if (!entry || (entry.status !== 'blocked' && entry.status !== 'blocked_manual')) return null;
  if (queueSessionBadge(entry)) return null;
  if (entry.status === 'blocked_manual') return entry.reason || 'GitHub refuses the app merge. Merge it yourself or requeue it.';
  if (queueBlockNeedsHuman(entry.blockedCode)) return `${entry.reason || 'The merge queue is waiting on you.'} It picks this PR back up on its own once that clears.`;
  return `${entry.reason || 'Blocked. It retries automatically.'} It clears on a new push. Requeue to retry now.`;
}

/** The queue status sentence on PR detail. Ports the web detail sheet's `statusLabel`. */
export function queueStatusLine(entry: MergeQueuePublic | null | undefined, sessionName?: string | null): string {
  if (!entry) return 'Waiting';
  const badge = queueSessionBadge(entry);
  const blocked = entry.status === 'blocked' || entry.status === 'blocked_manual';
  let label: string;
  if (badge) label = queueSessionBadgeTooltip(badge, entry.reason, sessionName);
  else if (entry.status === 'awaiting_stack' && entry.stackCoveredBy != null) {
    label = `In the merge queue as part of #${entry.stackCoveredBy}'s stack. They are tested together and land in one go.`;
  } else if (entry.status === 'awaiting_stack' && entry.stackParentNumber != null) {
    label = `Waiting for #${entry.stackParentNumber} to merge. This PR is stacked on it.`;
  } else if (entry.status === 'awaiting_review' && entry.stackParentNumber != null) {
    label = `Waiting for a required review. This PR was retargeted after #${entry.stackParentNumber} merged, which may have dismissed an earlier approval.`;
  } else if (blocked && queueBlockNeedsHuman(entry.blockedCode)) label = 'Waiting on you. The queue carries on by itself once this clears.';
  else label = queueLabel(entry.status);
  const position = entry.position ? `#${entry.position} · ` : '';
  const armed = entry.autoMerge?.armed && entry.status !== 'automerge_armed' ? ' · auto-merge armed' : '';
  return `${position}${label}${armed}`;
}

/** "Fix runs 1/3 · Check re-runs 0/2 · Re-signs 0/3", or null without budgets. */
export function queueBudgetsLine(entry: MergeQueuePublic | null | undefined): string | null {
  const budgets = entry?.budgets;
  if (!budgets) return null;
  return `Fix runs ${budgets.fixRuns[0]}/${budgets.fixRuns[1]} · Check re-runs ${budgets.checkReruns[0]}/${budgets.checkReruns[1]} · Re-signs ${budgets.resigns[0]}/${budgets.resigns[1]}`;
}
