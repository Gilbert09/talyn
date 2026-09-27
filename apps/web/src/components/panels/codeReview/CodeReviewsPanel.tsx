import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, ScanSearch } from 'lucide-react';
import {
  CODE_REVIEW_PHASE_AT_REST,
  CODE_REVIEW_PRESET_LABELS,
  CODE_REVIEW_SEVERITY_LABELS,
  codeReviewProgress,
  type CodeReviewListItem,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { openExternal } from '../../../lib/openExternal';
import { FindingsTab } from '../../widgets/codeReview/FindingsTab';
import { Button } from '../../ui/button';
import { Progress } from '../../ui/progress';
import { cn } from '../../../lib/utils';

/**
 * Every review this workspace has run, newest first.
 *
 * A COHORT view, which is why it earns a nav entry when the findings tab in the
 * sheet already exists: that answers "what is wrong with this pull request",
 * and this answers "where should I look first" — a question that previously
 * meant opening each pull request in turn to find out whether it had anything.
 *
 * Deliberately not a second PR table. The row is about the REVIEW: what it
 * found, what its own checking pass threw away, and whether it is still
 * running. The pull request is the subtitle.
 */
export function CodeReviewsPanel() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setActivePanel = useWorkspaceStore((s) => s.setActivePanel);
  const [items, setItems] = useState<CodeReviewListItem[] | null>(null);
  // One open at a time. Each expanded row mounts the real findings tab, which
  // fetches its own findings — several open at once would be several requests
  // for lists nobody is reading.
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await api.codeReviews.list(workspaceId);
      setItems(res.reviews);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your reviews');
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only while something is in flight. A list of finished reviews does not
  // change on its own, and polling one would be a request every five seconds
  // for a screen nobody is waiting on.
  const anyRunning = (items ?? []).some(
    (i) => !CODE_REVIEW_PHASE_AT_REST[i.review.phase]
  );
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

  return (
    <div className="flex h-full flex-col">
      <div className="app-region-drag border-b p-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ScanSearch className="h-4 w-4" />
          Code review
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Every review this workspace has run.
        </p>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs">
            {error}
          </div>
        )}

        {items === null && !error && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}

        {items !== null && items.length === 0 && (
          <div className="rounded-md border bg-muted/20 p-4 text-xs">
            <p className="font-medium">No reviews yet.</p>
            <p className="mt-1 text-muted-foreground">
              Open a pull request and use the Findings tab to review it. Reviews you run will
              collect here.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => setActivePanel('my_prs')}
            >
              Go to My PRs
            </Button>
          </div>
        )}

        {(items ?? []).map((item) => (
          <ReviewRow
            key={item.review.id}
            item={item}
            expanded={expanded === item.review.id}
            onToggle={() =>
              setExpanded((prev) => (prev === item.review.id ? null : item.review.id))
            }
          />
        ))}
      </div>
    </div>
  );
}

function ReviewRow({
  item,
  expanded,
  onToggle,
}: {
  item: CodeReviewListItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { review, pullRequest } = item;
  const running = !CODE_REVIEW_PHASE_AT_REST[review.phase];
  const progress = codeReviewProgress(review);
  const blockers = review.counts.blocker;

  return (
    <div
      className={cn(
        'rounded-md border transition-colors',
        blockers > 0 && !running && 'border-amber-500/40 bg-amber-500/5',
        !expanded && 'hover:border-muted-foreground/40'
      )}
    >
      {/* Expands into the REAL findings tab rather than linking away. It takes a
          pull request id and fetches its own findings, so the whole interaction
          — pick, fix, dismiss, review again, stop — comes with it rather than
          being rebuilt here and drifting from the sheet's copy. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full p-3 text-left"
      >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{pullRequest.title}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {pullRequest.owner}/{pullRequest.repo}#{pullRequest.number}
            {pullRequest.author && ` · @${pullRequest.author}`}
            {' · '}
            {CODE_REVIEW_PRESET_LABELS[review.preset]}
            {review.headShaShort && ` of ${review.headShaShort}`}
          </p>
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {running ? progress.label : outcomeLabel(review.openCount, review.phase)}
        </span>
      </div>

      {running && (
        <div className="mt-2">
          <Progress value={progress.fraction} label={progress.label} />
        </div>
      )}

      {!running && review.funnel.raised > 0 && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            {(['blocker', 'major', 'minor', 'nit'] as const).map((severity) =>
              review.counts[severity] ? (
                <span key={severity} className="flex items-center gap-1">
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      severity === 'blocker' && 'bg-red-500',
                      severity === 'major' && 'bg-amber-500',
                      severity === 'minor' && 'bg-zinc-400',
                      severity === 'nit' && 'bg-zinc-300'
                    )}
                    aria-hidden
                  />
                  {review.counts[severity]} {CODE_REVIEW_SEVERITY_LABELS[severity].toLowerCase()}
                </span>
              ) : null
            )}
          </div>
          {/* The funnel, said out loud. Without it a short list is
              indistinguishable from a shallow review — and the ratio is the
              most informative single fact about how a review went. */}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {review.funnel.raised} raised
            {review.funnel.rejected > 0 && ` · ${review.funnel.rejected} dropped by the checking pass`}
            {review.dismissedCount > 0 && ` · ${review.dismissedCount} you dismissed`}
          </p>
        </>
      )}

      {review.staleForHead && !running && (
        <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
          There are newer commits since this review.
        </p>
      )}

      {review.failureReason && (
        <p className="mt-1 text-[11px] text-red-700 dark:text-red-400">{review.failureReason}</p>
      )}

      <span className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {expanded ? 'Hide findings' : 'Show findings'}
      </span>
      </button>

      {expanded && (
        <div className="border-t p-3">
          {/* Seeded with the row's own payload so it paints immediately and then
              refreshes, rather than flashing a loading state for data we hold. */}
          <FindingsTab pullRequestId={pullRequest.id} seedReview={review} />
          <button
            type="button"
            onClick={() =>
              void openExternal(
                `https://github.com/${pullRequest.owner}/${pullRequest.repo}/pull/${pullRequest.number}`
              )
            }
            className="mt-3 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
            Open on GitHub
          </button>
        </div>
      )}
    </div>
  );
}

/** What the row says when the review is at rest. */
function outcomeLabel(openCount: number, phase: string): string {
  if (phase === 'failed') return 'Did not finish';
  if (phase === 'cancelled') return 'Stopped';
  if (phase === 'fixed') return 'Fix pushed';
  if (openCount === 0) return 'Nothing to flag';
  return `${openCount} finding${openCount === 1 ? '' : 's'}`;
}
