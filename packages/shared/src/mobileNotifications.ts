export const MOBILE_NOTIFICATION_CATEGORIES = ['session_update', 'pr_review', 'ci_failure', 'merge_ready', 'human_gate'] as const;
export type MobileNotificationCategory = typeof MOBILE_NOTIFICATION_CATEGORIES[number];
export type MobilePushProvider = 'expo';
export type MobilePushEnvironment = 'development' | 'preview' | 'production';
export interface MobileNotificationDestination {
  kind: 'session' | 'thread' | 'pull_request';
  workspaceId: string;
  entityId: string;
}
export interface MobileNotificationPayload {
  schemaVersion: 1;
  eventId: string;
  category: MobileNotificationCategory;
  destination: MobileNotificationDestination;
}
export interface MobileNotificationResolution extends MobileNotificationPayload {
  expiresAt: string;
}
export interface RegisterMobileInstallationInput {
  schemaVersion: 1;
  installationId: string;
  workspaceId: string;
  provider: MobilePushProvider;
  token: string;
  platform: 'ios' | 'android';
  environment: MobilePushEnvironment;
  appIdentity: string;
  appVersion: string;
  locale: string;
  timezone: string;
}
export interface MobileInstallation {
  schemaVersion: 1;
  installationId: string;
  enabled: boolean;
  providerAvailable: boolean;
}
export interface MobileInstallationHeartbeatInput {
  schemaVersion: 1;
  workspaceId: string;
  appVersion: string;
  locale: string;
  timezone: string;
}
export interface MobileQuietHours {
  enabled: boolean;
  start: string;
  end: string;
}
export interface MobileNotificationPreferences {
  schemaVersion: 1;
  workspaceId: string;
  enabled: boolean;
  categories: Record<MobileNotificationCategory, boolean>;
  quietHours: MobileQuietHours;
  timezone: string;
  sensitivePreview: boolean;
}
export interface MobileNotificationPreferencesResult {
  preferences: MobileNotificationPreferences;
  providerAvailable: boolean;
}
export interface MobileProviderReceipt {
  ticketId: string;
  status: 'ok' | 'error';
  errorClass?: 'device_not_registered' | 'temporary' | 'permanent';
}

export function defaultMobileNotificationPreferences(workspaceId: string): MobileNotificationPreferences {
  return {
    schemaVersion: 1, workspaceId, enabled: false,
    categories: { session_update: true, pr_review: true, ci_failure: true, merge_ready: true, human_gate: true },
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
    timezone: 'UTC', sensitivePreview: false,
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function isMobileNotificationDestination(value: unknown): value is MobileNotificationDestination {
  return record(value) && Object.keys(value).length === 3 &&
    ['session', 'thread', 'pull_request'].includes(value.kind as string) &&
    typeof value.workspaceId === 'string' && uuid.test(value.workspaceId) &&
    typeof value.entityId === 'string' && uuid.test(value.entityId);
}
export function isMobileNotificationPayload(value: unknown): value is MobileNotificationPayload {
  return record(value) && Object.keys(value).length === 4 && value.schemaVersion === 1 &&
    typeof value.eventId === 'string' && uuid.test(value.eventId) &&
    MOBILE_NOTIFICATION_CATEGORIES.includes(value.category as MobileNotificationCategory) &&
    isMobileNotificationDestination(value.destination);
}
export function isMobileNotificationResolution(value: unknown): value is MobileNotificationResolution {
  if (!record(value) || Object.keys(value).length !== 5 || typeof value.expiresAt !== 'string') return false;
  const { expiresAt, ...payload } = value;
  return Number.isFinite(Date.parse(expiresAt)) && isMobileNotificationPayload(payload);
}
