import type { CodeReviewPublic, PRRow } from '@talyn/client/native';
import { codeCompleteBlockers, codeReviewProgress, isSessionCodeComplete, sessionReviewCardShown, sessionReviewState,
  type CodeCompleteInput, type SessionReviewState, type Workbench } from '@talyn/shared';

import type { Tone } from '../../components/UI';
import { openFindingCounts, sessionReportLine } from '../prs/codeReview';
import { isArchived } from './actions';

/** What the session screen knows about a session, for the code-complete rule. */
export interface CodeCompleteFacts {
  item: Workbench;
  row: PRRow | null;
  /** Background jobs that run now. Null: not known yet. */
  runningJobs: number | null;
}

/** The facts in the shape of the shared rule. Mobile has no session script state, so scripts read as 0. */
export function codeCompleteInput({ item, row, runningJobs }: CodeCompleteFacts): CodeCompleteInput {
  return {
    kind: item.kind ?? 'session',
    archived: isArchived(item),
    chats: item.chats ?? [],
    pullRequestState: item.pullRequestId ? row?.state ?? item.pr?.state ?? null : null,
    runningBackgroundJobs: runningJobs ?? 0,
    runningScripts: 0,
    uncommittedFiles: item.uncommittedStats?.files ?? null,
    unpushedCommits: item.unpushedCommits ?? null,
  };
}

export const sessionCodeComplete = (facts: CodeCompleteFacts) => isSessionCodeComplete(codeCompleteInput(facts));

export interface ReviewCardView {
  state: SessionReviewState;
  title: string;
  /** The explanation, the progress or the failure reason. */
  text: string | null;
  /** Done: the open findings by severity ("Must fix 1 · Should fix 2"), or "No open findings". */
  findings: string | null;
  /** Running: how far the review got, 0 to 1. Null when not known. */
  progress: number | null;
  /** "Talyn sent 2 findings to this session." */
  sent: string | null;
  /** The label of the button that starts a review, or null for none. */
  start: string | null;
  viewFindings: boolean;
  tone: Tone;
}

/**
 * The card at the end of the chat, or null. "Ready for review" needs the
 * session code complete; a review that runs, waits, failed or finished shows
 * also before that (see `sessionReviewCardShown`), without a start button.
 */
export function reviewCard(facts: CodeCompleteFacts): ReviewCardView | null {
  const blockers = codeCompleteBlockers(codeCompleteInput(facts));
  const review = facts.row?.codeReview ?? null;
  const state = sessionReviewState(review);
  if (!sessionReviewCardShown(blockers, state)) return null;
  const card = reviewCardFor(facts, review, state);
  // Before the work is pushed, a new review would read an old head.
  return blockers.length === 0 ? card : { ...card, start: null };
}

function reviewCardFor(facts: CodeCompleteFacts, review: CodeReviewPublic | null, state: SessionReviewState): ReviewCardView {
  const sent = review ? sessionReportLine(review, facts.item.id) : null;
  const base = { state, text: null, findings: null, progress: null, sent, start: null, viewFindings: false };
  switch (state) {
    case 'none':
      return { ...base, sent: null, title: 'Ready for review', text: 'The work is pushed and the pull request is open.',
        start: 'Run code review', tone: 'primary' };
    case 'running': {
      const progress = codeReviewProgress(review!);
      return { ...base, title: 'Code review running', text: progress.label, progress: progress.fraction, tone: 'information' };
    }
    case 'waiting':
      return { ...base, title: 'Code review is waiting for a runner', text: 'The review starts when a runner is free.', tone: 'warning' };
    case 'failed':
      return { ...base, title: 'The code review did not finish.', text: review!.failureReason, start: 'Run again', viewFindings: true,
        tone: 'destructive' };
    case 'done': {
      const counts = openFindingCounts(review!);
      // The session handled every finding and pushed: offer a review of the fixes.
      const handled = review!.staleForHead && !counts.length;
      return { ...base, title: 'Code review done',
        findings: counts.length ? counts.join(' · ') : handled ? 'No open findings. The session fixed or dismissed each finding.' : 'No open findings',
        start: handled ? 'Review again' : null, viewFindings: true, tone: counts.length ? 'warning' : 'success' };
    }
  }
}

export type ReviewBadgeIcon = 'spinner' | 'clock' | 'findings' | 'check' | 'failed' | 'review';

export interface ReviewBadgeView {
  state: SessionReviewState;
  label: string;
  /** What a narrow header shows next to the icon. Null: the icon only. */
  short: string | null;
  icon: ReviewBadgeIcon;
  tone: Tone;
  accessibilityLabel: string;
}

const findingsLabel = (count: number) => `${count} ${count === 1 ? 'finding' : 'findings'}`;

/**
 * The header's review badge: the review's status, or "Ready for review" when
 * the session is code complete with no current review. Null otherwise.
 */
export function reviewBadge(facts: CodeCompleteFacts): ReviewBadgeView | null {
  if ((facts.item.kind ?? 'session') !== 'session' || !facts.row) return null;
  const review: CodeReviewPublic | null = facts.row.codeReview ?? null;
  const state = sessionReviewState(review);
  const badge = (label: string, short: string | null, icon: ReviewBadgeIcon, tone: Tone): ReviewBadgeView =>
    ({ state, label, short, icon, tone, accessibilityLabel: `Code review: ${label}. Show the findings.` });
  switch (state) {
    case 'none':
      return sessionCodeComplete(facts) ? { ...badge('Ready for review', 'Review', 'review', 'primary'),
        accessibilityLabel: 'Ready for review. Open the code review.' } : null;
    case 'running': return badge('Reviewing', null, 'spinner', 'information');
    case 'waiting': return badge('Waiting for a runner', null, 'clock', 'warning');
    case 'failed': return badge('Review failed', null, 'failed', 'destructive');
    case 'done': {
      const open = review!.openCount;
      return open > 0 ? badge(findingsLabel(open), String(open), 'findings', review!.counts.blocker > 0 ? 'destructive' : 'warning')
        : badge(review!.staleForHead ? 'No open findings' : 'No findings', null, 'check', 'success');
    }
  }
}
