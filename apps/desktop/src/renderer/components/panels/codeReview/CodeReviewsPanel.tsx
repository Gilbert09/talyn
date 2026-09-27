import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, ScanSearch } from 'lucide-react';
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
import { PRDetailSheet } from '../../widgets/PRDetailSheet';
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
 *
 * A row opens the SAME detail sheet the pull-request list opens, on its
 * findings. It used to expand in place, which meant a second way of showing a
 * review that had to be kept in step with the first — and gave no route to the
 * checks, the files or the merge actions that are often the reason you came.
 */
export function CodeReviewsPanel() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setActivePanel = useWorkspaceStore((s) => s.setActivePanel);
  const [items, setItems] = useState<CodeReviewListItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const anyRunning = (items ?? []).some((i) => !CODE_REVIEW_PHASE_AT_REST[i.review.phase]);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [anyRunning, load]);

  return (
    <div className="relative flex h-full flex-col">
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

        {items === null && !error && <LoadingRows />}

        {items !== null && items.length === 0 && (
          <EmptyState onGoToPrs={() => setActivePanel('my_prs')} />
        )}

        {(items ?? []).map((item) => (
          <ReviewRow
            key={item.review.id}
            item={item}
            onOpen={() => setSelectedId(item.pullRequest.id)}
          />
        ))}
      </div>

      {/* The same sheet the pull-request list opens, `contained` so it floats
          over this list rather than squashing it, and opened on the findings —
          which is the thing that was clicked. */}
      <PRDetailSheet
        pullRequestId={selectedId}
        onClose={() => setSelectedId(null)}
        layout="contained"
        initialTab="findings"
      />
    </div>
  );
}

/**
 * The list's shape while it loads, rather than the word "Loading".
 *
 * Three skeleton rows at the height a real one settles to, so the page does not
 * jump when the data lands — the reason to draw a skeleton at all rather than a
 * spinner, which tells you something is happening and nothing about what.
 */
function LoadingRows() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading your reviews">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-md border p-3">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-2.5 w-1/3 animate-pulse rounded bg-muted/70" />
          <div className="mt-3 flex gap-3">
            <div className="h-2.5 w-20 animate-pulse rounded bg-muted/70" />
            <div className="h-2.5 w-24 animate-pulse rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Nothing here yet, and what to do about it.
 *
 * An empty cohort view is the one screen where a person has no idea whether the
 * feature is broken or simply unused, so this says which, says what a review
 * does, and offers the one action that leads to a first one.
 */
function EmptyState({ onGoToPrs }: { onGoToPrs: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-dashed px-6 py-12 text-center">
      <ScanSearch className="h-6 w-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">No reviews yet</p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        Talyn reads a pull request from several angles, checks what it found against the
        code, and shows you what is worth fixing. Reviews you run collect here.
      </p>
      <Button size="sm" variant="outline" className="mt-4" onClick={onGoToPrs}>
        Go to My PRs
      </Button>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Open a pull request and use its Findings tab to run the first one.
      </p>
    </div>
  );
}

function ReviewRow({ item, onOpen }: { item: CodeReviewListItem; onOpen: () => void }) {
  const { review, pullRequest } = item;
  const running = !CODE_REVIEW_PHASE_AT_REST[review.phase];
  const progress = codeReviewProgress(review);
  const blockers = review.counts.blocker;

  return (
    <div
      className={cn(
        'rounded-md border transition-colors hover:border-muted-foreground/40',
        blockers > 0 && !running && 'border-amber-500/40 bg-amber-500/5'
      )}
    >
      <button type="button" onClick={onOpen} className="w-full p-3 text-left">
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
              {review.funnel.rejected > 0 &&
                ` · ${review.funnel.rejected} dropped by the checking pass`}
              {review.dismissedCount > 0 && ` · ${review.dismissedCount} you dismissed`}
            </p>
          </>
        )}

        {review.staleForHead && !running && (
          <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
            There are newer commits since this review.
          </p>
        )}

        {review.failureReason && (
          <p className="mt-1 text-[11px] text-red-700 dark:text-red-400">
            {review.failureReason}
          </p>
        )}
      </button>

      {/* Outside the row's own button — a button inside a button is invalid, and
          this goes somewhere else entirely. */}
      <div className="border-t px-3 py-1.5">
        <button
          type="button"
          onClick={() =>
            void openExternal(
              `https://github.com/${pullRequest.owner}/${pullRequest.repo}/pull/${pullRequest.number}`
            )
          }
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="h-3 w-3" />
          Open on GitHub
        </button>
      </div>
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
