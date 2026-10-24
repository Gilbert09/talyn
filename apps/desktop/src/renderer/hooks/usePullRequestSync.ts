import { useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { useOnReconnect } from './useOnReconnect';
import { toast } from '../stores/toast';
import { useWorkspaceStore } from '../stores/workspace';
import {
  usePullRequestStore,
  type PullRequestUpdatePayload,
} from '../stores/pullRequests';

/** How long `pull_request:updated` echoes are buffered before one store write. */
export const PR_UPDATE_FLUSH_MS = 40;

/**
 * A real GitHub force-poll followed by a re-list of the workspace's open PRs.
 * Standalone (reads both stores via `getState`) so the page header's Refresh
 * button can call it directly without threading a callback through the tree.
 *
 * It deliberately does not touch `connected`. A list that succeeds says the
 * BACKEND answered, not that GitHub is connected — the rows it returns are
 * cached and outlive a revoked installation — and a second writer of that flag
 * is how the page's CTA and the banner's came to disagree in the first place.
 */
export async function refreshPullRequests(
  opts: { initialSync?: boolean } = {}
): Promise<void> {
  const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
  if (!currentWorkspaceId) return;
  const { setRows, setLoading, setError, setInitialSync } = usePullRequestStore.getState();
  setLoading(true);
  if (opts.initialSync) setInitialSync(true);
  setError(null);
  // A failed force-poll (backend busy/restarting) shouldn't abort the
  // refresh — the cached list is still worth re-reading, and a successful
  // list clears the error so the page recovers instead of pinning a stale
  // banner. Only an error from the list itself surfaces.
  let pollFailure: string | null = null;
  try {
    const result = await api.repositories.forcePoll();
    // Said out loud: the re-list below shows cached rows either way, so a
    // refresh that did not happen looks exactly like one that found nothing.
    if (result.skipped) {
      toast.info('A refresh is already running', 'The list updates as it finishes.');
    } else if (result.failedRepos && result.repos) {
      toast.info(
        `${result.failedRepos} of ${result.repos} repos couldn't be refreshed`,
        result.failure ?? undefined
      );
    }
  } catch (err) {
    pollFailure = err instanceof Error ? err.message : 'Refresh failed';
    toast.error("Couldn't refresh from GitHub", pollFailure);
  }
  try {
    const data = await api.pullRequests.list({
      workspaceId: currentWorkspaceId,
      state: 'open',
    });
    setRows(data);
    if (pollFailure) {
      console.warn(`PR refresh: force-poll failed (${pollFailure}); showing cached rows`);
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : pollFailure ?? 'Refresh failed');
  } finally {
    setLoading(false);
    if (opts.initialSync) setInitialSync(false);
  }
}

/**
 * A quiet re-list of the open PRs: no force-poll and no loading state. For
 * reconciling after a row action — the backend has already written the row by
 * then, and its WS echo usually lands first anyway. A force-poll asks GitHub
 * about every watched repo, which is far too slow to hold a button on.
 */
export async function reloadPullRequests(): Promise<void> {
  const currentWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
  if (!currentWorkspaceId) return;
  try {
    const data = await api.pullRequests.list({ workspaceId: currentWorkspaceId, state: 'open' });
    usePullRequestStore.getState().setRows(data);
  } catch {
    // The WS echo still reconciles the row.
  }
}

/**
 * Owns the open-PR data lifecycle for the whole app: the initial fetch, the
 * PostHog connection probe, and the single `pull_request:updated` subscription
 * that patches rows in place. Mounted once (in MainLayout) so the Sidebar
 * badges and all three GitHub pages share one live set of rows.
 *
 * GitHub's connection state is the one thing it does NOT probe: that answer
 * belongs to `useSystemStatus`, and this hook mirrors it.
 */
export function usePullRequestSync(): void {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  // GitHub's connection state comes from the workspace store — see the effect
  // below for why this hook no longer fetches its own.
  const githubStatus = useWorkspaceStore((s) => s.githubStatus);
  const githubUser = useWorkspaceStore((s) => s.githubUser);
  const fetchError = usePullRequestStore((s) => s.error);
  const {
    setRows,
    setLoading,
    setError,
    setConnected,
    setViewerLogin,
    setPosthogConnected,
    applyPullRequestUpdates,
  } = usePullRequestStore.getState();

  // Initial fetch of every open PR for the workspace. Relationship/repo
  // filtering happens client-side per page, so we pull the full open set once.
  useEffect(() => {
    if (!currentWorkspaceId) {
      setRows([]);
      // No workspace means no fetch is coming — clear the initial-true
      // loading flag so the pages settle on their empty state.
      setLoading(false);
      return;
    }
    // Just finished onboarding: the freshly-watched repos haven't been polled
    // yet, so a plain cached list would land the user on an empty state. Force
    // a real GitHub poll instead (refreshPullRequests keeps `loading` true
    // throughout) so their PRs populate immediately. One-shot — clear the flag.
    const { justOnboarded, setJustOnboarded } = useWorkspaceStore.getState();
    if (justOnboarded) {
      setJustOnboarded(false);
      void refreshPullRequests({ initialSync: true });
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
  //
  // MIRRORED from the workspace store, never fetched here. `useSystemStatus`
  // owns that fetch and re-checks it whenever the window regains focus, which
  // is the ONLY signal the app gets that a connection landed: the GitHub App
  // install completes in the system browser. This used to be a second,
  // one-shot fetch per workspace, so the two answers diverged the moment
  // somebody connected — the banner's CTA cleared on their return and the
  // identical CTA under "My PRs" did not, which reads as a connect that
  // failed and sends the user round the flow again.
  const connectionRef = useRef<{ workspaceId: string; connected: boolean } | null>(null);
  useEffect(() => {
    if (!currentWorkspaceId) {
      connectionRef.current = null;
      setConnected(null);
      setViewerLogin(null);
      return;
    }
    // `null` means the status has not been read yet — distinct from "not
    // connected", and the pages draw it as neither.
    const connected = githubStatus ? githubStatus.connected : null;
    setConnected(connected);
    setViewerLogin(connected ? githubUser?.login ?? null : null);
    if (connected === null) return;

    const previous = connectionRef.current;
    connectionRef.current = { workspaceId: currentWorkspaceId, connected };
    // Just connected, in this workspace: nothing has ever been polled, so the
    // cached list is empty and the plain fetch above would land the user on
    // "no pull requests" a second after they authorized. Ask GitHub instead,
    // and keep the page in its loading state while that runs.
    if (connected && previous?.workspaceId === currentWorkspaceId && previous.connected === false) {
      void refreshPullRequests({ initialSync: true });
    }
  }, [currentWorkspaceId, githubStatus, githubUser, setConnected, setViewerLogin]);

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
  //
  // Batched like task events in useApi: the backend sends one message per
  // queued PR on every enqueue or merge, so a 100-PR queue is 100 messages in a
  // burst. One `set` per message re-rendered every subscriber 100 times.
  useEffect(() => {
    // An array, not a map keyed by id: two echoes for one PR can each be a
    // partial patch, so both must be applied, in order.
    let pending: PullRequestUpdatePayload[] = [];
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      const batch = pending;
      pending = [];
      if (batch.length === 0) return;
      const needsRefetch = applyPullRequestUpdates(batch);
      // At most one refetch per flush, however many unknown PRs it held.
      if (needsRefetch && currentWorkspaceId) {
        api.pullRequests
          .list({ workspaceId: currentWorkspaceId, state: 'open' })
          .then(setRows)
          .catch(() => {});
      }
    };
    const unsubscribe = api.ws.on('pull_request:updated', (payload) => {
      pending.push(payload as PullRequestUpdatePayload);
      // setTimeout, not rAF, so a backgrounded window still applies them.
      if (timer === null) timer = window.setTimeout(flush, PR_UPDATE_FLUSH_MS);
    });
    return () => {
      unsubscribe();
      // Dropped, not flushed: they belong to the workspace we are leaving, and
      // the next workspace's initial fetch replaces the rows anyway.
      if (timer !== null) window.clearTimeout(timer);
      pending = [];
    };
  }, [currentWorkspaceId, applyPullRequestUpdates, setRows]);

  // Self-heal: while the store holds a fetch error (backend outage, edge
  // 5xx), retry the plain list every 30s until one succeeds — success clears
  // the error and replaces the stale rows, so a transient outage recovers
  // without the user mashing Refresh. The cheap list (no force-poll) keeps
  // the retry gentle on a backend that's struggling.
  useEffect(() => {
    if (!fetchError || !currentWorkspaceId) return;
    const timer = window.setInterval(() => {
      api.pullRequests
        .list({ workspaceId: currentWorkspaceId, state: 'open' })
        .then((data) => {
          setRows(data);
          setError(null);
        })
        .catch(() => {}); // still down — banner stays, next tick retries
    }, 30_000);
    return () => clearInterval(timer);
  }, [fetchError, currentWorkspaceId, setRows, setError]);

  // Reconnect catch-up: `pull_request:updated` broadcasts (which carry live
  // merge-queue positions/status) are fire-and-forget to open sockets only, so
  // any change that lands while we're disconnected is lost — leaving the merge
  // queue stale until the next change happens to fire. On a genuine *re*connect,
  // re-list the open PRs to reconcile. Mirrors `reconcileTasksFromServer` for
  // tasks; the first connect is covered by the initial fetch above.
  useOnReconnect(() => {
    if (!currentWorkspaceId) return;
    api.pullRequests
      .list({ workspaceId: currentWorkspaceId, state: 'open' })
      .then(setRows)
      .catch(() => {});
  });
}
