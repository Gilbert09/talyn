import {
  CODE_REVIEW_SEVERITY_LABELS,
  CODE_REVIEW_SEVERITY_ORDER,
  type CodeReviewCounts,
} from '@talyn/shared';
import { cn } from '../../../lib/utils';

/**
 * The open findings of a code review, by severity: "2 must fix · 1 should fix".
 * Draws nothing when there are no counts.
 *
 * Keep this file the same in web and desktop. It must not import the diff
 * library, because list rows use it.
 */
export function CodeReviewSeverityCounts({
  counts,
  openCount,
  className,
}: {
  counts: CodeReviewCounts;
  /**
   * The review's `openCount`. When set, show only the severities that make up
   * this number, so the counts agree with the findings badge. `counts` also
   * holds the findings below the workspace's reporting bar.
   */
  openCount?: number;
  className?: string;
}) {
  const shown = severitiesShown(counts, openCount);
  if (shown.length === 0) return null;
  return (
    <div
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]', className)}
      data-testid="code-review-severity-counts"
    >
      {shown.map((severity) => (
        <span key={severity} className="flex items-center gap-1" data-severity={severity}>
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
          {counts[severity]} {CODE_REVIEW_SEVERITY_LABELS[severity].toLowerCase()}
        </span>
      ))}
    </div>
  );
}

/**
 * The severities to show, most serious first. `openCount` is the sum of the
 * counts at or above the reporting bar, so the bar is the longest run of
 * severities whose total stays within it.
 */
export function severitiesShown(counts: CodeReviewCounts, openCount?: number) {
  let total = 0;
  return CODE_REVIEW_SEVERITY_ORDER.filter((severity) => {
    total += counts[severity];
    return counts[severity] > 0 && (openCount === undefined || total <= openCount);
  });
}
