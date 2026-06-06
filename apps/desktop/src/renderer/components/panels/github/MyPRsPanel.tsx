import { useMemo, useState } from 'react';
import { GitPullRequest } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import type { TaskStatus } from '@fastowl/shared';
import { cn } from '../../../lib/utils';
import { GitHubPageShell } from './GitHubPageShell';
import { PRTable, isNeedsAttention } from './prTableShared';
import { RepoFilter, SortToggle, compareByCreated, prMatchesText, type SortDir } from './filters';
import { useGitHubActions } from './useGitHubActions';

/**
 * "My PRs" — every open PR you authored, across watched repos. Carries the
 * repo dropdown, the created-at sort, and the "Needs attention" toggle
 * (blocking issues you own).
 */
export function MyPRsPanel() {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const tasks = useWorkspaceStore((s) => s.tasks);
  const rows = usePullRequestStore((s) => s.rows);
  const viewerLogin = usePullRequestStore((s) => s.viewerLogin);
  const actions = useGitHubActions();

  const [repoFilter, setRepoFilter] = useState('all');
  const [needsAttention, setNeedsAttention] = useState(false);
  const [search, setSearch] = useState('');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const attentionCount = useMemo(
    () => rows.filter((r) => r.authored && isNeedsAttention(r)).length,
    [rows]
  );

  const taskStatusById = useMemo(() => {
    const m = new Map<string, TaskStatus>();
    for (const t of tasks) m.set(t.id, t.status);
    return m;
  }, [tasks]);

  const filtered = useMemo(() => {
    let out = rows.filter((r) => r.authored);
    if (repoFilter !== 'all') out = out.filter((r) => r.repositoryId === repoFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => prMatchesText(r, q));
    }
    if (needsAttention) out = out.filter(isNeedsAttention);
    return out.slice().sort((a, b) => compareByCreated(a, b, sortDir));
  }, [rows, repoFilter, search, needsAttention, sortDir]);

  return (
    <GitHubPageShell
      title="My PRs"
      icon={<GitPullRequest className="h-5 w-5" />}
      activeView="mine"
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
          <button
            type="button"
            onClick={() => setNeedsAttention((v) => !v)}
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
          <SortToggle sortDir={sortDir} onToggle={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))} />
        </>
      }
    >
      {({ selectedId, onSelect }) => (
        <PRTable
          rows={filtered}
          variant="mine"
          viewerLogin={viewerLogin}
          selectedId={selectedId}
          onSelect={onSelect}
          onOpenTask={actions.openTask}
          onMerge={actions.mergeRow}
          onSetMergeQueue={actions.setMergeQueue}
          onCreatePostHogTask={actions.createPostHogTask}
          posthogEnabled={actions.posthogEnabled}
          taskStatusById={taskStatusById}
        />
      )}
    </GitHubPageShell>
  );
}
