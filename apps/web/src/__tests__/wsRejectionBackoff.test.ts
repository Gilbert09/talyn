import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureApiClient, wsClient } from '@talyn/client';

/**
 * Backoff after the server rejects an OPEN socket.
 *
 * A socket that opens is not a socket the server has accepted. It can still be
 * closed straight afterwards — `1013` when the owner is at its connection
 * limit, `4401` when the token is invalid, revoked, or its authorization has
 * expired. Resetting the backoff on `open` made every such rejection reconnect
 * at a flat one second, forever: each cycle costs the backend a token
 * verification plus a user-row write, and burns the address's upgrade budget,
 * so two looping clients behind one NAT start refusing that NAT's healthy ones.
 *
 * The reset therefore belongs at the point the server CONFIRMS the connection,
 * and a standing rejection goes straight to the ceiling.
 */

const getAccessToken = vi.fn<() => Promise<string | null>>();

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  /** The server closing us, with the code it actually sends. */
  reject(code: number) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
  /** The server confirming the connection after `auth`. */
  accept() {
    this.onmessage?.({
      data: JSON.stringify({ type: 'connection:status', payload: { connected: true } }),
    });
  }
}

async function connect(): Promise<FakeWebSocket> {
  FakeWebSocket.instances = [];
  await wsClient.connect();
  const ws = FakeWebSocket.instances[0];
  ws.onopen?.();
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
  getAccessToken.mockReset().mockResolvedValue('token');
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  configureApiClient({
    baseUrl: 'http://localhost:4747',
    clientVersion: 'web/test',
    getAccessToken,
    recoverSession: async () => false,
  });
});

afterEach(() => {
  wsClient.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reconnect backoff after a post-open rejection', () => {
  it.each([
    ['an expired or revoked authorization', 4401],
    ['the owner connection limit', 1013],
  ])('waits the full ceiling after %s', async (_name, code) => {
    const ws = await connect();
    ws.reject(code);

    // Nothing at the one-second delay an opened-then-rejected socket used to get.
    await vi.advanceTimersByTimeAsync(29_999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('stays at the ceiling while the rejection keeps repeating', async () => {
    const ws = await connect();
    ws.reject(4401);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.instances[1];
    second.onopen?.();
    second.reject(4401);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('starts over once the server confirms a connection', async () => {
    const ws = await connect();
    ws.reject(4401);
    await vi.advanceTimersByTimeAsync(30_000);

    // The second attempt is accepted, which is what earns a fresh backoff.
    const second = FakeWebSocket.instances[1];
    second.onopen?.();
    second.accept();
    second.reject(1006); // an ordinary drop, not a rejection

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('still backs off normally for an ordinary close', async () => {
    const ws = await connect();
    ws.accept();
    ws.reject(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
