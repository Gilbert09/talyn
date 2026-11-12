import { waitFor } from '@testing-library/react-native';
import { defaultMobileNotificationPreferences, type MobileNotificationPayload } from '@talyn/shared';

import { NotificationController, notificationPath } from '../notifications/controller';

const workspace = '10000000-0000-4000-8000-000000000001';
const entity = '20000000-0000-4000-8000-000000000002';
const eventId = '30000000-0000-4000-8000-000000000003';
const payload: MobileNotificationPayload = { schemaVersion: 1, eventId, category: 'session_update',
  destination: { kind: 'session', workspaceId: workspace, entityId: entity } };
function fixture() {
  let storedInstallation: string | null = null;
  let online = true;
  const preferences = { ...defaultMobileNotificationPreferences(workspace), enabled: true };
  const api = {
    getPreferences: jest.fn(async () => ({ preferences, providerAvailable: true })),
    updatePreferences: jest.fn(async (value) => ({ preferences: value, providerAvailable: true })),
    registerInstallation: jest.fn(async (value) => ({ schemaVersion: 1 as const, installationId: value.installationId, enabled: true, providerAvailable: true })),
    removeInstallation: jest.fn(async () => {}),
    resolveNotification: jest.fn(async (id: string) => ({ ...payload, eventId: id, expiresAt: '2030-01-01T00:00:00.000Z' })),
  };
  const device = {
    available: jest.fn(() => true), permission: jest.fn(async () => true), channels: jest.fn(async () => {}),
    token: jest.fn(async () => 'ExpoPushToken[synthetic-device-value]'),
    installation: jest.fn(async (_user: string, create: boolean) => { if (create) storedInstallation ??= entity; return storedInstallation; }),
    clearInstallation: jest.fn(async () => { storedInstallation = null; }),
    metadata: () => ({ platform: 'ios' as const, environment: 'development' as const,
      appIdentity: 'dev.example.mobile', appVersion: '0.1.0', locale: 'en', timezone: 'UTC' }),
  };
  const fetchDestination = jest.fn(async () => {});
  const navigate = jest.fn();
  const controller = new NotificationController(api, device, () => online, fetchDestination, () => Date.parse('2026-11-08'));
  controller.setNavigation(navigate, '/sessions');
  controller.setScope({ user: 'alice', workspace });
  return { api, device, controller, navigate, fetchDestination, preferences, offline: () => { online = false; } };
}

describe('notification registration', () => {
  it.each([
    ['absent', undefined, true],
    ['false', false, false],
    ['true', true, true],
  ] as const)('reads onlyWhenAway %s from the backend as %s', async (_name, value, expected) => {
    const f = fixture();
    const { onlyWhenAway: _dropped, ...legacy } = f.preferences;
    f.api.getPreferences.mockResolvedValue({ preferences: (value === undefined ? legacy : { ...legacy, onlyWhenAway: value }) as typeof f.preferences, providerAvailable: true });
    await f.controller.refresh();
    expect(f.controller.getSnapshot().preferences?.onlyWhenAway).toBe(expected);
    f.controller.dispose();
  });
  it('does not request permission or register on first launch', async () => {
    const f = fixture(); await f.controller.refresh();
    expect(f.device.permission).not.toHaveBeenCalled(); expect(f.api.registerInstallation).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().state).toBe('disabled'); f.controller.dispose();
  });
  it('registers only after explicit opt-in and uses secure installation identity', async () => {
    const f = fixture(); await f.controller.refresh(); await f.controller.enableDevice();
    expect(f.device.permission).toHaveBeenCalledWith(true);
    expect(f.device.channels).toHaveBeenCalledTimes(1);
    expect(f.api.registerInstallation).toHaveBeenCalledWith(expect.objectContaining({ installationId: entity, workspaceId: workspace }));
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('synthetic-device-value');
    expect(f.controller.getSnapshot().state).toBe('ready'); f.controller.dispose();
  });
  it.each(['permission', 'device', 'provider', 'network'] as const)('keeps workflows usable when %s is unavailable', async (reason) => {
    const f = fixture(); await f.controller.refresh();
    if (reason === 'permission') f.device.permission.mockResolvedValue(false);
    if (reason === 'device') f.device.available.mockReturnValue(false);
    if (reason === 'provider') f.api.updatePreferences.mockImplementation(async (value) => ({ preferences: value, providerAvailable: false }));
    if (reason === 'network') f.api.registerInstallation.mockRejectedValue(new Error('private diagnostic'));
    await f.controller.enableDevice();
    expect(f.controller.getSnapshot().state).toBe(reason === 'permission' ? 'denied' : reason === 'network' ? 'failed' : 'unavailable');
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain('private diagnostic'); f.controller.dispose();
  });
  it('refreshes the real Expo token after rotation without another prompt', async () => {
    const f = fixture(); await f.controller.refresh(); await f.controller.enableDevice();
    f.device.token.mockResolvedValue('ExpoPushToken[synthetic-rotated-value]');
    f.controller.tokenChanged(); await f.controller.refresh();
    expect(f.api.registerInstallation).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'ExpoPushToken[synthetic-rotated-value]' }));
    expect(f.device.permission).toHaveBeenLastCalledWith(false); f.controller.dispose();
  });
  it.each([false, true])('clears device credentials after logout when offline=%s', async (offline) => {
    const f = fixture(); await f.controller.refresh(); await f.controller.enableDevice();
    if (offline) f.offline(); else f.api.removeInstallation.mockRejectedValueOnce(new Error('unreachable'));
    await f.controller.logout();
    expect(f.api.removeInstallation).toHaveBeenCalledTimes(offline ? 0 : 1);
    expect(f.device.clearInstallation).toHaveBeenCalledWith('alice');
    expect(f.controller.getSnapshot().preferences).toBeNull(); f.controller.dispose();
  });
  it('does not apply registration results after a workspace boundary', async () => {
    const f = fixture(); await f.controller.refresh();
    let finish!: (value: boolean) => void;
    f.device.permission.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = f.controller.enableDevice();
    await waitFor(() => expect(finish).toBeDefined());
    f.controller.setScope(null); finish(true); await pending;
    expect(f.api.registerInstallation).not.toHaveBeenCalled(); f.controller.dispose();
  });
  it('rejects malformed native tokens before a server registration', async () => {
    const f = fixture(); await f.controller.refresh(); f.device.token.mockResolvedValue('invalid');
    await f.controller.enableDevice(); expect(f.controller.getSnapshot().state).toBe('failed');
    expect(f.api.registerInstallation).not.toHaveBeenCalled(); f.controller.dispose();
  });
  it('clears notification identity and pending work after account deletion', async () => {
    const f = fixture(); await f.controller.refresh(); await f.controller.enableDevice();
    await f.controller.clearLocal('alice');
    expect(f.device.clearInstallation).toHaveBeenCalledWith('alice');
    expect(f.controller.getSnapshot().preferences).toBeNull(); f.controller.dispose();
  });
});

describe('notification taps', () => {
  it.each(['cold', 'warm'] as const)('resolves %s taps and fetches authoritative state before navigation', async (start) => {
    const f = fixture();
    if (start === 'cold') f.controller.setScope(null);
    f.controller.receiveTap(payload);
    if (start === 'cold') { expect(f.api.resolveNotification).not.toHaveBeenCalled(); f.controller.setScope({ user: 'alice', workspace }); }
    await waitFor(() => expect(f.navigate).toHaveBeenCalledWith(`/sessions/${entity}`));
    expect(f.api.resolveNotification.mock.invocationCallOrder[0]).toBeLessThan(f.fetchDestination.mock.invocationCallOrder[0]);
    expect(f.fetchDestination.mock.invocationCallOrder[0]).toBeLessThan(f.navigate.mock.invocationCallOrder[0]); f.controller.dispose();
  });
  it('deduplicates concurrent and repeated taps by event ID', async () => {
    const f = fixture(); f.controller.receiveTap(payload); f.controller.receiveTap(payload);
    await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1)); f.controller.receiveTap(payload);
    expect(f.navigate).toHaveBeenCalledTimes(1); f.controller.dispose();
  });
  it.each(['expired', 'deleted', 'wrong_account', 'invalid'] as const)('rejects a %s notification without navigation', async (reason) => {
    const f = fixture();
    if (reason === 'expired') f.api.resolveNotification.mockResolvedValue({ ...payload, expiresAt: '2020-01-01T00:00:00.000Z' });
    if (reason === 'deleted') f.fetchDestination.mockRejectedValue({ status: 404 });
    if (reason === 'wrong_account') f.api.resolveNotification.mockRejectedValue({ status: 404 });
    f.controller.receiveTap(reason === 'invalid' ? { ...payload, privateText: 'discard' } : payload);
    await waitFor(() => expect(f.controller.getSnapshot().tapIssue).not.toBeNull());
    expect(f.navigate).not.toHaveBeenCalled(); f.controller.dispose();
  });
  it('waits for authorization in the selected workspace', async () => {
    const f = fixture(); f.controller.setScope({ user: 'alice', workspace: entity }); f.controller.receiveTap(payload);
    expect(f.api.resolveNotification).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().tapIssue).toContain('Choose');
    f.controller.setScope({ user: 'alice', workspace });
    await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1)); f.controller.dispose();
  });
  it('blocks a late authorized result after the account changes', async () => {
    const f = fixture(); let finish!: () => void;
    f.fetchDestination.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    f.controller.receiveTap(payload); await waitFor(() => expect(finish).toBeDefined());
    f.controller.setScope({ user: 'bob', workspace }); finish();
    await Promise.resolve(); expect(f.navigate).not.toHaveBeenCalled(); f.controller.dispose();
  });
  it('keeps a second tap while the first current-state fetch is pending', async () => {
    const f = fixture(); let finish!: () => void;
    f.api.resolveNotification.mockImplementation(async (id: string) => ({ ...payload, eventId: id, expiresAt: '2030-01-01T00:00:00.000Z' }));
    f.fetchDestination.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.controller.receiveTap(payload); await waitFor(() => expect(finish).toBeDefined());
    f.controller.receiveTap({ ...payload, eventId: '40000000-0000-4000-8000-000000000004' });
    finish(); await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(2)); f.controller.dispose();
  });
  it('retains a cold tap through temporary workspace validation', async () => {
    const f = fixture(); f.controller.setScope(null); f.controller.receiveTap(payload);
    f.controller.setScope({ user: 'alice', workspace: entity }); f.controller.setScope(null);
    f.controller.setScope({ user: 'alice', workspace });
    await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1)); f.controller.dispose();
  });
  it('suppresses foreground banners when the target is visible', () => {
    const f = fixture(); expect(f.controller.shouldAlert(payload)).toBe(true);
    f.controller.setNavigation(f.navigate, notificationPath(payload.destination));
    expect(f.controller.shouldAlert(payload)).toBe(false); expect(f.controller.shouldAlert({})).toBe(false); f.controller.dispose();
  });
});
