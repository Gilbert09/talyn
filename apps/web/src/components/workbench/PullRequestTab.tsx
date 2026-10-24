import { openExternal } from '../../lib/openExternal';
import { useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Eye,
  ListChecks,
  Loader2,
  PanelRightOpen,
  RefreshCw,
  ScanSearch,
} from 'lucide-react';
import {
  CODE_REVIEW_PHASE_AT_REST,
  codeReviewOffered,
  coarseQueueStatus,
  queueBlockNeedsHuman,
  type CodeReviewPublic,
  type Workbench,
  type WorkbenchChat,
} from '@talyn/shared';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { api, type PRChecks, type PRRow } from '../../lib/api';
import { toast } from '../../stores/toast';
import { maybeHandleBillingLimit } from '../../stores/billing';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkspaceStore } from '../../stores/workspace';
import { useGitHubActions } from '../panels/github/useGitHubActions';
import { MergeQueueSection, PRDetailSheet, ReviewsTab, usePrAutoKeep } from '../widgets/PRDetailSheet';
import { PRStatusPill, blockingReasonText } from '../widgets/PRStatusPill';
import { PRReviewPill } from '../widgets/PRReviewPill';
import { CodeReviewRowChip } from '../widgets/codeReview/CodeReviewRowChip';
import { NoPullRequest, PrChecksList, usePrDetail } from './WorkbenchChecks';
import { PrPill } from './WorkbenchBadges';
import { timeAgo } from './new/RecentWorkbenches';

const NO_CHECKS: PRChecks = {
  total: 0,
  passed: 0,
  failed: 0,
  inProgress: 0,
  skipped: 0,
};

type SheetTab = 'overview' | 'findings';

/**
 * The Pull request tab of the right panel: the PR this branch opened, with
 * what the GitHub page offers for it. Its status, the merge queue, auto-keep,
 * a code review, the checks (each with "Add to chat") and the reviews.
 *
 * The pills and actions read the PR store, which the WS keeps current. The
 * check runs and reviews are a live GitHub read, made when the tab opens,
 * after each turn ends, and on Refresh.
 */
export function PullRequestTab({
  workbench,
  chat,
  pr,
  visible,
  turnsEnded,
}: {
  workbench: Workbench;
  chat: WorkbenchChat | null;
  pr: PRRow | null;
  visible: boolean;
  /** Bumps each time a turn in this workbench ends. */
  turnsEnded: number;
}) {
  const { data, error, loading, stale, loadCount, refresh } = usePrDetail(pr, {
    visible,
    turnsEnded,
  });
  const autoKeep = usePrAutoKeep(pr);
  const { setMergeQueue } = useGitHubActions();
  const features = useWorkspaceStore((s) => s.features);
  const [sheet, setSheet] = useState<SheetTab | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);

  if (!pr) {
    // A merged or closed PR is not in the open-PR store and is fetched on its
    // own; until it lands, the summary the workbench carries says which it is.
    if (workbench.pullRequestId && workbench.pr) {
      const s = workbench.pr;
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <PrPill number={s.number} state={s.state} />
            <span className="flex-1 text-xs text-muted-foreground">Loading the pull request…</span>
            <GitHubLink url={s.url} />
          </div>
        </div>
      );
    }
    return <NoPullRequest />;
  }

  const open = pr.state === 'open';
  const summary = pr.summary;
  const review = pr.codeReview ?? null;
  const reviewOffered = codeReviewOffered(features);
  const reviewRunning = review ? !CODE_REVIEW_PHASE_AT_REST[(review as unknown as CodeReviewPublic).phase] : false;
  const mergedAgo = pr.mergedAt ? timeAgo(pr.mergedAt) : null;

  const toggleQueue = async () => {
    setQueueBusy(true);
    try {
      await setMergeQueue(pr, !pr.mergeQueued);
    } finally {
      setQueueBusy(false);
    }
  };

  const startReview = async () => {
    setReviewBusy(true);
    try {
      const next = await api.pullRequests.startCodeReview(pr.id);
      usePullRequestStore.getState().patchRow(pr.id, { codeReview: next });
      toast.info('Code review started', 'The findings show here when it finishes.');
    } catch (err) {
      if (!maybeHandleBillingLimit(err, 'code_review_start')) {
        toast.error('Could not start the code review', err instanceof Error ? err.message : undefined);
      }
    } finally {
      setReviewBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="pr-tab">
      <div className="space-y-1.5 border-b px-3 py-2">
        <div className="flex items-center gap-1.5">
          <PRStatusPill
            blockingReason={summary.blockingReason}
            checks={summary.checks ?? NO_CHECKS}
            mergeStateStatus={summary.mergeStateStatus}
            state={pr.state}
            hideReviewState
            labels={summary.labels}
            ciStatus={summary.ciStatus}
            humanGates={summary.humanGates}
          />
          {open && (
            <PRReviewPill reviewDecision={summary.effectiveReviewDecision ?? summary.reviewDecision} state={pr.state} />
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Refresh the checks and reviews"
            aria-label="Refresh"
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          </button>
          <GitHubLink url={summary.url} />
        </div>
        <button
          type="button"
          onClick={() => setSheet('overview')}
          className="block w-full truncate text-left text-xs font-medium hover:underline"
          title={`${summary.title}. Open the details`}
        >
          <span className="font-mono text-muted-foreground">#{pr.number}</span> {summary.title}
        </button>
        {open && summary.blockingReason && (
          <p className="text-[11px] text-muted-foreground" data-testid="pr-blocking-reason">
            {blockingReasonText(summary.blockingReason, summary.reviewDecision, summary.humanGates)}
          </p>
        )}
        {pr.state === 'merged' && (
          <p className="text-[11px] text-muted-foreground">
            Merged into {summary.baseBranch || workbench.baseBranch}
            {mergedAgo ? ` · ${mergedAgo === 'now' ? 'just now' : `${mergedAgo} ago`}` : ''}
          </p>
        )}
        {pr.state === 'closed' && <p className="text-[11px] text-muted-foreground">Closed without merging</p>}
        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          {open && (
            <Button
              variant={pr.mergeQueued ? 'default' : 'outline'}
              className="h-6 px-2 text-[11px]"
              onClick={() => void toggleQueue()}
              disabled={queueBusy}
              title={
                pr.mergeQueued
                  ? 'In the merge queue. Click to remove it'
                  : 'Add to the merge queue. It merges when it is clean'
              }
            >
              {queueBusy ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : queueBlocked(pr) ? (
                <AlertTriangle className="mr-1 h-3 w-3" />
              ) : (
                <ListChecks className="mr-1 h-3 w-3" />
              )}
              {queueLabel(pr)}
            </Button>
          )}
          {open && autoKeep.posthogConnected && (
            <Button
              variant={pr.autoKeepMergeable ? 'default' : 'outline'}
              className="h-6 px-2 text-[11px]"
              onClick={() => void autoKeep.toggle(!pr.autoKeepMergeable)}
              disabled={autoKeep.toggling}
              title={
                pr.autoKeepMergeable
                  ? 'Auto-keep is on. Click to turn it off'
                  : 'Keep this PR mergeable: fix conflicts, CI and review comments until it merges'
              }
            >
              {autoKeep.toggling ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : pr.autoKeepMergeable && pr.autoMergeState?.paused ? (
                <AlertTriangle className="mr-1 h-3 w-3" />
              ) : (
                <Eye className="mr-1 h-3 w-3" />
              )}
              {pr.autoKeepMergeable ? (pr.autoMergeState?.paused ? 'Auto-fix paused' : 'Auto-keeping') : 'Auto-keep'}
            </Button>
          )}
          {open && reviewOffered && (
            <Button
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => void startReview()}
              disabled={reviewBusy || reviewRunning}
              title={reviewRunning ? 'A code review is running' : 'Start a code review of this PR'}
            >
              {reviewBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <ScanSearch className="mr-1 h-3 w-3" />}
              Review
            </Button>
          )}
          <Button
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => setSheet('overview')}
            title="Open the full pull request view"
          >
            <PanelRightOpen className="mr-1 h-3 w-3" />
            Details
          </Button>
        </div>
        {reviewOffered && review && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" data-testid="pr-code-review">
            <span>Code review</span>
            <CodeReviewRowChip review={review} onOpen={() => setSheet('findings')} />
            {!reviewRunning && review.openCount === 0 && (review as unknown as CodeReviewPublic).phase !== 'failed' && (
              <button type="button" className="hover:underline" onClick={() => setSheet('findings')}>
                No open findings
              </button>
            )}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {open && (pr.mergeQueued || pr.mergeQueue) && (
          <div className="border-b px-3 py-2">
            <MergeQueueSection row={pr} />
          </div>
        )}
        {stale && (
          <button
            type="button"
            onClick={() => void refresh()}
            className="w-full border-b px-3 py-1.5 text-left text-[11px] text-info hover:bg-accent/50"
          >
            The checks changed. Refresh
          </button>
        )}
        <PrChecksList workbench={workbench} chat={chat} row={pr} data={data} error={error} />
        {data && (
          <section className="border-t px-3 py-2">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reviews</h3>
            <ReviewsTab key={loadCount} data={{ row: pr, fresh: data.fresh }} />
          </section>
        )}
      </div>
      <PRDetailSheet
        key={sheet ?? 'closed'}
        pullRequestId={sheet ? pr.id : null}
        onClose={() => setSheet(null)}
        layout="overlay"
        seedRow={pr}
        initialTab={sheet ?? 'overview'}
      />
    </div>
  );
}

function GitHubLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      onClick={(event) => {
        event.preventDefault();
        openExternal(url);
      }}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      title="Open on GitHub"
    >
      GitHub <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function queueBlocked(pr: PRRow): boolean {
  return pr.mergeQueued && coarseQueueStatus(pr.mergeQueue?.status ?? 'queued') === 'blocked';
}

/** The merge queue button's words, as the PR detail sheet says them. */
export function queueLabel(pr: PRRow): string {
  if (!pr.mergeQueued) return 'Add to merge queue';
  const coarse = coarseQueueStatus(pr.mergeQueue?.status ?? 'queued');
  if (coarse === 'blocked')
    return queueBlockNeedsHuman(pr.mergeQueue?.blockedCode) ? 'Queue needs you' : 'Queue blocked';
  if (coarse === 'merging') return 'Merging…';
  if (coarse === 'fixing') return 'Fixing…';
  const pos = pr.mergeQueue?.position;
  return pos ? `Queued #${pos}` : 'Queued';
}
