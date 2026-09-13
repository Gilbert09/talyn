import { useCallback, useEffect, useRef } from 'react';
import { workflowsOffered } from '@talyn/shared';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { useGithubConnection } from './useGithubConnection';
import { useGithubInstallations } from './useGithubInstallations';
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
  const setBackendReachable = useWorkspaceStore((s) => s.setBackendReachable);
  const setGitHubUser = useWorkspaceStore((s) => s.setGitHubUser);
  const setPostHogStatus = useWorkspaceStore((s) => s.setPostHogStatus);
  const setCloudProviders = useWorkspaceStore((s) => s.setCloudProviders);
  const setFeatures = useWorkspaceStore((s) => s.setFeatures);
  const features = useWorkspaceStore((s) => s.features);
  const setEnabledWorkflowCount = useWorkspaceStore((s) => s.setEnabledWorkflowCount);
  const { status, user, reachable } = useGithubConnection(currentWorkspaceId);
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
    setBackendReachable(reachable);
  }, [reachable, setBackendReachable]);

  useEffect(() => {
    setGitHubUser(user);
  }, [user, setGitHubUser]);

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

  // The sidebar's Workflows badge.
  //
  // Workspace-scoped, unlike `features` — so it re-counts on a workspace switch
  // — and gated on the feature being offered, because every workflow route 403s
  // when the kill switch is off and asking anyway spends a request per boot to
  // be told so.
  //
  // This is only the SEED. `useWorkflows` writes the same store value whenever
  // its list changes, so toggling a rule on the Workflows page moves the badge
  // with no round trip; this exists so the badge is right for somebody who
  // never opens that page.
  const countWorkspaceRef = useRef(currentWorkspaceId);
  countWorkspaceRef.current = currentWorkspaceId;

  const refreshWorkflowCount = useCallback(() => {
    if (!currentWorkspaceId || !workflowsOffered(features)) {
      setEnabledWorkflowCount(null);
      return;
    }
    api.workflows
      .count(currentWorkspaceId)
      .then(({ enabled }) => {
        // Guards a response from a workspace the user has already left.
        if (countWorkspaceRef.current !== currentWorkspaceId) return;
        setEnabledWorkflowCount(enabled);
      })
      // Left at its last known value on a transient failure: blanking the badge
      // is a worse lie than a slightly stale number.
      .catch(() => {});
  }, [currentWorkspaceId, features, setEnabledWorkflowCount]);

  // Cleared on a workspace switch so the badge never shows the previous
  // workspace's number while the new count is in flight. `null` draws nothing,
  // which is honest; the old number would be a confidently wrong one.
  useEffect(() => {
    setEnabledWorkflowCount(null);
  }, [currentWorkspaceId, setEnabledWorkflowCount]);

  useEffect(() => {
    refreshWorkflowCount();
  }, [refreshWorkflowCount]);

  // Re-counted on focus as well. The in-app edits already push to the store, so
  // this is purely for a change made somewhere else — another device, or the
  // web app alongside the desktop one. One indexed `count(*)`, so it is cheap
  // enough to make the badge self-healing rather than stale until restart.
  useEffect(() => {
    const onFocus = () => refreshWorkflowCount();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshWorkflowCount]);

  useOnReconnect(refreshWorkflowCount);
}
