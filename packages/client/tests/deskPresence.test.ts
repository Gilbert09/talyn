import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeskPresenceState } from '@talyn/shared';
import { startDeskPresenceHeartbeat, type DeskActivitySource } from '../src/deskPresence';

function source(initial: DeskPresenceState | 'throw' = 'active') {
  let state = initial;
  const listeners = new Set<() => void>();
  const value: DeskActivitySource & { set(next: DeskPresenceState | 'throw'): void; listeners: Set<() => void> } = {
    listeners,
    read: () => {
      if (state === 'throw') throw new Error('unavailable');
      return state;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = next;
      for (const listener of listeners) listener();
    },
  };
  return value;
}

describe('desk presence heartbeat', () => {
  let sent: DeskPresenceState[];
  const send = (state: DeskPresenceState) => { sent.push(state); };
  beforeEach(() => { vi.useFakeTimers(); sent = []; });
  afterEach(() => { vi.useRealTimers(); });

  it('sends active at once and every 30 seconds while active', async () => {
    const stop = startDeskPresenceHeartbeat(source(), send);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['active']);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(sent).toEqual(['active']);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['active', 'active']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual(['active', 'active', 'active', 'active']);
    stop();
  });

  it.each(['tick', 'event'] as const)('sends one away and then nothing when it goes away on a %s', async (how) => {
    const activity = source();
    const stop = startDeskPresenceHeartbeat(activity, send);
    await vi.advanceTimersByTimeAsync(0);
    if (how === 'event') activity.set('away');
    else {
      activity.set('away');
      activity.listeners.clear();
    }
    await vi.advanceTimersByTimeAsync(how === 'tick' ? 30_000 : 0);
    expect(sent).toEqual(['active', 'away']);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sent).toEqual(['active', 'away']);
    stop();
    expect(sent).toEqual(['active', 'away']);
  });

  it('sends active at once when the person comes back, without waiting for a beat', async () => {
    const activity = source('away');
    const stop = startDeskPresenceHeartbeat(activity, send);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['away']);
    activity.set('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['away', 'active']);
    stop();
  });

  it('ignores change events that do not change the state', async () => {
    const activity = source();
    const stop = startDeskPresenceHeartbeat(activity, send);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 50; i++) activity.set('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual(['active']);
    stop();
  });

  it('reads a failing source as away', async () => {
    const activity = source('throw');
    const stop = startDeskPresenceHeartbeat(activity, send);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toEqual(['away']);
    stop();
  });

  it('accepts an asynchronous source and ignores a reading that lands after stop', async () => {
    let resolve!: (state: DeskPresenceState) => void;
    const stop = startDeskPresenceHeartbeat({
      read: () => new Promise<DeskPresenceState>((done) => { resolve = done; }),
      subscribe: () => () => undefined,
    }, send);
    stop();
    resolve('active');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toEqual([]);
  });

  it('sends away on stop after active, unsubscribes and stops the timer', async () => {
    const activity = source();
    const stop = startDeskPresenceHeartbeat(activity, send);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    stop();
    expect(sent).toEqual(['active', 'away']);
    expect(activity.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
