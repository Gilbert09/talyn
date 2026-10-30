import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { trackEvent } from './analytics';

/**
 * `React.lazy` that survives a deploy.
 *
 * Every deploy replaces the hashed files in /assets/, so a tab opened before
 * it asks for a chunk that no longer exists. A plain `lazy` rejects, and the
 * root ErrorBoundary swaps the whole app for its "Reload" card. Here the failed
 * import reloads the page instead, which fetches the new index.html and its new
 * chunk names. The returned promise never settles, so the Suspense fallback
 * stays on screen until the browser navigates.
 *
 * At most one reload per RELOAD_WINDOW_MS (sessionStorage, so it is per tab):
 * if the chunk still fails after the reload, it is not a stale tab, and the
 * error goes to the boundary as before rather than looping.
 */
const RELOAD_AT_KEY = 'talyn-stale-chunk-reload-at';
const RELOAD_WINDOW_MS = 60_000;

// Same constraint as React's own `lazy`, so any component type passes through.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((error: unknown) => {
      if (!reloadForStaleChunk()) throw error;
      return new Promise<never>(() => {});
    })
  );
}

/** Reload the page unless that would not help. True when it reloads. */
export function reloadForStaleChunk(now = Date.now()): boolean {
  // Offline, a reload lands on the browser's own error page — worse than the
  // boundary's card, which keeps the app shell.
  if (navigator.onLine === false) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_AT_KEY));
    if (last && now - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_AT_KEY, String(now));
  } catch {
    // No sessionStorage means no loop guard, so do not reload.
    return false;
  }
  trackEvent('app_reloaded_for_stale_chunk');
  window.location.reload();
  return true;
}
