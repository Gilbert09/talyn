import {
  externalQueueStatusFromLabels,
  nextWorkbenchAction,
  prSummaryToNextActionPr,
  type ExternalQueueState,
  type Workbench,
  type WorkbenchChat,
} from '@talyn/shared';
import type { PRBlockingReason, PRChecks, PRCiStatus, PRReviewDecision, PRRow, PRState } from '@talyn/client/native';

/** Semantic colours a status mark can use. They map onto theme tokens. */
export type StatusTone = 'success' | 'warning' | 'destructive' | 'information' | 'muted' | 'merged';

// ---------------------------------------------------------------------------
// Session state. Ports web `lib/sessionState.ts` without unread and background
// job input, which mobile does not hold yet.
// ---------------------------------------------------------------------------

export type SessionStateKind = 'failed' | 'starting' | 'working' | 'needs_reply' | 'background_job' | 'pr_opened' | 'pr_attention'
  | 'ready_to_merge' | 'pr_waiting' | 'draft' | 'merged' | 'closed' | 'unshipped' | 'wakeup' | 'idle';
export interface SessionState { kind: SessionStateKind; label: string }

export interface SessionPr {
  number: number;
  state: PRState;
  summary: { mergeable?: string | null; ciStatus?: PRCiStatus | null; draft?: boolean };
}

/** The PR a session shows: the full row when it is known, else the summary the workbench carries. */
export function sessionPr(workbench: Pick<Workbench, 'pr'>, row?: PRRow | null): SessionPr | null {
  if (row) return row;
  const pr = workbench.pr;
  if (!pr) return null;
  return {
    number: pr.number,
    state: pr.state,
    summary: {
      mergeable: pr.mergeable === 'conflicting' ? 'CONFLICTING' : pr.mergeable === 'mergeable' ? 'MERGEABLE' : 'UNKNOWN',
      ciStatus: pr.ciStatus === 'success' ? 'passing' : pr.ciStatus === 'failure' ? 'failing_required' : pr.ciStatus === 'pending' ? 'running' : 'none',
    },
  };
}

type StateWorkbench = Pick<Workbench, 'status' | 'sandboxState' | 'diffStat' | 'archivedAt'> & Partial<Pick<Workbench, 'committedStats' | 'kind'>>;
type StateChat = Pick<WorkbenchChat, 'id' | 'status'> & { queuedMessages?: WorkbenchChat['queuedMessages'] };

export function sessionState(workbench: StateWorkbench, chats: StateChat[], pr: SessionPr | null): SessionState {
  if (workbench.status === 'error' || workbench.sandboxState === 'error') return { kind: 'failed', label: 'Failed to start' };
  if (chats.some((chat) => chat.status === 'error')) return { kind: 'failed', label: 'A chat failed' };
  if (workbench.status === 'provisioning' || workbench.sandboxState === 'creating') return { kind: 'starting', label: 'Starting' };
  if (chats.some((chat) => chat.status === 'running')) return { kind: 'working', label: 'Working' };
  if (chats.some((chat) => (chat.queuedMessages?.length ?? 0) > 0)) return { kind: 'working', label: 'A message waits for the sandbox' };
  if (chats.some((chat) => chat.status === 'awaiting_input')) return { kind: 'needs_reply', label: 'Waiting for your answer' };
  if (pr && !workbench.archivedAt && workbench.kind !== 'thread') {
    if (pr.state === 'merged') return { kind: 'merged', label: `Done: #${pr.number} merged` };
    if (pr.state === 'closed') return { kind: 'closed', label: `#${pr.number} closed` };
    if (pr.summary.draft) return { kind: 'draft', label: `Draft PR #${pr.number}` };
    const next = nextWorkbenchAction({
      hasChanges: true,
      pr: prSummaryToNextActionPr({ state: pr.state, mergeable: pr.summary.mergeable ?? undefined, ciStatus: pr.summary.ciStatus ?? undefined }),
    });
    if (next === 'resolve_conflicts') return { kind: 'pr_attention', label: `#${pr.number} has conflicts` };
    if (next === 'fix_checks') return { kind: 'pr_waiting', label: `#${pr.number} open, checks are failing` };
    if (next === 'merge') return { kind: 'ready_to_merge', label: `#${pr.number} is ready to merge` };
    return { kind: 'pr_waiting', label: `#${pr.number} open, waiting on checks or review` };
  }
  if ((workbench.diffStat?.files ?? 0) > 0 || (workbench.committedStats?.files ?? 0) > 0) {
    return { kind: 'unshipped', label: 'Changes with no pull request yet' };
  }
  return { kind: 'idle', label: 'Idle' };
}

export function workbenchState(item: Workbench, row?: PRRow | null): SessionState {
  return sessionState(item, item.chats ?? [], sessionPr(item, row));
}

// ---------------------------------------------------------------------------
// PR status pill. Ports web `PRStatusPill` with `hideReviewState`, which is how
// the PR list draws it: review has its own pill.
// ---------------------------------------------------------------------------

export type PrIcon = 'check' | 'warning' | 'failed' | 'spinner' | 'merged' | 'closed' | 'review' | 'unknown' | 'protected' | 'clock' | 'behind' | 'person';
export interface PrPillVariant { icon: PrIcon; label: string; tone: StatusTone }

export interface PrStatusInput {
  state?: PRState;
  blockingReason?: PRBlockingReason | null;
  checks?: PRChecks | null;
  mergeStateStatus?: string | null;
  ciStatus?: PRCiStatus | null;
  reviewDecision?: PRReviewDecision;
  labels?: string[];
  externalQueueState?: ExternalQueueState;
  /** Draw review verdicts too. Off for list rows, where review has its own pill. */
  includeReview?: boolean;
}

const EMPTY_CHECKS: PRChecks = { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 };
const NEEDS_HUMAN: PrPillVariant = { icon: 'person', label: 'Needs human', tone: 'warning' };
const CI_DESCRIBED = new Set<PRBlockingReason>(['mergeable', 'checks_failed', 'checks_failed_optional', 'changes_requested', 'blocked']);

function running(checks: PRChecks): PrPillVariant {
  return { icon: 'spinner', label: `${checks.inProgress}/${checks.total} running`, tone: 'information' };
}

function pick(reason: PRBlockingReason, checks: PRChecks, hideReview = false, mergeState?: string | null, review?: PRReviewDecision, ci?: PRCiStatus | null): PrPillVariant {
  if (reason === 'needs_human') return NEEDS_HUMAN;
  if (hideReview && ci && CI_DESCRIBED.has(reason)) {
    switch (ci) {
      case 'failing_required': return pick('checks_failed', checks);
      case 'failing_optional': return pick('checks_failed_optional', checks);
      case 'needs_human': return NEEDS_HUMAN;
      case 'running': return pick(checks.failed > 0 ? 'checks_failed_optional' : 'mergeable', checks);
      default: return pick('mergeable', checks);
    }
  }
  if (hideReview && (reason === 'changes_requested' || reason === 'blocked')) {
    const ciReason: PRBlockingReason = checks.failed === 0 ? 'mergeable' : reason === 'blocked' ? 'checks_failed'
      : mergeState?.toUpperCase() === 'UNSTABLE' ? 'checks_failed_optional' : 'checks_failed';
    return pick(ciReason, checks);
  }
  switch (reason) {
    case 'merge_conflicts': return { icon: 'warning', label: 'Conflicts', tone: 'destructive' };
    case 'changes_requested': return { icon: 'warning', label: 'Changes requested', tone: 'warning' };
    case 'checks_failed':
      if (checks.failed === 0) return pick('mergeable', checks);
      return { icon: 'failed', label: `${checks.failed}/${checks.total} failing`, tone: 'destructive' };
    case 'checks_failed_optional':
      if (checks.inProgress > 0) return running(checks);
      return { icon: 'check', label: `${checks.failed} non-required`, tone: 'success' };
    case 'mergeable':
      if (checks.failed > 0) return pick(mergeState?.toUpperCase() === 'UNSTABLE' ? 'checks_failed_optional' : 'checks_failed', checks, hideReview, mergeState);
      if (checks.inProgress > 0) return running(checks);
      return { icon: 'check', label: 'Ready', tone: 'success' };
    case 'blocked':
      if (checks.inProgress > 0) return running(checks);
      if (review === 'APPROVED') return { icon: 'protected', label: 'Protected', tone: 'warning' };
      return { icon: 'review', label: 'Review', tone: 'warning' };
    case 'behind': return { icon: 'behind', label: 'Behind', tone: 'warning' };
    default: return { icon: 'unknown', label: 'Unknown', tone: 'muted' };
  }
}

function externalVariant(input: PrStatusInput, checks: PRChecks): PrPillVariant | null {
  const state = input.externalQueueState ?? externalQueueStatusFromLabels(input.labels)?.state;
  if (!state || state === 'not_submitted') return null;
  switch (state) {
    case 'rejected': return { icon: 'closed', label: 'Queue: refused', tone: 'destructive' };
    case 'failed': return { icon: 'closed', label: 'Queue: failed', tone: 'destructive' };
    case 'pending_failure': return { icon: 'clock', label: 'Queue: failure pending', tone: 'warning' };
    case 'cancelled': return { icon: 'warning', label: 'Queue: cancelled', tone: 'warning' };
    case 'merged': return { icon: 'merged', label: 'Merged', tone: 'merged' };
    case 'passed': return { icon: 'check', label: 'Queue: passed', tone: 'success' };
    case 'not_ready': {
      const reason = input.blockingReason;
      const prSaysWhy = checks.inProgress > 0 || checks.failed > 0 || reason === 'merge_conflicts' || reason === 'changes_requested' || reason === 'needs_human';
      return prSaysWhy ? null : { icon: 'clock', label: 'Queue: not ready', tone: 'warning' };
    }
    case 'testing': return { icon: 'spinner', label: 'Queue: testing', tone: 'information' };
    default: return { icon: 'clock', label: 'Queue: queued', tone: 'information' };
  }
}

/** One compact status for a PR: conflicts, CI, mergeability, queue and terminal state in one answer. */
export function prStatus(input: PrStatusInput): PrPillVariant {
  if (input.state === 'merged') return { icon: 'merged', label: 'Merged', tone: 'merged' };
  if (input.state === 'closed') return { icon: 'closed', label: 'Closed', tone: 'muted' };
  const checks = input.checks ?? EMPTY_CHECKS;
  const external = input.state === 'open' ? externalVariant(input, checks) : null;
  if (external) return external;
  return pick(input.blockingReason ?? 'unknown', checks, !input.includeReview, input.mergeStateStatus, input.reviewDecision, input.ciStatus);
}

export function prRowStatus(row: Pick<PRRow, 'state' | 'summary' | 'mergeQueue'>, includeReview = false): PrPillVariant {
  const summary = row.summary;
  return prStatus({
    state: row.state, blockingReason: summary.blockingReason, checks: summary.checks, mergeStateStatus: summary.mergeStateStatus,
    ciStatus: summary.ciStatus, reviewDecision: summary.effectiveReviewDecision ?? summary.reviewDecision,
    labels: summary.labels, externalQueueState: row.mergeQueue?.external?.state as ExternalQueueState | undefined,
    includeReview,
  });
}

// ---------------------------------------------------------------------------
// Review pill and PR number. Ports web `PRReviewPill` and `PrPill`.
// ---------------------------------------------------------------------------

/** The review verdict, or null when there is nothing a person can act on. */
export function prReview(decision: PRReviewDecision | undefined, state?: PRState): PrPillVariant | null {
  if (state === 'merged' || state === 'closed') return null;
  if (decision === 'APPROVED') return { icon: 'check', label: 'Approved', tone: 'success' };
  if (decision === 'CHANGES_REQUESTED') return { icon: 'warning', label: 'Changes requested', tone: 'warning' };
  if (decision === 'REVIEW_REQUIRED') return { icon: 'review', label: 'Needs approval', tone: 'warning' };
  return null;
}

export function prNumberTone(state: PRState | string, draft?: boolean): StatusTone {
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'destructive';
  if (draft) return 'muted';
  return 'success';
}
