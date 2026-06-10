import React, { useState } from 'react';
import {
  ExternalLink,
  GitMerge,
  Loader2,
  Copy,
  Check,
  Bot,
  MessageSquare,
  Users,
  AtSign,
  Eye,
  AlertTriangle,
  ListChecks,
} from 'lucide-react';
import type { PRRow, PRSummaryShape } from '../../../lib/api';
import { type TaskStatus, prNeedsFollowup } from '@fastowl/shared';
import { PRStatusPill } from '../../widgets/PRStatusPill';
import { PRReviewPill } from '../../widgets/PRReviewPill';
import { cn } from '../../../lib/utils';
import { toast } from '../../../stores/toast';

/**
 * Shared PR table used by all three GitHub pages. The `variant` picks the
 * second column:
 *   - 'mine'   → CI/review status pills (My PRs)
 *   - 'review' → who requested your review (Reviews)
 *   - 'queue'  → queue position + status (Merge Queue)
 * Extracted from the old single GitHubPanel so the pages share one row layout.
 */
export type PRTableVariant = 'mine' | 'review' | 'queue';

interface PRTableProps {
  rows: PRRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenTask: (taskId: string) => void;
  onMerge: (row: PRRow) => Promise<void>;
  onSetMergeQueue: (row: PRRow, enabled: boolean) => Promise<void>;
  onCreatePostHogTask: (row: PRRow) => Promise<void>;
  /** PostHog Code is configured + a cloud env exists to dispatch to. */
  posthogEnabled: boolean;
  /** Live status of each linked task, keyed by task id. */
  taskStatusById: Map<string, TaskStatus>;
  variant: PRTableVariant;
  viewerLogin: string | null;
}

export function PRTable({
  rows,
  selectedId,
  onSelect,
  onOpenTask,
  onMerge,
  onSetMergeQueue,
  onCreatePostHogTask,
  posthogEnabled,
  taskStatusById,
  variant,
  viewerLogin,
}: PRTableProps) {
  // The queue tab splits its second column into Queue (position/state) + Status
  // (PR readiness pill); every other variant keeps a single second column.
  const secondColLabel = variant === 'review' ? 'Requested' : 'Status';
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-background text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-4 py-2 text-left font-medium">Title</th>
          {variant === 'queue' && (
            <th className="px-2 py-2 text-left font-medium">Queue</th>
          )}
          <th className="px-2 py-2 text-left font-medium">{secondColLabel}</th>
          <th className="px-2 py-2 text-left font-medium">Updated</th>
          <th className="w-8 px-2 py-2"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <PRTableRow
            key={row.id}
            row={row}
            variant={variant}
            viewerLogin={viewerLogin}
            isSelected={row.id === selectedId}
            onSelect={() => onSelect(row.id)}
            onOpenTask={onOpenTask}
            onMerge={onMerge}
            onSetMergeQueue={onSetMergeQueue}
            onCreatePostHogTask={onCreatePostHogTask}
            posthogEnabled={posthogEnabled}
            taskStatus={row.taskId ? taskStatusById.get(row.taskId) : undefined}
          />
        ))}
      </tbody>
    </table>
  );
}

function PRTableRow({
  row,
  variant,
  viewerLogin,
  isSelected,
  onSelect,
  onOpenTask,
  onMerge,
  onSetMergeQueue,
  onCreatePostHogTask,
  posthogEnabled,
  taskStatus,
}: {
  row: PRRow;
  variant: PRTableVariant;
  viewerLogin: string | null;
  isSelected: boolean;
  onSelect: () => void;
  onOpenTask: (taskId: string) => void;
  onMerge: (row: PRRow) => Promise<void>;
  onSetMergeQueue: (row: PRRow, enabled: boolean) => Promise<void>;
  onCreatePostHogTask: (row: PRRow) => Promise<void>;
  posthogEnabled: boolean;
  /** Live status of the row's linked task, if any is loaded. */
  taskStatus?: TaskStatus;
}) {
  const summary = row.summary;
  const updatedTooltip = new Date(summary.updatedAt || row.lastPolledAt).toLocaleString();
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [busy, setBusy] = useState<null | 'merge' | 'posthog' | 'queue'>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Brief confirmation flash after a PostHog Code run is kicked off — we
  // stay on the GitHub page, so this is the only signal it started.
  const [posthogStarted, setPosthogStarted] = useState(false);
  // Mergeable covers the clean case AND "mergeable, but only non-required
  // checks are failing" — GitHub lets you merge both.
  const canMerge =
    row.state === 'open' &&
    (summary.blockingReason === 'mergeable' ||
      summary.blockingReason === 'checks_failed_optional');
  const unresolved = summary.unresolvedReviewThreads ?? 0;
  const requested = variant === 'review' ? reviewRequestLabel(summary, viewerLogin) : null;

  // A linked task is "active" while it's queued or running — i.e. not yet
  // fully done. Drives the row's in-progress indicator and suppresses the
  // start-task buttons so you can't double-launch.
  const taskRunning =
    taskStatus === 'pending' || taskStatus === 'queued' || taskStatus === 'in_progress';
  // taskStatus is undefined when the task isn't loaded in the store — keep
  // the link visible (plain badge) rather than guessing it's done.
  const taskActive = taskRunning || (!!row.taskId && !taskStatus);

  // A follow-up run only makes sense on an open PR with something to fix,
  // and not while one is already working it.
  const canFollowUp =
    posthogEnabled && row.state === 'open' && prNeedsFollowup(summary) && !taskActive;

  function copyBranch(e: React.MouseEvent) {
    e.stopPropagation();
    void navigator.clipboard.writeText(summary.headBranch).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  async function runMerge(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy('merge');
    setRowError(null);
    try {
      await onMerge(row);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Merge failed';
      setRowError(message);
      // Surface *why* it failed — GitHub's message (e.g. "Pull Request is
      // not mergeable", "At least 1 approving review is required") is the
      // useful part. Previously this only lived in a hover tooltip.
      toast.error(
        `Couldn't merge ${row.owner}/${row.repo}#${row.number}`,
        friendlyMergeError(message)
      );
      setConfirmMerge(false);
    } finally {
      setBusy(null);
    }
  }

  async function runToggleQueue(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy('queue');
    setRowError(null);
    try {
      await onSetMergeQueue(row, !row.mergeQueued);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not update merge queue');
    } finally {
      setBusy(null);
    }
  }

  async function runCreatePostHogTask(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy('posthog');
    setRowError(null);
    try {
      await onCreatePostHogTask(row);
      setPosthogStarted(true);
      setTimeout(() => setPosthogStarted(false), 2000);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not start PostHog Code task');
    } finally {
      setBusy(null);
    }
  }
  return (
    <tr
      className={cn(
        'group cursor-pointer border-b transition-colors hover:bg-muted/40 focus:bg-muted/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isSelected && 'bg-muted/40'
      )}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <td className="px-4 py-2">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 truncate font-medium">
            <span className="truncate">{summary.title || '(no title)'}</span>
          </span>
          <span className="text-xs text-muted-foreground">
            {row.owner}/{row.repo}#{row.number} · @{summary.author || 'unknown'}
            {(summary.createdAt || row.createdAt) && (
              <span title={`Opened ${new Date(summary.createdAt || row.createdAt).toLocaleString()}`}>
                {' · opened '}
                {formatRelative(summary.createdAt || row.createdAt)}
              </span>
            )}
            {summary.draft && (
              <span className="ml-2 rounded bg-zinc-200 px-1 py-0.5 text-[10px] uppercase text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300">
                Draft
              </span>
            )}
            {row.reviewRequested && (
              <span
                className="ml-2 rounded bg-purple-200 px-1 py-0.5 text-[10px] uppercase text-purple-800 dark:bg-purple-900 dark:text-purple-200"
                title="You're a requested reviewer on this PR"
              >
                Review
              </span>
            )}
            {/* Linked-task indicator. Shows while a fix task is running
                ("Working"); deep-links to the task. Disappears once the
                task is fully done (completed / failed / cancelled). */}
            {row.taskId && taskActive && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenTask(row.taskId!);
                }}
                className="ml-2 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] uppercase bg-blue-200 text-blue-800 hover:bg-blue-300 dark:bg-blue-900 dark:text-blue-200 dark:hover:bg-blue-800"
                title={
                  taskRunning
                    ? 'A task is working this PR — click to open it'
                    : 'Open the linked task'
                }
              >
                {taskRunning ? (
                  <>
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    Working
                  </>
                ) : (
                  'Task'
                )}
              </button>
            )}
            {/* Auto-keep-mergeable watcher indicator. "Watching" while armed,
                "Paused" once it's given up after 3 attempts. */}
            {row.autoKeepMergeable &&
              (row.autoMergeState?.paused ? (
                <span
                  className="ml-2 inline-flex items-center gap-1 rounded bg-amber-200 px-1 py-0.5 text-[10px] uppercase text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                  title="Auto-keep-mergeable paused after 3 attempts — needs attention"
                >
                  <AlertTriangle className="h-2.5 w-2.5" />
                  Paused
                </span>
              ) : (
                <span
                  className="ml-2 inline-flex items-center gap-1 rounded bg-emerald-200 px-1 py-0.5 text-[10px] uppercase text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200"
                  title="Auto-keep-mergeable is on — keeping this PR in a mergeable state"
                >
                  <Eye className="h-2.5 w-2.5" />
                  Watching
                </span>
              ))}
            {/* Merge-queue indicator. The membership badge ("Queued #N") stays
                visible the whole time the PR is in the queue; an activity badge
                (Merging / Blocked) sits alongside it. We deliberately DON'T show
                a "Fixing" badge — when a cloud run is clearing blockers the
                linked-task "Working" badge above already says so, so a separate
                Fixing chip would be redundant. On the Merge Queue page the
                Queue column carries this, so we skip the title badge there. */}
            {variant !== 'queue' &&
              row.mergeQueued &&
              (() => {
                const qs = row.mergeQueueState?.status ?? 'waiting';
                const pos = row.mergeQueueState?.position ?? 0;
                const reason = row.mergeQueueState?.reason;
                return (
                  <>
                    <span
                      className="ml-2 inline-flex items-center gap-1 rounded bg-indigo-200 px-1 py-0.5 text-[10px] uppercase text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200"
                      title="In the merge queue — merges automatically when it's its turn and clean"
                    >
                      <GitMerge className="h-2.5 w-2.5" />
                      {pos > 0 ? `Queued #${pos}` : 'Queued'}
                    </span>
                    {qs === 'merging' && (
                      <span
                        className="ml-1 inline-flex items-center gap-1 rounded bg-blue-200 px-1 py-0.5 text-[10px] uppercase text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                        title="Merging this PR now"
                      >
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                        Merging
                      </span>
                    )}
                    {qs === 'blocked' && (
                      <span
                        className="ml-1 inline-flex items-center gap-1 rounded bg-amber-200 px-1 py-0.5 text-[10px] uppercase text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                        title={
                          reason
                            ? `Merge queue gave up after 3 attempts — ${reason}. Needs manual intervention.`
                            : 'Merge queue gave up after 3 attempts — needs manual intervention'
                        }
                      >
                        <AlertTriangle className="h-2.5 w-2.5" />
                        Blocked
                      </span>
                    )}
                  </>
                );
              })()}
          </span>
        </div>
      </td>
      {variant === 'review' ? (
        <td className="px-2 py-2 text-xs">
          {requested ? (
            <span
              className="inline-flex items-center gap-1 text-muted-foreground"
              title={
                requested.direct
                  ? 'You were asked to review directly'
                  : `Requested via team ${requested.label.slice(1)}${
                      requested.extra > 0 ? ` (+${requested.extra} more)` : ''
                    }`
              }
            >
              {requested.direct ? (
                <AtSign className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Users className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{requested.label}</span>
              {requested.extra > 0 && <span className="opacity-70">+{requested.extra}</span>}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
      ) : variant === 'queue' ? (
        <>
          <QueueCell row={row} />
          <td className="px-2 py-2">
            <PRStatusPill
              blockingReason={summary.blockingReason}
              checks={summary.checks}
              mergeStateStatus={summary.mergeStateStatus}
              state={row.state}
            />
          </td>
        </>
      ) : (
        <td className="px-2 py-2">
          <div className="flex items-center gap-1.5">
            <PRReviewPill
              reviewDecision={summary.effectiveReviewDecision ?? summary.reviewDecision}
              state={row.state}
              minimal
            />
            <PRStatusPill
              blockingReason={summary.blockingReason}
              checks={summary.checks}
              mergeStateStatus={summary.mergeStateStatus}
              state={row.state}
              hideReviewState
            />
            {row.state === 'open' && unresolved > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
                title={`${unresolved} unresolved review ${unresolved === 1 ? 'comment' : 'comments'}`}
              >
                <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                {unresolved}
              </span>
            )}
          </div>
        </td>
      )}
      <td className="px-2 py-2 text-xs text-muted-foreground" title={updatedTooltip}>
        {formatRelative(summary.updatedAt || row.lastPolledAt)}
      </td>
      <td className="px-2 py-2" title={rowError ?? undefined}>
        <div className="flex items-center justify-end gap-1">
          {/* Row actions reveal on hover/focus to keep the table calm.
              Merge, merge-queue, and "get mergeable" are owner actions, so
              they're hidden on the Reviews page (you're reviewing someone
              else's PR there). */}
          {variant !== 'review' && row.state === 'open' && (
            <button
              type="button"
              onClick={runToggleQueue}
              disabled={busy !== null}
              className={cn(
                'rounded p-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                row.mergeQueued
                  ? 'text-indigo-600 hover:bg-indigo-500/10 dark:text-indigo-400'
                  : 'text-muted-foreground opacity-0 hover:bg-indigo-500/10 hover:text-indigo-600 focus:opacity-100 group-hover:opacity-100 dark:hover:text-indigo-400'
              )}
              title={
                row.mergeQueued
                  ? 'Remove from the merge queue'
                  : 'Add to the merge queue — merges automatically when clean, auto-fixing conflicts'
              }
            >
              {busy === 'queue' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListChecks className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {variant !== 'review' &&
            canMerge &&
            (confirmMerge ? (
              <button
                type="button"
                onClick={runMerge}
                disabled={busy !== null}
                className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400"
                title="Confirm squash-merge"
              >
                {busy === 'merge' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  'Confirm'
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmMerge(true);
                }}
                className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-emerald-500/10 hover:text-emerald-600 focus:opacity-100 group-hover:opacity-100"
                title="Merge this PR"
              >
                <GitMerge className="h-3.5 w-3.5" />
              </button>
            ))}
          {variant !== 'review' && posthogEnabled && row.state === 'open' && (
            <button
              type="button"
              onClick={runCreatePostHogTask}
              disabled={!canFollowUp || busy !== null}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-violet-500/10 hover:text-violet-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground dark:hover:text-violet-400"
              title={
                posthogStarted
                  ? 'PostHog Code run started — see the Tasks panel'
                  : taskActive
                  ? 'A task is already working this PR — open it from the Working/Review badge'
                  : canFollowUp
                  ? 'Get this PR mergeable with PostHog Code (resolve comments, fix CI, resolve conflicts)'
                  : 'Nothing to fix — no conflicts, failing checks, or unresolved review comments'
              }
            >
              {busy === 'posthog' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : posthogStarted ? (
                <Check className="h-3.5 w-3.5 text-emerald-600" />
              ) : (
                <Bot className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={copyBranch}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title={copied ? 'Copied!' : `Copy branch: ${summary.headBranch}`}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
          <a
            href={summary.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title="Open on GitHub"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </td>
    </tr>
  );
}

/** The Merge Queue page's second column: position + coarse status + reason. */
function QueueCell({ row }: { row: PRRow }) {
  const qs = row.mergeQueueState?.status ?? 'waiting';
  const pos = row.mergeQueueState?.position ?? 0;
  const reason = row.mergeQueueState?.reason;
  return (
    <td className="px-2 py-2 text-xs">
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-foreground">{pos > 0 ? `#${pos}` : '—'}</span>
        {qs === 'merging' ? (
          <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Merging
          </span>
        ) : qs === 'blocked' ? (
          <span
            className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"
            title={
              reason
                ? `Merge queue gave up after 3 attempts — ${reason}. Needs manual intervention.`
                : 'Merge queue gave up after 3 attempts — needs manual intervention'
            }
          >
            <AlertTriangle className="h-3 w-3" />
            Blocked
          </span>
        ) : qs === 'fixing' ? (
          <span className="inline-flex items-center gap-1 text-violet-700 dark:text-violet-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Fixing
          </span>
        ) : (
          <span className="text-muted-foreground">Waiting</span>
        )}
      </div>
    </td>
  );
}

/**
 * How the viewer was asked to review, for the Review tab's "Requested"
 * column. A direct request wins over a team one. Returns the primary label
 * (your @handle, or the first team's `@org/team`) plus the count of any
 * additional teams, or null when we have no request info (older cached rows).
 */
export function reviewRequestLabel(
  summary: PRSummaryShape,
  viewerLogin: string | null
): { label: string; extra: number; direct: boolean } | null {
  const via = summary.reviewRequestVia;
  if (!via) return null;
  if (via.direct) return { label: `@${viewerLogin ?? 'you'}`, extra: 0, direct: true };
  if (via.teams.length > 0)
    return { label: `@${via.teams[0]}`, extra: via.teams.length - 1, direct: false };
  return null;
}

/**
 * Searchable text for a row's review request, so the search box can filter
 * the Review tab by team name or "direct"/your handle.
 */
export function reviewRequestSearchText(
  summary: PRSummaryShape,
  viewerLogin: string | null
): string {
  const via = summary.reviewRequestVia;
  if (!via) return '';
  const parts: string[] = [];
  if (via.direct) parts.push('direct', 'you', viewerLogin ?? '');
  parts.push(...via.teams);
  return parts.join(' ').toLowerCase();
}

/** A PR has a blocking issue the user should act on. */
export function isNeedsAttention(r: PRRow): boolean {
  return (
    r.summary.blockingReason === 'changes_requested' ||
    r.summary.blockingReason === 'checks_failed' ||
    r.summary.blockingReason === 'merge_conflicts'
  );
}

/**
 * A (non-draft) PR you authored that's still waiting on a review from others —
 * GitHub says a review is required and one hasn't landed yet. Uses the same
 * effective-vs-raw decision the table badge shows.
 */
export function isAwaitingReview(r: PRRow): boolean {
  if (r.summary.draft) return false;
  const decision = r.summary.effectiveReviewDecision ?? r.summary.reviewDecision;
  return decision === 'REVIEW_REQUIRED';
}

/**
 * Make a GitHub merge error readable in a toast. Strips the noisy
 * "GitHub API error 405 Method Not Allowed:" prefix the backend prepends,
 * and adds a nudge for the most common (and most cryptic) case.
 */
function friendlyMergeError(message: string): string {
  const cleaned = message.replace(/^GitHub API error \d+[^:]*:\s*/i, '').trim() || message;
  if (/not mergeable/i.test(cleaned)) {
    return `${cleaned}. The PR may have new conflicts, failing required checks, or pending required reviews — refresh and check its status.`;
  }
  return cleaned;
}

/** Small relative-time helper; no dependency on date-fns. */
export function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
