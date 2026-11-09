import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useMobileRuntime } from '../../auth/AuthProvider';
import { failureState, type LoadState, type Resource } from '../../workflow/model';

/** The shortest automatic refresh. Faster polling costs battery and server time for no visible gain. */
export const MIN_REFRESH_MS = 30_000;

export interface Remote<T> extends Resource<T> {
  refresh(): Promise<void>;
  /** Change the held data without a fetch, for an optimistic update. */
  mutate(update: (data: T) => T): void;
}

interface State<T> { key: string | null; status: LoadState; data?: T; refreshing: boolean; updatedAt?: number }

/** The next refresh interval: never below {@link MIN_REFRESH_MS}, or none. */
export function refreshInterval(intervalMs: number | undefined): number | null {
  if (!intervalMs || intervalMs <= 0) return null;
  return Math.max(MIN_REFRESH_MS, intervalMs);
}

/**
 * One server read for a screen of these features. `key` names what is read
 * (include the workspace id): a new key drops the old data, and null reads
 * nothing. It keeps the last data through a failed refresh, refreshes when
 * the app comes back to the foreground or online, and polls no faster than
 * every 30 seconds. The shape matches the store's `Resource`, so
 * `StateNotice` draws its states.
 */
export function useRemote<T>(key: string | null, load: () => Promise<T>, options: { intervalMs?: number } = {}): Remote<T> {
  const { lifecycle } = useMobileRuntime();
  const life = useSyncExternalStore(lifecycle.subscribe, lifecycle.getSnapshot, lifecycle.getSnapshot);
  const [state, setState] = useState<State<T>>({ key, status: key ? 'loading' : 'idle', refreshing: false });
  const loader = useRef(load);
  loader.current = load;
  const current = useRef(key);
  current.current = key;
  const offline = useRef(life.reachability === 'offline');
  offline.current = life.reachability === 'offline';

  const run = useCallback(async () => {
    const target = current.current;
    if (!target) return;
    if (offline.current) {
      setState((prev) => prev.key === target ? { ...prev, status: prev.data === undefined ? 'offline' : prev.status, refreshing: false } : prev);
      return;
    }
    setState((prev) => prev.key === target ? { ...prev, refreshing: true, status: prev.data === undefined ? 'loading' : prev.status } : prev);
    try {
      const data = await loader.current();
      if (current.current !== target) return;
      setState({ key: target, status: 'ready', data, refreshing: false, updatedAt: Date.now() });
    } catch (error) {
      if (current.current !== target) return;
      setState((prev) => ({ ...prev, key: target, status: failureState(error), refreshing: false }));
    }
  }, []);

  useEffect(() => {
    setState({ key, status: key ? 'loading' : 'idle', refreshing: false });
    void run();
  }, [key, run]);

  // Foreground and reconnect: refetch silently, keeping what is on screen.
  const active = life.activity === 'active' && life.reachability !== 'offline';
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) void run();
    wasActive.current = active;
  }, [active, run]);

  const every = refreshInterval(options.intervalMs);
  useEffect(() => {
    if (!every || !active || !key) return undefined;
    const timer = setInterval(() => { void run(); }, every);
    return () => clearInterval(timer);
  }, [every, active, key, run]);

  const mutate = useCallback((update: (data: T) => T) => {
    setState((prev) => prev.data === undefined ? prev : { ...prev, data: update(prev.data) });
  }, []);

  const shown = state.key === key ? state : { key, status: key ? 'loading' as const : 'idle' as const, refreshing: false };
  return { status: shown.status, data: shown.data, stale: false, refreshing: shown.refreshing, updatedAt: shown.updatedAt, refresh: run, mutate };
}
