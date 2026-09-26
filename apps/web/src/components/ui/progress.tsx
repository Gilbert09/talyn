import { cn } from '../../lib/utils';

/**
 * Progress bars.
 *
 * # Why this is in `ui/` rather than next to its first caller
 *
 * Accessibility. There was no `role="progressbar"` anywhere in this app before
 * this file, and three call sites each hand-rolling one is three chances to omit
 * the role, the value or the human sentence. A shared primitive gets it right once.
 *
 * # What this deliberately does NOT absorb
 *
 * `CheckRollupBar` in `widgets/PRStatusPill.tsx`. It looks like the same thing and
 * is not: it is proportional to COUNTS (how many checks passed) while
 * `SegmentedProgress` is ordered by PHASE (which step are we on). Merging the two
 * concepts produces a primitive that serves neither well. Revisit only if a third
 * caller genuinely wants both behaviours.
 */

export interface ProgressProps {
  /** 0..1, or null for indeterminate. */
  value: number | null;
  /** The sentence a screen reader should hear. Required — see the docblock. */
  label: string;
  className?: string;
}

/**
 * A single determinate fill.
 *
 * An indeterminate value omits `aria-valuenow`, which is the ARIA spec's own way
 * of saying "in progress, position unknown" — and it is why the indeterminate look
 * can be a CSS animation rather than a second component.
 */
export function Progress({ value, label, className }: ProgressProps) {
  const pct = value === null ? null : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuetext={label}
      aria-valuemin={0}
      aria-valuemax={1}
      {...(value === null ? {} : { 'aria-valuenow': Number(value.toFixed(3)) })}
      className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}
    >
      {pct === null ? (
        <div className="owl-scan-bar h-full w-full" />
      ) : (
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
}

export interface SegmentedProgressProps {
  /** How many steps this run will take. Zero renders indeterminate. */
  total: number;
  /** Which step is active, zero-based. */
  index: number;
  /** 0..1 through the whole run, for the fill inside the active segment. */
  value: number | null;
  label: string;
  className?: string;
}

/**
 * A phase-ordered bar: one segment per step, filled up to where we are.
 *
 * Segments rather than one fill because the steps are named and unequal — a user
 * watching this wants to see "three of five done" at a glance, and a single bar at
 * 62% does not say that.
 *
 * No `aria-live` here, deliberately. Twenty of these on a list of pull requests
 * would make a screen reader unusable; the live region belongs on the ONE place
 * that describes the review in detail, which is the detail sheet's header.
 */
export function SegmentedProgress({
  total,
  index,
  value,
  label,
  className,
}: SegmentedProgressProps) {
  if (total <= 0 || value === null) {
    return <Progress value={null} label={label} className={className} />;
  }
  const steps = Array.from({ length: total }, (_, i) => i);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuetext={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(3))}
      title={label}
      className={cn('flex h-1.5 items-stretch gap-px overflow-hidden rounded-sm', className)}
    >
      {steps.map((step) => (
        <div
          key={step}
          className={cn(
            'flex-1 rounded-[1px] transition-colors duration-300',
            step < index && 'bg-primary',
            step === index && 'owl-progress-active bg-primary/60',
            step > index && 'bg-muted'
          )}
        />
      ))}
    </div>
  );
}
