import { useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import {
  usePullRequestStore,
  type PullRequestUpdatePayload,
} from '../stores/pullRequests';

/**
 * A real GitHub force-poll followed by a re-list of the workspace's open PRs.
 * Standalone (reads both stores via `getState`) so the page header's Refresh
 * button can call it directly without threading a callback through the tree.
 */
export async function refreshPullRequests(): Promise<void> {
  const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
  if (!currentWorkspaceId) return;
  const { setRows, setLoading, setError, setConnected } = usePullRequestStore.getState();
  setLoading(true);
  setError(null);
  try {
    await api.repositories.forcePoll();
    const data = await api.pullRequests.list({
      workspaceId: currentWorkspaceId,
      state: 'open',
    });
    setRows(data);
    setConnected(true); // a successful poll implies a working connection
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Refresh failed');
  } finally {
    setLoading(false);
  }
}

/**
 * Owns the open-PR data lifecycle for the whole app: the initial fetch, the
 * GitHub/PostHog connection probes, and the single `pull_request:updated`
 * subscription that patches rows in place. Mounted once (in MainLayout) so the
 * Sidebar badges and all three GitHub pages share one live set of rows.
 */
export function usePullRequestSync(): void {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const {
    setRows,
    setLoading,
    setError,
    setConnected,
    setViewerLogin,
    setPosthogConnected,
    applyPullRequestUpdate,
  } = usePullRequestStore.getState();

  // Initial fetch of every open PR for the workspace. Relationship/repo
  // filtering happens client-side per page, so we pull the full open set once.
  useEffect(() => {
    if (!currentWorkspaceId) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.pullRequests
      .list({ workspaceId: currentWorkspaceId, state: 'open' })
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, setRows, setLoading, setError]);

  // GitHub connection status + viewer login — drive the "Connect GitHub" CTA
  // and the Reviews "requested directly (@you)" label.
  useEffect(() => {
    if (!currentWorkspaceId) {
      setConnected(null);
      setViewerLogin(null);
      return;
    }
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
  }, [currentWorkspaceId, setConnected, setViewerLogin]);

  // PostHog Code connection status — gates the per-row "Get PR mergeable" run.
  useEffect(() => {
    if (!currentWorkspaceId) {
      setPosthogConnected(false);
      return;
    }
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
  }, [currentWorkspaceId, setPosthogConnected]);

  // Live updates from the prMonitor. A brand-new open PR we don't hold yet
  // can't be hand-merged (we lack workspaceId/repositoryId), so refetch.
  useEffect(() => {
    const unsubscribe = api.ws.on('pull_request:updated', (payload) => {
      const needsRefetch = applyPullRequestUpdate(payload as PullRequestUpdatePayload);
      if (needsRefetch && currentWorkspaceId) {
        api.pullRequests
          .list({ workspaceId: currentWorkspaceId, state: 'open' })
          .then(setRows)
          .catch(() => {});
      }
    });
    return unsubscribe;
  }, [currentWorkspaceId, applyPullRequestUpdate, setRows]);

  // Reconnect catch-up: `pull_request:updated` broadcasts (which carry live
  // merge-queue positions/status) are fire-and-forget to open sockets only, so
  // any change that lands while we're disconnected is lost — leaving the merge
  // queue stale until the next change happens to fire. On a genuine *re*connect,
  // re-list the open PRs to reconcile. Mirrors `reconcileTasksFromServer` for
  // tasks; the first connect is covered by the initial fetch above.
  const sawDisconnectRef = useRef(false);
  useEffect(() => {
    const unsubscribe = api.ws.on('connection:status', (payload) => {
      const connected = (payload as { connected?: boolean } | undefined)?.connected;
      if (connected === false) {
        sawDisconnectRef.current = true;
        return;
      }
      if (connected && sawDisconnectRef.current && currentWorkspaceId) {
        sawDisconnectRef.current = false;
        api.pullRequests
          .list({ workspaceId: currentWorkspaceId, state: 'open' })
          .then(setRows)
          .catch(() => {});
      }
    });
    return unsubscribe;
  }, [currentWorkspaceId, setRows]);
}
