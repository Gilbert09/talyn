import type {
  MobileInstallation,
  MobileInstallationHeartbeatInput,
  MobileNotificationPreferences,
  MobileNotificationPreferencesResult,
  MobileNotificationResolution,
  RegisterMobileInstallationInput,
} from '@talyn/shared';
import { request } from './http.js';

export const mobileNotifications = {
  registerInstallation: (input: RegisterMobileInstallationInput) =>
    request<MobileInstallation>('POST', '/mobile/installations', input),
  heartbeatInstallation: (installationId: string, input: MobileInstallationHeartbeatInput) =>
    request<MobileInstallation>('PATCH', `/mobile/installations/${encodeURIComponent(installationId)}`, input),
  removeInstallation: (installationId: string) =>
    request<void>('DELETE', `/mobile/installations/${encodeURIComponent(installationId)}`),
  getPreferences: (workspaceId: string) =>
    request<MobileNotificationPreferencesResult>('GET', `/mobile/notification-preferences?workspaceId=${encodeURIComponent(workspaceId)}`),
  updatePreferences: (input: MobileNotificationPreferences) =>
    request<MobileNotificationPreferencesResult>('PUT', '/mobile/notification-preferences', input),
  resolveNotification: (eventId: string) =>
    request<MobileNotificationResolution>('GET', `/mobile/notifications/${encodeURIComponent(eventId)}`),
};
