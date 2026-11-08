import type { ClientLifecycle, ClientState, Reachability } from './runtime.js';

function reachability(): Reachability {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return 'unknown';
  return navigator.onLine ? 'online' : 'offline';
}

function snapshot(): ClientState {
  // Hidden tabs keep the existing heartbeat and reconnect behavior.
  return { activity: 'active', reachability: reachability() };
}

export const browserLifecycle: ClientLifecycle = {
  getSnapshot: snapshot,
  subscribe: (listener) => {
    if (typeof window === 'undefined') return () => {};
    const wake = () => listener({ type: 'wake' });
    const state = () => listener({ type: 'state', state: snapshot() });
    const visible = () => {
      if (document.visibilityState === 'visible') wake();
    };
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    window.addEventListener('online', wake);
    window.addEventListener('offline', state);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('offline', state);
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', visible);
    };
  },
};
