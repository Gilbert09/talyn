import type { PRCheckContext, PRFreshDetail, PRRow, PRSummaryShape } from '@talyn/client/native';
import { fixBlockedMessage, queueBlockNeedsHuman, queueSessionBadge, queueSessionBadgeTooltip } from '@talyn/shared';

import { relativeTimeLabel } from '../../lib/time';
import { canMerge, failingChecks, mergeLine, type PrActionSet } from './actions';
import { queueStatusLabel } from './lists';

export type NextStepTone = 'danger' | 'warning' | 'success' | 'information' | 'neutral';
export type NextStepIcon = 'merged' | 'closed' | 'agent' | 'queue' | 'stopped' | 'draft' | 'conflict' | 'person' | 'failed'
  | 'changes' | 'behind' | 'running' | 'review' | 'ready' | 'info';
export type NextStepKey = 'merged' | 'closed' | 'agent' | 'queued' | 'queue_stopped' | 'draft' | 'conflicts' | 'needs_human'
  | 'checks_failing' | 'changes_requested' | 'behind' | 'checks_running' | 'awaiting_review' | 'ready' | 'branch_rule'
  | 'waiting' | 'review_requested' | 'other';
export type PrimaryKind = 'merge' | 'fix' | 'queue' | 'resubmit' | 'requeue' | 'session' | 'review' | 'findings' | 'open'
  | 'approve' | 'request_changes';

export interface NextStepPrimary {
  kind: PrimaryKind;
  label: string;
  /** Set when the action cannot run. The bar shows it instead of a dead button. */
  disabledReason?: string;
}

export interface NextStep {
  key: NextStepKey;
  verdict: string;
  detail: string | null;
  tone: NextStepTone;
  icon: NextStepIcon;
  /** Null when nothing is needed from the person. */
  primary: NextStepPrimary | null;
  /** A second action drawn beside the primary one. Null for most states. */
  secondary: NextStepPrimary | null;
  session: { id: string; name: string } | null;
  /** Up to three failing check names, for the card. */
  failing: string[];
}

export interface NextStepInput {
  row: PRRow;
  /** The live summary when it has landed, else the cached one. */
  summary: PRSummaryShape;
  actions: PrActionSet;
  checkContexts?: PRCheckContext[];
  recentReviews?: PRFreshDetail['recentReviews'];
  /** The PR's linked cloud run has not finished. */
  taskRunning?: boolean;
  codeReview?: 'none' | 'running' | 'ready';
  now: number;
}

const OPEN: NextStepPrimary = { kind: 'open', label: 'Open on GitHub' };
const QUEUE: NextStepPrimary = { kind: 'queue', label: 'Add to merge queue' };
const APPROVE: NextStepPrimary = { kind: 'approve', label: 'Approve' };
const REQUEST_CHANGES: NextStepPrimary = { kind: 'request_changes', label: 'Request changes' };

/** Who last asked for changes, from the live reviews. */
function changesRequestedBy(reviews: PRFreshDetail['recentReviews'] | undefined): string | null {
  const asks = (reviews ?? []).filter((review) => review.state === 'CHANGES_REQUESTED')
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return asks[0]?.author || null;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const sentence = (text: string) => text.replace(/\.$/, '');

/**
 * The PR page's verdict and its one primary action. The first matching state
 * wins, so a PR an agent is fixing never also offers Fix.
 */
export function prNextStep(input: NextStepInput): NextStep {
  const { row, summary, actions } = input;
  const base = summary.baseBranch || 'the base branch';
  const session = row.session ? { id: row.session.id, name: row.session.name } : null;
  const step = (key: NextStepKey, verdict: string, detail: string | null, tone: NextStepTone, icon: NextStepIcon,
    primary: NextStepPrimary | null, failing: string[] = [], secondary: NextStepPrimary | null = null): NextStep =>
    ({ key, verdict, detail, tone, icon, primary, secondary, session, failing });
  const fix = (label: string): NextStepPrimary => !actions.fix ? OPEN
    : actions.fixBlocked ? { kind: 'fix', label, disabledReason: fixBlockedMessage(actions.fixBlocked) } : { kind: 'fix', label };
  const queueOr = (fallback: NextStepPrimary) => actions.queue ? QUEUE : fallback;

  if (row.state === 'merged') {
    const when = relativeTimeLabel(row.mergedAt ?? summary.updatedAt, input.now);
    return step('merged', when ? `Merged ${when}` : 'Merged', null, 'neutral', 'merged', OPEN);
  }
  if (row.state === 'closed') return step('closed', 'Closed without merging', null, 'neutral', 'closed', OPEN);

  const entry = row.mergeQueue;
  const queued = row.mergeQueued || Boolean(entry);
  const badge = queueSessionBadge(entry);
  const queueFixing = entry?.status === 'fixing';
  if (badge || queueFixing || input.taskRunning) {
    const detail = badge ? queueSessionBadgeTooltip(badge, entry?.reason, session?.name)
      : queueFixing ? entry?.fixKind === 'resign' ? 'The merge queue is re-signing its commits.' : 'The merge queue started a cloud run to fix it.'
        : 'A cloud run is working on it.';
    return step('agent', 'An agent is fixing this', detail, 'information', 'agent', session ? { kind: 'session', label: 'View session' } : null);
  }

  const blocked = entry?.status === 'blocked' || entry?.status === 'blocked_manual';
  if (queued && !blocked) {
    return step('queued', entry?.position ? `In the merge queue, #${entry.position}` : 'In the merge queue',
      queueStatusLabel(entry, session?.name), 'information', 'queue', null);
  }
  if (queued && entry && blocked) {
    const needsHuman = queueBlockNeedsHuman(entry.blockedCode);
    const detail = entry.reason || (needsHuman ? 'Waiting on you. The queue carries on by itself once this clears.'
      : entry.status === 'blocked_manual' ? 'GitHub refuses the app merge. Merge it yourself or requeue it.' : 'It retries on the next push.');
    let primary: NextStepPrimary;
    if (actions.resubmit) primary = { kind: 'resubmit', label: 'Re-submit to Trunk' };
    else if (needsHuman) primary = entry.blockedCode === 'code_review_blocker' && input.codeReview && input.codeReview !== 'none'
      ? { kind: 'findings', label: 'View findings' } : OPEN;
    else if (actions.fix && !actions.fixBlocked) primary = { kind: 'fix', label: 'Fix with agent' };
    else if (actions.requeue) primary = { kind: 'requeue', label: 'Requeue' };
    else primary = OPEN;
    return step('queue_stopped', 'Merge queue stopped', detail, needsHuman ? 'warning' : 'danger', 'stopped', primary);
  }

  if (summary.draft) return step('draft', 'Draft', 'Mark it ready for review on GitHub before it can merge.', 'neutral', 'draft', OPEN);

  const reason = summary.blockingReason;
  const decision = summary.effectiveReviewDecision ?? summary.reviewDecision;
  if (actions.owner) {
    if (reason === 'merge_conflicts' || summary.mergeable === 'CONFLICTING') {
      return step('conflicts', `Merge conflicts with ${base}`, 'Resolve them before it can merge.', 'danger', 'conflict', fix('Resolve with agent'));
    }
    if (reason === 'needs_human') {
      const gates = (summary.humanGates ?? []).map((gate) => gate.label || gate.name);
      return step('needs_human', 'A person must approve a check', gates.length ? `${[...new Set(gates)].join(', ')}. No agent can clear it.`
        : 'No agent can clear it.', 'warning', 'person', OPEN);
    }
    // Every failing check, the number the Checks tab badge and list show; the detail says how many block the merge.
    const failing = failingChecks(input.checkContexts);
    const required = failing.filter((check) => check.required !== false);
    const failingCount = failing.length || summary.checks?.failed || 0;
    if ((reason === 'checks_failed' || summary.ciStatus === 'failing_required') && failingCount > 0) {
      const optional = failing.length - required.length;
      const detail = failing.length && optional > 0
        ? `${plural(required.length, 'is', 'are')} required and must pass before it can merge.`
        : 'Required checks must pass before it can merge.';
      return step('checks_failing', `${plural(failingCount, 'check is', 'checks are')} failing`, detail,
        'danger', 'failed', fix('Fix with agent'), [...required, ...failing.filter((check) => check.required === false)].slice(0, 3).map((check) => check.name));
    }
    if (reason === 'changes_requested' || decision === 'CHANGES_REQUESTED') {
      const who = changesRequestedBy(input.recentReviews);
      const threads = summary.unresolvedReviewThreads ?? 0;
      return step('changes_requested', who ? `Changes requested by ${who}` : 'Changes requested',
        threads > 0 ? `${plural(threads, 'comment is', 'comments are')} not resolved.` : 'Address the review before it can merge.',
        'warning', 'changes', fix('Address review with agent'));
    }
    if (reason === 'behind') {
      return step('behind', `Behind ${base}`, 'Update the branch on GitHub before it can merge.', 'warning', 'behind', OPEN);
    }
    const checks = summary.checks;
    // Failing checks that do not block the merge. The Checks tab counts them, so the card says what they mean.
    const optionalFailing = failing.filter((check) => check.required === false).length;
    const optionalNote = optionalFailing > 0
      ? ` ${plural(optionalFailing, 'optional check fails', 'optional checks fail')}, which does not block the merge.` : '';
    if (checks && checks.inProgress > 0) {
      return step('checks_running', `Checks are running (${checks.total - checks.inProgress} of ${checks.total} done)`,
        `Add it to the merge queue and it merges when ready.${optionalNote}`, 'neutral', 'running', queueOr(OPEN));
    }
    if (decision === 'REVIEW_REQUIRED' || (reason === 'blocked' && decision !== 'APPROVED')) {
      return step('awaiting_review', 'Waiting for review', `A required review is missing.${optionalNote}`, 'neutral', 'review', queueOr(OPEN));
    }
    if (canMerge({ state: row.state, summary })) {
      return step('ready', 'Ready to merge', reason === 'checks_failed_optional' ? `Merges into ${base}. Some optional checks fail.` : `Merges into ${base}.`,
        'success', 'ready', actions.merge ? { kind: 'merge', label: 'Merge' } : queueOr(OPEN));
    }
    if (reason === 'blocked') return step('branch_rule', 'Blocked by a branch rule', mergeLine(row, summary), 'warning', 'stopped', queueOr(OPEN));
    return step('waiting', 'Waiting for GitHub', mergeLine(row, summary), 'neutral', 'info', queueOr(OPEN));
  }

  // "Review with Talyn" is in the menu and on the Findings tab for this state.
  if (row.reviewRequested && !row.authored) {
    return step('review_requested', 'Your review is requested', mergeLine(row, summary), 'information', 'review',
      APPROVE, [], REQUEST_CHANGES);
  }
  return step('other', sentence(mergeLine(row, summary)), null, 'neutral', 'info', OPEN);
}
