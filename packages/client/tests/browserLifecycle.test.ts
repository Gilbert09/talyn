// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureApiClient, WebSocketClient } from '../src/index';
import { Socket } from './helpers';
import { browserLifecycle } from '../src/browserLifecycle';

let client: WebSocketClient;
let sockets: Socket[];
beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  configureApiClient({
    baseUrl: 'https://example.test',
    clientVersion: 'web/test',
    getAccessToken: async () => 'token',
    recoverSession: async () => false,
    runtime: {
      createWebSocket: (url) => {
        const socket = new Socket(url);
        sockets.push(socket);
        return socket;
      },
    },
  });
  client = new WebSocketClient();
});
afterEach(() => {
  client.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(['focus', 'online', 'pageshow', 'visibilitychange'])(
  'retains browser recovery for %s',
  async (type) => {
    await client.connect();
    const socket = sockets[0];
    socket.open();
    socket.accept();
    if (type === 'visibilitychange') document.dispatchEvent(new Event(type));
    else window.dispatchEvent(new Event(type));
    expect(socket.pings()).toBe(1);
    socket.message('connection:status', { pong: true });
    socket.reject(1006);
    if (type === 'visibilitychange') document.dispatchEvent(new Event(type));
    else window.dispatchEvent(new Event(type));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
  }
);

it('keeps hidden tabs active and supports absent online detection', async () => {
  Object.defineProperty(navigator, 'onLine', { value: undefined, configurable: true });
  expect(browserLifecycle.getSnapshot().reachability).toBe('unknown');
  await client.connect();
  sockets[0].open();
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(sockets[0].pings()).toBe(0);
  expect(vi.getTimerCount()).toBe(2);
});

it('cancels reconnect on offline and starts one recovery on online', async () => {
  await client.connect();
  sockets[0].open();
  sockets[0].reject(1006);
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
  window.dispatchEvent(new Event('offline'));
  expect(vi.getTimerCount()).toBe(0);
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sockets).toHaveLength(1);
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  window.dispatchEvent(new Event('online'));
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(0);
  expect(sockets).toHaveLength(2);
});

it('removes every browser listener on disconnect', async () => {
  const addWindow = vi.spyOn(window, 'addEventListener');
  const removeWindow = vi.spyOn(window, 'removeEventListener');
  const addDocument = vi.spyOn(document, 'addEventListener');
  const removeDocument = vi.spyOn(document, 'removeEventListener');
  await client.connect();
  client.disconnect();
  expect(addWindow.mock.calls.map(([type]) => type).sort()).toEqual([
    'focus',
    'offline',
    'online',
    'pageshow',
  ]);
  expect(removeWindow.mock.calls).toEqual(addWindow.mock.calls);
  expect(removeDocument.mock.calls).toEqual(addDocument.mock.calls);
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sockets).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
