import { useCallback, useEffect, useState } from 'react';
import { ApiError, ApiNetworkError, api, type GitHubStatus, type GitHubUser } from '../lib/api';

/**
 * What the last status check says about the BACKEND, apart from GitHub.
 * `offline`: no answer at all. `degraded`: it answered, with a server error or
 * a timeout — up, but not well. `null`: not checked yet.
 */
export type BackendHealth = 'ok' | 'offline' | 'degraded' | null;

/** While the backend is unhealthy, re-check this often instead of only on focus. */
const UNHEALTHY_RECHECK_MS = 30_000;

/**
 * Tracks GitHub connection state for a workspace and detects OAuth
 * completion. The OAuth flow happens in the system browser (not the
 * renderer), so we can't read query params off window.location — instead we
 * re-check status whenever the app regains focus, since the user naturally
 * returns to Talyn after authorizing in their browser. Shared by the
 * Settings integrations card and the onboarding GitHub step.
 */
export function useGithubConnection(workspaceId: string | null) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [health, setHealth] = useState<BackendHealth>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const s = await api.github.getStatus(workspaceId);
      setHealth('ok');
      setStatus(s);
      if (s.connected) {
        try {
          setUser(await api.github.getUser(workspaceId));
        } catch {
          // User fetch failed, but the connection might still be valid.
        }
      } else {
        setUser(null);
      }
    } catch (err) {
      // No failure is the backend saying GitHub is unconfigured — only a 200
      // with `configured: false` says that. This used to record any non-network
      // failure as `{ configured: false }`, so when production's database pool
      // wedged (2026-09-30) and every request 500'd, the app told users to set
      // GITHUB_CLIENT_ID. Keep the last known status and report the backend's
      // health instead.
      if (err instanceof ApiNetworkError) {
        setHealth('offline');
      } else if (err instanceof ApiError && (err.status >= 500 || err.status === 408 || err.status === 429)) {
        setHealth('degraded');
      }
      // Anything else (a 401 mid-refresh, a 404 for a workspace just deleted)
      // says nothing about the backend's health; leave everything as it was.
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  // "Retrying automatically" has to be true: focus alone never fires for
  // someone looking at the window the whole time.
  useEffect(() => {
    if (health !== 'offline' && health !== 'degraded') return;
    const timer = setInterval(() => void refresh(), UNHEALTHY_RECHECK_MS);
    return () => clearInterval(timer);
  }, [health, refresh]);

  return { status, user, health, refresh, setStatus, setUser };
}
