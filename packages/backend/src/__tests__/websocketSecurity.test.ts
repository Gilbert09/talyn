import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import { WebSocket, type WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as auth from '../middleware/auth.js';
import { getDbClient } from '../db/client.js';
import { debugBus } from '../services/debugBus.js';
import { dispatchIncoming } from '../services/wsBus.js';
import {
  broadcastToUser,
  broadcastToWorkspace,
  createWebSocketUpgradeGuard,
  setupWebSocket,
} from '../services/websocket.js';

vi.mock('../db/client.js', () => ({ getDbClient: vi.fn() }));

class TestSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  close = vi.fn((code = 1000, _reason?: string) => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code);
  });
  terminate = vi.fn(() => this.close());

  receive(message: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const event = { type: 'task:update' as const, payload: {}, timestamp: '2026-09-12T00:00:00Z' };

describe('WebSocket authorization and message limits', () => {
  let socket: TestSocket;
  let server: EventEmitter;
  let sockets: TestSocket[];
  let user: auth.AuthUser;
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
    vi.stubEnv('TALYN_ALLOWED_EMAILS', '');
    user = { id: 'owner', email: 'owner@test', isAdmin: true, expiresAt: Date.now() + 60_000 };
    vi.spyOn(auth, 'verifyTokenAndGetUser').mockResolvedValue(user);
    vi.mocked(getDbClient).mockReturnValue(db as never);
    db.select.mockReturnValue(db);
    db.from.mockReturnValue(db);
    db.where.mockReturnValue(db);
    db.limit.mockResolvedValue([{ email: user.email, isAdmin: true, ownerId: user.id }]);
    sockets = [];
    server = new EventEmitter();
    setupWebSocket(server as WebSocketServer, 500, 1000);
    socket = createSocket();
  });

  afterEach(() => {
    for (const connected of sockets) connected.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  function createSocket() {
    const created = new TestSocket();
    sockets.push(created);
    server.emit('connection', created, { socket: { remoteAddress: `192.0.2.${sockets.length}` } });
    return created;
  }

  async function authenticate(target = socket) {
    target.receive({ type: 'auth', token: 'test-token' });
    await vi.advanceTimersByTimeAsync(0);
    expect(target.send).toHaveBeenCalledWith(expect.stringContaining('"connected":true'));
  }

  function sendAllScopes() {
    broadcastToUser(user.id, event);
    broadcastToWorkspace('workspace', event);
    for (const scope of ['all', 'workspace', 'user']) {
      dispatchIncoming(JSON.stringify({ replicaId: 'other', scope, userId: user.id, workspaceId: 'workspace', event }));
    }
    debugBus.recordEvent({ service: 'test', action: 'test', summary: 'sensitive' });
  }

  it('closes at token expiry and stops every delivery path', async () => {
    user.expiresAt = Date.now() + 500;
    await authenticate();
    socket.receive({ type: 'subscribe', workspaceId: 'workspace' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.close).toHaveBeenCalledWith(4401, 'authorization expired');
    socket.send.mockClear();
    sendAllScopes();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('blocks delivery at the deadline even before the timer runs', async () => {
    user.expiresAt = Date.now() + 500;
    await authenticate();
    socket.send.mockClear();
    vi.setSystemTime(Date.now() + 500);
    sendAllScopes();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, NaN, Infinity])('refuses an invalid verified expiry: %s', async (expiresAt) => {
    user.expiresAt = expiresAt;
    socket.receive({ type: 'auth', token: 'test-token' });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.close).toHaveBeenCalledWith(4401, 'invalid token');
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('removes debug access after database demotion without bootstrapping the user again', async () => {
    vi.stubEnv('TALYN_ADMIN_EMAILS', user.email);
    await authenticate();
    db.limit.mockResolvedValue([{ email: user.email, isAdmin: false }]);
    await vi.advanceTimersByTimeAsync(1000);
    socket.send.mockClear();
    debugBus.recordEvent({ service: 'test', action: 'test', summary: 'sensitive' });
    expect(socket.send).not.toHaveBeenCalled();
    broadcastToUser(user.id, event);
    expect(socket.send).toHaveBeenCalledOnce();
    expect(auth.verifyTokenAndGetUser).toHaveBeenCalledOnce();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it.each(['close', 'error', 'expiry'])('caps one owner across IPs and releases capacity on %s', async (reason) => {
    if (reason === 'expiry') user.expiresAt = Date.now() + 500;
    await authenticate();
    user = { ...user, expiresAt: Date.now() + 60_000 };
    vi.mocked(auth.verifyTokenAndGetUser).mockResolvedValue(user);
    for (let i = 1; i < 20; i++) await authenticate(createSocket());

    const rejected = createSocket();
    rejected.receive({ type: 'auth', token: 'test-token' });
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected.close).toHaveBeenCalledWith(1013, 'owner connection limit');
    expect(rejected.send).not.toHaveBeenCalled();

    vi.mocked(auth.verifyTokenAndGetUser).mockResolvedValueOnce({ ...user, id: 'another-owner' });
    await authenticate(createSocket());
    if (reason === 'close') socket.close();
    if (reason === 'error') socket.emit('error', new Error('socket failed'));
    if (reason === 'expiry') await vi.advanceTimersByTimeAsync(500);
    await authenticate(createSocket());
  });

  it('enforces the owner cap when authentication attempts finish together', async () => {
    const pending = deferred<auth.AuthUser>();
    vi.mocked(auth.verifyTokenAndGetUser).mockReturnValue(pending.promise);
    for (let i = 0; i < 21; i++) {
      const target = i === 0 ? socket : createSocket();
      target.receive({ type: 'auth', token: 'test-token' });
    }
    pending.resolve(user);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets.filter((target) => target.readyState === WebSocket.OPEN)).toHaveLength(20);
    expect(sockets[20].close).toHaveBeenCalledWith(1013, 'owner connection limit');
  });

  it.each(['deleted', 'forbidden', 'database failure'])('closes when authorization becomes %s', async (failure) => {
    await authenticate();
    if (failure === 'deleted') db.limit.mockResolvedValue([]);
    if (failure === 'forbidden') vi.stubEnv('TALYN_ALLOWED_EMAILS', 'someone-else@test');
    if (failure === 'database failure') db.limit.mockRejectedValue(new Error('database unavailable'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.close).toHaveBeenCalledWith(failure === 'database failure' ? 1013 : 4401, expect.any(String));
    socket.send.mockClear();
    sendAllScopes();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('expires a stalled authorization check and ignores its late result', async () => {
    await authenticate();
    const pending = deferred<Array<{ email: string; isAdmin: boolean }>>();
    db.limit.mockReturnValue(pending.promise);
    await vi.advanceTimersByTimeAsync(2000);
    expect(db.limit).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(4401, 'authorization expired');
    pending.resolve([{ email: user.email, isAdmin: true }]);
    await vi.advanceTimersByTimeAsync(0);
    socket.send.mockClear();
    sendAllScopes();
    expect(socket.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['duplicate auth', 'peer close', 'handshake timeout'])('ignores authentication after %s', async (failure) => {
    const pending = deferred<auth.AuthUser>();
    vi.mocked(auth.verifyTokenAndGetUser).mockReturnValue(pending.promise);
    socket.receive({ type: 'auth', token: 'first' });
    if (failure === 'duplicate auth') socket.receive({ type: 'auth', token: 'second' });
    if (failure === 'peer close') socket.close();
    if (failure === 'handshake timeout') await vi.advanceTimersByTimeAsync(500);
    pending.resolve(user);
    await vi.advanceTimersByTimeAsync(0);
    expect(auth.verifyTokenAndGetUser).toHaveBeenCalledOnce();
    expect(socket.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes subscriptions, avoids duplicate queries, and preserves unsubscribe order', async () => {
    await authenticate();
    socket.receive({ type: 'subscribe', workspaceId: 'workspace' });
    socket.receive({ type: 'subscribe', workspaceId: 'workspace' });
    socket.receive({ type: 'unsubscribe', workspaceId: 'workspace' });
    await vi.advanceTimersByTimeAsync(0);
    expect(db.limit).toHaveBeenCalledOnce();
    socket.send.mockClear();
    broadcastToWorkspace('workspace', event);
    expect(socket.send.mock.calls.map(([raw]) => JSON.parse(raw).type)).not.toContain('task:update');
  });

  it('bounds pending subscription work and drops the queue after closure', async () => {
    await authenticate();
    const pending = deferred<Array<{ ownerId: string }>>();
    db.limit.mockReturnValue(pending.promise);
    socket.receive({ type: 'subscribe', workspaceId: 'workspace' });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 66; i++) socket.receive({ type: 'subscribe', workspaceId: `workspace-${i}` });
    expect(socket.close).toHaveBeenCalledWith(1008, 'too many pending messages');
    pending.resolve([{ ownerId: user.id }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(db.limit).toHaveBeenCalledOnce();
    socket.send.mockClear();
    sendAllScopes();
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('catches subscription query failures', async () => {
    await authenticate();
    db.limit.mockRejectedValue(new Error('database unavailable'));
    socket.receive({ type: 'subscribe', workspaceId: 'workspace' });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.close).toHaveBeenCalledWith(1013, 'message handling failed');
  });

  it.each([null, [], 'auth', { type: 'subscribe', workspaceId: {} }, { type: 'unknown' }])(
    'rejects malformed messages: %j', async (message) => {
      await authenticate();
      socket.receive(message);
      await vi.advanceTimersByTimeAsync(0);
      expect(socket.close).toHaveBeenCalledWith(1008, expect.any(String));
      expect(db.limit).not.toHaveBeenCalled();
    }
  );

  it('caps active subscriptions', async () => {
    await authenticate();
    for (let i = 0; i < 65; i++) {
      socket.receive({ type: 'subscribe', workspaceId: `workspace-${i}` });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(db.limit).toHaveBeenCalledTimes(64);
    expect(socket.close).toHaveBeenCalledWith(1008, 'subscription limit');
  });

  it('accepts a reconnect burst for every permitted subscription', async () => {
    await authenticate();
    for (let i = 0; i < 64; i++) socket.receive({ type: 'subscribe', workspaceId: `workspace-${i}` });
    socket.receive({ type: 'debug:filter', owner: 'all' });
    socket.receive({ type: 'ping' });
    await vi.advanceTimersByTimeAsync(0);
    expect(db.limit).toHaveBeenCalledTimes(64);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('limits messages even when each message finishes immediately', async () => {
    await authenticate();
    for (let i = 0; i < 120; i++) {
      socket.receive({ type: 'ping' });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(socket.close).toHaveBeenCalledWith(1008, 'message limit');
    expect(db.limit).not.toHaveBeenCalled();
  });
});

describe('WebSocket upgrade guard', () => {
  function request(ip: string, forwarded?: string) {
    const socket = Object.assign(new EventEmitter(), { remoteAddress: ip });
    return { headers: { 'x-forwarded-for': forwarded }, socket } as unknown as IncomingMessage;
  }

  afterEach(() => { vi.useRealTimers(); });

  it('limits repeated upgrades and renews the budget after a minute', () => {
    vi.useFakeTimers();
    const allow = createWebSocketUpgradeGuard();
    for (let i = 0; i < 120; i++) {
      const req = request('192.0.2.1');
      expect(allow(req)).toBe(true);
      req.socket.emit('close');
    }
    expect(allow(request('192.0.2.1'))).toBe(false);
    expect(allow(request('192.0.2.2'))).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(allow(request('192.0.2.1'))).toBe(true);
  });

  it('caps concurrent sockets and releases capacity on closure', () => {
    const allow = createWebSocketUpgradeGuard();
    const first = request('192.0.2.1');
    expect(allow(first)).toBe(true);
    for (let i = 1; i < 50; i++) expect(allow(request('192.0.2.1'))).toBe(true);
    expect(allow(request('192.0.2.1'))).toBe(false);
    first.socket.emit('close');
    expect(allow(request('192.0.2.1'))).toBe(true);
  });

  it('uses the last forwarded address, not an attacker-controlled prefix', () => {
    const allow = createWebSocketUpgradeGuard();
    for (let i = 0; i < 50; i++) {
      expect(allow(request('127.0.0.1', `192.0.2.${i}, 198.51.100.1`))).toBe(true);
    }
    expect(allow(request('127.0.0.1', '203.0.113.1, 198.51.100.1'))).toBe(false);
    expect(allow(request('127.0.0.1', '198.51.100.2'))).toBe(true);
  });

  it('caps sockets across source addresses', () => {
    const allow = createWebSocketUpgradeGuard();
    for (let i = 0; i < 1000; i++) expect(allow(request(`2001:db8::${i.toString(16)}`))).toBe(true);
    expect(allow(request('192.0.2.1'))).toBe(false);
  });
});
