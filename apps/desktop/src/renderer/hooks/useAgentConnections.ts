import { useCallback, useEffect } from 'react';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { useOnReconnect } from './useOnReconnect';

/**
 * Which agents this workspace has connected — the PostHog Code credential and
 * the cloud-provider list the fleet card is drawn from.
 *
 * Split out of `useSystemStatus` so it can be mounted somewhere that hook is
 * NOT: the onboarding wizard. `useSystemStatus` mounts in `MainLayout`, which
 * renders only once onboarding is complete, so the Connect-an-agent step ran
 * with `cloudProviders === null` and `posthogStatus === null` for its whole
 * life. Both are read as "still loading, render nothing", so the step showed no
 * Talyn Fleet card at all — under a paragraph inviting the reader to connect
 * Claude or Codex to run on it — and PostHog Code fell back to its API-key form,
 * because `oauthAvailable` is a field of the status nobody had fetched.
 *
 * Mounted in exactly one place at a time: the wizard before onboarding
 * finishes, `useSystemStatus` after. They never overlap, so this does not
 * double-fetch.
 */
export function useAgentConnections(): void {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setPostHogStatus = useWorkspaceStore((s) => s.setPostHogStatus);
  const setCloudProviders = useWorkspaceStore((s) => s.setCloudProviders);

  const refreshPostHogStatus = useCallback(() => {
    if (!currentWorkspaceId) {
      setPostHogStatus(null);
      return;
    }
    api.posthog
      .getStatus(currentWorkspaceId)
      .then(setPostHogStatus)
      // Leave the last-known status in place on a transient failure rather than
      // flashing "Not Connected" at someone who is connected.
      .catch(() => {});
  }, [currentWorkspaceId, setPostHogStatus]);

  useEffect(() => {
    refreshPostHogStatus();
  }, [refreshPostHogStatus]);

  // The OAuth connect flow completes in the system browser, so focus is the only
  // signal that a workspace just became connected.
  useEffect(() => {
    const onFocus = () => refreshPostHogStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshPostHogStatus]);

  const refreshCloudProviders = useCallback(() => {
    if (!currentWorkspaceId) {
      setCloudProviders(null);
      return;
    }
    api.cloudProviders
      .list(currentWorkspaceId)
      .then(setCloudProviders)
      // Leave the last-known list in place on a transient failure rather than
      // blanking it (which would flash "disconnected").
      .catch(() => {});
  }, [currentWorkspaceId, setCloudProviders]);

  // Initial load + whenever the workspace changes.
  useEffect(() => {
    setCloudProviders(null); // mark "checking" so cards don't flash "Not Connected"
    refreshCloudProviders();
  }, [refreshCloudProviders, setCloudProviders]);

  // Re-check on window focus (a key was added/rotated in another window), on the
  // env provisioning WS events, and after an outage.
  useEffect(() => {
    const onFocus = () => refreshCloudProviders();
    window.addEventListener('focus', onFocus);
    const offCreated = api.ws.on('environment:created', refreshCloudProviders);
    const offStatus = api.ws.on('environment:status', refreshCloudProviders);
    return () => {
      window.removeEventListener('focus', onFocus);
      offCreated();
      offStatus();
    };
  }, [refreshCloudProviders]);

  useOnReconnect(refreshCloudProviders);
}
