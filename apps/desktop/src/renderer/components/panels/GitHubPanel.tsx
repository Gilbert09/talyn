import React, { useEffect, useMemo, useState } from 'react';
import {
  Github,
  Settings,
  Search,
  RefreshCw,
  ExternalLink,
  GitPullRequest,
  ArrowUpDown,
  X,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { useWorkspaceStore } from '../../stores/workspace';
import { api, type PRRow, type PRSummaryShape, type PRState } from '../../lib/api';
import { PRStatusPill } from '../widgets/PRStatusPill';
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

type StateFilter = 'open' | 'closed' | 'merged' | 'all';
type SortDir = 'asc' | 'desc';

const STATE_OPTIONS: Array<{ value: StateFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'merged', label: 'Merged' },
  { value: 'closed', label: 'Closed' },
  { value: 'all', label: 'All' },
];

export function GitHubPanel() {
  const { setActivePanel, currentWorkspaceId, repositories, selectTask } =
    useWorkspaceStore();
  const [rows, setRows] = useState<PRRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [needsAttention, setNeedsAttention] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  // null = not yet checked. Distinguishes "GitHub disconnected" from
  // "connected but no PRs" so the empty state isn't misleading.
  const [connected, setConnected] = useState<boolean | null>(null);

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
        };
        return next;
      });
    });
    return unsubscribe;
  }, [currentWorkspaceId, stateFilter, repoFilter]);

  const attentionCount = useMemo(() => rows.filter(isNeedsAttention).length, [rows]);

  const filtered = useMemo(() => {
    let out = rows;
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
  }, [rows, search, needsAttention, sortDir]);

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
        repoFilter={repoFilter}
        onRepoFilter={setRepoFilter}
        repos={repositories.map((r) => ({ id: r.id, name: r.fullName }))}
        search={search}
        onSearch={setSearch}
        needsAttention={needsAttention}
        onNeedsAttention={setNeedsAttention}
        stateCount={rows.length}
        attentionCount={attentionCount}
      />

      <div className="flex-1 overflow-hidden">
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
              onSelect={setSelectedId}
              sortDir={sortDir}
              onToggleSort={() =>
                setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
              }
              onOpenTask={(taskId) => {
                selectTask(taskId);
                setActivePanel('queue');
              }}
            />
          )}
        </ScrollArea>
      </div>

      <PRDetailSheet pullRequestId={selectedId} onClose={() => setSelectedId(null)} />
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
  repoFilter: string;
  onRepoFilter: (v: string) => void;
  repos: Array<{ id: string; name: string }>;
  search: string;
  onSearch: (v: string) => void;
  needsAttention: boolean;
  onNeedsAttention: (v: boolean) => void;
  /** Count of loaded rows for the active state (the only state we hold data for). */
  stateCount: number;
  attentionCount: number;
}

function FilterBar({
  stateFilter,
  onStateFilter,
  repoFilter,
  onRepoFilter,
  repos,
  search,
  onSearch,
  needsAttention,
  onNeedsAttention,
  stateCount,
  attentionCount,
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
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search title or repo…"
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
}

function PRTable({
  rows,
  selectedId,
  onSelect,
  sortDir,
  onToggleSort,
  onOpenTask,
}: PRTableProps) {
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-background text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-4 py-2 text-left font-medium">Title</th>
          <th className="px-2 py-2 text-left font-medium">Branch</th>
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
}: {
  row: PRRow;
  isSelected: boolean;
  onSelect: () => void;
  onOpenTask: (taskId: string) => void;
}) {
  const summary = row.summary;
  const updatedTooltip = new Date(summary.updatedAt || row.lastPolledAt).toLocaleString();
  return (
    <tr
      className={cn(
        'cursor-pointer border-b transition-colors hover:bg-muted/40 focus:bg-muted/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
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
          <span className="truncate font-medium">{summary.title || '(no title)'}</span>
          <span className="text-xs text-muted-foreground">
            {row.owner}/{row.repo}#{row.number} · @{summary.author || 'unknown'}
            {summary.draft && (
              <span className="ml-2 rounded bg-zinc-200 px-1 py-0.5 text-[10px] uppercase text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300">
                Draft
              </span>
            )}
            {row.taskId && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenTask(row.taskId!);
                }}
                className="ml-2 rounded bg-blue-200 px-1 py-0.5 text-[10px] uppercase text-blue-800 hover:bg-blue-300 dark:bg-blue-900 dark:text-blue-200 dark:hover:bg-blue-800"
                title="Open the linked task"
              >
                Task
              </button>
            )}
          </span>
        </div>
      </td>
      <td className="px-2 py-2 text-xs">
        <span className="font-mono">
          <span className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">
            {summary.headBranch}
          </span>
          <span className="px-1 text-muted-foreground">→</span>
          <span className="rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800">
            {summary.baseBranch}
          </span>
        </span>
      </td>
      <td className="px-2 py-2">
        <PRStatusPill blockingReason={summary.blockingReason} checks={summary.checks} />
      </td>
      <td className="px-2 py-2 text-xs text-muted-foreground" title={updatedTooltip}>
        {formatRelative(summary.updatedAt || row.lastPolledAt)}
      </td>
      <td className="px-2 py-2">
        <a
          href={summary.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-muted-foreground hover:text-foreground"
          title="Open on GitHub"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
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

