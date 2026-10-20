import React, { useEffect, useRef } from 'react';
import { Github, Settings, Search, RefreshCw, Copy, X, GitPullRequest, Loader2, MoreHorizontal } from 'lucide-react';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { ScrollArea } from '../../ui/scroll-area';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { PRDetailSheet } from '../../widgets/PRDetailSheet';
import { api, type PRRow } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import { useGitHubActions } from './useGitHubActions';
import type { StackMeta } from './stacks';
import { refreshPullRequests } from '../../../hooks/usePullRequestSync';

/**
 * Shared chrome for the three GitHub pages (My PRs, Reviews, Merge Queue):
 * one toolbar row (the page's `filters` on the left; its `viewControls`, a
 * common search box with ⌘F and a "⋯" menu on the right), the loading /
 * error / empty / disconnected states, and the list+detail split layout.
 *
 * The page passes its already-filtered+sorted `rows` and renders the list
 * body via the `children` render-prop, which receives the shared selection
 * state so clicking a row opens the detail sheet beside the list.
 */
interface GitHubPageShellProps {
  /** Which cohort to tell the backend is on screen (adaptive polling). */
  activeView: 'mine' | 'review' | 'all';
  search: string;
  onSearch: (v: string) => void;
  searchPlaceholder?: string;
  /** What the page shows: the quick filters and the saved filters, on the left. */
  filters?: React.ReactNode;
  /** How the page shows it: the repo and the sort, just left of the search box. */
  viewControls?: React.ReactNode;
  /**
   * Page actions, as `DropdownMenuItem`s at the top of the "⋯" menu, above
   * Copy list, Refresh and GitHub settings. Actions go in the menu so that the
   * row only holds controls that change the list.
   */
  menuItems?: React.ReactNode;
  /** The page's filtered + sorted rows — drives Copy list + empty states. */
  rows: PRRow[];
  /** Per-row stack placement (when the page stacks PRs) — Copy list uses it
   *  to indent stacked PRs under their parent. */
  stackMeta?: Map<string, StackMeta>;
  /** Empty-state copy shown when GitHub is connected but the page has no rows.
   *  Defaults to the generic "no PRs match the current filters" message. */
  emptyIcon?: React.ReactNode;
  emptyTitle?: string;
  emptyHint?: string;
  /**
   * Rendered under the list, inside the same scroll area — where the Reviews
   * tab keeps its hidden PRs. Below the rows rather than in the filter bar
   * because it is the END of the list, not a control over it, and it must stay
   * reachable when the list is empty (hide everything and the footer is the
   * only way back). Gets the same selection handle as the rows, so a PR opened
   * from it lands in the same detail panel.
   */
  listFooter?: (sel: { selectedId: string | null; onSelect: (id: string) => void }) => React.ReactNode;
  children: (sel: { selectedId: string | null; onSelect: (id: string) => void }) => React.ReactNode;
}

export function GitHubPageShell({
  activeView,
  search,
  onSearch,
  searchPlaceholder = 'Search title, repo or #number… (⌘F)',
  filters,
  viewControls,
  menuItems,
  rows,
  stackMeta,
  emptyIcon,
  emptyTitle = 'No pull requests match the current filters.',
  emptyHint,
  listFooter,
  children,
}: GitHubPageShellProps) {
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const loading = usePullRequestStore((s) => s.loading);
  const error = usePullRequestStore((s) => s.error);
  const connected = usePullRequestStore((s) => s.connected);
  const initialSync = usePullRequestStore((s) => s.initialSync);
  const { copyList, connect } = useGitHubActions();

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  // Only the open row, not the whole list: a row keeps its identity until it
  // changes, so this re-renders the shell for that row's echoes alone.
  const seedRow = usePullRequestStore((s) =>
    selectedId ? (s.rows.find((r) => r.id === selectedId) ?? null) : null
  );
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+F focuses the PR search box. Each page mounts its own shell, so
  // the listener is naturally scoped to the active page.
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
  // the others slackly. Re-announce on WS reconnect (the registry is in-memory
  // and a backend restart forgets it), and signal 'none' on unmount so a
  // backgrounded page drops to slack polling.
  useEffect(() => {
    if (!currentWorkspaceId) return;
    const announce = () =>
      void api.pullRequests.setView(currentWorkspaceId, activeView).catch(() => {});
    announce();
    const off = api.ws.on('connection:status', (p) => {
      if ((p as { connected?: boolean })?.connected) announce();
    });
    return () => {
      off();
      void api.pullRequests.setView(currentWorkspaceId, 'none').catch(() => {});
    };
  }, [currentWorkspaceId, activeView]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-4 py-1.5 text-xs">
        {filters}
        <div className="ml-auto flex items-center gap-1">
          {/* The list refreshes in the background; the only sign is this. The
              first load has its own spinner in the list. */}
          {loading && rows.length > 0 && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-label="Refreshing" />
          )}
          {viewControls}
          <div className="relative w-56">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={searchPlaceholder}
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="w-7 p-0"
                title="More actions"
                data-attr="pr-toolbar-more"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {menuItems}
              {menuItems && <DropdownMenuSeparator />}
              <DropdownMenuItem
                disabled={rows.length === 0}
                onSelect={() => void copyList(rows, stackMeta)}
                title="Copy the PRs in the list for Slack"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy list
              </DropdownMenuItem>
              <DropdownMenuItem disabled={loading} onSelect={() => void refreshPullRequests()}>
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openSettings('pullRequests')}>
                <Settings className="h-3.5 w-3.5" />
                Pull request settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* The list always keeps its full width; the detail panel floats over its
          right edge as a `contained` overlay (absolute to this relative row)
          rather than squishing the columns. The visible left of the list stays
          clickable, so clicking another PR switches the open panel. */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-hidden">
          {/* First load (no rows yet): a centered spinner instead of flashing
              the empty state while the initial PR fetch is in flight.
              `initialSync` counts as loading in its own right — a cached list
              resolving late would otherwise clear `loading` underneath the
              post-connect poll and flash "no pull requests" at somebody who
              has just authorized. */}
          {(loading || initialSync) && rows.length === 0 && !error ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              {/* The catch-up poll that follows a fresh connection reads from
                  GitHub and takes a few seconds. Say what is happening: the
                  person watching has just authorized and is waiting to see
                  their PRs appear. */}
              <p className="text-[13px]">
                {initialSync ? 'Pulling in your pull requests…' : 'Loading pull requests…'}
              </p>
              {initialSync && (
                <p className="text-xs">This takes a few seconds the first time.</p>
              )}
            </div>
          ) : (
          <ScrollArea className="h-full">
            {error && (
              <div className="m-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-400">
                {error}
              </div>
            )}
            {!loading && rows.length === 0 && !error && connected === false && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-[13px] text-muted-foreground">
                <Github className="h-6 w-6 opacity-50" />
                <p>GitHub isn't connected for this workspace.</p>
                <p className="text-xs">
                  Connect GitHub to watch pull requests across your repos.
                </p>
                <Button size="sm" className="mt-1" onClick={() => void connect()}>
                  <Github className="h-3.5 w-3.5" />
                  Connect GitHub
                </Button>
              </div>
            )}
            {!loading && rows.length === 0 && !error && connected !== false && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center text-[13px] text-muted-foreground">
                <div className="opacity-50">
                  {emptyIcon ?? <GitPullRequest className="h-6 w-6" />}
                </div>
                <p>{emptyTitle}</p>
                {emptyHint && <p className="max-w-xs text-xs">{emptyHint}</p>}
              </div>
            )}
            {rows.length > 0 && children({ selectedId, onSelect: setSelectedId })}
            {/* Not gated on `rows.length`: with every PR hidden the list is
                empty and the footer is the only route back to them. Gated on
                the connection, because a disconnected workspace has nothing to
                say here and the CTA above is the only thing worth showing. */}
            {connected !== false &&
              listFooter?.({ selectedId, onSelect: setSelectedId })}
          </ScrollArea>
          )}
        </div>

        <PRDetailSheet
          pullRequestId={selectedId}
          onClose={() => setSelectedId(null)}
          layout="contained"
          seedRow={seedRow}
        />
      </div>
    </div>
  );
}
