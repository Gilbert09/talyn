import { EventEmitter } from 'node:events';
import { WebSocket, type WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESK_PRESENCE_TTL_MS } from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import * as auth from '../middleware/auth.js';
import { debugBus } from '../services/debugBus.js';
import { deskPresence, DeskPresenceStore } from '../services/deskPresence.js';
import { getRedis } from '../services/redis.js';
import { setupWebSocket } from '../services/websocket.js';

vi.mock('../db/client.js', () => ({ getDbClient: vi.fn(), getPoolDbClient: vi.fn() }));
vi.mock('../services/redis.js', () => ({ getRedis: vi.fn(() => null), isRedisEnabled: () => false }));

/** Runs the store's one script against a map, and records each key's expiry. */
function createDeskRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const expiries = new Map<string, number>();
  return {
    hashes,
    expiries,
    hgetall: vi.fn(async (key: string) => Object.fromEntries(hashes.get(key) ?? [])),
    eval: vi.fn(async (_script: string, _keys: number, key: string, field: string, value: string, ttl: string) => {
      let hash = hashes.get(key);
      if (!value) {
        hash?.delete(field);
        if (!hash?.size) hashes.delete(key);
        return 1;
      }
      if (!hash) hashes.set(key, hash = new Map());
      hash.set(field, value);
      expiries.set(key, Number(ttl));
      return 1;
    }),
  };
}

describe.each(['memory', 'redis'] as const)('desk presence store with %s', (mode) => {
  let redis: ReturnType<typeof createDeskRedis>;
  let store: DeskPresenceStore;
  beforeEach(() => {
    vi.useFakeTimers();
    redis = createDeskRedis();
    store = new DeskPresenceStore(() => (mode === 'redis' ? redis as never : null));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('reads nobody as at their desk', async () => {
    expect(await store.atDesk('user')).toBe(false);
  });

  it('holds an active beat for the TTL and renews it on the next beat', async () => {
    await store.report('user', 'socket', true);
    expect(await store.atDesk('user')).toBe(true);
    await vi.advanceTimersByTimeAsync(DESK_PRESENCE_TTL_MS - 1);
    expect(await store.atDesk('user')).toBe(true);
    await store.report('user', 'socket', true);
    await vi.advanceTimersByTimeAsync(DESK_PRESENCE_TTL_MS - 1);
    expect(await store.atDesk('user')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await store.atDesk('user')).toBe(false);
    if (mode === 'redis') expect(redis.expiries.get('talyn:desk:user')).toBe(DESK_PRESENCE_TTL_MS);
  });

  it('clears at once on away and on a closed socket', async () => {
    await store.report('user', 'socket', true);
    await store.report('user', 'socket', false);
    expect(await store.atDesk('user')).toBe(false);
    await store.report('user', 'socket', true);
    await store.forget('user', 'socket');
    expect(await store.atDesk('user')).toBe(false);
    if (mode === 'redis') expect(redis.hashes.size).toBe(0);
  });

  it('stays at the desk while any socket of the user is active', async () => {
    await store.report('user', 'desktop', true);
    await store.report('user', 'web', true);
    await store.report('user', 'web', false);
    expect(await store.atDesk('user')).toBe(true);
    await store.report('user', 'desktop', false);
    expect(await store.atDesk('user')).toBe(false);
  });

  it('keeps users apart', async () => {
    await store.report('user', 'socket', true);
    expect(await store.atDesk('other')).toBe(false);
  });

  it('ignores a value that is not a time', async () => {
    if (mode !== 'redis') return;
    redis.hashes.set('talyn:desk:user', new Map([['socket', 'not a number']]));
    expect(await store.atDesk('user')).toBe(false);
  });
});

it('removes silent users from memory on a later write', async () => {
  vi.useFakeTimers();
  const store = new DeskPresenceStore(() => null);
  await store.report('gone', 'socket', true);
  await vi.advanceTimersByTimeAsync(DESK_PRESENCE_TTL_MS);
  await store.report('user', 'socket', true);
  expect((store as unknown as { memory: Map<string, unknown> }).memory.has('gone')).toBe(false);
  vi.useRealTimers();
});

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.emit('close'); });
  terminate = this.close;
  receive(message: unknown) { this.emit('message', Buffer.from(JSON.stringify(message))); }
}

describe('desk_presence over the WebSocket', () => {
  let server: EventEmitter;
  let sockets: Socket[];
  const flush = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('TALYN_ALLOWED_EMAILS', '');
    vi.spyOn(auth, 'verifyTokenAndGetUser').mockImplementation(async (token) => ({
      id: token, email: `${token}@test`, githubUsername: token, isAdmin: false, expiresAt: Date.now() + 600_000,
    }));
    const db = { select: vi.fn(), from: vi.fn(), where: vi.fn(), limit: vi.fn() };
    for (const method of ['select', 'from', 'where'] as const) db[method].mockReturnValue(db);
    db.limit.mockResolvedValue([{ email: 'member@test', isAdmin: false }]);
    vi.mocked(getDbClient).mockReturnValue(db as never);
    vi.mocked(getRedis).mockReturnValue(null);
    server = new EventEmitter();
    sockets = [];
    setupWebSocket(server as WebSocketServer);
  });
  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await flush();
    server.emit('close');
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function connect(user = 'member') {
    const socket = new Socket();
    sockets.push(socket);
    server.emit('connection', socket);
    socket.receive({ type: 'auth', token: user });
    await flush();
    return socket;
  }

  it('stores active for the authenticated user and ignores ids in the body', async () => {
    const socket = await connect('member');
    socket.receive({ type: 'desk_presence', state: 'active', userId: 'victim', ownerId: 'victim' });
    await flush();
    expect(await deskPresence.atDesk('member')).toBe(true);
    expect(await deskPresence.atDesk('victim')).toBe(false);
    socket.receive({ type: 'desk_presence', state: 'away' });
    await flush();
    expect(await deskPresence.atDesk('member')).toBe(false);
  });

  it('refuses desk presence before authentication', async () => {
    const socket = new Socket();
    sockets.push(socket);
    server.emit('connection', socket);
    socket.receive({ type: 'desk_presence', state: 'active' });
    await flush();
    expect(socket.close).toHaveBeenCalledWith(4401, 'expected one auth frame');
    expect(await deskPresence.atDesk('member')).toBe(false);
  });

  it.each([undefined, 'idle', 1, null])('closes the socket on an invalid state %j', async (state) => {
    const socket = await connect('member');
    socket.receive({ type: 'desk_presence', state });
    await flush();
    expect(socket.close).toHaveBeenCalledWith(1008, 'invalid presence');
    expect(await deskPresence.atDesk('member')).toBe(false);
  });

  it('forgets the socket when it closes', async () => {
    const socket = await connect('member');
    socket.receive({ type: 'desk_presence', state: 'active' });
    await flush();
    socket.close();
    await flush();
    expect(await deskPresence.atDesk('member')).toBe(false);
  });

  it('keeps another socket of the same user at the desk when one closes', async () => {
    const desktop = await connect('member');
    const web = await connect('member');
    desktop.receive({ type: 'desk_presence', state: 'active' });
    web.receive({ type: 'desk_presence', state: 'active' });
    await flush();
    web.close();
    await flush();
    expect(await deskPresence.atDesk('member')).toBe(true);
  });

  it('traces a change of state and not each beat', async () => {
    const record = vi.spyOn(debugBus, 'recordWs');
    const socket = await connect('member');
    record.mockClear();
    for (let i = 0; i < 3; i++) socket.receive({ type: 'desk_presence', state: 'active' });
    socket.receive({ type: 'desk_presence', state: 'away' });
    await flush();
    expect(record.mock.calls.map(([input]) => input.summary)).toEqual(['recv desk_presence active', 'recv desk_presence away']);
  });
});
