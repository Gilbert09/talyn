import React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  GitMerge,
  Eye,
  HelpCircle,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { PRBlockingReason, PRChecks, PRState } from '../../lib/api';

/**
 * One-glance status badge for a task's PR. Mirrors supacode's
 * `PullRequestMergeReadiness` rollup — blocking reason picks the
 * shape, the 5-segment check bar shows progress at a glance.
 *
 * State priority (top wins):
 *   merge_conflicts     → red, "Conflicts"
 *   changes_requested   → amber, "N changes requested" (use review count)
 *   checks_failed       → red, "N/M failing"
 *   checks running      → blue spinner, "N/M running"
 *   mergeable           → green, "Ready"
 *   blocked             → amber, "Blocked"
 *   unknown             → grey, "—"
 */

interface PRStatusPillProps {
  blockingReason: PRBlockingReason;
  checks: PRChecks;
  /**
   * PR lifecycle state. When merged/closed it overrides blockingReason
   * — a terminal PR shows "Merged"/"Closed", not its last open verdict
   * (which would otherwise leave a merged PR stuck on a green "Ready").
   */
  state?: PRState;
  /** Click target — usually opens the side-sheet detail panel. */
  onClick?: () => void;
  /** Hide the inline rollup bar; shrinks the pill for tight headers. */
  compact?: boolean;
  /**
   * Drop review-related verdicts (changes_requested, blocked-on-review)
   * so this pill reflects only conflicts / CI / mergeability. Used where
   * approval state lives in its own column (the GitHub table's Review
   * column via PRReviewPill). Off elsewhere so the task-screen pill keeps
   * its all-in-one rollup.
   */
  hideReviewState?: boolean;
  className?: string;
}

interface PillVariant {
  icon: React.ElementType;
  label: string;
  /** Tailwind class fragment. */
  tone: 'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple';
  spin?: boolean;
}

export function PRStatusPill({
  blockingReason,
  checks,
  state,
  onClick,
  compact = false,
  hideReviewState = false,
  className,
}: PRStatusPillProps) {
  const terminal = terminalVariant(state);
  const variant = terminal ?? pickVariant(blockingReason, checks, hideReviewState);
  const Icon = variant.icon;
  // A merged/closed PR's check rollup is no longer meaningful.
  const showRollup = !terminal && !compact && checks.total > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      title={terminal ? terminal.label : titleFor(blockingReason, checks)}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
        toneClass(variant.tone),
        onClick ? 'cursor-pointer hover:opacity-90' : 'cursor-default',
        className
      )}
    >
      <Icon
        className={cn('w-3.5 h-3.5 shrink-0', variant.spin && 'animate-spin')}
      />
      <span className="truncate">{variant.label}</span>
      {showRollup && <CheckRollupBar checks={checks} />}
    </button>
  );
}

/**
 * Terminal-state override. Returns a variant for merged/closed PRs;
 * null for open PRs (fall through to the blocking-reason logic).
 */
function terminalVariant(state?: PRState): PillVariant | null {
  if (state === 'merged') {
    return { icon: GitMerge, label: 'Merged', tone: 'purple' };
  }
  if (state === 'closed') {
    return { icon: XCircle, label: 'Closed', tone: 'grey' };
  }
  return null;
}

/**
 * 5-segment progress bar — passed / failed / in-progress / skipped /
 * remaining. Rendered next to the pill so the user sees the
 * breakdown at a glance without opening the detail panel.
 *
 * Segments are proportional to `checks.total`. Zero-width segments
 * collapse so e.g. an all-passing PR shows a single solid green bar.
 */
function CheckRollupBar({ checks }: { checks: PRChecks }) {
  const total = Math.max(checks.total, 1);
  // Skipped checks count as green — a PR with everything passing or
  // skipped should read as a solid green bar, not a partly-grey one.
  const segments: Array<{ width: number; bg: string; title: string }> = [
    {
      width: ((checks.passed + checks.skipped) / total) * 100,
      bg: 'bg-emerald-500',
      title:
        `${checks.passed} passed` +
        (checks.skipped ? ` · ${checks.skipped} skipped` : ''),
    },
    {
      width: (checks.failed / total) * 100,
      bg: 'bg-red-500',
      title: `${checks.failed} failed`,
    },
    {
      width: (checks.inProgress / total) * 100,
      bg: 'bg-blue-500',
      title: `${checks.inProgress} in progress`,
    },
  ];
  return (
    <div
      className="ml-1 flex h-1.5 w-12 overflow-hidden rounded-sm bg-zinc-200 dark:bg-zinc-700"
      aria-label="check status breakdown"
    >
      {segments.map((seg, i) =>
        seg.width > 0 ? (
          <div
            key={i}
            className={seg.bg}
            style={{ width: `${seg.width}%` }}
            title={seg.title}
          />
        ) : null
      )}
    </div>
  );
}

function pickVariant(
  blockingReason: PRBlockingReason,
  checks: PRChecks,
  hideReviewState = false
): PillVariant {
  // When approval lives in its own column, the review-related verdicts
  // ('changes_requested', 'blocked'-on-review) shouldn't drive this pill
  // — fall back to the conflicts/CI/mergeability picture instead.
  if (
    hideReviewState &&
    (blockingReason === 'changes_requested' || blockingReason === 'blocked')
  ) {
    return pickVariant(checks.failed > 0 ? 'checks_failed' : 'mergeable', checks);
  }
  switch (blockingReason) {
    case 'merge_conflicts':
      return { icon: AlertTriangle, label: 'Conflicts', tone: 'red' };
    case 'changes_requested':
      return { icon: AlertTriangle, label: 'Changes requested', tone: 'amber' };
    case 'checks_failed':
      return {
        icon: XCircle,
        label: `${checks.failed}/${checks.total} failing`,
        tone: 'red',
      };
    case 'mergeable':
      // Special-case in-progress checks even when overall verdict is
      // mergeable — the user wants to see "still running".
      if (checks.inProgress > 0) {
        return {
          icon: Loader2,
          label: `${checks.inProgress}/${checks.total} running`,
          tone: 'blue',
          spin: true,
        };
      }
      return { icon: CheckCircle2, label: 'Ready', tone: 'green' };
    case 'blocked':
      // Mergeable on its own — held only by branch protection, almost
      // always a required review/approval that hasn't landed yet.
      return { icon: Eye, label: 'Review', tone: 'amber' };
    case 'unknown':
    default:
      return { icon: HelpCircle, label: '—', tone: 'grey' };
  }
}

function titleFor(blockingReason: PRBlockingReason, checks: PRChecks): string {
  const checkSummary =
    checks.total === 0
      ? 'no checks'
      : `${checks.passed} passed · ${checks.failed} failed · ${checks.inProgress} running · ${checks.skipped} skipped`;
  return `${humanReason(blockingReason)} · ${checkSummary}`;
}

function humanReason(b: PRBlockingReason): string {
  switch (b) {
    case 'mergeable':
      return 'Ready to merge';
    case 'merge_conflicts':
      return 'Merge conflicts with base';
    case 'changes_requested':
      return 'Reviewer requested changes';
    case 'checks_failed':
      return 'CI checks failing';
    case 'blocked':
      return 'Waiting on required review';
    case 'unknown':
    default:
      return 'Status pending';
  }
}

function toneClass(tone: PillVariant['tone']): string {
  switch (tone) {
    case 'green':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
    case 'red':
      return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400';
    case 'amber':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400';
    case 'blue':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400';
    case 'purple':
      return 'border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-400';
    case 'grey':
    default:
      return 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  }
}
