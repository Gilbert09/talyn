export type Reachability = 'online' | 'offline' | 'unknown';
export interface ClientState {
  activity: 'active' | 'suspended';
  reachability: Reachability;
}
export type ClientLifecycleEvent = { type: 'state'; state: ClientState } | { type: 'wake' };

/** The host owns AppState and reachability listeners. */
export interface ClientLifecycle {
  getSnapshot(): ClientState;
  subscribe(listener: (event: ClientLifecycleEvent) => void): () => void;
}

/** Each timer returns its cancellation function. */
export interface ClientScheduler {
  now(): number;
  timeout(callback: () => void, delayMs: number): () => void;
  interval(callback: () => void, delayMs: number): () => void;
}

export interface ClientSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event?: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ClientRuntime {
  lifecycle?: ClientLifecycle;
  scheduler?: ClientScheduler;
  createWebSocket?: (url: string) => ClientSocket;
  fetch?: typeof globalThis.fetch;
  /** Optional positive jitter, from zero to one. The total delay is at most 30 seconds. */
  reconnectJitter?: number;
  random?: () => number;
}

const neutralLifecycle: ClientLifecycle = {
  getSnapshot: () => ({ activity: 'active', reachability: 'unknown' }),
  subscribe: () => () => {},
};

export const defaultScheduler: ClientScheduler = {
  now: () => Date.now(),
  timeout: (callback, delay) => {
    const timer = globalThis.setTimeout(callback, delay);
    return () => globalThis.clearTimeout(timer);
  },
  interval: (callback, delay) => {
    const timer = globalThis.setInterval(callback, delay);
    return () => globalThis.clearInterval(timer);
  },
};

export function resolveRuntime(runtime: ClientRuntime = {}) {
  return {
    lifecycle: runtime.lifecycle ?? neutralLifecycle,
    scheduler: runtime.scheduler ?? defaultScheduler,
    createWebSocket:
      runtime.createWebSocket ??
      ((url: string) => new globalThis.WebSocket(url) as unknown as ClientSocket),
    fetch: runtime.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)),
    reconnectJitter: Math.max(0, Math.min(1, runtime.reconnectJitter ?? 0)),
    random: runtime.random ?? Math.random,
  };
}

export function canRun(state: ClientState): boolean {
  return state.activity === 'active' && state.reachability !== 'offline';
}
