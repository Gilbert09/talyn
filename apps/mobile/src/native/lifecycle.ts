import type { ClientLifecycle, ClientLifecycleEvent, ClientState, Reachability } from '@talyn/client/native';

export interface NativeActivity {
  currentState: string | null | undefined;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}
export interface NetworkState { isConnected: boolean | null; isInternetReachable: boolean | null }
export interface NativeNetwork {
  addEventListener(listener: (state: NetworkState) => void): () => void;
}

export function reachability(state: NetworkState): Reachability {
  if (state.isConnected === false || state.isInternetReachable === false) return 'offline';
  if (state.isConnected === true && state.isInternetReachable === true) return 'online';
  return 'unknown';
}

export function createNativeLifecycle(activity: NativeActivity, network: NativeNetwork): ClientLifecycle & { dispose(): void } {
  let state: ClientState = { activity: activity.currentState === 'active' ? 'active' : 'suspended', reachability: 'unknown' };
  const listeners = new Set<(event: ClientLifecycleEvent) => void>();
  const update = (next: ClientState) => {
    if (state.activity === next.activity && state.reachability === next.reachability) return;
    state = next;
    for (const listener of listeners) listener({ type: 'state', state });
  };
  const app = activity.addEventListener('change', (value) => update({ ...state, activity: value === 'active' ? 'active' : 'suspended' }));
  const net = network.addEventListener((value) => update({ ...state, reachability: reachability(value) }));
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { app.remove(); net(); listeners.clear(); },
  };
}
