import { AlertTriangle, ScanSearch } from 'lucide-react';
import {
  CODE_REVIEW_PHASE_AT_REST,
  codeReviewProgress,
  type CodeReviewPublic,
} from '@talyn/shared';
import type { CodeReviewPublic as ClientCodeReview } from '../../../lib/api';

/**
 * A code review, on one line of a pull-request row.
 *
 * # Why nothing here imports a diff renderer
 *
 * The web fork lazy-loads `PRDetailSheet` because it is the only importer of the
 * diff library, and the row table is NOT lazy. Anything this file pulls in lands in
 * the initial bundle, so it stays to icons and text. Desktop cannot detect a
 * regression here; only the web bundle can.
 *
 * # The colour rule
 *
 * The row's own grammar, spelled out where the other chips are defined: a coloured
 * chip means STATE. So a review with blockers is amber and a clean one is slate —
 * a review that found nothing is not a state worth colouring, and colouring it
 * would train people to ignore the colour that matters.
 */
export function CodeReviewRowChip({
  review,
  onOpen,
}: {
  review: ClientCodeReview;
  onOpen: () => void;
}) {
  const shared = review as unknown as CodeReviewPublic;
  const atRest = CODE_REVIEW_PHASE_AT_REST[shared.phase];

  // Waiting for a runner rather than working. Reuses the amber treatment the
  // auto-keep watcher's deferral already has, because it is the same fact: the
  // plan said yes and the machine has not got to it.
  if (review.deferredSince && !atRest) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] uppercase text-amber-800 dark:bg-amber-900/60 dark:text-amber-200"
        title="This review is waiting for a runner to become free."
      >
        Waiting
      </button>
    );
  }

  if (!atRest) {
    const progress = codeReviewProgress(shared);
    const plan = shared.phasePlan.length;
    const index = Math.max(0, shared.phasePlan.indexOf(shared.phase));
    return (
      <span className="inline-flex items-center gap-1.5" title={progress.label}>
        <SegmentedBar total={plan} index={index} value={progress.fraction} label={progress.label} />
        <span className="text-[10px] uppercase text-muted-foreground">{progress.short}</span>
      </span>
    );
  }

  if (shared.phase === 'failed') {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-1 rounded bg-red-100 px-1 py-0.5 text-[10px] uppercase text-red-800 dark:bg-red-900/60 dark:text-red-200"
        title={review.failureReason ?? 'The review did not finish.'}
      >
        <AlertTriangle className="h-2.5 w-2.5" />
        Review failed
      </button>
    );
  }

  // Nothing to say. A clean review is worth reading once, in the sheet — it is not
  // worth a permanent chip on a list somebody scans for problems.
  if (review.openCount === 0) return null;

  const hasBlockers = review.counts.blocker > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={
        hasBlockers
          ? 'inline-flex items-center gap-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] uppercase text-amber-800 dark:bg-amber-900/60 dark:text-amber-200'
          : 'inline-flex items-center gap-1 rounded bg-zinc-200 px-1 py-0.5 text-[10px] uppercase text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200'
      }
      title={
        hasBlockers
          ? `${review.counts.blocker} blocker(s) and ${review.openCount - review.counts.blocker} other finding(s).`
          : `${review.openCount} finding(s) from the code review.`
      }
    >
      <ScanSearch className="h-2.5 w-2.5" />
      {review.openCount} finding{review.openCount === 1 ? '' : 's'}
      {review.staleForHead ? ' · older commit' : ''}
    </button>
  );
}

/**
 * The bar, inlined rather than imported from `ui/progress`.
 *
 * Deliberate: see the bundle note at the top of the file. This is a dozen lines of
 * divs, and the alternative is a cross-directory import from the one component
 * tree that must stay light. The accessible version with the role and the value
 * lives in `ui/progress.tsx` and is what the sheet uses — where a screen reader
 * wants one description rather than twenty.
 */
function SegmentedBar({
  total,
  index,
  value,
  label,
}: {
  total: number;
  index: number;
  value: number | null;
  label: string;
}) {
  if (total <= 0 || value === null) {
    // The shimmer MUST sit inside a clipping track. `owl-scan` travels from
    // translateX(-160%) to 360% of the animated element's own width, which is
    // how an indeterminate bar reads as moving — but a transform does not
    // affect layout, so with the class on a bare 48px span the paint escaped
    // roughly 250px in each direction and slid straight across the rest of the
    // row. Every other user of this class already wraps it (App.tsx's w-44
    // track, ui/progress.tsx's overflow-hidden); this was the one that did not.
    return (
      <span
        className="inline-block h-1.5 w-12 overflow-hidden rounded-sm bg-muted align-middle"
        aria-label={label}
      >
        <span className="owl-scan-bar block h-full w-1/3 rounded-sm bg-primary/70" />
      </span>
    );
  }
  return (
    <span className="flex h-1.5 w-12 items-stretch gap-px" aria-label={label}>
      {Array.from({ length: total }, (_, step) => (
        <span
          key={step}
          className={
            step < index
              ? 'flex-1 rounded-[1px] bg-primary'
              : step === index
                ? 'owl-progress-active flex-1 rounded-[1px] bg-primary/60'
                : 'flex-1 rounded-[1px] bg-muted'
          }
        />
      ))}
    </span>
  );
}
