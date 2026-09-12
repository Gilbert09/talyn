import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configureApiClient, wsClient } from '@talyn/client';

/**
 * The WebSocket connect race.
 *
 * `connect()` guards re-entry on `this.ws?.readyState`, but it awaits
 * `getAuthToken()` BEFORE assigning `this.ws`. Two callers arriving inside that
 * window — a focus wake landing on top of a reconnect tick — therefore both saw
 * a null socket and both opened one. The loser's socket was orphaned but still
 * live, and when it opened, its handler sent the auth frame on `this.ws`: by
 * then the WINNER's socket, still CONNECTING.
 *
 * That produced the top unhandled exception in the project:
 *
 *   DOMException: InvalidStateError: Failed to execute 'send' on 'WebSocket':
 *   Still in CONNECTING state.
 *
 * `send()` on the fake below throws exactly as the browser does, so these tests
 * fail with the real error rather than on a stand-in assertion.
 */

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  // Sockets start CONNECTING, as real ones do. The bug lives entirely in the
  // window before OPEN, so a fake that starts OPEN cannot reproduce it.
  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      // The browser's exact behaviour, and the whole point of these tests.
      throw new DOMException(
        "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
        'InvalidStateError'
      );
    }
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** The normal path: the handshake completes, then onopen fires. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** onopen delivered after the socket has already gone (sleep/wake). */
  openAfterClose() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onopen?.();
  }

  authFrames() {
    return this.sent.filter((s) => s.includes('"auth"')).length;
  }
}

/** A token whose resolution we control, to hold `connect()` open mid-await. */
function deferredToken() {
  let release!: (token: string) => void;
  const promise = new Promise<string>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let token: ReturnType<typeof deferredToken>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  token = deferredToken();
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  configureApiClient({
    baseUrl: 'http://localhost:4747',
    clientVersion: 'web/test',
    getAccessToken: () => token.promise,
    recoverSession: async () => false,
  });
});

afterEach(() => {
  wsClient.disconnect();
  vi.unstubAllGlobals();
});

describe('concurrent connect()', () => {
  it('opens exactly ONE socket when two callers race the token await', async () => {
    // Both calls start while `this.ws` is still null — the readyState guard
    // cannot see either of them.
    const first = wsClient.connect();
    const second = wsClient.connect();

    token.release('a-token');
    await Promise.all([first, second]);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('never throws InvalidStateError when the raced sockets open', async () => {
    const first = wsClient.connect();
    const second = wsClient.connect();
    token.release('a-token');
    await Promise.all([first, second]);

    // Opening every socket this produced must be safe. Before the fix the
    // orphan's onopen called send() on the winner's CONNECTING socket and this
    // threw.
    expect(() => {
      for (const ws of FakeWebSocket.instances) ws.open();
    }).not.toThrow();
  });

  it('authenticates on the socket that actually opened', async () => {
    const connecting = wsClient.connect();
    token.release('a-token');
    await connecting;

    const ws = FakeWebSocket.instances[0];
    ws.open();

    expect(ws.authFrames()).toBe(1);
    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: 'auth', token: 'a-token' });
  });
});

describe('a superseded socket', () => {
  it('does not send, and closes itself, when it opens after the field moved on', async () => {
    const connecting = wsClient.connect();
    token.release('a-token');
    await connecting;
    const orphan = FakeWebSocket.instances[0];

    // `disconnect()` nulls the field, which is what makes this socket an
    // orphan. Its handlers are still attached and still fire.
    wsClient.disconnect();

    expect(() => orphan.open()).not.toThrow();
    expect(orphan.authFrames()).toBe(0);
    expect(orphan.closed).toBe(true);
  });

  it('does not report a disconnect when an orphan closes', async () => {
    const connecting = wsClient.connect();
    token.release('a-token');
    await connecting;
    const orphan = FakeWebSocket.instances[0];
    orphan.open();

    const statuses: unknown[] = [];
    const off = wsClient.on('connection:status', (p) => statuses.push(p));
    wsClient.disconnect();
    statuses.length = 0; // the deliberate disconnect is not what we're testing

    // A late close from a socket that is no longer current must not announce
    // an outage under a healthy connection.
    orphan.close();
    expect(statuses).toEqual([]);
    off();
  });
});

describe('onopen delivered late', () => {
  it('does not send when the socket is no longer OPEN', async () => {
    const connecting = wsClient.connect();
    token.release('a-token');
    await connecting;
    const ws = FakeWebSocket.instances[0];

    // Still the current socket, but closed under us between the handshake and
    // the callback — a sleep/wake. send() would throw.
    expect(() => ws.openAfterClose()).not.toThrow();
    expect(ws.authFrames()).toBe(0);
  });
});

describe('the connecting guard releases', () => {
  it('allows a later connect after the token fails', async () => {
    configureApiClient({
      baseUrl: 'http://localhost:4747',
      clientVersion: 'web/test',
      getAccessToken: async () => {
        throw new Error('no session');
      },
      recoverSession: async () => false,
    });

    // A throw from getAuthToken must not wedge the guard on — that would block
    // every reconnect for the life of the process.
    await expect(wsClient.connect()).rejects.toThrow('no session');

    configureApiClient({
      baseUrl: 'http://localhost:4747',
      clientVersion: 'web/test',
      getAccessToken: async () => 'later-token',
      recoverSession: async () => false,
    });
    await wsClient.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('allows a later connect after the token comes back empty', async () => {
    configureApiClient({
      baseUrl: 'http://localhost:4747',
      clientVersion: 'web/test',
      getAccessToken: async () => '',
      recoverSession: async () => false,
    });
    await wsClient.connect();
    expect(FakeWebSocket.instances).toHaveLength(0);

    configureApiClient({
      baseUrl: 'http://localhost:4747',
      clientVersion: 'web/test',
      getAccessToken: async () => 'later-token',
      recoverSession: async () => false,
    });
    await wsClient.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
