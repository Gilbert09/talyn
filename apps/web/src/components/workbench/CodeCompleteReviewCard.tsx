import React, { useLayoutEffect } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, ScanSearch } from 'lucide-react';
import { sessionReviewState, type SessionReviewState, type Workbench } from '@talyn/shared';
import type { PRRow } from '../../lib/api';
import { cn } from '../../lib/utils';
import { isThread } from '../../lib/threads';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkbenchStore } from '../../stores/workbenches';
import { Button } from '../ui/button';
import { CodeReviewRowChip } from '../widgets/codeReview/CodeReviewRowChip';
import { CodeReviewSeverityCounts } from '../widgets/codeReview/CodeReviewSeverityCounts';
import { sessionReportText } from '../widgets/codeReview/sessionReportText';
import { useStartCodeReview } from './useStartCodeReview';
import { useSessionCodeComplete } from './workbenchSelectors';

const CARD_ATTR = 'code-complete-review-card';

/** The session's PR row from the open-PR store. A closed or merged PR is never code complete. */
function useStorePr(workbench: Workbench): PRRow | null {
  const id = workbench.pullRequestId;
  return usePullRequestStore((s) => (id ? (s.rows.find((r) => r.id === id) ?? null) : null));
}

const TITLES: Record<SessionReviewState, string> = {
  none: 'Ready for review',
  waiting: 'Code review is waiting for a runner',
  running: 'Code review running',
  failed: 'Code review failed',
  done: 'Code review done',
};

/**
 * At the end of the chat, while the session is code complete: the pull
 * request is ready for a code review. Offers to run one, then shows its
 * progress and its open findings. Draws nothing in other conditions.
 */
export function CodeCompleteReviewCard({
  workbench,
  onLayout,
}: {
  workbench: Workbench;
  /** Called after the card appears or changes, so the transcript can stay at the bottom. */
  onLayout?: () => void;
}) {
  const pr = useStorePr(workbench);
  const complete = useSessionCodeComplete(workbench, pr);
  const openPrDetail = useWorkbenchStore((s) => s.openPrDetail);
  const { busy, start } = useStartCodeReview(pr);
  const review = pr?.codeReview ?? null;
  const shown = complete && pr !== null;
  const state = sessionReviewState(review);

  useLayoutEffect(() => {
    if (shown) onLayout?.();
  }, [shown, state, onLayout]);

  if (!shown || !pr) return null;

  const viewFindings = () => openPrDetail(pr.id, 'findings');
  const highlight = state === 'none' || (state === 'done' && (review?.openCount ?? 0) > 0);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border',
        state === 'failed'
          ? 'border-red-500/40 bg-red-500/[0.03]'
          : highlight
            ? 'border-violet-500/50 bg-violet-500/[0.04]'
            : 'border-border bg-muted/30',
      )}
      data-testid={CARD_ATTR}
      data-attr={CARD_ATTR}
      data-state={state}
      data-workbench-id={workbench.id}
    >
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        <StateIcon state={state} />
        <span>{TITLES[state]}</span>
        <span className="ml-auto font-mono">#{pr.number}</span>
      </div>
      <div className="space-y-1.5 px-3 py-2 text-[12px] text-muted-foreground">
        {state === 'none' && <p>The work is pushed and the pull request is open.</p>}
        {state === 'waiting' && <p>The review starts when a runner is free.</p>}
        {state === 'running' && review && (
          <div className="flex items-center gap-1.5">
            <CodeReviewRowChip review={review} onOpen={viewFindings} />
          </div>
        )}
        {state === 'failed' && (
          <>
            <p>The code review did not finish.</p>
            {review?.failureReason && (
              <p className="text-[11px] [overflow-wrap:anywhere]" data-testid="code-complete-review-reason">
                {review.failureReason}
              </p>
            )}
          </>
        )}
        {state === 'done' &&
          review &&
          (review.openCount > 0 ? (
            <CodeReviewSeverityCounts counts={review.counts} openCount={review.openCount} />
          ) : (
            <p>No open findings</p>
          ))}
        {review?.sessionReport && (
          <p className="text-[11px]" data-testid="code-complete-review-sent">
            {sessionReportText(review.sessionReport, workbench.id)}
          </p>
        )}
      </div>
      {(state === 'none' || state === 'failed' || state === 'done') && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
          {(state === 'none' || state === 'failed') && (
            <Button size="sm" onClick={() => void start()} disabled={busy} data-attr="code-complete-review-run">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
              {state === 'failed' ? 'Run again' : 'Run code review'}
            </Button>
          )}
          {(state === 'failed' || state === 'done') && (
            <Button size="sm" variant="outline" onClick={viewFindings} data-attr="code-complete-review-findings">
              View findings
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function StateIcon({ state }: { state: SessionReviewState }) {
  if (state === 'running') return <Loader2 className="h-3 w-3 animate-spin text-violet-600 dark:text-violet-400" />;
  if (state === 'waiting') return <Clock className="h-3 w-3 text-amber-600 dark:text-amber-400" />;
  if (state === 'failed') return <AlertTriangle className="h-3 w-3 text-red-600 dark:text-red-400" />;
  if (state === 'done') return <CheckCircle2 className="h-3 w-3 text-success" />;
  return <ScanSearch className="h-3 w-3 text-violet-600 dark:text-violet-400" />;
}

const BADGE_BASE =
  'app-region-no-drag inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide';

/**
 * The code review in a session header. The PR-row chip for a running, failed
 * or findings review. It adds "No findings" for a clean review of the head, and
 * "Ready for review" while the session is code complete with no review of the
 * head: that one scrolls to the card at the end of the chat.
 */
export function WorkbenchCodeReviewBadge({ workbench, pr }: { workbench: Workbench; pr: PRRow | null }) {
  const complete = useSessionCodeComplete(workbench, pr);
  const openPrDetail = useWorkbenchStore((s) => s.openPrDetail);
  if (!pr || isThread(workbench)) return null;
  const review = pr.codeReview ?? null;
  const state = sessionReviewState(review);
  const openFindings = () => openPrDetail(pr.id, 'findings');

  let badge: React.ReactNode = null;
  if (review && (state === 'running' || state === 'waiting' || review.phase === 'failed' || review.openCount > 0)) {
    badge = <CodeReviewRowChip review={review} onOpen={openFindings} />;
  } else if (state === 'done') {
    badge = (
      <button
        type="button"
        onClick={openFindings}
        className={cn(BADGE_BASE, 'bg-muted text-muted-foreground hover:text-foreground')}
        title="The code review found nothing to fix. Show the findings"
      >
        <CheckCircle2 className="h-2.5 w-2.5" />
        No findings
      </button>
    );
  } else if (complete && state === 'none') {
    badge = (
      <button
        type="button"
        onClick={() => {
          if (!scrollToCard(workbench.id)) openFindings();
        }}
        className={cn(
          BADGE_BASE,
          'bg-violet-500/15 text-violet-700 ring-1 ring-inset ring-violet-500/40 dark:bg-violet-400/15 dark:text-violet-300 dark:ring-violet-400/40',
        )}
        title="The work is pushed and the pull request is open. Show the code review"
      >
        <ScanSearch className="h-2.5 w-2.5" />
        Ready for review
      </button>
    );
  }
  if (!badge) return null;
  return (
    <span className="app-region-no-drag inline-flex shrink-0 items-center" data-attr="workbench-code-review">
      {badge}
    </span>
  );
}

function scrollToCard(workbenchId: string): boolean {
  const card = document.querySelector<HTMLElement>(`[data-attr="${CARD_ATTR}"][data-workbench-id="${workbenchId}"]`);
  if (!card) return false;
  card.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  card.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  return true;
}
