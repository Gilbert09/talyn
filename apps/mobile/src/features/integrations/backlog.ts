import { workflows } from '@talyn/client/native';
import { DEFAULT_POSTHOG_INBOX_BACKLOG_DAYS, type PostHogInboxBacklogCount, type PostHogInboxBacklogDays, type PostHogInboxBacklogPage, type PostHogInboxBacklogRow } from '@talyn/shared';
import { useCallback, useState } from 'react';

import { useWorkspace } from '../../auth/AuthProvider';
import { showActionError } from '../../lib/errors';
import { useRemote } from '../more/useRemote';

/** The first page of the backlog of one rule in a time range, then the pages that "Load more" adds. Read-only. */
export function useBacklog(workflowId: string, enabled: boolean, days: PostHogInboxBacklogDays = DEFAULT_POSTHOG_INBOX_BACKLOG_DAYS) {
  const workspace = useWorkspace().selected;
  const key = enabled && workspace && workflowId ? `posthog-backlog:${workspace}:${workflowId}:${days}` : null;
  const first = useRemote<PostHogInboxBacklogPage>(key, () => workflows.posthogInboxBacklog(workspace ?? '', { workflowId, days }));
  const [more, setMore] = useState<{ key: string | null; rows: PostHogInboxBacklogRow[]; nextOffset: number | null | undefined }>({ key: null, rows: [], nextOffset: undefined });
  const [loadingMore, setLoadingMore] = useState(false);
  const extra = more.key === key ? more : { rows: [] as PostHogInboxBacklogRow[], nextOffset: undefined };
  const nextOffset = extra.nextOffset !== undefined ? extra.nextOffset : first.data?.nextOffset ?? null;
  const rows = first.data ? [...first.data.rows, ...extra.rows] : undefined;

  const loadMore = useCallback(async () => {
    if (!key || nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await workflows.posthogInboxBacklog(workspace ?? '', { workflowId, days, offset: nextOffset });
      setMore((prev) => ({ key, rows: [...(prev.key === key ? prev.rows : []), ...page.rows], nextOffset: page.nextOffset }));
    } catch (error) {
      showActionError('Could not load more reports', error);
    } finally {
      setLoadingMore(false);
    }
  }, [key, nextOffset, loadingMore, workspace, workflowId, days]);

  const refresh = useCallback(async () => {
    setMore({ key: null, rows: [], nextOffset: undefined });
    await first.refresh();
  }, [first]);

  return { remote: first, rows, nextOffset, loadMore, loadingMore, refresh, days: first.data?.days };
}

/** How many reports in the range match the rule, by state. Read-only. */
export function useBacklogCount(workflowId: string, enabled: boolean, days: PostHogInboxBacklogDays) {
  const workspace = useWorkspace().selected;
  const key = enabled && workspace && workflowId ? `posthog-backlog-count:${workspace}:${workflowId}:${days}` : null;
  return useRemote<PostHogInboxBacklogCount>(key, () => workflows.posthogInboxBacklogCount(workspace ?? '', { workflowId, days }));
}
