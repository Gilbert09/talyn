import { useCallback, useEffect } from 'react';
import type { GithubHealth } from '@talyn/shared';
import { api } from '../lib/api';
import { useWorkspaceStore } from '../stores/workspace';
import { useOnReconnect } from './useOnReconnect';

/**
 * Keeps the store's `githubHealth` current: whether GitHub itself is up.
 *
 * Loaded once on mount, then followed through the `github:health` WebSocket
 * event, which the backend sends only when the state or the set of incidents
 * changes. Loaded again on window focus and after a WebSocket reconnect,
 * because an event sent while the socket was down is lost.
 *
 * A failed load leaves the last known value in place. The backend being
 * unreachable is a different banner row, and it hides this one.
 */
export function useGithubHealth(): void {
  const setGithubHealth = useWorkspaceStore((s) => s.setGithubHealth);

  const refresh = useCallback(() => {
    api.system
      .githubHealth()
      .then(setGithubHealth)
      .catch(() => {});
  }, [setGithubHealth]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  useEffect(
    () => api.ws.on<GithubHealth>('github:health', (payload) => setGithubHealth(payload)),
    [setGithubHealth]
  );

  useOnReconnect(refresh);
}
