import { act, cleanup, renderHook } from '@testing-library/react';

jest.mock('../renderer/lib/api', () => ({
  api: { teams: { list: jest.fn() }, ws: { on: jest.fn(() => () => {}) } },
  wsClient: { on: jest.fn(() => () => {}) },
}));

import { PRESENCE_HEARTBEAT_MS, usePresenceHeartbeat, useSpacesBoot, type PresenceClient } from '../renderer/hooks/useSpaces';

import { api } from '../renderer/lib/api';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useSpacesStore } from '../renderer/stores/spaces';
import type { SpacesTeam } from '@talyn/shared';

function fakeClient() {
  return {
    subscribeSpace: jest.fn(),
    unsubscribeSpace: jest.fn(),
    sendPresence: jest.fn(),
  } satisfies PresenceClient;
}

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  jest.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('usePresenceHeartbeat', () => {
  it('does nothing outside a space', () => {
    const client = fakeClient();
    renderHook(() => usePresenceHeartbeat(null, 'wb1', client));
    jest.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
    expect(client.subscribeSpace).not.toHaveBeenCalled();
    expect(client.sendPresence).not.toHaveBeenCalled();
  });

  it('subscribes, says what is open, and repeats it every 20s', () => {
    const client = fakeClient();
    renderHook(() => usePresenceHeartbeat('s1', 'wb1', client));
    expect(client.subscribeSpace).toHaveBeenCalledWith('s1');
    expect(client.sendPresence).toHaveBeenCalledTimes(1);
    expect(client.sendPresence).toHaveBeenLastCalledWith('s1', 'wb1', 'active');

    jest.advanceTimersByTime(PRESENCE_HEARTBEAT_MS - 1);
    expect(client.sendPresence).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(client.sendPresence).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2);
    expect(client.sendPresence).toHaveBeenCalledTimes(4);
  });

  it('sends at once on navigation and restarts the interval', () => {
    const client = fakeClient();
    const { rerender } = renderHook(({ id }) => usePresenceHeartbeat('s1', id, client), {
      initialProps: { id: null as string | null },
    });
    expect(client.sendPresence).toHaveBeenLastCalledWith('s1', null, 'active');
    jest.advanceTimersByTime(PRESENCE_HEARTBEAT_MS / 2);
    rerender({ id: 'wb2' });
    expect(client.sendPresence).toHaveBeenLastCalledWith('s1', 'wb2', 'active');
    expect(client.sendPresence).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(PRESENCE_HEARTBEAT_MS / 2);
    expect(client.sendPresence).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(PRESENCE_HEARTBEAT_MS / 2);
    expect(client.sendPresence).toHaveBeenCalledTimes(3);
    expect(client.subscribeSpace).toHaveBeenCalledTimes(1);
  });

  it('says away while the tab is hidden, and active again when it comes back', () => {
    const client = fakeClient();
    renderHook(() => usePresenceHeartbeat('s1', 'wb1', client));
    setVisibility('hidden');
    expect(client.sendPresence).toHaveBeenLastCalledWith('s1', null, 'away');
    jest.advanceTimersByTime(PRESENCE_HEARTBEAT_MS);
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
    jest.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3);
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


describe('useSpacesBoot', () => {
  const teams = [{ id: 't1', spaces: [{ id: 's1' }] }] as SpacesTeam[];

  beforeEach(() => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      currentContext: { kind: 'space', spaceId: 's1' },
      features: { spaces: true } as never,
    });
    useSpacesStore.setState({ teams: null });
    jest.mocked(api.teams.list).mockResolvedValue(teams);
  });

  it.each([null, {}, { spaces: false }])('does not load teams for features=%j', (features) => {
    useWorkspaceStore.setState({ features: features as never });
    renderHook(() => useSpacesBoot());
    expect(api.teams.list).not.toHaveBeenCalled();
  });

  it.each([
    ['s1', 'space'],
    ['gone', 'personal'],
  ])('restores %s as %s after teams load', async (spaceId, kind) => {
    useWorkspaceStore.getState().setContext({ kind: 'space', spaceId });
    await act(async () => {
      renderHook(() => useSpacesBoot());
    });
    expect(api.teams.list).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().currentContext.kind).toBe(kind);
    expect(useWorkspaceStore.getState().currentWorkspaceId).toBe('ws1');
  });

  it('reloads teams after reconnecting', async () => {
    await act(async () => {
      renderHook(() => useSpacesBoot());
    });
    const onStatus = jest.mocked(api.ws.on).mock.calls.find(([event]) => event === 'connection:status')![1];
    await act(async () => {
      onStatus({ connected: false });
      onStatus({ connected: true });
    });
    expect(api.teams.list).toHaveBeenCalledTimes(2);
  });
});
