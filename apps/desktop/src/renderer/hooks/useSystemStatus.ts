import { useEffect } from 'react';
import { useWorkspaceStore } from '../stores/workspace';
import { useGithubConnection } from './useGithubConnection';

/**
 * Syncs core-service connection status (currently GitHub) into the workspace
 * store so the global SystemStatusBanner can react app-wide. Mount once from
 * MainLayout. Reuses useGithubConnection's fetch + on-focus re-check, which
 * also catches OAuth completing in the external browser — so reconnecting
 * clears the banner without a manual refresh.
 */
export function useSystemStatus(): void {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setGitHubStatus = useWorkspaceStore((s) => s.setGitHubStatus);
  const { status } = useGithubConnection(currentWorkspaceId);

  useEffect(() => {
    setGitHubStatus(status);
  }, [status, setGitHubStatus]);
}
