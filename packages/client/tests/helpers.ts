import { vi } from 'vitest';
import type {
  ClientLifecycle,
  ClientLifecycleEvent,
  ClientSocket,
  ClientState,
} from '../src/runtime';

export class Lifecycle implements ClientLifecycle {
  state: ClientState = { activity: 'active', reachability: 'unknown' };
  listeners = new Set<(event: ClientLifecycleEvent) => void>();
  removed: ((event: ClientLifecycleEvent) => void)[] = [];
  getSnapshot = () => this.state;
  subscribe = (listener: (event: ClientLifecycleEvent) => void) => {
    this.listeners.add(listener);
    return () => {
      this.removed.push(listener);
      this.listeners.delete(listener);
    };
  };
  update(state: Partial<ClientState>) {
    this.state = { ...this.state, ...state };
    for (const listener of this.listeners) listener({ type: 'state', state: this.state });
  }
  wake() {
    for (const listener of this.listeners) listener({ type: 'wake' });
  }
}

export class Socket implements ClientSocket {
  readyState = 0;
  onopen: ClientSocket['onopen'] = null;
  onmessage: ClientSocket['onmessage'] = null;
  onclose: ClientSocket['onclose'] = null;
  onerror: ClientSocket['onerror'] = null;
  sent: Record<string, unknown>[] = [];
  close = vi.fn(() => {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  });
  constructor(readonly url: string) {}
  send(data: string) {
    if (this.readyState !== 1) throw new Error('Socket is not open');
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(type: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, payload }) });
  }
  accept() {
    this.message('connection:status', { connected: true });
  }
  reject(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  pings() {
    return this.sent.filter((frame) => frame.type === 'ping').length;
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function response(status = 200, data: unknown = []): Response {
  return {
    status,
    ok: status < 400,
    text: async () =>
      JSON.stringify(
        status < 400 ? { success: true, data } : { success: false, error: 'Unauthorized' }
      ),
  } as Response;
}
