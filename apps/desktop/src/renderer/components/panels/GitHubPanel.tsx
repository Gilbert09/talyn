import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Github,
  Settings,
  Search,
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  GitMerge,
  Loader2,
  ArrowUpDown,
  Copy,
  Check,
  X,
  Bot,
  MessageSquare,
  Users,
  AtSign,
  Eye,
  AlertTriangle,
  ListChecks,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { useTaskActions } from '../../hooks/useApi';
import { api, type PRRow, type PRSummaryShape, type PRState } from '../../lib/api';
import { type TaskStatus, prNeedsFollowup, buildPostHogPrompt } from '@fastowl/shared';
import { PRStatusPill } from '../widgets/PRStatusPill';
import { PRReviewPill } from '../widgets/PRReviewPill';
import { PRDetailSheet } from '../widgets/PRDetailSheet';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toast';

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

// The GitHub screen shows two views of your OPEN PRs: ones you authored
// ("My PRs") and ones awaiting your review ("Review"). Merged/closed PRs
// stay in the DB for task linking but aren't browsable here.
type RelationshipFilter = 'authored' | 'review_requested';
type SortDir = 'asc' | 'desc';

const RELATIONSHIP_OPTIONS: Array<{ value: RelationshipFilter; label: string }> = [
  { value: 'authored', label: 'My PRs' },
  { value: 'review_requested', label: 'Review' },
];

/** Escape a string for safe interpolation into the copied HTML list. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function GitHubPanel() {
  const {
    setActivePanel,
    currentWorkspaceId,
    repositories,
    environments,
    selectTask,
    tasks,
    addTask,
  } = useWorkspaceStore();
  const { createTask } = useTaskActions();
  const [rows, setRows] = useState<PRRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Relationship is filtered client-side off each row's `authored` /
  // `reviewRequested` flag (no refetch), so both pills can show counts.
  const [relationship, setRelationship] = useState<RelationshipFilter>('authored');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  // Review-tab "Requested" filter: 'all' | 'direct' | `team:<org/team>`.
  const [requestedFilter, setRequestedFilter] = useState<string>('all');
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
  // The viewer's GitHub login — used to label "requested directly" rows on
  // the Review tab with your @handle.
  const [viewerLogin, setViewerLogin] = useState<string | null>(null);

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
        if (cancelled) return;
        setConnected(s.connected);
        if (s.connected) {
          api.github
            .getUser(currentWorkspaceId)
            .then((u) => {
              if (!cancelled) setViewerLogin(u.login);
            })
            .catch(() => {});
        }
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

  // Tell the backend which cohort is on screen so it polls that one hard and
  // the other slackly. Re-announce on WS reconnect (the registry is in-memory
  // and a backend restart forgets it), and signal 'none' on unmount so a
  // backgrounded GitHub panel drops to slack polling for both cohorts.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    const view = relationship === 'authored' ? 'mine' : 'review';
    const announce = () =>
      void api.pullRequests.setView(currentWorkspaceId, view).catch(() => {});
    announce();
    const off = api.ws.on('connection:status', (p) => {
      if ((p as { connected?: boolean })?.connected) announce();
    });
    return () => {
      off();
      void api.pullRequests.setView(currentWorkspaceId, 'none').catch(() => {});
    };
  }, [currentWorkspaceId, relationship]);

  // Initial fetch + refetch on filter change.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.pullRequests
      .list({
        workspaceId: currentWorkspaceId,
        state: 'open',
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
  }, [currentWorkspaceId, repoFilter]);

  // Live updates from the prMonitor.
  useEffect(() => {
    const unsubscribe = api.ws.on('pull_request:updated', (payload) => {
      const p = payload as {
        id: string;
        taskId: string | null;
        state: PRState;
        lastSummary: PRSummaryShape;
        reviewRequested?: boolean;
        authored?: boolean;
        autoKeepMergeable?: boolean;
        autoMergeState?: { attempts: number; paused: boolean } | null;
        mergeQueued?: boolean;
        mergeQueueState?: {
          status: 'waiting' | 'fixing' | 'merging' | 'blocked';
          attempts: number;
          position: number;
          reason?: string;
        } | null;
      };
      setRows((prev) => {
        const idx = prev.findIndex((r) => r.id === p.id);
        if (idx === -1) {
          // The list only holds open PRs, so a non-open echo for a row we
          // don't have is a no-op. A new *open* PR triggers a refetch
          // rather than a hand-merge (we'd need workspaceId/repositoryId
          // to insert, and the backend already orders by lastPolledAt).
          if (p.state === 'open' && currentWorkspaceId) {
            api.pullRequests
              .list({
                workspaceId: currentWorkspaceId,
                state: 'open',
                repo: repoFilter === 'all' ? undefined : repoFilter,
              })
              .then(setRows)
              .catch(() => {});
          }
          return prev;
        }
        // A row that left "open" (merged/closed upstream, incl. auto-merge)
        // no longer belongs in this open-only list — drop it.
        if (p.state !== 'open') {
          return prev.filter((r) => r.id !== p.id);
        }
        const next = prev.slice();
        next[idx] = {
          ...next[idx],
          state: p.state,
          summary: p.lastSummary,
          // Preserve a known link if the echo omits it; adopt a new one
          // when the backend reports it (e.g. just-started fix task).
          taskId: p.taskId ?? next[idx].taskId,
          // Relationship flags are only on the payload when the monitor
          // re-bucketed the row (e.g. it left Review after being reviewed);
          // otherwise keep what we have.
          reviewRequested: p.reviewRequested ?? next[idx].reviewRequested,
          authored: p.authored ?? next[idx].authored,
          // Watcher state only rides along when it changed; otherwise keep ours.
          autoKeepMergeable: p.autoKeepMergeable ?? next[idx].autoKeepMergeable,
          autoMergeState:
            p.autoMergeState !== undefined ? p.autoMergeState : next[idx].autoMergeState,
          // Merge-queue state only rides along when it changed; otherwise keep ours.
          mergeQueued: p.mergeQueued ?? next[idx].mergeQueued,
          mergeQueueState:
            p.mergeQueueState !== undefined ? p.mergeQueueState : next[idx].mergeQueueState,
        };
        return next;
      });
    });
    return unsubscribe;
  }, [currentWorkspaceId, repoFilter]);

  // Open the detail sheet for the selected PR.
  function handleSelect(id: string) {
    setSelectedId(id);
  }

  // "Needs attention" is a My-PRs-only concept (blocking issues on PRs you
  // own), so its count is scoped to authored rows.
  const attentionCount = useMemo(
    () => rows.filter((r) => r.authored && isNeedsAttention(r)).length,
    [rows]
  );

  // Relationship buckets for the current repo set — drive the always-on
  // counts on the My PRs / Review pills.
  const relationshipCounts = useMemo(
    () => ({
      authored: rows.filter((r) => r.authored).length,
      review_requested: rows.filter((r) => r.reviewRequested).length,
    }),
    [rows]
  );

  // The distinct "requested via" options present in the review-requested
  // rows — drives the Review-tab Requested filter dropdown.
  const requestedOptions = useMemo(() => {
    const teams = new Set<string>();
    let hasDirect = false;
    for (const r of rows) {
      if (!r.reviewRequested) continue;
      const via = r.summary.reviewRequestVia;
      if (!via) continue;
      if (via.direct) hasDirect = true;
      for (const t of via.teams) teams.add(t);
    }
    const opts: Array<{ value: string; label: string }> = [];
    if (hasDirect) {
      opts.push({ value: 'direct', label: `Directly${viewerLogin ? ` (@${viewerLogin})` : ''}` });
    }
    for (const t of [...teams].sort()) opts.push({ value: `team:${t}`, label: `@${t}` });
    return opts;
  }, [rows, viewerLogin]);

  // Drop a stale Requested selection when the tab changes or the option
  // disappears from the list, so it can't silently filter to nothing.
  useEffect(() => {
    if (relationship !== 'review_requested') {
      if (requestedFilter !== 'all') setRequestedFilter('all');
      return;
    }
    if (requestedFilter !== 'all' && !requestedOptions.some((o) => o.value === requestedFilter)) {
      setRequestedFilter('all');
    }
  }, [relationship, requestedOptions, requestedFilter]);

  // Live status of each linked task, so a row can show whether its fix
  // task is still running. Driven by the workspace store, which the WS
  // task:status handler keeps current.
  const taskStatusById = useMemo(() => {
    const m = new Map<string, TaskStatus>();
    for (const t of tasks) m.set(t.id, t.status);
    return m;
  }, [tasks]);

  const filtered = useMemo(() => {
    let out =
      relationship === 'authored'
        ? rows.filter((r) => r.authored)
        : rows.filter((r) => r.reviewRequested);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => {
        const title = r.summary.title?.toLowerCase() ?? '';
        const repo = `${r.owner}/${r.repo}`.toLowerCase();
        if (title.includes(q) || repo.includes(q)) return true;
        // On the Review tab, also match the requester (team name / your handle).
        return (
          relationship === 'review_requested' &&
          reviewRequestSearchText(r.summary, viewerLogin).includes(q)
        );
      });
    }
    // Needs-attention only applies to My PRs (it gates on blocking issues you
    // own); on the Review tab the toggle isn't shown.
    if (needsAttention && relationship === 'authored') {
      out = out.filter(isNeedsAttention);
    }
    // Review-tab Requested filter: directly to me, or via a specific team.
    if (relationship === 'review_requested' && requestedFilter !== 'all') {
      out = out.filter((r) => {
        const via = r.summary.reviewRequestVia;
        if (!via) return false;
        if (requestedFilter === 'direct') return via.direct;
        if (requestedFilter.startsWith('team:')) return via.teams.includes(requestedFilter.slice(5));
        return true;
      });
    }
    const sorted = out.slice().sort((a, b) => {
      // Order by when the PR was opened on GitHub. Fall back to the DB
      // row's createdAt for rows cached before we tracked the PR's own
      // creation time.
      const ta = new Date(a.summary.createdAt || a.createdAt).getTime();
      const tb = new Date(b.summary.createdAt || b.createdAt).getTime();
      return sortDir === 'desc' ? tb - ta : ta - tb;
    });
    return sorted;
  }, [rows, relationship, search, needsAttention, sortDir, viewerLogin, requestedFilter]);

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
        state: 'open',
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

  // Squash-merge a PR straight from its row. Throws (with GitHub's reason)
  // if the merge is rejected so the caller can toast it; on success it
  // removes the row optimistically and reconciles via a re-list.
  async function handleMergeRow(row: PRRow) {
    const ref = `${row.owner}/${row.repo}#${row.number}`;
    const result = await api.pullRequests.merge(row.id);
    // GitHub can 200 with `merged: false` (e.g. it accepted the request but
    // declined to merge). Treat that as a failure so we don't claim success
    // and wrongly drop the row.
    if (!result.merged) {
      throw new Error(result.message || 'GitHub did not merge the pull request');
    }
    toast.success(`Merged ${ref}`, row.summary.title);
    // Drop the row immediately — the merged PR no longer belongs in the
    // Open view. The re-list below reconciles counts/other rows.
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    if (!currentWorkspaceId) return;
    try {
      const data = await api.pullRequests.list({
        workspaceId: currentWorkspaceId,
        state: 'open',
        repo: repoFilter === 'all' ? undefined : repoFilter,
      });
      setRows(data);
    } catch {
      // Re-list is best-effort; the optimistic removal already happened and
      // the next poll tick will reconcile.
    }
  }

  // Add/remove a PR from the FastOwl merge queue. Optimistically patches the
  // row so the badge flips instantly; the backend echoes the authoritative
  // state (incl. queue position) over WS. Rolls back on error.
  async function handleSetMergeQueue(row: PRRow, enabled: boolean) {
    setRows((prev) =>
      prev.map((r) =>
        r.id === row.id
          ? {
              ...r,
              mergeQueued: enabled,
              mergeQueueState: enabled
                ? { status: 'waiting', attempts: 0, position: r.mergeQueueState?.position ?? 0 }
                : null,
            }
          : r
      )
    );
    try {
      await api.pullRequests.setMergeQueue(row.id, enabled);
    } catch (err) {
      setRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, mergeQueued: !enabled } : r))
      );
      toast.error(
        `Couldn't ${enabled ? 'queue' : 'dequeue'} ${row.owner}/${row.repo}#${row.number}`,
        err instanceof Error ? err.message : undefined
      );
    }
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
      prompt: buildPostHogPrompt({
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        summary: row.summary,
      }),
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

  // Copy the currently filtered PRs as a list for pasting into Slack (etc.)
  // when requesting approvals. We write both a rich `text/html` bullet list
  // of hyperlinks (so Slack/Notion/docs paste as clickable links) and a
  // plain-text markdown fallback (`- [title](url)`) for editors that only
  // take plain text.
  async function handleCopyList() {
    const items = filtered
      .map((r) => ({ title: r.summary.title || '(no title)', url: r.summary.url }))
      .filter((i) => i.url);
    if (items.length === 0) {
      toast.info('Nothing to copy', 'No pull requests match the current filters.');
      return;
    }

    const markdown = items.map((i) => `- [${i.title}](${i.url})`).join('\n');
    const html = `<ul>${items
      .map((i) => `<li><a href="${escapeHtml(i.url)}">${escapeHtml(i.title)}</a></li>`)
      .join('')}</ul>`;

    const count = `${items.length} PR${items.length === 1 ? '' : 's'}`;
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([markdown], { type: 'text/plain' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(markdown);
      }
      toast.success(`Copied ${count}`, 'Paste into Slack to request approval.');
    } catch {
      try {
        await navigator.clipboard.writeText(markdown);
        toast.success(`Copied ${count}`, 'Paste into Slack to request approval.');
      } catch {
        toast.error('Could not copy to clipboard');
      }
    }
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
            onClick={handleCopyList}
            disabled={filtered.length === 0}
            title="Copy the filtered PRs as a list for Slack"
          >
            <Copy className="mr-1 h-4 w-4" />
            Copy list
          </Button>
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
        relationship={relationship}
        onRelationship={setRelationship}
        repoFilter={repoFilter}
        onRepoFilter={setRepoFilter}
        repos={repositories.map((r) => ({ id: r.id, name: r.fullName }))}
        requestedFilter={requestedFilter}
        onRequestedFilter={setRequestedFilter}
        requestedOptions={requestedOptions}
        search={search}
        onSearch={setSearch}
        searchRef={searchInputRef}
        needsAttention={needsAttention}
        onNeedsAttention={setNeedsAttention}
        attentionCount={attentionCount}
        relationshipCounts={relationshipCounts}
        sortDir={sortDir}
        onToggleSort={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
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
              variant={relationship === 'review_requested' ? 'review' : 'mine'}
              viewerLogin={viewerLogin}
              selectedId={selectedId}
              onSelect={handleSelect}
              onOpenTask={(taskId) => {
                setActivePanel('queue');
                selectTask(taskId);
                // The task may not be in the store yet (e.g. a backend-created
                // merge-queue fix run on a client that connected after it
                // started). Fetch it on demand so the Tasks screen resolves it
                // instead of showing "Task not found".
                if (!tasks.some((t) => t.id === taskId)) {
                  api.tasks
                    .get(taskId)
                    .then((t) => addTask(t))
                    .catch(() => {});
                }
              }}
              onMerge={handleMergeRow}
              onSetMergeQueue={handleSetMergeQueue}
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

/**
 * How the viewer was asked to review, for the Review tab's "Requested"
 * column. A direct request wins over a team one. Returns the primary label
 * (your @handle, or the first team's `@org/team`) plus the count of any
 * additional teams, or null when we have no request info (older cached rows).
 */
function reviewRequestLabel(
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
function reviewRequestSearchText(summary: PRSummaryShape, viewerLogin: string | null): string {
  const via = summary.reviewRequestVia;
  if (!via) return '';
  const parts: string[] = [];
  if (via.direct) parts.push('direct', 'you', viewerLogin ?? '');
  parts.push(...via.teams);
  return parts.join(' ').toLowerCase();
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
  relationship: RelationshipFilter;
  onRelationship: (v: RelationshipFilter) => void;
  repoFilter: string;
  onRepoFilter: (v: string) => void;
  repos: Array<{ id: string; name: string }>;
  /** Review-tab "Requested" filter + its available options. */
  requestedFilter: string;
  onRequestedFilter: (v: string) => void;
  requestedOptions: Array<{ value: string; label: string }>;
  search: string;
  onSearch: (v: string) => void;
  searchRef?: React.Ref<HTMLInputElement>;
  needsAttention: boolean;
  onNeedsAttention: (v: boolean) => void;
  attentionCount: number;
  relationshipCounts: Record<RelationshipFilter, number>;
  /** Sort direction for the created-at ordering. */
  sortDir: SortDir;
  onToggleSort: () => void;
}

function FilterBar({
  relationship,
  onRelationship,
  repoFilter,
  onRepoFilter,
  repos,
  requestedFilter,
  onRequestedFilter,
  requestedOptions,
  search,
  onSearch,
  searchRef,
  needsAttention,
  onNeedsAttention,
  attentionCount,
  relationshipCounts,
  sortDir,
  onToggleSort,
}: FilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
      {/* Relationship tabs — your PRs vs awaiting-your-review. */}
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
                : 'PRs you authored'
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

      {/* Requested filter — Review tab only, populated from the options
          actually present (directly to you, or via one of your teams). */}
      {relationship === 'review_requested' && requestedOptions.length > 0 && (
        <select
          value={requestedFilter}
          onChange={(e) => onRequestedFilter(e.target.value)}
          className="h-7 rounded-md border bg-background px-2 py-0 text-xs leading-7"
          title="Filter by who requested your review"
        >
          <option value="all">Any requester</option>
          {requestedOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}

      {/* Needs attention toggle — only meaningful for your own PRs. */}
      {relationship === 'authored' && (
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
      )}

      {/* Created-at sort toggle. */}
      <button
        type="button"
        onClick={onToggleSort}
        className="flex items-center gap-1 rounded-md border px-2 py-1 text-muted-foreground transition-colors hover:text-foreground"
        title={`Sorted by created date — ${sortDir === 'desc' ? 'newest first' : 'oldest first'}. Click to flip.`}
      >
        <ArrowUpDown className="h-3 w-3" />
        {sortDir === 'desc' ? 'Newest' : 'Oldest'}
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
  onOpenTask: (taskId: string) => void;
  onMerge: (row: PRRow) => Promise<void>;
  onSetMergeQueue: (row: PRRow, enabled: boolean) => Promise<void>;
  onCreatePostHogTask: (row: PRRow) => Promise<void>;
  /** PostHog Code is configured + a cloud env exists to dispatch to. */
  posthogEnabled: boolean;
  /** Live status of each linked task, keyed by task id. */
  taskStatusById: Map<string, TaskStatus>;
  /** 'mine' shows the CI status column; 'review' swaps it for who requested
   *  the review (you directly vs a team you're on). */
  variant: 'mine' | 'review';
  viewerLogin: string | null;
}

function PRTable({
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
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-background text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-4 py-2 text-left font-medium">Title</th>
          <th className="px-2 py-2 text-left font-medium">
            {variant === 'review' ? 'Requested' : 'Status'}
          </th>
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
  variant: 'mine' | 'review';
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
                Fixing chip would be redundant. */}
            {row.mergeQueued &&
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
          {/* Row actions reveal on hover/focus to keep the table calm. */}
          {row.state === 'open' && (
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

