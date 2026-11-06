import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PresenceStore, startPresenceSweep } from '../services/teams/presence.js';
import { debugBus } from '../services/debugBus.js';
import { createPresenceRedis } from './helpers/presenceRedis.js';

const member = { userId: 'user', sessionId: 'session', state: 'active' as const, githubLogin: 'tom', avatarUrl: 'avatar' };

describe.each(['memory', 'redis'] as const)('presence store with %s', (mode) => {
  let store: PresenceStore;
  let redis: ReturnType<typeof createPresenceRedis>;
  let onChange: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    redis = createPresenceRedis();
    onChange = vi.fn();
    store = new PresenceStore(() => mode === 'redis' ? redis as never : null, onChange);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('stores a heartbeat and renews its expiry without a change broadcast', async () => {
    await store.heartbeat('space', 'socket', member);
    expect(await store.snapshot('space')).toEqual([{ ...member, at: Date.now() }]);
    expect(onChange).toHaveBeenCalledWith('space');
    await vi.advanceTimersByTimeAsync(59_999);
    await store.heartbeat('space', 'socket', member);
    await vi.advanceTimersByTimeAsync(1);
    await store.sweep();
    expect(await store.snapshot('space')).toHaveLength(1);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it('expires at 60 seconds and broadcasts the removal', async () => {
    await store.heartbeat('space', 'socket', member);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await store.snapshot('space')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await store.snapshot('space')).toEqual([]);
    await store.sweep();
    expect(onChange).toHaveBeenCalledTimes(2);
    await store.sweep();
    expect(onChange).toHaveBeenCalledTimes(2);
    if (mode === 'redis') expect(redis.hashes.size).toBe(0);
  });

  it.each([{ state: 'away' as const }, { sessionId: 'another' }, { sessionId: null }])(
    'broadcasts a change: %j', async (update) => {
      await store.heartbeat('space', 'socket', member);
      await store.heartbeat('space', 'socket', { ...member, ...update });
      expect((await store.snapshot('space'))[0]).toMatchObject(update);
      expect(onChange).toHaveBeenCalledTimes(2);
    }
  );

  it('removes presence only when the last socket disconnects', async () => {
    await store.heartbeat('space', 'a', member);
    await store.heartbeat('space', 'b', member);
    await store.disconnect('space', member.userId, 'a');
    expect(await store.snapshot('space')).toHaveLength(1);
    expect(onChange).toHaveBeenCalledOnce();
    await store.disconnect('space', member.userId, 'b');
    expect(await store.snapshot('space')).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps presence when a second socket has not sent a heartbeat', async () => {
    await store.connect('space', member.userId, 'observer');
    expect(await store.snapshot('space')).toEqual([]);
    await store.heartbeat('space', 'active', member);
    await store.disconnect('space', member.userId, 'active');
    expect(await store.snapshot('space')).toHaveLength(1);
    await store.disconnect('space', member.userId, 'observer');
    expect(await store.snapshot('space')).toEqual([]);
  });

  it('expires presence even when the connection lease is renewed', async () => {
    await store.heartbeat('space', 'socket', member);
    await vi.advanceTimersByTimeAsync(30_000);
    await store.connect('space', member.userId, 'socket');
    await vi.advanceTimersByTimeAsync(30_000);
    await store.sweep();
    expect(await store.snapshot('space')).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('keeps users and spaces separate', async () => {
    await store.heartbeat('space', 'socket', member);
    await store.heartbeat('other', 'socket', member);
    await store.heartbeat('space', 'b', { ...member, userId: 'other-user' });
    await store.disconnect('space', member.userId, 'socket');
    expect((await store.snapshot('space')).map((m) => m.userId)).toEqual(['other-user']);
    expect(await store.snapshot('other')).toHaveLength(1);
  });

  it('registers the sweep and records failed ticks', async () => {
    const register = vi.spyOn(debugBus, 'registerPoller');
    const tick = vi.spyOn(debugBus, 'pollerTick');
    const error = new Error('store unavailable');
    vi.spyOn(store, 'sweep').mockRejectedValueOnce(error);
    const stop = startPresenceSweep(store);
    expect(register).toHaveBeenCalledWith('space-presence', 10_000, expect.any(String));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledWith('space-presence', expect.objectContaining({ ok: false, error }));
    stop();
  });
});

it('shares socket leases across replicas and retries concurrent updates', async () => {
  const redis = createPresenceRedis();
  const a = new PresenceStore(() => redis as never);
  const b = new PresenceStore(() => redis as never);
  await Promise.all([a.heartbeat('space', 'a', member), b.heartbeat('space', 'b', member)]);
  expect(redis.eval.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(await a.snapshot('space')).toEqual(await b.snapshot('space'));
  await a.disconnect('space', member.userId, 'a');
  expect(await b.snapshot('space')).toHaveLength(1);
  await b.disconnect('space', member.userId, 'b');
  expect(await a.snapshot('space')).toEqual([]);
});
