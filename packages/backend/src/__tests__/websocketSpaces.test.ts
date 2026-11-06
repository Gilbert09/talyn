import { EventEmitter } from 'node:events';
import { WebSocket, type WebSocketServer } from 'ws';
import type { WSEvent } from '@talyn/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDbClient, getPoolDbClient } from '../db/client.js';
import * as auth from '../middleware/auth.js';
import { isFeatureEnabled } from '../services/featureFlags.js';
import { assertSpaceMember, canViewItem } from '../services/teams/access.js';
import { resetSpaceEventCache } from '../services/teams/spaceEvents.js';
import { PresenceStore } from '../services/teams/presence.js';
import { getRedis } from '../services/redis.js';
import { dispatchIncoming } from '../services/wsBus.js';
import { setupWebSocket, broadcastToWorkspace } from '../services/websocket.js';
import { createPresenceRedis } from './helpers/presenceRedis.js';

vi.mock('../db/client.js', () => ({ getDbClient: vi.fn(), getPoolDbClient: vi.fn() }));
vi.mock('../services/teams/access.js', () => ({ assertSpaceMember: vi.fn(), canViewItem: vi.fn() }));
vi.mock('../services/featureFlags.js', () => ({ isFeatureEnabled: vi.fn() }));
vi.mock('../services/redis.js', () => ({ getRedis: vi.fn(), isRedisEnabled: () => false }));

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = WebSocket.CLOSED; this.emit('close'); });
  terminate = this.close;
  receive(message: unknown) { this.emit('message', Buffer.from(JSON.stringify(message))); }
  events(type: string) { return this.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter((event) => event.type === type); }
}

function query(rows: unknown[]) {
  const db = { select: vi.fn(), from: vi.fn(), where: vi.fn(), innerJoin: vi.fn(), leftJoin: vi.fn(), limit: vi.fn() };
  for (const method of ['select', 'from', 'where', 'innerJoin', 'leftJoin'] as const) db[method].mockReturnValue(db);
  db.limit.mockResolvedValue(rows);
  return db;
}

const item = { workspaceId: 'workspace', spaceId: 'space', repoFullName: 'owner/repo' };
const event: WSEvent = {
  type: 'workbench:updated',
  payload: { workbench: { id: 'session', ...item, name: 'Renamed', sandboxId: 'secret', deviceId: 'device', localPath: '/secret', keptWorktree: { path: '/secret' } } },
  timestamp: '2026-11-06T00:00:00Z',
};
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('space WebSocket delivery', () => {
  let server: EventEmitter;
  let sockets: Socket[];
  let db: ReturnType<typeof query>;
  let pool: ReturnType<typeof query>;
  let redis: ReturnType<typeof createPresenceRedis>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetSpaceEventCache();
    vi.stubEnv('TALYN_ALLOWED_EMAILS', '');
    vi.spyOn(auth, 'verifyTokenAndGetUser').mockImplementation(async (token) => ({
      id: token, email: `${token}@test`, githubUsername: token, isAdmin: false, expiresAt: Date.now() + 600_000,
    }));
    vi.mocked(isFeatureEnabled).mockResolvedValue(true);
    vi.mocked(assertSpaceMember).mockResolvedValue({ id: 'space' } as never);
    vi.mocked(canViewItem).mockResolvedValue(true);
    db = query([{ email: 'member@test', isAdmin: false, ownerId: 'owner' }]);
    pool = query([item]);
    vi.mocked(getDbClient).mockReturnValue(db as never);
    vi.mocked(getPoolDbClient).mockReturnValue(pool as never);
    redis = createPresenceRedis();
    vi.mocked(getRedis).mockReturnValue(redis as never);
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
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  async function connect(user = 'member', subscribe = true) {
    const socket = new Socket();
    sockets.push(socket);
    server.emit('connection', socket);
    socket.receive({ type: 'auth', token: user });
    await flush();
    if (subscribe) {
      socket.receive({ type: 'subscribe_space', spaceId: 'space' });
      await flush();
    }
    return socket;
  }

  it('accepts a member and sends the full snapshot', async () => {
    const socket = await connect();
    expect(isFeatureEnabled).toHaveBeenCalledWith('spaces', { distinctId: 'member', email: 'member@test' });
    expect(assertSpaceMember).toHaveBeenCalledWith('member', 'space');
    expect(socket.events('space:presence')[0].payload).toEqual({ spaceId: 'space', members: [] });
  });

  it.each(['flag off', 'not a member'])('refuses a subscription when %s', async (reason) => {
    if (reason === 'flag off') vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    else vi.mocked(assertSpaceMember).mockRejectedValue(new Error('not a member'));
    const socket = await connect();
    socket.receive({ type: 'presence', spaceId: 'space', sessionId: null, state: 'active' });
    broadcastToWorkspace('workspace', event);
    await flush();
    expect(socket.events('space:presence')).toEqual([]);
    expect(socket.events(event.type)).toEqual([]);
    expect(redis.hashes.size).toBe(0);
  });

  it.each(['membership', 'flag'])('drops a subscription after %s is removed', async (reason) => {
    const socket = await connect();
    socket.receive({ type: 'presence', spaceId: 'space', sessionId: null, state: 'active' });
    await flush();
    if (reason === 'membership') vi.mocked(assertSpaceMember).mockRejectedValue(new Error('removed'));
    else vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(15_000);
    broadcastToWorkspace('workspace', event);
    await flush();
    expect(socket.events(event.type)).toEqual([]);
    expect(redis.hashes.size).toBe(0);
  });

  it.each(['local', 'remote'])('strips runtime fields on the %s workspace path', async (path) => {
    const socket = await connect();
    if (path === 'local') broadcastToWorkspace('workspace', event);
    else dispatchIncoming(JSON.stringify({ replicaId: 'other', scope: 'workspace', workspaceId: 'workspace', event }));
    await flush();
    expect(socket.events(event.type)).toHaveLength(1);
    expect(socket.events(event.type)[0].payload.workbench).toMatchObject({ name: 'Renamed', sandboxId: null, deviceId: null, localPath: null, keptWorktree: null });
    expect((event.payload as { workbench: { sandboxId: string } }).workbench.sandboxId).toBe('secret');
  });

  it.each(['personal', 'repo denied', 'script', 'unrelated', 'wrong workspace'])('does not relay %s events', async (reason) => {
    const socket = await connect();
    if (reason === 'personal') pool.limit.mockResolvedValue([{ ...item, spaceId: null }]);
    if (reason === 'repo denied') vi.mocked(canViewItem).mockResolvedValue(false);
    const type = reason === 'script' ? 'workbench:script' : reason === 'unrelated' ? 'pull_request:updated' : event.type;
    broadcastToWorkspace(reason === 'wrong workspace' ? 'wrong' : 'workspace', { ...event, type });
    await flush();
    expect(socket.events(type)).toEqual([]);
  });

  it('delivers an owner workspace event once and preserves the owner payload', async () => {
    const socket = await connect('owner');
    socket.receive({ type: 'subscribe', workspaceId: 'workspace' });
    await flush();
    broadcastToWorkspace('workspace', event);
    await flush();
    expect(socket.events(event.type)).toEqual([event]);
  });

  it('caches lookup and visibility checks for 60 seconds', async () => {
    const socket = await connect();
    for (let i = 0; i < 10; i++) broadcastToWorkspace('workspace', event);
    await flush();
    expect(socket.events(event.type)).toHaveLength(10);
    expect(pool.limit).toHaveBeenCalledOnce();
    expect(canViewItem).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    broadcastToWorkspace('workspace', event);
    await flush();
    expect(pool.limit).toHaveBeenCalledTimes(2);
    expect(canViewItem).toHaveBeenCalledTimes(2);
  });

  it.each(['repo denied', 'other space'])('hides a presence session when %s', async (reason) => {
    const socket = await connect();
    if (reason === 'repo denied') vi.mocked(canViewItem).mockResolvedValue(false);
    else pool.limit.mockResolvedValue([{ ...item, spaceId: 'other' }]);
    socket.receive({ type: 'presence', spaceId: 'space', sessionId: 'session', state: 'away' });
    await flush();
    expect(socket.events('space:presence').at(-1).payload.members).toEqual([
      expect.objectContaining({ userId: 'member', sessionId: null, state: 'away', githubLogin: 'member' }),
    ]);
  });

  it('sends a visible session and removes presence on disconnect', async () => {
    const socket = await connect();
    const observer = await connect('observer');
    socket.receive({ type: 'presence', spaceId: 'space', sessionId: 'session', state: 'active' });
    await flush();
    expect(observer.events('space:presence').at(-1).payload.members[0].sessionId).toBe('session');
    socket.close();
    await flush();
    expect(observer.events('space:presence').at(-1).payload.members).toEqual([]);
  });

  it('retains presence until the last subscribed socket disconnects', async () => {
    const active = await connect();
    const second = await connect();
    const observer = await connect('observer');
    active.receive({ type: 'presence', spaceId: 'space', sessionId: null, state: 'active' });
    await flush();
    active.close();
    await flush();
    expect(observer.events('space:presence').at(-1).payload.members).toHaveLength(1);
    second.close();
    await flush();
    expect(observer.events('space:presence').at(-1).payload.members).toEqual([]);
  });

  it('reads the same presence on another replica through wsBus', async () => {
    const socket = await connect();
    const remote = new PresenceStore(() => redis as never, (spaceId) => {
      dispatchIncoming(JSON.stringify({ replicaId: 'other', scope: 'space', spaceId,
        event: { type: 'space:presence', payload: { spaceId, members: [] }, timestamp: new Date().toISOString() } }));
    });
    await remote.heartbeat('space', 'remote-socket', {
      userId: 'remote-user', sessionId: null, state: 'active', githubLogin: 'remote', avatarUrl: null,
    });
    await flush();
    expect(socket.events('space:presence').at(-1).payload.members).toEqual(await remote.snapshot('space'));
    await remote.disconnect('space', 'remote-user', 'remote-socket');
    await flush();
    expect(socket.events('space:presence').at(-1).payload.members).toEqual([]);
  });

  it.each([
    { type: 'workbench:chat', payload: { chat: { workbenchId: 'session', status: 'running' } } },
    { type: 'workbench:event', payload: { chatId: 'chat', events: [{ turn: 1, event: { type: 'text', text: 'hello' } }] } },
    { type: 'task:event', payload: { taskId: 'task', event: { type: 'text', text: 'hello' } } },
  ] as const)('relays $type to members', async (message) => {
    const socket = await connect();
    if (message.type === 'workbench:event') pool.limit.mockResolvedValueOnce([{ workbenchId: 'session' }]);
    const outgoing = { ...message, timestamp: event.timestamp } as WSEvent;
    broadcastToWorkspace('workspace', outgoing);
    await flush();
    expect(socket.events(message.type)).toEqual([outgoing]);
    expect(canViewItem).toHaveBeenCalledWith('member', item);
  });

  it.each([
    { type: 'task:status', payload: { taskId: 'task', status: 'completed', result: { secret: 'private' } },
      expected: { taskId: 'task', status: 'completed' } },
    { type: 'task:update', payload: { taskId: 'task', updates: { title: 'Renamed', metadata: { secret: 'private' }, transcript: [] } },
      expected: { taskId: 'task', updates: { title: 'Renamed' } } },
  ] as const)('limits the $type payload', async ({ type, payload, expected }) => {
    const socket = await connect();
    broadcastToWorkspace('workspace', { type, payload, timestamp: event.timestamp });
    await flush();
    expect(socket.events(type)[0].payload).toEqual(expected);
  });

  it('stops cached chat events after a session moves to Personal', async () => {
    const socket = await connect();
    pool.limit.mockResolvedValueOnce([{ workbenchId: 'session' }]);
    const chatEvent: WSEvent = { type: 'workbench:event', payload: { chatId: 'chat', events: [] }, timestamp: event.timestamp };
    broadcastToWorkspace('workspace', chatEvent);
    await flush();
    expect(socket.events(chatEvent.type)).toHaveLength(1);
    pool.limit.mockResolvedValue([{ ...item, spaceId: null }]);
    broadcastToWorkspace('workspace', { ...event, payload: { workbench: { id: 'session', ...item, spaceId: null } } });
    broadcastToWorkspace('workspace', chatEvent);
    await flush();
    expect(socket.events(chatEvent.type)).toHaveLength(1);
    expect(socket.events(event.type)).toEqual([]);
  });

  it('does not share a cached visibility result between users', async () => {
    const allowed = await connect('allowed');
    const denied = await connect('denied');
    vi.mocked(canViewItem).mockImplementation(async (userId) => userId === 'allowed');
    broadcastToWorkspace('workspace', event);
    await flush();
    expect(allowed.events(event.type)).toHaveLength(1);
    expect(denied.events(event.type)).toEqual([]);
  });

  it('stops delivery while a membership refresh is stalled', async () => {
    const socket = await connect();
    let finish!: (value: never) => void;
    vi.mocked(assertSpaceMember).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await vi.advanceTimersByTimeAsync(30_000);
    broadcastToWorkspace('workspace', event);
    await flush();
    expect(socket.events(event.type)).toEqual([]);
    expect(socket.close).toHaveBeenCalled();
    finish({ id: 'space' } as never);
    await flush();
    expect(socket.events(event.type)).toEqual([]);
  });

  it('does not deliver an event after its visibility check outlives the subscription', async () => {
    const socket = await connect();
    let finish!: (value: boolean) => void;
    vi.mocked(canViewItem).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    broadcastToWorkspace('workspace', event);
    await flush();
    socket.receive({ type: 'unsubscribe_space', spaceId: 'space' });
    await flush();
    finish(true);
    await flush();
    expect(socket.events(event.type)).toEqual([]);
  });

  it('unsubscribes and rejects later presence', async () => {
    const socket = await connect();
    socket.receive({ type: 'unsubscribe_space', spaceId: 'space' });
    socket.receive({ type: 'presence', spaceId: 'space', sessionId: null, state: 'active' });
    await flush();
    broadcastToWorkspace('workspace', event);
    await flush();
    expect(socket.events(event.type)).toEqual([]);
    expect(redis.hashes.size).toBe(0);
  });

  it.each([
    { type: 'subscribe_space', spaceId: {} },
    { type: 'presence', spaceId: 'space', sessionId: 42, state: 'active' },
    { type: 'presence', spaceId: 'space', sessionId: null, state: 'invalid' },
  ])('refuses malformed messages: %j', async (message) => {
    const socket = await connect();
    socket.receive(message);
    await flush();
    expect(socket.close).toHaveBeenCalled();
  });
});
