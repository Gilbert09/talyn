import { loadReviewSortMode, REVIEW_SORT_MODE_KEY } from '@talyn/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { api, type ReviewRankPayload } from '../../../lib/api';
import { trackEvent } from '../../../lib/analytics';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import type {
  TaskStatus,
  AnyCloudProviderType,
  PRFilterDefinition,
  PRPriorityVerdict,
} from '@talyn/shared';
import {
  TASK_STATUS_TERMINAL,
  buildPRPriorityMap,
  comparePRByPriority,
  prMatchesAnyFilter,
  reviewPriorityOffered,
} from '@talyn/shared';
import { taskCloudProvider } from '../../../lib/providerMeta';
import { GitHubPageShell } from './GitHubPageShell';
import { PRTable, reviewRequestSearchText } from './prTableShared';
import {
  ClearFiltersButton,
  RepoFilter,
  ReviewSortToggle,
  compareByCreated,
  prMatchesText,
  sortDirForMode,
  type ReviewSortMode,
} from './filters';
import { PRFilterModal, SavedFilterBar, useSavedPRFilters } from './savedFilters';
import { useGitHubActions } from './useGitHubActions';
import { hiddenReviewCohort, visibleReviewCohort } from './reviewHidden';
import { useReviewRankingCapture } from './useReviewRankingCapture';
import { ReviewRankingExportButton } from './ReviewRankingExportButton';

/**
 * Where the chosen sort lives.
 *
 * `localStorage`, not workspace settings: it is a personal view preference, and
 * a round-trip per click to persist which way a list is sorted would be absurd.
 * Same call `AutoKeepToggle` makes for its own toggle.
 */
const SORT_MODE_KEY = REVIEW_SORT_MODE_KEY;

function loadSortMode(): ReviewSortMode {
  try { return loadReviewSortMode(window.localStorage); }
  catch { return 'priority'; }
}

/**
 * "Reviews" — every open PR awaiting your review (you're a requested reviewer,
 * directly or via a team, and haven't reviewed yet). Carries the repo
 * dropdown, the created-at sort, and the "Requested via" filter (directly to
 * you, or via a specific team).
 */
export function ReviewsPanel() {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const tasks = useWorkspaceStore((s) => s.tasks);
  const environments = useWorkspaceStore((s) => s.environments);
  const rows = usePullRequestStore((s) => s.rows);
  const viewerLogin = usePullRequestStore((s) => s.viewerLogin);
  const actions = useGitHubActions();

  const [repoFilter, setRepoFilter] = useState('all');
  const [requestedFilter, setRequestedFilter] = useState('all');
  const [search, setSearch] = useState('');
  // Whether the hidden list at the foot of the page is open. Component state,
  // not persisted: it is a peek at PRs the user has already dealt with, and a
  // page that reopens it on every visit would undo the hiding.
  const [showHidden, setShowHidden] = useState(false);
  // Read once on mount rather than on every render: `localStorage` is
  // synchronous and this component re-renders on every poll.
  const [sortMode, setSortMode] = useState<ReviewSortMode>(loadSortMode);
  const features = useWorkspaceStore((s) => s.features);
  const offerPriority = reviewPriorityOffered(features);
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);

  /**
   * The viewer's learned ranking profile.
   *
   * Fetched ONCE per workspace, not per sort: the aggregates move when the
   * hourly trainer runs, which is far slower than this component re-renders.
   * Null covers every normal reason there is nothing to apply — the flag is
   * off, GitHub is not connected, no fit has happened yet — and the ordering
   * works without it, so a failure here degrades the sort rather than the page.
   */
  const [rankProfile, setRankProfile] = useState<ReviewRankPayload | null>(null);
  const profileWorkspaceId = useRef<string | null>(null);
  const fetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!offerPriority || !workspaceId) return;
    if (fetchedFor.current === workspaceId) return;
    fetchedFor.current = workspaceId;
    let cancelled = false;
    api.workspaces
      .reviewRankModel(workspaceId)
      .then((payload) => {
        if (!cancelled) {
          profileWorkspaceId.current = workspaceId;
          setRankProfile(payload);
        }
      })
      .catch(() => {
        // Deliberately silent. The prior ranks the list perfectly well, and a
        // toast about a ranking refinement failing to load is noise about
        // something the user never asked for.
        if (!cancelled) setRankProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [offerPriority, workspaceId]);

  // Saved filters: the definitions are workspace-scoped, the selection is not.
  const setSortModePersisted = (next: ReviewSortMode) => {
    // The one question that decides whether any of this was worth building: is
    // Priority chosen more than once? A ranking people switch away from is a
    // ranking that is wrong, and nothing else in the product would say so.
    trackEvent('pr_review_sort_mode_changed', { from: sortMode, to: next });
    setSortMode(next);
    try {
      window.localStorage.setItem(SORT_MODE_KEY, next);
    } catch {
      // A preference that fails to persist is not worth failing the click over.
    }
  };

  const savedFilters = useSavedPRFilters();
  const [activeFilterIds, setActiveFilterIds] = useState<string[]>([]);
  const [filterModal, setFilterModal] = useState<
    { open: false } | { open: true; editing: PRFilterDefinition | null }
  >({ open: false });

  // A selection can outlive its filter (deleted here, or on another client).
  // Drop the stale ids or the page silently filters against nothing.
  useEffect(() => {
    setActiveFilterIds((prev) => {
      const next = prev.filter((id) => savedFilters.filters.some((f) => f.id === id));
      return next.length === prev.length ? prev : next;
    });
  }, [savedFilters.filters]);

  const activeCriteria = useMemo(
    () =>
      savedFilters.filters.filter((f) => activeFilterIds.includes(f.id)).map((f) => f.criteria),
    [savedFilters.filters, activeFilterIds]
  );

  const taskStatusById = useMemo(() => {
    const m = new Map<string, TaskStatus>();
    for (const t of tasks) m.set(t.id, t.status);
    return m;
  }, [tasks]);

  const taskProviderById = useMemo(() => {
    const m = new Map<string, AnyCloudProviderType | null>();
    for (const t of tasks) m.set(t.id, taskCloudProvider(t, environments));
    return m;
  }, [tasks, environments]);

  // The distinct "requested via" options present in the review-requested rows.
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

  // Drop a stale Requested selection when its option disappears from the list,
  // so it can't silently filter to nothing.
  useEffect(() => {
    if (requestedFilter !== 'all' && !requestedOptions.some((o) => o.value === requestedFilter)) {
      setRequestedFilter('all');
    }
  }, [requestedOptions, requestedFilter]);

  // The page's cohort before any filter — what the chips count against and
  // what the modal previews a draft filter over.
  //
  // Hidden PRs are out of it entirely — see `visibleReviewCohort`.
  const cohort = useMemo(() => visibleReviewCohort(rows), [rows]);

  const hiddenRows = useMemo(() => hiddenReviewCohort(rows), [rows]);

  // A stored 'priority' can outlive the flag being taken away — see
  // ReviewSortToggle, which falls back to the same 'newest' the sort does.
  const priorityMode = sortMode === 'priority' && offerPriority;

  /**
   * Every row's priority verdict, scored ONCE per cohort change.
   *
   * Two things here are load-bearing and easy to lose in a refactor. `now` is
   * pinned for the whole pass — `Array.prototype.sort` needs a consistent
   * comparator, and a clock that advances mid-sort makes one non-transitive, at
   * which point V8 returns a scrambled array with no error at all. And the map
   * is built outside the comparator, so scoring is O(n) rather than O(n log n)
   * and the order cannot shift between two renders of the same data.
   *
   * Recomputed on `cohort` identity, which changes on a poll (30-60s), never on
   * a timer: the list must not reshuffle under the cursor.
   */
  const priorityById = useMemo(() => {
    if (!priorityMode) return null;

    // The BACKEND's verdict wins where it sent one.
    //
    // The ranking is computed server-side so it can change without a desktop
    // release: `packages/shared` is bundled into this app, and the first week
    // of tuning produced four fixes that were all logic rather than
    // configuration — none of which a config-from-server approach would have
    // delivered.
    //
    // The local path below is not a second implementation; it is the SAME
    // shared function, kept for a backend that predates this and for one that
    // has the feature switched off. A row the server scored is never rescored,
    // so the two can never disagree about the same PR.
    const map = new Map<string, PRPriorityVerdict>();
    const unscored: typeof cohort = [];
    for (const row of cohort) {
      if (row.priority) map.set(row.id, row.priority);
      else unscored.push(row);
    }
    if (unscored.length > 0) {
      const now = Date.now();
      const local = buildPRPriorityMap(unscored, {
        now,
        profile: rankProfile,
        captureTrace: { source: 'client' },
        isTaskActive: (taskId) => {
          const status = taskStatusById.get(taskId);
          return status ? TASK_STATUS_TERMINAL[status] === false : false;
        },
      });
      for (const [id, verdict] of local) map.set(id, verdict);
    }
    return map;
  }, [priorityMode, cohort, taskStatusById, rankProfile]);

  /**
   * The shape of the ranked list, once per switch into Priority mode.
   *
   * Not per render and not per poll: this answers "what does this person's
   * queue look like", which changes on the hour, and firing it on every tick
   * would drown the events that matter in noise about the same forty PRs.
   */
  const reportedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!priorityById) {
      reportedFor.current = null;
      return;
    }
    const key = `${workspaceId}:${cohort.length}`;
    if (reportedFor.current === key) return;
    reportedFor.current = key;
    const gates = { blocking_others: 0, actionable: 0, waiting_on_author: 0, not_ready: 0 };
    for (const verdict of priorityById.values()) gates[verdict.gate]++;
    trackEvent('pr_review_list_ranked', {
      cohort_size: cohort.length,
      model_installed: rankProfile?.model?.installed === true,
      model_events: rankProfile?.nEvents ?? 0,
      ...gates,
    });
  }, [priorityById, cohort.length, workspaceId, rankProfile]);

  const filtered = useMemo(() => {
    let out = cohort;
    if (repoFilter !== 'all') out = out.filter((r) => r.repositoryId === repoFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter(
        (r) =>
          prMatchesText(r, q) ||
          // Also match the requester (team name / your handle).
          reviewRequestSearchText(r.summary, viewerLogin).includes(q)
      );
    }
    if (requestedFilter !== 'all') {
      out = out.filter((r) => {
        const via = r.summary.reviewRequestVia;
        if (!via) return false;
        if (requestedFilter === 'direct') return via.direct;
        if (requestedFilter.startsWith('team:')) return via.teams.includes(requestedFilter.slice(5));
        return true;
      });
    }
    if (activeCriteria.length > 0) out = out.filter((r) => prMatchesAnyFilter(r, activeCriteria));
    if (priorityById) {
      return out.slice().sort((a, b) => comparePRByPriority(a, b, priorityById));
    }
    const dir = sortDirForMode(sortMode);
    return out.slice().sort((a, b) => compareByCreated(a, b, dir));
  }, [
    cohort,
    repoFilter,
    search,
    requestedFilter,
    sortMode,
    priorityById,
    viewerLogin,
    activeCriteria,
  ]);

  const anyFilterActive =
    repoFilter !== 'all' ||
    search.trim().length > 0 ||
    requestedFilter !== 'all' ||
    activeFilterIds.length > 0;

  const clearFilters = () => {
    setRepoFilter('all');
    setSearch('');
    setRequestedFilter('all');
    setActiveFilterIds([]);
  };

  const rankingCaptureContext = useMemo(() => ({
    workspaceId: workspaceId ?? '',
    viewerLogin: viewerLogin ?? '',
    sortMode: priorityMode ? 'priority' as const : sortMode === 'oldest' ? 'oldest' as const : 'newest' as const,
    assignedArm: features?.reviewRankingCandidate ? 'candidate' as const : 'control' as const,
    filterKey: JSON.stringify([repoFilter, requestedFilter, search, activeFilterIds]),
    filtered: anyFilterActive,
    profile: profileWorkspaceId.current === workspaceId ? rankProfile : null,
    priorityById,
    repositoryScope: repositories.filter((repo) => repo.workspaceId === workspaceId).map((repo) => repo.fullName),
  }), [workspaceId, viewerLogin, priorityMode, sortMode, repoFilter, requestedFilter,
    search, activeFilterIds, anyFilterActive, rankProfile, priorityById, repositories, features]);
  const recordReviewOpen = useReviewRankingCapture(
    filtered,
    rankingCaptureContext,
    offerPriority && !!workspaceId && !!viewerLogin,
  );

  return (
    <>
      <GitHubPageShell
        title="Reviews"
        icon={<Eye className="h-5 w-5" />}
        activeView="review"
        search={search}
        onSearch={setSearch}
        rows={filtered}
        filters={
          <>
            <RepoFilter
              value={repoFilter}
              onChange={setRepoFilter}
              repos={repositories.map((r) => ({ id: r.id, name: r.fullName }))}
            />
            {requestedOptions.length > 0 && (
              <select
                value={requestedFilter}
                onChange={(e) => setRequestedFilter(e.target.value)}
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
            <ReviewSortToggle
              mode={sortMode}
              onChange={setSortModePersisted}
              offerPriority={offerPriority}
              modelInstalled={rankProfile?.model?.installed === true}
              eventsUntilPersonalized={rankProfile?.eventsUntilPersonalized}
              nEvents={rankProfile?.nEvents}
            />
            <ClearFiltersButton active={anyFilterActive} onClear={clearFilters} />
            {offerPriority && features?.reviewRankingExport === true && workspaceId && (
              <ReviewRankingExportButton key={workspaceId} workspaceId={workspaceId} />
            )}
          </>
        }
        filtersSecondary={
          <SavedFilterBar
            filters={savedFilters.filters}
            activeIds={activeFilterIds}
            rows={cohort}
            onToggle={(id) =>
              setActiveFilterIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
              )
            }
            onNew={() => setFilterModal({ open: true, editing: null })}
            onEdit={(f) => setFilterModal({ open: true, editing: f })}
          />
        }
        emptyTitle={
          hiddenRows.length > 0 && cohort.length === 0
            ? `Nothing to review — ${hiddenRows.length} hidden ${hiddenRows.length === 1 ? 'PR is' : 'PRs are'} below.`
            : undefined
        }
        listFooter={({ selectedId, onSelect }) =>
          hiddenRows.length === 0 ? null : (
            <div className="border-t">
              <button
                type="button"
                data-attr="pr-review-hidden-toggle"
                onClick={() => {
                  if (!showHidden) {
                    trackEvent('pr_review_hidden_list_opened', { hidden_count: hiddenRows.length });
                  }
                  setShowHidden((v) => !v);
                }}
                className="flex w-full items-center gap-2 px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                {showHidden ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                <EyeOff className="h-3.5 w-3.5" />
                {showHidden ? 'Hide' : 'Show'} {hiddenRows.length} hidden pull request
                {hiddenRows.length === 1 ? '' : 's'}
              </button>
              {showHidden && (
                <PRTable
                  rows={hiddenRows}
                  variant="review"
                  viewerLogin={viewerLogin}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onOpenTask={actions.openTask}
                  onStopTask={actions.stopTask}
                  onMerge={actions.mergeRow}
                  onSetMergeQueue={actions.setMergeQueue}
                  onSetWatching={actions.setWatching}
                  onSetReviewHidden={actions.setReviewHidden}
                  onCreatePostHogTask={actions.createPostHogTask}
                  onRunSkill={actions.runSkillTask}
                  taskAsk={actions.taskAsk}
                  taskProviders={actions.taskProviders}
                  onOpenIntegrations={actions.openIntegrations}
                  taskStatusById={taskStatusById}
                  taskProviderById={taskProviderById}
                />
              )}
            </div>
          )
        }
      >
        {({ selectedId, onSelect }) => (
          <PRTable
            rows={filtered}
            variant="review"
            priorityById={priorityById}
            viewerLogin={viewerLogin}
            selectedId={selectedId}
            onSelect={(id) => {
              recordReviewOpen(id);
              onSelect(id);
            }}
            onOpenTask={actions.openTask}
            onStopTask={actions.stopTask}
            onMerge={actions.mergeRow}
            onSetMergeQueue={actions.setMergeQueue}
            onSetWatching={actions.setWatching}
            onSetReviewHidden={actions.setReviewHidden}
            onCreatePostHogTask={actions.createPostHogTask}
            onRunSkill={actions.runSkillTask}
            taskAsk={actions.taskAsk}
            taskProviders={actions.taskProviders}
            onOpenIntegrations={actions.openIntegrations}
            taskStatusById={taskStatusById}
            taskProviderById={taskProviderById}
          />
        )}
      </GitHubPageShell>
      <PRFilterModal
        open={filterModal.open}
        editing={filterModal.open ? filterModal.editing : null}
        onClose={() => setFilterModal({ open: false })}
        onSave={savedFilters.upsert}
        onDelete={async (id) => {
          setActiveFilterIds((prev) => prev.filter((x) => x !== id));
          return savedFilters.remove(id);
        }}
        saving={savedFilters.saving}
        rows={cohort}
      />
    </>
  );
}
