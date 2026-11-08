import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultMobileNotificationPreferences, isMobileNotificationPayload, isMobileNotificationResolution } from '@talyn/shared';
import { configureApiClient, mobileNotifications } from '../src/native';
import { response } from './helpers';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(response(200, { installationId: 'opaque' }));
  configureApiClient({ baseUrl: 'https://example.test', clientVersion: 'native/test',
    getAccessToken: async () => 'auth', recoverSession: async () => false,
    runtime: { fetch: fetchMock } });
});

describe('native notification transport', () => {
  it.each([
    ['heartbeatInstallation', 'PATCH', '/mobile/installations/device%2Fid'],
    ['removeInstallation', 'DELETE', '/mobile/installations/device%2Fid'],
    ['getPreferences', 'GET', '/mobile/notification-preferences?workspaceId=device%2Fid'],
    ['resolveNotification', 'GET', '/mobile/notifications/device%2Fid'],
  ] as const)('uses the authenticated transport for %s', async (method, verb, path) => {
    if (method === 'heartbeatInstallation') {
      await mobileNotifications[method]('device/id', { schemaVersion: 1, workspaceId: 'workspace',
        appVersion: '1', locale: 'en', timezone: 'UTC' });
    } else await mobileNotifications[method]('device/id');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(`https://example.test/api/v1${path}`,
      expect.objectContaining({ method: verb, headers: expect.objectContaining({ Authorization: 'Bearer auth' }) }));
  });

  it('sends explicit registration fields and returns the server response', async () => {
    const input = { schemaVersion: 1 as const, installationId: 'device', workspaceId: 'workspace',
      provider: 'expo' as const, token: 'ExponentPushToken[synthetic]', platform: 'ios' as const,
      environment: 'development' as const, appIdentity: 'dev.example.test', appVersion: '1',
      locale: 'en', timezone: 'UTC' };
    await expect(mobileNotifications.registerInstallation(input)).resolves.toEqual({ installationId: 'opaque' });
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/v1/mobile/installations',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
  });

  it('writes preferences through the existing transport', async () => {
    const preferences = defaultMobileNotificationPreferences('workspace');
    await mobileNotifications.updatePreferences(preferences);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/api/v1/mobile/notification-preferences',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify(preferences) }));
  });
});

describe('notification wire validation', () => {
  const payload = { schemaVersion: 1, eventId: '10000000-0000-4000-8000-000000000001', category: 'session_update',
    destination: { kind: 'session', workspaceId: '10000000-0000-4000-8000-000000000002',
      entityId: '10000000-0000-4000-8000-000000000003' } };
  it('accepts the explicit versioned payload', () => expect(isMobileNotificationPayload(payload)).toBe(true));
  it('validates server event resolution independently from push data', () => {
    expect(isMobileNotificationResolution({ ...payload, expiresAt: '2030-01-01T00:00:00Z' })).toBe(true);
    expect(isMobileNotificationResolution({ ...payload, expiresAt: 'invalid' })).toBe(false);
    expect(isMobileNotificationResolution({ ...payload, expiresAt: null })).toBe(false);
    expect(isMobileNotificationResolution({ ...payload, expiresAt: '2030-01-01', token: 'private' })).toBe(false);
    expect(isMobileNotificationResolution(null)).toBe(false);
  });
  it.each([
    null, [], {}, { ...payload, schemaVersion: 2 }, { ...payload, category: 'marketing' },
    { ...payload, eventId: 'https://example.test' }, { ...payload, title: 'private' },
    { ...payload, destination: { ...payload.destination, kind: 'external' } },
    { ...payload, destination: { ...payload.destination, entityId: '../other' } },
    { ...payload, destination: { ...payload.destination, title: 'private' } },
  ])('rejects malformed or extra fields: %j', (value) => expect(isMobileNotificationPayload(value)).toBe(false));
});
