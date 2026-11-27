import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Features, SpaceNotificationPreferences } from '@talyn/shared';
import { api } from '../lib/api';
import { isSpaceMuted, loadSpaceNotifications, setSpaceMuted, useSpacesStore } from '../stores/spaces';
import { useWorkspaceStore } from '../stores/workspace';

vi.mock('../lib/api', () => ({ api: { spaces: {
  notificationPreferences: vi.fn(),
  setNotificationsMuted: vi.fn(),
} } }));

function deferred() {
  let resolve!: (value: SpaceNotificationPreferences) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<SpaceNotificationPreferences>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const get = vi.mocked(api.spaces.notificationPreferences);
const save = vi.mocked(api.spaces.setNotificationsMuted);

beforeEach(() => {
  useWorkspaceStore.setState({ features: null });
  get.mockReset();
  save.mockReset();
  useSpacesStore.getState().setSelfUserId(null);
  useSpacesStore.getState().setSelfUserId('user-a');
});

describe('personal space preferences store', () => {
  it('ignores a read that started before a save', async () => {
    const oldRead = deferred();
    get.mockReturnValueOnce(oldRead.promise);
    save.mockResolvedValueOnce({ mutedSpaceIds: ['automations'] });
    const reading = loadSpaceNotifications();
    await setSpaceMuted('automations', true);
    oldRead.resolve({ mutedSpaceIds: [] });
    await reading;
    expect(useSpacesStore.getState().mutedSpaceIds).toEqual(['automations']);
  });

  it('keeps the newest read when responses arrive in reverse order', async () => {
    const first = deferred();
    const second = deferred();
    get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const reads = [loadSpaceNotifications(), loadSpaceNotifications()];
    second.resolve({ mutedSpaceIds: ['automations'] });
    await reads[1];
    first.resolve({ mutedSpaceIds: [] });
    await reads[0];
    expect(useSpacesStore.getState().mutedSpaceIds).toEqual(['automations']);
  });

  it('restores all earlier mutes when a save fails', async () => {
    useSpacesStore.setState({ mutedSpaceIds: ['work'], notificationsLoaded: true });
    const pending = deferred();
    save.mockReturnValueOnce(pending.promise);
    const saving = setSpaceMuted('automations', true);
    expect(useSpacesStore.getState().mutedSpaceIds).toEqual(['work', 'automations']);
    const rejection = expect(saving).rejects.toThrow('offline');
    pending.reject(new Error('offline'));
    await rejection;
    expect(useSpacesStore.getState().mutedSpaceIds).toEqual(['work']);
    expect(useSpacesStore.getState().notificationsSaving).toBe(false);
  });

  it('refreshes after saving when another device changes preferences during the save', async () => {
    const pending = deferred();
    save.mockReturnValueOnce(pending.promise);
    get.mockResolvedValueOnce({ mutedSpaceIds: ['automations', 'work'] });
    const saving = setSpaceMuted('automations', true);
    await loadSpaceNotifications();
    expect(get).not.toHaveBeenCalled();
    pending.resolve({ mutedSpaceIds: ['automations'] });
    await saving;
    expect(get).toHaveBeenCalledTimes(1);
    expect(useSpacesStore.getState().mutedSpaceIds).toEqual(['automations', 'work']);
  });

  it.each(['read', 'save'] as const)('clears preferences and ignores an old account %s', async (operation) => {
    useSpacesStore.setState({ mutedSpaceIds: ['work'], notificationsLoaded: true });
    const pending = deferred();
    get.mockReturnValueOnce(pending.promise);
    save.mockReturnValueOnce(pending.promise);
    const request = operation === 'read' ? loadSpaceNotifications() : setSpaceMuted('automations', true);
    useSpacesStore.getState().setSelfUserId('user-b');
    expect(useSpacesStore.getState()).toMatchObject({
      mutedSpaceIds: [], notificationsLoaded: false, notificationsSaving: false, notificationsError: null,
    });
    pending.resolve({ mutedSpaceIds: ['automations', 'work'] });
    await request;
    expect(useSpacesStore.getState()).toMatchObject({
      selfUserId: 'user-b', mutedSpaceIds: [], notificationsLoaded: false, notificationsSaving: false,
    });
  });

  it('keeps the previous choices if a refresh fails', async () => {
    useSpacesStore.setState({ mutedSpaceIds: ['automations'], notificationsLoaded: true });
    get.mockRejectedValueOnce(new Error('offline'));
    await loadSpaceNotifications();
    expect(useSpacesStore.getState().mutedSpaceIds).toEqual(['automations']);
    expect(useSpacesStore.getState().notificationsError).toBeTruthy();
  });
});


describe('space mute feature gate', () => {
  it.each([
    ['enabled', { spaces: true }, true],
    ['disabled', { spaces: false }, false],
    ['unknown', null, false],
    ['missing', {}, false],
  ] as const)('applies a cached mute when Spaces is %s', (_label, features, expected) => {
    useSpacesStore.setState({ mutedSpaceIds: ['automations'] });
    useWorkspaceStore.setState({ features: features as Features | null });
    expect(isSpaceMuted('automations')).toBe(expected);
    expect(isSpaceMuted('other')).toBe(false);
    expect(isSpaceMuted(null)).toBe(false);
    expect(isSpaceMuted(undefined)).toBe(false);
  });

  it('keeps the saved choice when Spaces is disabled and enabled again', () => {
    useSpacesStore.setState({ mutedSpaceIds: ['automations'] });
    for (const spaces of [true, false, true]) {
      useWorkspaceStore.setState({ features: { spaces } as Features });
      expect(isSpaceMuted('automations')).toBe(spaces);
      expect(useSpacesStore.getState().mutedSpaceIds).toEqual(['automations']);
    }
  });
});
