import { useCallback, useEffect } from 'react';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { useGithubConnection } from './useGithubConnection';
import { useGithubInstallations } from './useGithubInstallations';
import { useAgentConnections } from './useAgentConnections';
import { useGithubHealth } from './useGithubHealth';
import { useOnReconnect } from './useOnReconnect';

/**
 * Preloads integration connection state into the workspace store at startup
 * (mount once from MainLayout) so anything that reads it — the global
 * SystemStatusBanner and Settings → Integrations — renders instantly instead
 * of fetching on open.
 *
 * GitHub reuses useGithubConnection's fetch + on-focus re-check, which also
 * catches OAuth completing in the external browser, so reconnecting clears the
 * banner without a manual refresh. PostHog Code is re-checked on focus for the
 * same reason: its OAuth flow finishes in the system browser, so the app has no
 * in-process signal that the workspace just got connected. (The personal-API-key
 * path still writes the new status straight to the store from the card.)
 *
 * Allow-listed feature flags (`GET /features`) are loaded here too — account
 * level, so a workspace switch does not re-fetch them, but re-checked on focus
 * and after a reconnect, because a flag flips in the backend's environment and
 * the app has no in-process signal that it did. `null` means still loading and
 * absent means not offered; anything reading them must treat those the same way
 * `cloudProviderOffered` does, or the gated nav item flashes in on every
 * launch.
 *
 * Cloud-provider connection status is loaded here too (not per-component) so
 * the Settings cards, the default-provider selector, the sidebar status row,
 * and the per-task picker all read one store value — and it's re-checked on
 * window focus, on the env WS events, and after a reconnect, so connecting a
 * provider then leaving + returning to the tab never shows a stale state.
 */
export function useSystemStatus(): void {
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const setGitHubStatus = useWorkspaceStore((s) => s.setGitHubStatus);
  const setBackendHealth = useWorkspaceStore((s) => s.setBackendHealth);
  const setGitHubUser = useWorkspaceStore((s) => s.setGitHubUser);
  const setFeatures = useWorkspaceStore((s) => s.setFeatures);
  const { status, user, health } = useGithubConnection(currentWorkspaceId);
  // Load which orgs/accounts have the App installed (kept fresh on focus), so
  // the banner + Settings can flag watched repos whose owner lacks an install.
  useGithubInstallations(currentWorkspaceId, Boolean(status?.connected));

  useEffect(() => {
    setGitHubStatus(status);
  }, [status, setGitHubStatus]);

  // The GitHub status check is the app's most frequent backend call (initial
  // load + every focus), so it doubles as the reachability probe the banner
  // reads. No extra request.
  useEffect(() => {
    setBackendHealth(health);
  }, [health, setBackendHealth]);

  useEffect(() => {
    setGitHubUser(user);
  }, [user, setGitHubUser]);

  // Whether GitHub itself is up, for the banner's outage row. Global, so a
  // workspace switch does not load it again.
  useGithubHealth();

  // The agent credentials. Mounted here for the app proper; the onboarding
  // wizard mounts the same hook itself, because this one does not run until
  // onboarding is over.
  useAgentConnections();

  // Allow-listed features. Account-level rather than per-workspace, so a
  // workspace switch does not re-fetch them. Left at their last known value on a
  // transient failure: blanking them would pull a nav item out from under a
  // click.
  const refreshFeatures = useCallback(() => {
    api.features
      .get()
      .then(setFeatures)
      .catch(() => {});
  }, [setFeatures]);

  useEffect(() => {
    refreshFeatures();
  }, [refreshFeatures]);

  // Re-checked on focus, for the same reason PostHog's status is: a flag flips
  // in the backend's environment, so the app has no in-process signal that it
  // changed. MainLayout is not keyed on anything, so without this the only way
  // to pick up a newly granted feature is to restart — which is precisely the
  // moment somebody is waiting to see it appear.
  useEffect(() => {
    const onFocus = () => refreshFeatures();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshFeatures]);

  useOnReconnect(refreshFeatures);
}
