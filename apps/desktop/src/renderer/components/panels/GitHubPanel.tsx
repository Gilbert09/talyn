import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Github,
  Settings,
  Search,
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  GitMerge,
  ListPlus,
  Loader2,
  ArrowUpDown,
  Copy,
  Check,
  X,
  Bot,
  MessageSquare,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { useTaskActions } from '../../hooks/useApi';
import { api, type PRRow, type PRSummaryShape, type PRState } from '../../lib/api';
import type { TaskStatus } from '@fastowl/shared';
import { PRStatusPill } from '../widgets/PRStatusPill';
import { PRReviewPill } from '../widgets/PRReviewPill';
import { PRDetailSheet } from '../widgets/PRDetailSheet';
import { cn } from '../../lib/utils';

/**
 * The GitHub page — every user-authored PR across watched repos at a
 * glance. Phase 5 of the rebuild:
 *
 *   - Filter bar: state, repo, search, "needs attention" toggle, with
 *     live counts on the state pills.
 *   - Table: title, author, branch refs, status pill (5-segment
 *     check rollup inline), updated time. Sortable by updated; rows are
 *     keyboard-navigable and the Task badge deep-links to its task.
 *   - Side-sheet: opens on row click. Same component the task screen
 *     uses, with in-app file diffs, per-check breakdown, and merge.
 *
 * Refresh triggers a real GitHub force-poll, not just a cache re-read.
 * Subscribes to `pull_request:updated` to patch rows in place — no
 * full refetch on every WS event.
 */

/**
 * A PR has something a PostHog Code follow-up run could fix: merge
 * conflicts, requested changes, failing CI, or unresolved review
 * threads. Drives whether the "Get PR mergeable" button is enabled.
 */
function prNeedsFollowup(s: PRSummaryShape): boolean {
  return (
    s.blockingReason === 'merge_conflicts' ||
    s.blockingReason === 'changes_requested' ||
    s.blockingReason === 'checks_failed' ||
    s.mergeable === 'CONFLICTING' ||
    s.reviewDecision === 'CHANGES_REQUESTED' ||
    (s.unresolvedReviewThreads ?? 0) > 0 ||
    s.checks.failed > 0
  );
}

/** Bulleted list of the issues we detected, for the agent prompt. */
function buildIssuesSummary(s: PRSummaryShape): string {
  const lines: string[] = [];
  if (s.blockingReason === 'merge_conflicts' || s.mergeable === 'CONFLICTING') {
    lines.push('- Merge conflicts with the base branch');
  }
  if ((s.unresolvedReviewThreads ?? 0) > 0) {
    lines.push(`- Unresolved review threads: ${s.unresolvedReviewThreads}`);
  }
  if (s.reviewDecision === 'CHANGES_REQUESTED') {
    lines.push('- A reviewer has requested changes');
  }
  if (s.checks.failed > 0) {
    lines.push(`- Failing CI checks: ${s.checks.failed}/${s.checks.total}`);
  }
  return lines.length > 0
    ? lines.join('\n')
    : '- (Re-fetch the PR to confirm the current issues.)';
}

/**
 * The "take this PR to a clean, mergeable state" prompt handed to a
 * PostHog Code cloud run. Modelled on the task-script follow-up prompt:
 * resolve every reviewer comment, get CI green, and resolve conflicts,
 * looping until all three hold on the latest commit.
 */
function buildPostHogPrompt(row: PRRow): string {
  const s = row.summary;
  const ref = `${row.owner}/${row.repo}#${row.number}`;
  return `You are taking a pull request to a fully clean, mergeable state.

Pull request: ${s.url}
Repository: ${row.owner}/${row.repo}
PR number: #${row.number}
Branch: ${s.headBranch}

Current issues detected (verify by re-fetching — state may have changed since this task was created):
${buildIssuesSummary(s)}

Your job is to keep iterating on this PR until ALL of the following are true and stay true:

1. Every reviewer comment is resolved.
   - For each unresolved review comment / review thread on the PR (top-level review comments AND inline code review threads):
     a. Read the comment carefully and understand what the reviewer is asking for.
     b. If the feedback is correct or reasonable: implement the requested change in code, push the fix, then mark the thread as resolved.
     c. If you disagree with the feedback: reply to the thread on GitHub explaining your reasoning clearly and respectfully, then mark the thread as resolved.
     d. Do NOT silently ignore a comment. Every thread must end either with a code change you pushed, or with a reply from you, and in both cases the thread must be marked resolved.
   - Re-fetch review comments after pushing changes — reviewers may have left new feedback while you were working.

2. CI is fully green on the latest commit of the PR branch.
   - Inspect the check runs / status checks via \`gh pr checks\` (or the GitHub API).
   - If any required check is failing, investigate the failure (logs, test output) and fix the underlying problem in code. Push the fix.
   - Flaky tests: re-run them once to confirm they're actually flaky; if they are, document it briefly in a PR comment, but otherwise still try to fix the root cause rather than ignoring it.
   - Do not bypass checks (no --no-verify, no skipping required checks). Fix the real issue.

3. The branch merges cleanly into its base branch (no merge conflicts).
   - Check mergeability via \`gh pr view ${row.number} --json mergeable,mergeStateStatus\`.
   - If the branch is CONFLICTING / DIRTY, update it by MERGING the base branch IN. Do NOT rebase:
       git fetch origin ${s.baseBranch}
       git merge origin/${s.baseBranch}
     Then resolve each conflict by hand and commit the merge.
   - CRITICAL — do NOT rebase, reset, cherry-pick, squash, amend existing commits, or force-push this branch. Rebasing rewrites the PR's history and is what drags unrelated/duplicate commits and changes into the PR. Only ever merge in the PR's own base branch (\`origin/${s.baseBranch}\`) — never any other branch.
   - Resolve ONLY the genuine conflicts. Preserve the intent of both sides; never blindly discard the PR's changes or the base's. The update must add nothing beyond (a) one merge commit and (b) your conflict resolutions — no unrelated files, commits, or edits.
   - Before pushing, verify you didn't pull in stray changes: \`git diff origin/${s.baseBranch}...HEAD\` should show ONLY this PR's intended changes (plus conflict resolutions). If you see unrelated changes, abort the merge (\`git merge --abort\` / reset to \`origin/${s.headBranch}\`) and redo it cleanly.
   - After resolving, re-run the build/tests locally where feasible, then push (a normal \`git push\`, no \`--force\`). Resolving conflicts can re-trigger CI and reopen review threads, so re-check conditions (1) and (2) afterwards.

Loop discipline:
  - After every push, wait for CI to finish, then re-check all of: (1) review comments, (2) check status, and (3) mergeability.
  - Do not stop, do not declare victory, and do not hand control back until ALL conditions are simultaneously true on the latest commit.
  - If you genuinely get stuck (e.g. you need credentials you don't have, or a reviewer's request is impossible without product-level decisions), leave a clear PR comment describing exactly what you need and why, then stop. Otherwise keep going.

Start by checking out the PR branch (${ref}), fetching the current state of review threads and CI, and then work the loop until done.`;
}

type StateFilter = 'open' | 'closed' | 'merged' | 'all';
type RelationshipFilter = 'all' | 'authored' | 'review_requested';
type SortDir = 'asc' | 'desc';

const RELATIONSHIP_OPTIONS: Array<{ value: RelationshipFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'authored', label: 'Mine' },
  { value: 'review_requested', label: 'Review' },
];

const STATE_OPTIONS: Array<{ value: StateFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

export function GitHubPanel() {
  const { setActivePanel, currentWorkspaceId, repositories, environments, selectTask, tasks } =
    useWorkspaceStore();
  const { createTask } = useTaskActions();
  const [rows, setRows] = useState<PRRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  // Relationship is filtered client-side off each row's `reviewRequested`
  // flag (no refetch), so the All/Mine/Review pills can all show counts.
  const [relationship, setRelationship] = useState<RelationshipFilter>('authored');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [needsAttention, setNeedsAttention] = useState(false);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // null = not yet checked. Distinguishes "GitHub disconnected" from
  // "connected but no PRs" so the empty state isn't misleading.
  const [connected, setConnected] = useState<boolean | null>(null);
  // Whether PostHog Code (cloud tasks) is configured for this workspace.
  // Gates the "Get PR mergeable" follow-up button.
  const [posthogConnected, setPosthogConnected] = useState(false);

  // The auto-provisioned cloud env a follow-up task gets assigned to.
  const posthogEnvId = useMemo(
    () => environments.find((e) => e.type === 'posthog_code')?.id ?? null,
    [environments]
  );
  const posthogEnabled = posthogConnected && posthogEnvId !== null;

  // Connection status — drives the "Connect GitHub" CTA vs the empty list.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let cancelled = false;
    api.github
      .getStatus(currentWorkspaceId)
      .then((s) => {
        if (!cancelled) setConnected(s.connected);
      })
      .catch(() => {
        if (!cancelled) setConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId]);

  // PostHog Code connection status — gates the follow-up task button.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let cancelled = false;
    api.posthog
      .getStatus(currentWorkspaceId)
      .then((s) => {
        if (!cancelled) setPosthogConnected(s.connected);
      })
      .catch(() => {
        if (!cancelled) setPosthogConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId]);

  // Cmd/Ctrl+F focuses the PR search box. This panel only mounts while the
  // GitHub page is active, so the listener is naturally scoped to it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Initial fetch + refetch on filter change.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.pullRequests
      .list({
        workspaceId: currentWorkspaceId,
        state: stateFilter,
        repo: repoFilter === 'all' ? undefined : repoFilter,
      })
      .then((data) => {
        if (cancelled) return;
        setRows(data);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, stateFilter, repoFilter]);

  // Live updates from the prMonitor.
  useEffect(() => {
    const unsubscribe = api.ws.on('pull_request:updated', (payload) => {
      const p = payload as {
        id: string;
        taskId: string | null;
        state: PRState;
        lastSummary: PRSummaryShape;
      };
      setRows((prev) => {
        const idx = prev.findIndex((r) => r.id === p.id);
        if (idx === -1) {
          // New PR — refetch the whole list rather than hand-merging
          // (we'd need workspaceId/repositoryId to insert, and the
          // backend already enforces ordering by lastPolledAt).
          if (currentWorkspaceId) {
            api.pullRequests
              .list({
                workspaceId: currentWorkspaceId,
                state: stateFilter,
                repo: repoFilter === 'all' ? undefined : repoFilter,
              })
              .then(setRows)
              .catch(() => {});
          }
          return prev;
        }
        const next = prev.slice();
        next[idx] = {
          ...next[idx],
          state: p.state,
          summary: p.lastSummary,
          // Preserve a known link if the echo omits it; adopt a new one
          // when the backend reports it (e.g. just-started fix task).
          taskId: p.taskId ?? next[idx].taskId,
        };
        return next;
      });
    });
    return unsubscribe;
  }, [currentWorkspaceId, stateFilter, repoFilter]);

  // A new inbox item (review/comment/CI) for a watched PR — bump its
  // unread dot live without a refetch. Matched on the PR URL, the same
  // key the backend's unread count uses.
  useEffect(() => {
    const unsubscribe = api.ws.on('inbox:new', (payload) => {
      const url = (payload as { item?: { data?: { prUrl?: string } } })?.item?.data
        ?.prUrl;
      if (!url) return;
      setRows((prev) =>
        prev.map((r) =>
          r.summary.url === url ? { ...r, unreadCount: r.unreadCount + 1 } : r
        )
      );
    });
    return unsubscribe;
  }, []);

  // Open the detail sheet and clear the PR's unread dot (optimistically,
  // plus a backend mark-seen that flips the linked inbox items to read).
  function handleSelect(id: string) {
    setSelectedId(id);
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, unreadCount: 0 } : r))
    );
    void api.pullRequests.markSeen(id).catch(() => {});
  }

  const attentionCount = useMemo(() => rows.filter(isNeedsAttention).length, [rows]);

  // Relationship buckets for the current state+repo set — drive the
  // always-on counts on the All/Mine/Review pills.
  const relationshipCounts = useMemo(
    () => ({
      all: rows.length,
      authored: rows.filter((r) => !r.reviewRequested).length,
      review_requested: rows.filter((r) => r.reviewRequested).length,
    }),
    [rows]
  );

  // Live status of each linked task, so a row can show whether its fix
  // task is still running. Driven by the workspace store, which the WS
  // task:status handler keeps current.
  const taskStatusById = useMemo(() => {
    const m = new Map<string, TaskStatus>();
    for (const t of tasks) m.set(t.id, t.status);
    return m;
  }, [tasks]);

  const filtered = useMemo(() => {
    let out = rows;
    if (relationship === 'authored') {
      out = out.filter((r) => !r.reviewRequested);
    } else if (relationship === 'review_requested') {
      out = out.filter((r) => r.reviewRequested);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => {
        const title = r.summary.title?.toLowerCase() ?? '';
        const repo = `${r.owner}/${r.repo}`.toLowerCase();
        return title.includes(q) || repo.includes(q);
      });
    }
    if (needsAttention) {
      out = out.filter(isNeedsAttention);
    }
    const sorted = out.slice().sort((a, b) => {
      const ta = new Date(a.summary.updatedAt || a.lastPolledAt).getTime();
      const tb = new Date(b.summary.updatedAt || b.lastPolledAt).getTime();
      return sortDir === 'desc' ? tb - ta : ta - tb;
    });
    return sorted;
  }, [rows, relationship, search, needsAttention, sortDir]);

  // Refresh = a real GitHub force-poll, then re-read the freshly-updated
  // cache. The poll also emits WS deltas, but re-listing guarantees the
  // current filter view reflects the new state immediately.
  async function handleRefresh() {
    if (!currentWorkspaceId) return;
    setLoading(true);
    setError(null);
    try {
      await api.repositories.forcePoll();
      const data = await api.pullRequests.list({
        workspaceId: currentWorkspaceId,
        state: stateFilter,
        repo: repoFilter === 'all' ? undefined : repoFilter,
      });
      setRows(data);
      // A successful poll implies a working GitHub connection.
      setConnected(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect() {
    if (!currentWorkspaceId) return;
    try {
      const { authUrl } = await api.github.connect(currentWorkspaceId);
      window.open(authUrl, '_blank', 'width=600,height=700');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start GitHub connect');
    }
  }

  // Squash-merge a PR straight from its row. Re-list afterwards so the
  // merged PR drops out of the Open view.
  async function handleMergeRow(row: PRRow) {
    await api.pullRequests.merge(row.id);
    if (!currentWorkspaceId) return;
    const data = await api.pullRequests.list({
      workspaceId: currentWorkspaceId,
      state: stateFilter,
      repo: repoFilter === 'all' ? undefined : repoFilter,
    });
    setRows(data);
  }

  // Spin up a pr_response task to address a PR, then jump to it.
  async function handleCreateTaskFromPR(row: PRRow) {
    if (!currentWorkspaceId) return;
    const ref = `${row.owner}/${row.repo}#${row.number}`;
    const created = await createTask({
      workspaceId: currentWorkspaceId,
      type: 'pr_response',
      title: `Address ${ref}: ${row.summary.title}`,
      description: `Respond to review feedback / failing checks on ${ref}.`,
      prompt: `Address the open review feedback and any failing checks on PR ${row.summary.url} (${ref}: "${row.summary.title}").`,
      repositoryId: row.repositoryId,
      pullRequestId: row.id,
    });
    // Optimistically link the row so the in-progress indicator shows
    // instantly, ahead of the backend's pull_request:updated echo.
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, taskId: created.id } : r))
    );
    selectTask(created.id);
    setActivePanel('queue');
  }

  // Kick off a PostHog Code cloud run to take the PR to a clean,
  // mergeable state (resolve comments, fix CI, resolve conflicts).
  // Assigns the task to the cloud env so the scheduler dispatches it
  // to PostHog Code rather than a local agent. The run happens entirely
  // in the cloud, so — unlike a local task — there's nothing to watch
  // live; stay on the GitHub page rather than jumping to the task screen.
  async function handleCreatePostHogTask(row: PRRow) {
    if (!currentWorkspaceId || !posthogEnvId) return;
    const ref = `${row.owner}/${row.repo}#${row.number}`;
    const created = await createTask({
      workspaceId: currentWorkspaceId,
      type: 'pr_response',
      title: `Get ${ref} mergeable`,
      description: `Take ${ref} ("${row.summary.title}") to a clean, mergeable state via PostHog Code.`,
      prompt: buildPostHogPrompt(row),
      repositoryId: row.repositoryId,
      assignedEnvironmentId: posthogEnvId,
      pullRequestId: row.id,
    });
    // Optimistically link the row so the in-progress indicator shows
    // instantly — this path stays on the GitHub page, so the row badge
    // is the user's main signal the run started.
    setRows((prev) =>
      prev.map((r) => (r.id === row.id ? { ...r, taskId: created.id } : r))
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b p-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Github className="h-5 w-5" />
          GitHub
        </h2>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRefresh}
            disabled={loading}
            title="Refresh list"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setActivePanel('settings')}
            title="GitHub settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <FilterBar
        stateFilter={stateFilter}
        onStateFilter={setStateFilter}
        relationship={relationship}
        onRelationship={setRelationship}
        repoFilter={repoFilter}
        onRepoFilter={setRepoFilter}
        repos={repositories.map((r) => ({ id: r.id, name: r.fullName }))}
        search={search}
        onSearch={setSearch}
        searchRef={searchInputRef}
        needsAttention={needsAttention}
        onNeedsAttention={setNeedsAttention}
        stateCount={rows.length}
        attentionCount={attentionCount}
        relationshipCounts={relationshipCounts}
      />

      {/* Split row: the list keeps its own width (flex-1) and the detail
          panel sits beside it as an in-flow sibling — not a fixed overlay
          — so every row stays visible and clicking another PR switches
          the open panel. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          {error && (
            <div className="m-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400">
              {error}
            </div>
          )}
          {!loading && filtered.length === 0 && !error && connected === false && (
            <div className="flex flex-col items-center justify-center p-10 text-center text-muted-foreground">
              <Github className="mb-2 h-8 w-8 opacity-50" />
              <p className="text-sm">GitHub isn't connected for this workspace.</p>
              <p className="mt-1 text-xs">
                Connect GitHub to watch pull requests across your repos.
              </p>
              <Button size="sm" className="mt-3" onClick={handleConnect}>
                <Github className="mr-1 h-4 w-4" />
                Connect GitHub
              </Button>
            </div>
          )}
          {!loading && filtered.length === 0 && !error && connected !== false && (
            <div className="flex flex-col items-center justify-center p-10 text-center text-muted-foreground">
              <GitPullRequest className="mb-2 h-8 w-8 opacity-50" />
              <p className="text-sm">No pull requests match the current filters.</p>
            </div>
          )}
          {filtered.length > 0 && (
            <PRTable
              rows={filtered}
              selectedId={selectedId}
              onSelect={handleSelect}
              sortDir={sortDir}
              onToggleSort={() =>
                setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
              }
              onOpenTask={(taskId) => {
                selectTask(taskId);
                setActivePanel('queue');
              }}
              onMerge={handleMergeRow}
              onCreateTask={handleCreateTaskFromPR}
              onCreatePostHogTask={handleCreatePostHogTask}
              posthogEnabled={posthogEnabled}
              taskStatusById={taskStatusById}
            />
          )}
        </ScrollArea>
      </div>

        <PRDetailSheet
          pullRequestId={selectedId}
          onClose={() => setSelectedId(null)}
          layout="inline"
          seedRow={rows.find((r) => r.id === selectedId) ?? null}
        />
      </div>
    </div>
  );
}

/** A PR has a blocking issue the user should act on. */
function isNeedsAttention(r: PRRow): boolean {
  return (
    r.summary.blockingReason === 'changes_requested' ||
    r.summary.blockingReason === 'checks_failed' ||
    r.summary.blockingReason === 'merge_conflicts'
  );
}

interface FilterBarProps {
  stateFilter: StateFilter;
  onStateFilter: (v: StateFilter) => void;
  relationship: RelationshipFilter;
  onRelationship: (v: RelationshipFilter) => void;
  repoFilter: string;
  onRepoFilter: (v: string) => void;
  repos: Array<{ id: string; name: string }>;
  search: string;
  onSearch: (v: string) => void;
  searchRef?: React.Ref<HTMLInputElement>;
  needsAttention: boolean;
  onNeedsAttention: (v: boolean) => void;
  /** Count of loaded rows for the active state (the only state we hold data for). */
  stateCount: number;
  attentionCount: number;
  relationshipCounts: Record<RelationshipFilter, number>;
}

function FilterBar({
  stateFilter,
  onStateFilter,
  relationship,
  onRelationship,
  repoFilter,
  onRepoFilter,
  repos,
  search,
  onSearch,
  searchRef,
  needsAttention,
  onNeedsAttention,
  stateCount,
  attentionCount,
  relationshipCounts,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
      {/* State pills — the active one shows its loaded count. */}
      <div className="flex rounded-md border bg-muted/40 p-0.5">
        {STATE_OPTIONS.map((opt) => {
          const active = stateFilter === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onStateFilter(opt.value)}
              className={cn(
                'rounded px-2 py-1 transition-colors',
                active
                  ? 'bg-background shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {opt.label}
              {active && (
                <span className="ml-1 text-muted-foreground">{stateCount}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Relationship pills — authored vs awaiting-my-review. */}
      <div className="flex rounded-md border bg-muted/40 p-0.5">
        {RELATIONSHIP_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onRelationship(opt.value)}
            className={cn(
              'rounded px-2 py-1 transition-colors',
              relationship === opt.value
                ? 'bg-background shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
            title={
              opt.value === 'review_requested'
                ? 'PRs awaiting your review'
                : opt.value === 'authored'
                  ? 'PRs you authored'
                  : 'All watched PRs'
            }
          >
            {opt.label}
            <span className="ml-1 text-muted-foreground">
              {relationshipCounts[opt.value]}
            </span>
          </button>
        ))}
      </div>

      {/* Repo dropdown — native select keeps the bar compact + keyboard-friendly. */}
      <select
        value={repoFilter}
        onChange={(e) => onRepoFilter(e.target.value)}
        className="h-7 rounded-md border bg-background px-2 py-0 text-xs leading-7"
      >
        <option value="all">All repos</option>
        {repos.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>

      {/* Needs attention toggle. */}
      <button
        type="button"
        onClick={() => onNeedsAttention(!needsAttention)}
        className={cn(
          'rounded-md border px-2 py-1 transition-colors',
          needsAttention
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
            : 'text-muted-foreground hover:text-foreground'
        )}
        title="Only show PRs with blocking issues (conflicts, changes requested, failing checks)"
      >
        Needs attention
        {attentionCount > 0 && <span className="ml-1">{attentionCount}</span>}
      </button>

      {/* Search input — flex-1 so it grows. */}
      <div className="relative ml-auto flex-1 min-w-[160px] max-w-md">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search title or repo… (⌘F)"
          className="h-7 pl-7 pr-7 text-xs"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearch('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            title="Clear"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

interface PRTableProps {
  rows: PRRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  sortDir: SortDir;
  onToggleSort: () => void;
  onOpenTask: (taskId: string) => void;
  onMerge: (row: PRRow) => Promise<void>;
  onCreateTask: (row: PRRow) => Promise<void>;
  onCreatePostHogTask: (row: PRRow) => Promise<void>;
  /** PostHog Code is configured + a cloud env exists to dispatch to. */
  posthogEnabled: boolean;
  /** Live status of each linked task, keyed by task id. */
  taskStatusById: Map<string, TaskStatus>;
}

function PRTable({
  rows,
  selectedId,
  onSelect,
  sortDir,
  onToggleSort,
  onOpenTask,
  onMerge,
  onCreateTask,
  onCreatePostHogTask,
  posthogEnabled,
  taskStatusById,
}: PRTableProps) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-background text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-4 py-2 text-left font-medium">Title</th>
          <th className="px-2 py-2 text-left font-medium">Status</th>
          <th className="px-2 py-2 text-left font-medium">
            <button
              type="button"
              onClick={onToggleSort}
              className="flex items-center gap-1 uppercase tracking-wide hover:text-foreground"
              title={`Sort by updated (${sortDir === 'desc' ? 'newest first' : 'oldest first'})`}
            >
              Updated
              <ArrowUpDown className="h-3 w-3" />
            </button>
          </th>
          <th className="w-8 px-2 py-2"></th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <PRTableRow
            key={row.id}
            row={row}
            isSelected={row.id === selectedId}
            onSelect={() => onSelect(row.id)}
            onOpenTask={onOpenTask}
            onMerge={onMerge}
            onCreateTask={onCreateTask}
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
  isSelected,
  onSelect,
  onOpenTask,
  onMerge,
  onCreateTask,
  onCreatePostHogTask,
  posthogEnabled,
  taskStatus,
}: {
  row: PRRow;
  isSelected: boolean;
  onSelect: () => void;
  onOpenTask: (taskId: string) => void;
  onMerge: (row: PRRow) => Promise<void>;
  onCreateTask: (row: PRRow) => Promise<void>;
  onCreatePostHogTask: (row: PRRow) => Promise<void>;
  posthogEnabled: boolean;
  /** Live status of the row's linked task, if any is loaded. */
  taskStatus?: TaskStatus;
}) {
  const summary = row.summary;
  const updatedTooltip = new Date(summary.updatedAt || row.lastPolledAt).toLocaleString();
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [busy, setBusy] = useState<null | 'merge' | 'task' | 'posthog'>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Brief confirmation flash after a PostHog Code run is kicked off — we
  // stay on the GitHub page, so this is the only signal it started.
  const [posthogStarted, setPosthogStarted] = useState(false);
  const canMerge = row.state === 'open' && summary.blockingReason === 'mergeable';
  const unresolved = summary.unresolvedReviewThreads ?? 0;

  // A linked task is "active" while it's running or awaiting your review —
  // i.e. not yet fully done. Drives the row's in-progress indicator and
  // suppresses the start-task buttons so you can't double-launch.
  const taskRunning =
    taskStatus === 'pending' || taskStatus === 'queued' || taskStatus === 'in_progress';
  const taskAwaitingReview = taskStatus === 'awaiting_review';
  // taskStatus is undefined when the task isn't loaded in the store — keep
  // the link visible (plain badge) rather than guessing it's done.
  const taskActive = taskRunning || taskAwaitingReview || (!!row.taskId && !taskStatus);

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
      setRowError(err instanceof Error ? err.message : 'Merge failed');
      setConfirmMerge(false);
    } finally {
      setBusy(null);
    }
  }

  async function runCreateTask(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy('task');
    setRowError(null);
    try {
      await onCreateTask(row);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : 'Could not create task');
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
            {row.unreadCount > 0 && (
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-blue-500"
                title={`${row.unreadCount} new update${row.unreadCount > 1 ? 's' : ''} since you last looked`}
              />
            )}
            <span className={cn('truncate', row.unreadCount > 0 && 'font-semibold')}>
              {summary.title || '(no title)'}
            </span>
          </span>
          <span className="text-xs text-muted-foreground">
            {row.owner}/{row.repo}#{row.number} · @{summary.author || 'unknown'}
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
                ("Working") or awaiting your review ("Review"); deep-links
                to the task. Disappears once the task is fully done
                (completed / failed / cancelled). */}
            {row.taskId && taskActive && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenTask(row.taskId!);
                }}
                className={cn(
                  'ml-2 inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] uppercase',
                  taskAwaitingReview
                    ? 'bg-amber-200 text-amber-800 hover:bg-amber-300 dark:bg-amber-900 dark:text-amber-200 dark:hover:bg-amber-800'
                    : 'bg-blue-200 text-blue-800 hover:bg-blue-300 dark:bg-blue-900 dark:text-blue-200 dark:hover:bg-blue-800'
                )}
                title={
                  taskRunning
                    ? 'A task is working this PR — click to open it'
                    : taskAwaitingReview
                    ? 'Fix task finished — awaiting your review. Click to open it'
                    : 'Open the linked task'
                }
              >
                {taskRunning ? (
                  <>
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    Working
                  </>
                ) : taskAwaitingReview ? (
                  <>
                    <Check className="h-2.5 w-2.5" />
                    Review
                  </>
                ) : (
                  'Task'
                )}
              </button>
            )}
          </span>
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-1.5">
          <PRReviewPill
            reviewDecision={summary.reviewDecision}
            state={row.state}
            minimal
          />
          <PRStatusPill
            blockingReason={summary.blockingReason}
            checks={summary.checks}
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
      <td className="px-2 py-2 text-xs text-muted-foreground" title={updatedTooltip}>
        {formatRelative(summary.updatedAt || row.lastPolledAt)}
      </td>
      <td className="px-2 py-2" title={rowError ?? undefined}>
        <div className="flex items-center justify-end gap-1">
          {/* Row actions reveal on hover/focus to keep the table calm. */}
          {canMerge &&
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
          {!taskActive && (
            <button
              type="button"
              onClick={runCreateTask}
              disabled={busy !== null}
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
              title="Create a task to address this PR"
            >
              {busy === 'task' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListPlus className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {posthogEnabled && row.state === 'open' && (
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

/** Small relative-time helper; no dependency on date-fns. */
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

