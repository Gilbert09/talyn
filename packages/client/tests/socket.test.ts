import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureApiClient,
  WebSocketClient,
  type ApiClientConfig,
  type ClientRuntime,
} from '../src/native';
import { defaultScheduler } from '../src/runtime';
import { deferred, Lifecycle, Socket } from './helpers';

let lifecycle: Lifecycle;
let sockets: Socket[];
let client: WebSocketClient;
let config: ApiClientConfig;
const token = vi.fn<() => Promise<string | null>>();

function configure(runtime: ClientRuntime = {}) {
  config = {
    baseUrl: 'https://example.test/',
    clientVersion: 'native/test',
    getAccessToken: token,
    recoverSession: async () => false,
    runtime: {
      lifecycle,
      createWebSocket: (url) => {
        const socket = new Socket(url);
        sockets.push(socket);
        return socket;
      },
      ...runtime,
    },
  };
  configureApiClient(config);
}

async function connect() {
  await client.connect();
  const socket = sockets.at(-1)!;
  socket.open();
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  lifecycle = new Lifecycle();
  sockets = [];
  token.mockReset().mockResolvedValue('token');
  configure();
  client = new WebSocketClient();
});
afterEach(() => {
  client.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('native lifecycle and reachability', () => {
  it('handles a synchronous resume during listener binding without duplicate connections', async () => {
    lifecycle.update({ activity: 'suspended' });
    configure({
      lifecycle: {
        getSnapshot: lifecycle.getSnapshot,
        subscribe: (listener) => {
          const off = lifecycle.subscribe(listener);
          lifecycle.update({ activity: 'active' });
          return off;
        },
      },
    });
    await client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(token).toHaveBeenCalledOnce();
    expect(lifecycle.listeners.size).toBe(1);
    client.disconnect();
    expect(lifecycle.listeners.size).toBe(0);
  });

  it.each(['suspended', 'offline'] as const)(
    'cancels all timers while %s and resumes one connection',
    async (blocked) => {
      const socket = await connect();
      socket.accept();
      expect(vi.getTimerCount()).toBe(2);
      lifecycle.update(
        blocked === 'suspended' ? { activity: 'suspended' } : { reachability: 'offline' }
      );
      expect(socket.close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      await client.connect();
      expect(sockets).toHaveLength(1);
      lifecycle.update({ activity: 'active', reachability: 'unknown' });
      lifecycle.update({ activity: 'active', reachability: 'online' });
      lifecycle.wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      expect(token).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['active', 'suspended'] as const)(
    'does not resume while offline and %s',
    async (activity) => {
      lifecycle.update({ activity, reachability: 'offline' });
      await client.connect();
      lifecycle.wake();
      lifecycle.update({ activity: 'active' });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(token).not.toHaveBeenCalled();
      lifecycle.update({ reachability: 'unknown' });
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
    }
  );

  it('keeps recovery blocked until both suspension and offline state end', async () => {
    await connect();
    lifecycle.update({ activity: 'suspended', reachability: 'offline' });
    lifecycle.update({ reachability: 'online' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    lifecycle.update({ activity: 'active' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
  });

  it('cancels a queued reconnect and ignores late host callbacks after disconnect', async () => {
    const socket = await connect();
    const listener = [...lifecycle.listeners][0];
    socket.reject(1006);
    expect(vi.getTimerCount()).toBe(1);
    client.disconnect();
    listener({ type: 'wake' });
    expect(lifecycle.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await connect();
    expect(lifecycle.listeners.size).toBe(1);
    client.dispose();
    await client.connect();
    expect(lifecycle.listeners.size).toBe(0);
    expect(sockets).toHaveLength(2);
  });

  it.each(['suspend', 'disconnect', 'configure'] as const)(
    'ignores a stale token lookup after %s',
    async (action) => {
      const old = deferred<string>();
      token.mockReturnValueOnce(old.promise);
      const pending = client.connect();
      await client.connect();
      if (action === 'suspend') {
        lifecycle.update({ activity: 'suspended' });
        lifecycle.update({ activity: 'active' });
      } else if (action === 'disconnect') {
        client.disconnect();
        void client.connect();
      } else {
        configureApiClient({
          ...config,
          baseUrl: 'https://new.test',
          getAccessToken: async () => 'new-token',
        });
        void client.connect();
      }
      old.resolve('old-token');
      await pending;
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      sockets[0].open();
      expect(sockets[0].sent[0]).toEqual({
        type: 'auth',
        token: action === 'configure' ? 'new-token' : 'token',
      });
      if (action === 'configure') expect(sockets[0].url).toBe('wss://new.test/ws');
    }
  );

  it('clears account state and ignores all old socket handlers after configuration changes', async () => {
    client.subscribe('old-workspace');
    client.subscribeSpace('old-space');
    client.sendPresence('old-space', 'old-session', 'active');
    client.setCapabilities(['threads']);
    client.setDebugFilter('old-owner');
    const old = await connect();
    old.accept();
    const handler = vi.fn();
    client.on('event', handler);
    const callbacks = {
      open: old.onopen,
      message: old.onmessage,
      close: old.onclose,
      error: old.onerror,
    };
    const oldListener = [...lifecycle.listeners][0];
    configureApiClient({ ...config, baseUrl: 'https://new.test' });
    const currentHandler = vi.fn();
    client.on('event', currentHandler);
    const current = await connect();
    current.accept();
    oldListener({ type: 'wake' });
    callbacks.open?.();
    callbacks.message?.({ data: JSON.stringify({ type: 'event', payload: {} }) });
    callbacks.close?.({ code: 4401 });
    callbacks.error?.();
    current.message('event', {});
    expect(handler).not.toHaveBeenCalled();
    expect(currentHandler).toHaveBeenCalledOnce();
    expect(current.sent).toEqual([{ type: 'auth', token: 'token' }]);
    expect(vi.getTimerCount()).toBe(2);
  });
});

describe('protocol and scheduling', () => {
  it('authenticates first and restores subscriptions, capabilities, presence, and filters after acceptance', async () => {
    client.setCapabilities(['threads']);
    client.subscribe('workspace');
    client.subscribeSpace('space');
    client.sendPresence('space', 'session', 'active');
    client.setDebugFilter('owner');
    const first = await connect();
    expect(first.url).toBe('wss://example.test/ws');
    expect(first.sent).toEqual([{ type: 'auth', token: 'token' }]);
    first.accept();
    const restored = first.sent.slice(1);
    expect(restored).toEqual([
      { type: 'subscribe', workspaceId: 'workspace', capabilities: ['threads'] },
      { type: 'subscribe_space', spaceId: 'space' },
      { type: 'presence', spaceId: 'space', sessionId: 'session', state: 'active' },
      { type: 'debug:filter', owner: 'owner' },
    ]);
    first.reject(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const next = sockets[1];
    next.open();
    expect(next.sent).toHaveLength(1);
    next.accept();
    expect(next.sent.slice(1)).toEqual(restored);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(next.sent.at(-1)).toEqual(restored[2]);
  });

  it.each([null, 'throw', 'constructor'] as const)(
    'backs off and caps retries for %s failures',
    async (failure) => {
      if (failure === null) token.mockResolvedValue(null);
      else if (failure === 'throw') token.mockRejectedValue(new Error('No session'));
      else
        configure({
          createWebSocket: () => {
            throw new Error('Connection failed');
          },
        });
      await client.connect();
      let calls = 1;
      for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(token).toHaveBeenCalledTimes(calls);
        await vi.advanceTimersByTimeAsync(1);
        expect(token).toHaveBeenCalledTimes(++calls);
        expect(vi.getTimerCount()).toBe(1);
      }
    }
  );

  it.each([4401, 1013])(
    'preserves the retry floor for rejection %s across wake and resume',
    async (code) => {
      configure({ reconnectJitter: 1, random: () => 1 });
      const socket = await connect();
      socket.reject(code);
      lifecycle.wake();
      await client.connect();
      await vi.advanceTimersByTimeAsync(29_999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const rejected = sockets[1];
      rejected.open();
      rejected.reject(code);
      lifecycle.update({ activity: 'suspended' });
      lifecycle.update({ activity: 'active' });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      const accepted = sockets[2];
      accepted.open();
      accepted.accept();
      accepted.reject(1006);
      await vi.advanceTimersByTimeAsync(1999);
      expect(sockets).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(4);
    }
  );

  it.each([
    [0, 0],
    [0.5, 0.5],
    [1, 1],
    [-2, -1],
    [3, 2],
  ])('bounds jitter %s with random %s', async (jitter, random) => {
    configure({ reconnectJitter: jitter, random: () => random });
    const socket = await connect();
    socket.reject(1006);
    const delay = 1000 * (1 + Math.max(0, Math.min(1, jitter)) * Math.max(0, Math.min(1, random)));
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
  });

  it('uses the injected clock and ignores canceled heartbeat and reconnect callbacks', async () => {
    const callbacks: (() => void)[] = [];
    const timeout = vi.fn((callback: () => void, delay: number) => {
      callbacks.push(callback);
      return defaultScheduler.timeout(callback, delay);
    });
    const interval = vi.fn((callback: () => void, delay: number) => {
      callbacks.push(callback);
      return defaultScheduler.interval(callback, delay);
    });
    configure({ scheduler: { ...defaultScheduler, timeout, interval } });
    const socket = await connect();
    socket.reject(1006);
    client.disconnect();
    await connect();
    const fresh = sockets[1];
    fresh.accept();
    for (const callback of callbacks.slice(0, 3)) callback();
    expect(fresh.pings()).toBe(0);
    expect(sockets).toHaveLength(2);
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 25_000);
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1000);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(fresh.pings()).toBe(1);
    fresh.message('connection:status', { pong: true });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(fresh.close).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 300_000);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(fresh.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(fresh.close).toHaveBeenCalledOnce();
  });

  it('disposes event subscriptions', async () => {
    const socket = await connect();
    const handler = vi.fn();
    const off = client.on('event', handler);
    socket.message('event', {});
    off();
    socket.message('event', {});
    expect(handler).toHaveBeenCalledOnce();
  });

  it('keeps old disposal functions from removing new account listeners', async () => {
    const handler = vi.fn();
    await connect();
    const off = client.on('event', handler);
    configureApiClient(config);
    const current = await connect();
    client.on('event', handler);
    off();
    current.message('event', {});
    expect(handler).toHaveBeenCalledOnce();
  });

  it('stops delivering an event after a handler resets the account', async () => {
    const socket = await connect();
    const stale = vi.fn();
    client.on('event', () => configureApiClient(config));
    client.on('event', stale);
    socket.message('event', {});
    expect(stale).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
