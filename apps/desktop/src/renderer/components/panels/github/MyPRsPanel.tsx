import { useEffect, useMemo, useState } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import type { TaskStatus, AnyCloudProviderType, PRFilterDefinition } from '@talyn/shared';
import { prMatchesAnyFilter } from '@talyn/shared';
import { taskCloudProvider } from '../../../lib/providerMeta';
import { DropdownMenuCheckboxItem, DropdownMenuItem } from '../../ui/dropdown-menu';
import { GitHubPageShell } from './GitHubPageShell';
import { PRTable, isNeedsAttention, isAwaitingReview, isReadyToMerge } from './prTableShared';
import { ClearFiltersButton, RepoFilter, SortToggle, ToggleChip, prMatchesText, type SortDir } from './filters';
import { PRFilterModal, SavedFilterMenu, useSavedPRFilters } from './savedFilters';
import { WatchPRModal } from './WatchPRModal';
import { useAutoKeepDefault } from './AutoKeepToggle';
import { buildStackedRows } from './stacks';
import { useGitHubActions } from './useGitHubActions';

/**
 * "My PRs" — every open PR you authored, plus any you manually added to watch
 * (someone else's PR you care about the CI of), across watched repos. Carries
 * the repo dropdown, the created-at sort, the "Needs attention" toggle
 * (blocking issues you own), the "Needs review" toggle (still awaiting a
 * review), the "Ready to merge" toggle (nothing left to do but merge), and the
 * "Watching" toggle (the manually added ones).
 */
export function MyPRsPanel() {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const tasks = useWorkspaceStore((s) => s.tasks);
  const environments = useWorkspaceStore((s) => s.environments);
  const rows = usePullRequestStore((s) => s.rows);
  const viewerLogin = usePullRequestStore((s) => s.viewerLogin);
  const actions = useGitHubActions();
  const autoKeep = useAutoKeepDefault();

  const [repoFilter, setRepoFilter] = useState('all');
  const [needsAttention, setNeedsAttention] = useState(false);
  const [needsReview, setNeedsReview] = useState(false);
  const [readyToMerge, setReadyToMerge] = useState(false);
  const [watchingOnly, setWatchingOnly] = useState(false);
  const [watchModalOpen, setWatchModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Saved filters: the definitions are workspace-scoped, the selection is not.
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

  const attentionCount = useMemo(
    () => rows.filter((r) => r.authored && isNeedsAttention(r)).length,
    [rows]
  );
  const reviewCount = useMemo(
    () => rows.filter((r) => r.authored && isAwaitingReview(r)).length,
    [rows]
  );
  const readyCount = useMemo(
    () => rows.filter((r) => r.authored && isReadyToMerge(r)).length,
    [rows]
  );
  const watchingCount = useMemo(() => rows.filter((r) => r.watching).length, [rows]);

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

  // The page's cohort before any filter — what the chips count against and
  // what the modal previews a draft filter over. `watching` is in here because
  // a manually tracked PR is one you asked to see; it is a separate flag from
  // `authored` because the poller rewrites `authored` from GitHub's searches.
  const cohort = useMemo(() => rows.filter((r) => r.authored || r.watching), [rows]);

  const filtered = useMemo(() => {
    let out = cohort;
    if (repoFilter !== 'all') out = out.filter((r) => r.repositoryId === repoFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => prMatchesText(r, q));
    }
    if (needsAttention) out = out.filter(isNeedsAttention);
    if (needsReview) out = out.filter(isAwaitingReview);
    if (readyToMerge) out = out.filter(isReadyToMerge);
    if (watchingOnly) out = out.filter((r) => r.watching);
    if (activeCriteria.length > 0) out = out.filter((r) => prMatchesAnyFilter(r, activeCriteria));
    return out;
  }, [
    cohort,
    repoFilter,
    search,
    needsAttention,
    needsReview,
    readyToMerge,
    watchingOnly,
    activeCriteria,
  ]);

  const anyFilterActive =
    repoFilter !== 'all' ||
    search.trim().length > 0 ||
    needsAttention ||
    needsReview ||
    readyToMerge ||
    watchingOnly ||
    activeFilterIds.length > 0;

  const clearFilters = () => {
    setRepoFilter('all');
    setSearch('');
    setNeedsAttention(false);
    setNeedsReview(false);
    setReadyToMerge(false);
    setWatchingOnly(false);
    setActiveFilterIds([]);
  };

  // Group stacked PRs together (root-first, dependents indented) while keeping
  // the active sort for roots. `meta` drives the per-row indent + accent bar.
  const { ordered, meta: stackMeta } = useMemo(
    () => buildStackedRows(filtered, sortDir),
    [filtered, sortDir]
  );

  return (
    <>
      <GitHubPageShell
        activeView="mine"
        search={search}
        onSearch={setSearch}
        rows={ordered}
        stackMeta={stackMeta}
        menuItems={
          <>
            <DropdownMenuItem
              data-attr="my-prs-add-pr"
              onSelect={() => setWatchModalOpen(true)}
              title="Track any PR by its GitHub link. It does not have to be yours."
            >
              <Plus className="h-3.5 w-3.5" />
              Add a PR by link…
            </DropdownMenuItem>
            {autoKeep.workspaceId && (
              <DropdownMenuCheckboxItem
                data-attr="my-prs-auto-keep-toggle"
                checked={autoKeep.enabled}
                disabled={autoKeep.saving}
                onSelect={() => autoKeep.toggle()}
                title="A cloud agent clears conflicts and red CI on every PR you open"
              >
                <Sparkles className="h-3.5 w-3.5 text-violet-500" />
                Keep new PRs green
                {autoKeep.locked && (
                  <span className="ml-auto rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-300">
                    Unlimited
                  </span>
                )}
              </DropdownMenuCheckboxItem>
            )}
          </>
        }
        filters={
          <>
            <ToggleChip
              active={needsAttention}
              onToggle={() => setNeedsAttention((v) => !v)}
              tone="amber"
              count={attentionCount}
              title="Only show PRs with blocking issues (conflicts, changes requested, failing checks)"
            >
              Needs attention
            </ToggleChip>
            <ToggleChip
              active={needsReview}
              onToggle={() => setNeedsReview((v) => !v)}
              tone="violet"
              count={reviewCount}
              title="Only show PRs you opened that are still waiting on a review"
            >
              Needs review
            </ToggleChip>
            <ToggleChip
              active={readyToMerge}
              onToggle={() => setReadyToMerge((v) => !v)}
              tone="emerald"
              count={readyCount}
              title="Only show PRs that are fully ready to merge (approved or no review needed, checks green, no conflicts)"
            >
              Ready to merge
            </ToggleChip>
            <ToggleChip
              active={watchingOnly}
              onToggle={() => setWatchingOnly((v) => !v)}
              tone="sky"
              count={watchingCount}
              dataAttr="my-prs-watching-filter"
              title="Only show PRs you added manually to track"
            >
              Watching
            </ToggleChip>
            <SavedFilterMenu
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
            <ClearFiltersButton active={anyFilterActive} onClear={clearFilters} />
          </>
        }
        viewControls={
          <>
            <RepoFilter
              value={repoFilter}
              onChange={setRepoFilter}
              repos={repositories.map((r) => ({ id: r.id, name: r.fullName }))}
            />
            <SortToggle sortDir={sortDir} onToggle={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))} />
          </>
        }
      >
        {({ selectedId, onSelect }) => (
          <PRTable
            rows={ordered}
            variant="mine"
            stackMeta={stackMeta}
            viewerLogin={viewerLogin}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpenTask={actions.openTask}
            onStopTask={actions.stopTask}
            onMerge={actions.mergeRow}
            onSetMergeQueue={actions.setMergeQueue}
            onSetWatching={actions.setWatching}
            onSetMergeQueueStack={actions.setMergeQueueStack}
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
      <WatchPRModal open={watchModalOpen} onOpenChange={setWatchModalOpen} />
      {autoKeep.explainer}
    </>
  );
}
