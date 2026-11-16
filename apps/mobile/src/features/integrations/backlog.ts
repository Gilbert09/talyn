import { workflows } from '@talyn/client/native';
import type { PostHogInboxBacklogPage, PostHogInboxBacklogRow } from '@talyn/shared';
import { useCallback, useState } from 'react';

import { useWorkspace } from '../../auth/AuthProvider';
import { showActionError } from '../../lib/errors';
import { useRemote } from '../more/useRemote';

/** The first page of the backlog of one rule, then the pages that "Load more" adds. Read-only. */
export function useBacklog(workflowId: string, enabled: boolean) {
  const workspace = useWorkspace().selected;
  const key = enabled && workspace && workflowId ? `posthog-backlog:${workspace}:${workflowId}` : null;
  const first = useRemote<PostHogInboxBacklogPage>(key, () => workflows.posthogInboxBacklog(workspace ?? '', { workflowId }));
  const [more, setMore] = useState<{ key: string | null; rows: PostHogInboxBacklogRow[]; nextOffset: number | null | undefined }>({ key: null, rows: [], nextOffset: undefined });
  const [loadingMore, setLoadingMore] = useState(false);
  const extra = more.key === key ? more : { rows: [] as PostHogInboxBacklogRow[], nextOffset: undefined };
  const nextOffset = extra.nextOffset !== undefined ? extra.nextOffset : first.data?.nextOffset ?? null;
  const rows = first.data ? [...first.data.rows, ...extra.rows] : undefined;

  const loadMore = useCallback(async () => {
    if (!key || nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await workflows.posthogInboxBacklog(workspace ?? '', { workflowId, offset: nextOffset });
      setMore((prev) => ({ key, rows: [...(prev.key === key ? prev.rows : []), ...page.rows], nextOffset: page.nextOffset }));
    } catch (error) {
      showActionError('Could not load more reports', error);
    } finally {
      setLoadingMore(false);
    }
  }, [key, nextOffset, loadingMore, workspace, workflowId]);

  const refresh = useCallback(async () => {
    setMore({ key: null, rows: [], nextOffset: undefined });
    await first.refresh();
  }, [first]);

  return { remote: first, rows, nextOffset, loadMore, loadingMore, refresh, days: first.data?.days };
}
