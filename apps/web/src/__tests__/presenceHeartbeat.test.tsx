import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../lib/api', () => ({ api: {}, wsClient: { on: vi.fn(() => () => {}) } }));

import { PRESENCE_HEARTBEAT_MS, usePresenceHeartbeat, type PresenceClient } from '../hooks/useSpaces';

function fakeClient() {
  return {
    subscribeSpace: vi.fn(),
    unsubscribeSpace: vi.fn(),
    sendPresence: vi.fn(),
  } satisfies PresenceClient;
}

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePresenceHeartbeat', () => {
  it('does nothing outside a space', () => {
    const client = fakeClient();
    renderHook(() => usePresenceHeartbeat(null, 'wb1', client));
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    expect(client.subscribeSpace).not.toHaveBeenCalled();
    expect(client.sendPresence).not.toHaveBeenCalled();
  });

  it('subscribes, says what is open, and repeats it every 20s', () => {
    const client = fakeClient();
    renderHook(() => usePresenceHeartbeat('s1', 'wb1', client));
    expect(client.subscribeSpace).toHaveBeenCalledWith('s1');
    expect(client.sendPresence).toHaveBeenCalledTimes(1);
    expect(client.sendPresence).toHaveBeenLastCalledWith('s1', 'wb1', 'active');

    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS - 1);
    expect(client.sendPresence).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(client.sendPresence).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2);
    expect(client.sendPresence).toHaveBeenCalledTimes(4);
  });

  it('sends at once on navigation and restarts the interval', () => {
    const client = fakeClient();
    const { rerender } = renderHook(({ id }) => usePresenceHeartbeat('s1', id, client), {
      initialProps: { id: null as string | null },
    });
    expect(client.sendPresence).toHaveBeenLastCalledWith('s1', null, 'active');
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS / 2);
    rerender({ id: 'wb2' });
    expect(client.sendPresence).toHaveBeenLastCalledWith('s1', 'wb2', 'active');
    expect(client.sendPresence).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS / 2);
    expect(client.sendPresence).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS / 2);
    expect(client.sendPresence).toHaveBeenCalledTimes(3);
    expect(client.subscribeSpace).toHaveBeenCalledTimes(1);
  });

  it('says away while the tab is hidden, and active again when it comes back', () => {
    const client = fakeClient();
    renderHook(() => usePresenceHeartbeat('s1', 'wb1', client));
    setVisibility('hidden');
    expect(client.sendPresence).toHaveBeenLastCalledWith('s1', null, 'away');
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS);
    expect(client.sendPresence).toHaveBeenLastCalledWith('s1', null, 'away');
    setVisibility('visible');
    expect(client.sendPresence).toHaveBeenLastCalledWith('s1', 'wb1', 'active');
  });

  it('unsubscribes and stops on leaving the space', () => {
    const client = fakeClient();
    const { unmount } = renderHook(() => usePresenceHeartbeat('s1', 'wb1', client));
    unmount();
    expect(client.unsubscribeSpace).toHaveBeenCalledWith('s1');
    const sent = client.sendPresence.mock.calls.length;
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    setVisibility('hidden');
    expect(client.sendPresence).toHaveBeenCalledTimes(sent);
  });

  it('moves the subscription when the space changes', () => {
    const client = fakeClient();
    const { rerender } = renderHook(({ space }) => usePresenceHeartbeat(space, null, client), {
      initialProps: { space: 's1' as string | null },
    });
    rerender({ space: 's2' });
    expect(client.unsubscribeSpace).toHaveBeenCalledWith('s1');
    expect(client.subscribeSpace).toHaveBeenLastCalledWith('s2');
    expect(client.sendPresence).toHaveBeenLastCalledWith('s2', null, 'active');
    rerender({ space: null });
    expect(client.unsubscribeSpace).toHaveBeenLastCalledWith('s2');
  });
});
