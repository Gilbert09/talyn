import React from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  GitMerge,
  Eye,
  HelpCircle,
  ShieldAlert,
  Clock,
  ArrowDownToLine,
  UserRound,
} from 'lucide-react';
import {
  externalQueueProviderLabel,
  externalQueueStateLabel,
  externalQueueStatusFromLabels,
  type ExternalQueueState,
} from '@talyn/shared';
import { cn } from '../../lib/utils';
import type {
  PRBlockingReason,
  PRChecks,
  PRCiStatus,
  PRHumanGate,
  PRState,
} from '../../lib/api';

/**
 * One-glance status badge for a task's PR. Mirrors supacode's
 * `PullRequestMergeReadiness` rollup — blocking reason picks the
 * shape, the 5-segment check bar shows progress at a glance.
 *
 * State priority (top wins):
 *   merge_conflicts        → red, "Conflicts"
 *   changes_requested      → amber, "N changes requested" (use review count)
 *   checks_failed          → red, "N/M failing"
 *   needs_human            → amber, "Needs human" (only a person can clear
 *                            the failing gate, e.g. PostHog Visual Review)
 *   checks_failed_optional → green, "N non-required" (mergeable; the failures
 *                            don't block, so it reads as ready — the rollup bar
 *                            still shows the non-required reds in amber)
 *   checks running         → blue spinner, "N/M running"
 *   mergeable              → green, "Ready"
 *   blocked                → amber, "Blocked"
 *   unknown                → grey, "—"
 */

interface PRStatusPillProps {
  blockingReason: PRBlockingReason;
  checks: PRChecks;
  /**
   * GitHub's mergeStateStatus. Only used to tell required from
   * non-required check failures when review verdicts are stripped
   * (see `hideReviewState`); UNSTABLE ⇒ the failing checks aren't
   * required.
   */
  mergeStateStatus?: string;
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
  /**
   * The PR's review decision (effective preferred). Disambiguates the
   * 'blocked' verdict: GitHub reports mergeStateStatus BLOCKED both for a
   * missing required review AND for other branch-protection holds (required
   * signatures, merge restrictions). On an APPROVED PR the "Review" label
   * would be a lie — it renders as "Protected" instead.
   */
  reviewDecision?: string | null;
  /**
   * The PR's labels. An external merge queue (trunk.io) publishes a submitted
   * PR's state as labels, and once it holds the PR that state is what the
   * reader actually wants — "Queue: testing" beats "Ready" on a PR nobody but
   * the queue can merge. Ranked below merged/closed, above every open verdict.
   *
   * Only the FALLBACK channel: trunk applies these labels in some repo
   * configurations and not others. Prefer `externalQueueState` when the caller
   * has it.
   */
  labels?: string[];
  /**
   * The external queue's own answer, as the backend read it off the provider's
   * PR comment (`mergeQueue.external.state`). Authoritative — it wins over
   * whatever the labels say, and is often the only channel there is.
   */
  externalQueueState?: ExternalQueueState;
  /**
   * The CI picture alone, derived by the backend from per-check required-ness.
   * With `hideReviewState` the pill draws THIS instead of inferring
   * required-ness from `blockingReason` — PostHog reports BLOCKED on every PR,
   * and reading 'blocked' as "the failures are non-required" drew a red
   * required check as a green "2 non-required". Absent on rows written before
   * the field shipped.
   */
  ciStatus?: PRCiStatus;
  /** Failing gates only a person can clear — named in the tooltip. */
  humanGates?: PRHumanGate[];
  className?: string;
}

interface PillVariant {
  icon: React.ElementType;
  label: string;
  /** Tailwind class fragment. */
  tone: 'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple';
  spin?: boolean;
  /** Failing checks are non-required → draw the rollup's fail bar amber. */
  optionalFailures?: boolean;
  /** The pill is saying "a person must act" — the tooltip names the gate. */
  needsHuman?: boolean;
}

const NEEDS_HUMAN: PillVariant = {
  icon: UserRound,
  label: 'Needs human',
  tone: 'amber',
  needsHuman: true,
};

export function PRStatusPill({
  blockingReason,
  checks,
  mergeStateStatus,
  state,
  onClick,
  compact = false,
  hideReviewState = false,
  reviewDecision,
  labels,
  externalQueueState,
  ciStatus,
  humanGates,
  className,
}: PRStatusPillProps) {
  const terminal = terminalVariant(state);
  const external =
    terminal || state !== 'open'
      ? null
      : externalQueueVariant(labels, externalQueueState, { checks, blockingReason });
  const variant =
    terminal ??
    external?.variant ??
    pickVariant(
      blockingReason,
      checks,
      hideReviewState,
      mergeStateStatus,
      reviewDecision,
      ciStatus
    );
  const Icon = variant.icon;
  // A merged/closed PR's check rollup is no longer meaningful.
  const showRollup = !terminal && !compact && checks.total > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        terminal
          ? terminal.label
          : (external?.title ??
            titleFor(
              variant.needsHuman ? 'needs_human' : blockingReason,
              checks,
              reviewDecision,
              humanGates
            ))
      }
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
      {showRollup && (
        <CheckRollupBar checks={checks} optionalFailures={variant.optionalFailures} />
      )}
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
 * An external merge queue (trunk.io) holding the PR outranks every open-state
 * verdict: on a branch only that system can merge, "Ready" is misleading and
 * "Queue: testing" is the answer. An ejected PR (failed/cancelled) reads red or
 * amber so it stands out — it's back in the author's court.
 */
function externalQueueVariant(
  labels: string[] | undefined,
  observed: ExternalQueueState | undefined,
  /** The PR's own verdict — consulted only for `not_ready`, see that case. */
  own: { checks: PRChecks; blockingReason: PRBlockingReason }
): { variant: PillVariant; title: string } | null {
  const ext = observed
    ? ({ provider: 'trunk', state: observed, source: 'comment', evidence: 'its own comment' } as const)
    : externalQueueStatusFromLabels(labels);
  if (!ext) return null;
  // The provider does NOT have the PR — nothing to say; the normal open-state
  // verdicts describe it better than a queue pill would.
  if (ext.state === 'not_submitted') return null;
  const provider = externalQueueProviderLabel(ext.provider);
  const state = externalQueueStateLabel(ext.state);
  const base = { label: `Queue: ${state.toLowerCase()}`, tone: 'blue' as const };
  switch (ext.state) {
    case 'rejected':
      return {
        variant: { ...base, label: 'Queue: refused', icon: XCircle, tone: 'red' },
        title: `${provider}'s merge queue says it cannot merge this PR (${ext.evidence}).`,
      };
    case 'pending_failure':
      return {
        variant: { ...base, icon: Clock, tone: 'amber' },
        title: `A check failed in ${provider}'s merge queue (${ext.evidence}) — it still has this PR, and retests it or sends it back once the PRs ahead of it finish.`,
      };
    case 'failed':
      return {
        variant: { ...base, icon: XCircle, tone: 'red' },
        title: `${provider}'s merge queue rejected this PR (${ext.evidence}) — its tests fail merging with the base.`,
      };
    case 'cancelled':
      return {
        variant: { ...base, icon: AlertTriangle, tone: 'amber' },
        title: `This PR was cancelled in ${provider}'s merge queue (${ext.evidence}).`,
      };
    case 'merged':
      return {
        variant: { icon: GitMerge, label: 'Merged', tone: 'purple' },
        title: `${provider} merged this PR.`,
      };
    case 'not_ready': {
      // The one queue state that is ABOUT the PR rather than about the queue:
      // trunk has the submission and says it "will be added to the merge queue
      // once all branch protection rules pass". On a repo like posthog that
      // covers the entire ~40-minute CI run, so it is the ordinary state of
      // every submitted PR — and overriding "1/201 running" with an amber
      // "Queue: not ready" turned every ordinary wait into something that read
      // like it needed a human, on seven PRs at once.
      //
      // So when the PR itself explains the wait, let it: those verdicts ARE
      // the branch protection trunk is waiting on, and they say which part.
      // Only on a PR with nothing left to report does the queue add anything.
      const prSaysWhy =
        own.checks.inProgress > 0 ||
        own.checks.failed > 0 ||
        own.blockingReason === 'merge_conflicts' ||
        own.blockingReason === 'changes_requested' ||
        own.blockingReason === 'needs_human';
      if (prSaysWhy) return null;
      return {
        variant: { ...base, icon: Clock, tone: 'amber' },
        title: `${provider}'s merge queue is holding this PR until it meets the merge requirements (${ext.evidence}).`,
      };
    }
    case 'passed':
      return {
        variant: { ...base, icon: CheckCircle2, tone: 'green' },
        title: `${provider}'s merge queue passed this PR (${ext.evidence}) — merging shortly.`,
      };
    default:
      return {
        variant: { ...base, icon: Loader2, spin: ext.state === 'testing' },
        title: `This PR is in ${provider}'s merge queue (${ext.evidence}) — it merges when the queue's tests pass.`,
      };
  }
}

/**
 * 5-segment progress bar — passed / failed / in-progress / skipped /
 * remaining. Rendered next to the pill so the user sees the
 * breakdown at a glance without opening the detail panel.
 *
 * Segments are proportional to `checks.total`. Zero-width segments
 * collapse so e.g. an all-passing PR shows a single solid green bar.
 */
function CheckRollupBar({
  checks,
  optionalFailures = false,
}: {
  checks: PRChecks;
  optionalFailures?: boolean;
}) {
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
      // Non-required failures read amber, not red — they don't block.
      bg: optionalFailures ? 'bg-amber-500' : 'bg-red-500',
      title: `${checks.failed} failed${optionalFailures ? ' (not required)' : ''}`,
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

/**
 * The CI picture from the backend's own `ciStatus`. Required-ness was decided
 * per check where the data is, so nothing here guesses it.
 */
function ciVariant(ciStatus: PRCiStatus, checks: PRChecks): PillVariant {
  switch (ciStatus) {
    case 'failing_required':
      return pickVariant('checks_failed', checks);
    case 'failing_optional':
      return pickVariant('checks_failed_optional', checks);
    case 'needs_human':
      return NEEDS_HUMAN;
    case 'running':
      // Running never includes a blocking failure, but can include an optional
      // one — draw that as the running spinner with the amber marks, not the
      // red the 'mergeable' stale-verdict guard would pick for `failed > 0`.
      return pickVariant(checks.failed > 0 ? 'checks_failed_optional' : 'mergeable', checks);
    case 'passing':
    case 'none':
    default:
      // 'mergeable' draws the running spinner while checks run and Ready once
      // they are done — the CI half of what this pill says.
      return pickVariant('mergeable', checks);
  }
}

// Verdicts that describe CI or reviews, which `ciStatus` answers better when
// approval has its own column. Conflicts, behind and unknown still describe
// the PR itself, so they keep their own pills.
const CI_DESCRIBED: ReadonlySet<PRBlockingReason> = new Set<PRBlockingReason>([
  'mergeable',
  'checks_failed',
  'checks_failed_optional',
  'changes_requested',
  'blocked',
]);

function pickVariant(
  blockingReason: PRBlockingReason,
  checks: PRChecks,
  hideReviewState = false,
  mergeStateStatus?: string,
  reviewDecision?: string | null,
  ciStatus?: PRCiStatus
): PillVariant {
  if (blockingReason === 'needs_human') return NEEDS_HUMAN;
  if (hideReviewState && ciStatus && CI_DESCRIBED.has(blockingReason)) {
    return ciVariant(ciStatus, checks);
  }
  // When approval lives in its own column, the review-related verdicts
  // ('changes_requested', 'blocked'-on-review) shouldn't drive this pill
  // — fall back to the conflicts/CI/mergeability picture instead. This is
  // the path for rows written before `ciStatus` existed.
  if (
    hideReviewState &&
    (blockingReason === 'changes_requested' || blockingReason === 'blocked')
  ) {
    let ciReason: PRBlockingReason;
    if (checks.failed === 0) {
      ciReason = 'mergeable';
    } else if (blockingReason === 'blocked') {
      // 'blocked' does NOT mean the failures are non-required: a held verdict
      // is not re-derived when a check fails later, and PostHog reports
      // BLOCKED on every PR. Without per-check data, draw it red — a wrong
      // red costs a click, a wrong green hides a broken required check.
      ciReason = 'checks_failed';
    } else {
      // changes_requested masks the CI verdict (it short-circuits before
      // checks are weighed), so we can't tell required from not — fall back
      // to the mergeStateStatus heuristic (UNSTABLE ⇒ non-required).
      ciReason =
        mergeStateStatus?.toUpperCase() === 'UNSTABLE'
          ? 'checks_failed_optional'
          : 'checks_failed';
    }
    return pickVariant(ciReason, checks);
  }
  switch (blockingReason) {
    case 'merge_conflicts':
      return { icon: AlertTriangle, label: 'Conflicts', tone: 'red' };
    case 'changes_requested':
      return { icon: AlertTriangle, label: 'Changes requested', tone: 'amber' };
    case 'checks_failed':
      // 'checks_failed' means at least one check is failing. If the failing
      // count is 0 the verdict is stale relative to the counts — the last
      // failing check re-ran green and a partial summary update refreshed
      // `checks` before `blockingReason` caught up (the row store shallow-merges
      // summaries). A red "0/N failing" pill is self-contradictory; render the
      // mergeable picture (Ready, or a running spinner) so label and tone agree.
      if (checks.failed === 0) {
        return pickVariant('mergeable', checks);
      }
      return {
        icon: XCircle,
        label: `${checks.failed}/${checks.total} failing`,
        tone: 'red',
      };
    case 'checks_failed_optional':
      // Mergeable despite failing checks — none are required. A running spinner
      // still wins if some checks haven't finished; otherwise it reads green
      // (the PR can merge), with the label noting the non-required failures and
      // the rollup bar drawing those reds in amber so the detail isn't lost.
      if (checks.inProgress > 0) {
        return {
          icon: Loader2,
          label: `${checks.inProgress}/${checks.total} running`,
          tone: 'blue',
          spin: true,
          optionalFailures: true,
        };
      }
      return {
        icon: CheckCircle2,
        label: `${checks.failed} non-required`,
        tone: 'green',
        optionalFailures: true,
      };
    case 'mergeable':
      // A 'mergeable' verdict implies zero failing checks — the backend never
      // derives 'mergeable' with failures. So `failed > 0` here is a stale
      // verdict: an incremental {checks}-only update advanced the counts before
      // the verdict caught up (mirror of the checks_failed/0-failing guard
      // above). The backend reconciles this at the source; this is the render
      // backstop so an already-loaded row can't flash a green "Ready" beside
      // failing checks. UNSTABLE ⇒ the failures aren't required.
      if (checks.failed > 0) {
        return pickVariant(
          mergeStateStatus?.toUpperCase() === 'UNSTABLE'
            ? 'checks_failed_optional'
            : 'checks_failed',
          checks,
          hideReviewState,
          mergeStateStatus
        );
      }
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
      // Held by branch protection. If required checks are still running, that's
      // the immediate gate — GitHub reports mergeStateStatus BLOCKED while the
      // rollup is PENDING even on an already-approved PR — so show the running
      // spinner rather than a misleading "Review". Once checks finish, a genuine
      // review/approval hold falls through to "Review".
      if (checks.inProgress > 0) {
        return {
          icon: Loader2,
          label: `${checks.inProgress}/${checks.total} running`,
          tone: 'blue',
          spin: true,
        };
      }
      // BLOCKED covers every branch-protection hold, not just reviews. On an
      // already-APPROVED PR the hold is something else (required signatures,
      // merge restrictions, GitHub's own merge queue) — "Review" would be a
      // lie there (the 2026-07-17 merge-queue-page report). Say "Protected".
      if (reviewDecision === 'APPROVED') {
        return { icon: ShieldAlert, label: 'Protected', tone: 'amber' };
      }
      return { icon: Eye, label: 'Review', tone: 'amber' };
    case 'behind':
      // Still amber rather than red: nothing is broken, the head just has to
      // catch up, and GitHub's own "Update branch" button (which the merge
      // queue presses for a queued PR) is the whole fix.
      return { icon: ArrowDownToLine, label: 'Behind', tone: 'amber' };
    case 'unknown':
    default:
      return { icon: HelpCircle, label: '—', tone: 'grey' };
  }
}

function titleFor(
  blockingReason: PRBlockingReason,
  checks: PRChecks,
  reviewDecision?: string | null,
  humanGates?: PRHumanGate[]
): string {
  const checkSummary =
    checks.total === 0
      ? 'no checks'
      : `${checks.passed} passed · ${checks.failed} failed · ${checks.inProgress} running · ${checks.skipped} skipped`;
  const reason =
    blockingReason === 'blocked' && reviewDecision === 'APPROVED'
      ? 'Approved, but held by branch protection (required signatures / merge restrictions)'
      : blockingReason === 'needs_human'
        ? humanGateReason(humanGates)
        : humanReason(blockingReason);
  return `${reason} · ${checkSummary}`;
}

function humanGateReason(gates: PRHumanGate[] | undefined): string {
  if (!gates || gates.length === 0) return 'A check needs a person to approve it';
  const names = gates.map((g) => `${g.label} (${g.name})`).join(', ');
  const url = gates.find((g) => g.url)?.url;
  return `Needs a person: ${names} — an agent cannot approve it${url ? `. Approve at ${url}` : ''}`;
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
      return 'Required CI checks failing';
    case 'checks_failed_optional':
      return 'Mergeable — only non-required checks failing';
    case 'needs_human':
      return 'A check needs a person to approve it';
    case 'blocked':
      return 'Waiting on required review';
    case 'behind':
      return 'Behind the base branch — this repo requires it to be up to date before merging';
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
