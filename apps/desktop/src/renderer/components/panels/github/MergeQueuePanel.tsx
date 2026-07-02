import { useMemo, useState } from 'react';
import { GitMerge } from 'lucide-react';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import type { TaskStatus, CloudProviderType } from '@talyn/shared';
import { taskCloudProvider } from '../../../lib/providerMeta';
import type { PRRow } from '../../../lib/api';
import { GitHubPageShell } from './GitHubPageShell';
import { PRTable } from './prTableShared';
import { prMatchesText } from './filters';
import { useGitHubActions } from './useGitHubActions';

interface QueueGroup {
  key: string;
  owner: string;
  repo: string;
  base: string;
  rows: PRRow[];
}

/**
 * "Merge Queue" — every PR you've queued, grouped by repo + base branch (the
 * unit the queue serializes over) and ordered by the backend-assigned FIFO
 * position within each group. Each row shows its position + status (waiting /
 * fixing / merging / blocked) and the usual row actions (remove, open task…).
 */
export function MergeQueuePanel() {
  const tasks = useWorkspaceStore((s) => s.tasks);
  const environments = useWorkspaceStore((s) => s.environments);
  const rows = usePullRequestStore((s) => s.rows);
  const viewerLogin = usePullRequestStore((s) => s.viewerLogin);
  const actions = useGitHubActions();

  const [search, setSearch] = useState('');

  const taskStatusById = useMemo(() => {
    const m = new Map<string, TaskStatus>();
    for (const t of tasks) m.set(t.id, t.status);
    return m;
  }, [tasks]);

  const taskProviderById = useMemo(() => {
    const m = new Map<string, CloudProviderType | null>();
    for (const t of tasks) m.set(t.id, taskCloudProvider(t, environments));
    return m;
  }, [tasks, environments]);

  // Flat list of queued rows matching the search — feeds Copy list + empty state.
  const queued = useMemo(() => {
    let out = rows.filter((r) => r.mergeQueued);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      out = out.filter((r) => prMatchesText(r, q));
    }
    return out;
  }, [rows, search]);

  // Grouped by repo + base, each group ordered by queue position. Mirrors the
  // backend's (repo, base) serialization so the "#N" matches merge order.
  const groups = useMemo<QueueGroup[]>(() => {
    const byKey = new Map<string, QueueGroup>();
    for (const r of queued) {
      const base = r.summary.baseBranch ?? '';
      const key = `${r.repositoryId}|${base}`;
      let g = byKey.get(key);
      if (!g) {
        g = { key, owner: r.owner, repo: r.repo, base, rows: [] };
        byKey.set(key, g);
      }
      g.rows.push(r);
    }
    const list = [...byKey.values()];
    for (const g of list) {
      g.rows.sort(
        (a, b) => (a.mergeQueueState?.position ?? 0) - (b.mergeQueueState?.position ?? 0)
      );
    }
    list.sort((a, b) =>
      `${a.owner}/${a.repo}/${a.base}`.localeCompare(`${b.owner}/${b.repo}/${b.base}`)
    );
    return list;
  }, [queued]);

  const hasSearch = search.trim().length > 0;

  return (
    <GitHubPageShell
      title="Merge Queue"
      icon={<GitMerge className="h-5 w-5" />}
      activeView="all"
      search={search}
      onSearch={setSearch}
      searchPlaceholder="Search queued PRs or #number… (⌘F)"
      rows={queued}
      emptyIcon={<GitMerge className="h-8 w-8" />}
      emptyTitle={hasSearch ? 'No queued PRs match your search.' : 'The merge queue is empty.'}
      emptyHint={
        hasSearch
          ? undefined
          : 'Queue a PR from My PRs or Reviews (the checklist icon on a row) and it’ll merge automatically when clean — auto-fixing conflicts along the way.'
      }
    >
      {({ selectedId, onSelect }) => (
        <div className="flex flex-col">
          {groups.map((g) => (
            <div key={g.key}>
              <div className="sticky top-0 z-[1] flex items-center gap-1.5 border-b bg-muted/60 px-4 py-1.5 text-xs font-medium text-muted-foreground">
                <GitMerge className="h-3.5 w-3.5" />
                {g.owner}/{g.repo}
                <span className="opacity-60">→</span>
                {g.base || 'default'}
              </div>
              <PRTable
                rows={g.rows}
                variant="queue"
                viewerLogin={viewerLogin}
                selectedId={selectedId}
                onSelect={onSelect}
                onOpenTask={actions.openTask}
                onMerge={actions.mergeRow}
                onSetMergeQueue={actions.setMergeQueue}
                onCreatePostHogTask={actions.createPostHogTask}
                onRunSkill={actions.runSkillTask}
                posthogEnabled={actions.posthogEnabled}
                taskAsk={actions.taskAsk}
                taskProviders={actions.taskProviders}
                onOpenIntegrations={actions.openIntegrations}
                taskStatusById={taskStatusById}
                taskProviderById={taskProviderById}
              />
            </div>
          ))}
        </div>
      )}
    </GitHubPageShell>
  );
}
