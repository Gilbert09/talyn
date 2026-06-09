import { useEffect } from 'react';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { useGithubConnection } from './useGithubConnection';

/**
 * Preloads integration connection state into the workspace store at startup
 * (mount once from MainLayout) so anything that reads it — the global
 * SystemStatusBanner and Settings → Integrations — renders instantly instead
 * of fetching on open.
 *
 * GitHub reuses useGithubConnection's fetch + on-focus re-check, which also
 * catches OAuth completing in the external browser, so reconnecting clears the
 * banner without a manual refresh. PostHog Code credentials only change from
 * inside the app (the Settings card writes the new status straight to the
 * store), so a one-shot fetch per workspace is enough.
 */
export function useSystemStatus(): void {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setGitHubStatus = useWorkspaceStore((s) => s.setGitHubStatus);
  const setGitHubUser = useWorkspaceStore((s) => s.setGitHubUser);
  const setPostHogStatus = useWorkspaceStore((s) => s.setPostHogStatus);
  const { status, user } = useGithubConnection(currentWorkspaceId);

  useEffect(() => {
    setGitHubStatus(status);
  }, [status, setGitHubStatus]);

  useEffect(() => {
    setGitHubUser(user);
  }, [user, setGitHubUser]);

  useEffect(() => {
    if (!currentWorkspaceId) {
      setPostHogStatus(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const s = await api.posthog.getStatus(currentWorkspaceId);
        if (!cancelled) setPostHogStatus(s);
      } catch {
        if (!cancelled) setPostHogStatus({ connected: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, setPostHogStatus]);
}
