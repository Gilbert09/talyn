import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureApiClient, wsClient } from '../../../client/src/index.js';

class BrowserSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static sockets: BrowserSocket[] = [];
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  send = vi.fn();
  constructor() { BrowserSocket.sockets.push(this); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  open() { this.readyState = 1; this.onopen?.(); }
  accept() { this.onmessage?.({ data: JSON.stringify({ type: 'connection:status', payload: { connected: true } }) }); }
  messages() { return this.send.mock.calls.map(([raw]) => JSON.parse(raw)); }
}

beforeEach(() => {
  vi.useFakeTimers();
  BrowserSocket.sockets = [];
  vi.stubGlobal('WebSocket', BrowserSocket);
  vi.stubGlobal('window', { setInterval, setTimeout, addEventListener: vi.fn() });
  vi.stubGlobal('document', { addEventListener: vi.fn() });
  configureApiClient({ baseUrl: 'https://example.test', clientVersion: 'test', getAccessToken: async () => 'token', recoverSession: async () => false });
});
afterEach(() => {
  wsClient.unsubscribeSpace('space');
  wsClient.disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function connect() {
  await wsClient.connect();
  const socket = BrowserSocket.sockets.at(-1)!;
  socket.open();
  return socket;
}

it('sends subscriptions and queued presence after authentication', async () => {
  wsClient.subscribeSpace('space');
  wsClient.sendPresence('space', 'session', 'active');
  const socket = await connect();
  expect(socket.messages()).toEqual([{ type: 'auth', token: 'token' }]);
  socket.accept();
  expect(socket.messages().slice(1)).toEqual([
    { type: 'subscribe_space', spaceId: 'space' },
    { type: 'presence', spaceId: 'space', sessionId: 'session', state: 'active' },
  ]);
});

it('renews presence every 20 seconds and stops after unsubscribe', async () => {
  const socket = await connect();
  socket.accept();
  wsClient.subscribeSpace('space');
  wsClient.sendPresence('space', 'session', 'active');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(socket.messages().filter((m) => m.type === 'presence')).toHaveLength(2);
  wsClient.sendPresence('space', null, 'away');
  expect(socket.messages().at(-1)).toMatchObject({ type: 'presence', sessionId: null, state: 'away' });
  wsClient.unsubscribeSpace('space');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(socket.messages().filter((m) => m.type === 'presence')).toHaveLength(3);
  expect(socket.messages()).toContainEqual({ type: 'unsubscribe_space', spaceId: 'space' });
});

it('resubscribes and restores presence after reconnect', async () => {
  wsClient.subscribeSpace('space');
  wsClient.sendPresence('space', 'session', 'active');
  const first = await connect();
  first.accept();
  first.close();
  await vi.advanceTimersByTimeAsync(2_000);
  const second = BrowserSocket.sockets.at(-1)!;
  expect(second).not.toBe(first);
  second.open();
  second.accept();
  expect(second.messages().slice(1)).toEqual([
    { type: 'subscribe_space', spaceId: 'space' },
    { type: 'presence', spaceId: 'space', sessionId: 'session', state: 'active' },
  ]);
});

it('does not send presence for an unsubscribed space', async () => {
  const socket = await connect();
  socket.accept();
  wsClient.sendPresence('space', 'session', 'active');
  expect(socket.messages().some((m) => m.type === 'presence')).toBe(false);
});
