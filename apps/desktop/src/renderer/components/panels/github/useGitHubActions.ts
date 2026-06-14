import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type PRRow } from '../../../lib/api';
import { buildPostHogPrompt } from '@fastowl/shared';
import { useWorkspaceStore } from '../../../stores/workspace';
import { usePullRequestStore } from '../../../stores/pullRequests';
import { useTaskActions } from '../../../hooks/useApi';
import { refreshPullRequests } from '../../../hooks/usePullRequestSync';
import { toast } from '../../../stores/toast';
import { trackEvent } from '../../../lib/analytics';

/** Escape a string for safe interpolation into the copied HTML list. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The row/header action handlers shared by all three GitHub pages. They mutate
 * the shared PR store (optimistic patches) and let the WS echo reconcile, so
 * the same action works no matter which page fired it.
 */
export function useGitHubActions() {
  const { currentWorkspaceId, environments, selectTask, tasks, addTask, setActivePanel } =
    useWorkspaceStore();
  const { createTask } = useTaskActions();
  const { patchRow, removeRow } = usePullRequestStore.getState();

  // Which cloud providers this workspace has connected (authoritative — checks
  // stored credentials, not just the env marker which lingers after disconnect).
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
  useEffect(() => {
    if (!currentWorkspaceId) return;
    let cancelled = false;
    api.cloudProviders
      .list(currentWorkspaceId)
      .then((providers) => {
        if (cancelled) return;
        setConnectedProviders(providers.filter((p) => p.connected).map((p) => p.type));
      })
      .catch(() => {
        /* leave empty — the fix button just won't show */
      });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId]);

  // The auto-provisioned cloud env a follow-up ("get mergeable") task is
  // assigned to. Generic across providers: prefer PostHog Code for back-compat,
  // else fall back to Claude Code. (A per-task provider picker for the
  // both-connected case is a planned follow-up — see docs/CLOUD_PROVIDERS.md.)
  // Named `posthogEnvId`/`posthogEnabled` for now to avoid churning consumers.
  const posthogEnvId = useMemo(() => {
    const envFor = (type: string) => environments.find((e) => e.type === type)?.id ?? null;
    for (const type of ['posthog_code', 'claude_routine']) {
      if (connectedProviders.includes(type)) {
        const id = envFor(type);
        if (id) return id;
      }
    }
    return null;
  }, [environments, connectedProviders]);
  const posthogEnabled = posthogEnvId !== null;

  // Deep-link to a row's linked task. It may not be in the store yet (e.g. a
  // backend-created merge-queue fix run on a client that connected after it
  // started), so fetch it on demand.
  const openTask = useCallback(
    (taskId: string) => {
      setActivePanel('queue');
      selectTask(taskId);
      if (!tasks.some((t) => t.id === taskId)) {
        api.tasks
          .get(taskId)
          .then((t) => addTask(t))
          .catch(() => {});
      }
    },
    [setActivePanel, selectTask, tasks, addTask]
  );

  // Squash-merge a PR straight from its row. Throws (with GitHub's reason) if
  // rejected so the row can toast it; on success it drops the row optimistically
  // and reconciles via a re-list.
  const mergeRow = useCallback(
    async (row: PRRow) => {
      const ref = `${row.owner}/${row.repo}#${row.number}`;
      const result = await api.pullRequests.merge(row.id);
      // GitHub can 200 with `merged: false` — treat that as failure so we
      // don't claim success and wrongly drop the row.
      if (!result.merged) {
        throw new Error(result.message || 'GitHub did not merge the pull request');
      }
      trackEvent('pr_merged', {
        repo: `${row.owner}/${row.repo}`,
        pr_number: row.number,
        blocking_reason: row.summary.blockingReason,
      });
      toast.success(`Merged ${ref}`, row.summary.title);
      removeRow(row.id);
      await refreshPullRequests();
    },
    [removeRow]
  );

  // Add/remove a PR from the FastOwl merge queue. Optimistically patches the
  // row so the badge flips instantly; the backend echoes the authoritative
  // state (incl. queue position) over WS. Rolls back on error.
  const setMergeQueue = useCallback(
    async (row: PRRow, enabled: boolean) => {
      patchRow(row.id, {
        mergeQueued: enabled,
        mergeQueueState: enabled
          ? { status: 'waiting', attempts: 0, position: row.mergeQueueState?.position ?? 0 }
          : null,
      });
      try {
        await api.pullRequests.setMergeQueue(row.id, enabled);
        trackEvent('merge_queue_toggled', {
          enabled,
          repo: `${row.owner}/${row.repo}`,
          pr_number: row.number,
        });
      } catch (err) {
        patchRow(row.id, { mergeQueued: !enabled });
        toast.error(
          `Couldn't ${enabled ? 'queue' : 'dequeue'} ${row.owner}/${row.repo}#${row.number}`,
          err instanceof Error ? err.message : undefined
        );
      }
    },
    [patchRow]
  );

  // Kick off a PostHog Code cloud run to take the PR to a clean, mergeable
  // state. Assigns it to the cloud env so the scheduler dispatches it to
  // PostHog Code. The run happens entirely in the cloud, so we stay on the
  // current page — the row's task badge is the user's signal it started.
  const createPostHogTask = useCallback(
    async (row: PRRow) => {
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
      trackEvent('pr_fix_task_started', {
        repo: `${row.owner}/${row.repo}`,
        pr_number: row.number,
        blocking_reason: row.summary.blockingReason,
      });
      // Optimistically link the row so the in-progress indicator shows instantly.
      patchRow(row.id, { taskId: created.id });
    },
    [currentWorkspaceId, posthogEnvId, createTask, patchRow]
  );

  // Connect GitHub for the workspace (opens the OAuth popup).
  const connect = useCallback(async () => {
    if (!currentWorkspaceId) return;
    const { authUrl } = await api.github.connect(currentWorkspaceId);
    trackEvent('github_connect_started');
    window.open(authUrl, '_blank', 'width=600,height=700');
  }, [currentWorkspaceId]);

  // Copy the given PRs as a list for pasting into Slack (etc.). Writes a rich
  // `text/html` bullet list of hyperlinks plus a plain-text markdown fallback.
  const copyList = useCallback(async (rows: PRRow[]) => {
    const items = rows
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
  }, []);

  return {
    posthogEnabled,
    openTask,
    mergeRow,
    setMergeQueue,
    createPostHogTask,
    connect,
    copyList,
  };
}
