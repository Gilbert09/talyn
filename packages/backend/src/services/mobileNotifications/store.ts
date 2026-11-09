import { mobileNotificationMetrics } from './metrics.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, gt, sql } from 'drizzle-orm';
import {
  defaultMobileNotificationPreferences, isMobileNotificationPayload,
  type MobileInstallation, type MobileInstallationHeartbeatInput, type MobileNotificationCategory,
  type MobileNotificationDestination, type MobileNotificationPreferences, type MobileNotificationPreferencesResult,
  type RegisterMobileInstallationInput,
} from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { mobileInstallations as installations, mobileNotificationPreferences as preferences,
  mobileNotificationOutbox as outbox, mobileNotificationAudit as audit, workspaces, workbenches, pullRequests } from '../../db/schema.js';
import { encryptString } from '../tokenCrypto.js';
import { mobileProviderAvailable } from './provider.js';

export class MobileNotificationError extends Error {
  constructor(readonly status: number, readonly code: string) { super('Mobile notification request failed.'); }
}
export async function ownsMobileWorkspace(ownerId: string, workspaceId: string, db = getPoolDbClient()): Promise<boolean> {
  const [row] = await db.select({ id: workspaces.id }).from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, ownerId))).limit(1);
  return !!row;
}
async function requireWorkspace(ownerId: string, workspaceId: string, db: Database): Promise<void> {
  if (!await ownsMobileWorkspace(ownerId, workspaceId, db)) throw new MobileNotificationError(404, 'not_found');
}
function view(installationId: string, enabled: boolean): MobileInstallation {
  return { schemaVersion: 1, installationId, enabled, providerAvailable: mobileProviderAvailable() };
}
function approvedIdentity(input: RegisterMobileInstallationInput): boolean {
  const identities = (process.env.TALYN_MOBILE_PUSH_APP_IDENTITIES ?? '').split(',').map((item) => item.trim());
  return identities.includes(`${input.appIdentity}@${input.environment}`);
}
export async function registerMobileInstallation(ownerId: string, input: RegisterMobileInstallationInput): Promise<MobileInstallation> {
  if (!mobileProviderAvailable()) throw new MobileNotificationError(503, 'push_unavailable');
  if (!approvedIdentity(input)) throw new MobileNotificationError(400, 'invalid_app_identity');
  const fingerprint = createHash('sha256').update(input.token).digest('hex');
  const envelope = encryptString(input.token);
  try {
    return await getPoolDbClient().transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await requireWorkspace(ownerId, input.workspaceId, db);
      // Serializes identity changes, including registrations for another account.
      await db.execute(sql`SELECT pg_advisory_xact_lock(77101, hashtext(${ownerId}))`);
      await db.execute(sql`SELECT pg_advisory_xact_lock(77102, hashtext(${fingerprint}))`);
      const [existing] = await db.select().from(installations).where(eq(installations.id, input.installationId)).limit(1);
      if (existing && existing.ownerId !== ownerId) throw new MobileNotificationError(409, 'installation_conflict');
      const matching = await db.select({ id: installations.id, ownerId: installations.ownerId }).from(installations)
        .where(and(eq(installations.tokenFingerprint, fingerprint), isNull(installations.disabledAt)));
      if (matching.some((row) => row.ownerId !== ownerId)) throw new MobileNotificationError(409, 'installation_conflict');
      const now = new Date();
      await db.update(installations).set({ disabledAt: now, failureState: 'token_rotated', updatedAt: now })
        .where(and(eq(installations.ownerId, ownerId), eq(installations.tokenFingerprint, fingerprint)));
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(installations)
        .where(and(eq(installations.ownerId, ownerId), isNull(installations.disabledAt)));
      const activeOthers = count - (existing && !existing.disabledAt && existing.tokenFingerprint !== fingerprint ? 1 : 0);
      if (activeOthers >= 20) throw new MobileNotificationError(429, 'installation_limit');
      const values = { ownerId, provider: input.provider, tokenEnvelope: envelope, tokenFingerprint: fingerprint,
        platform: input.platform, environment: input.environment, appIdentity: input.appIdentity,
        appVersion: input.appVersion, locale: input.locale, timezone: input.timezone,
        disabledAt: null, failureState: null, lastSeenAt: now, updatedAt: now };
      if (existing) await db.update(installations).set(values).where(and(eq(installations.id, input.installationId), eq(installations.ownerId, ownerId)));
      else await db.insert(installations).values({ id: input.installationId, ...values });
      await db.insert(audit).values({ id: randomUUID(), ownerId, action: 'installation_registered' });
      return view(input.installationId, true);
    });
  } catch (error) {
    if (error instanceof MobileNotificationError) throw error;
    // Database errors can include encrypted values and request parameters.
    throw new MobileNotificationError(503, 'registration_failed');
  }
}
export async function heartbeatMobileInstallation(ownerId: string, id: string, input: MobileInstallationHeartbeatInput): Promise<MobileInstallation> {
  const db = getPoolDbClient();
  await requireWorkspace(ownerId, input.workspaceId, db);
  const [row] = await db.update(installations).set({ appVersion: input.appVersion, locale: input.locale,
    timezone: input.timezone, lastSeenAt: new Date(), updatedAt: new Date() })
    .where(and(eq(installations.id, id), eq(installations.ownerId, ownerId))).returning({ disabledAt: installations.disabledAt });
  if (!row) throw new MobileNotificationError(404, 'not_found');
  return view(id, !row.disabledAt);
}
export async function removeMobileInstallation(ownerId: string, id: string): Promise<void> {
  await getPoolDbClient().transaction(async (transaction) => {
    const now = new Date();
    const changed = await transaction.update(installations).set({ disabledAt: now, failureState: 'removed', updatedAt: now })
      .where(and(eq(installations.id, id), eq(installations.ownerId, ownerId), isNull(installations.disabledAt))).returning({ id: installations.id });
    if (changed.length) await transaction.insert(audit).values({ id: randomUUID(), ownerId, action: 'installation_removed' });
    await transaction.update(outbox).set({ state: 'cancelled', updatedAt: now })
      .where(and(eq(outbox.installationId, id), eq(outbox.ownerId, ownerId), eq(outbox.state, 'pending')));
  });
}
export async function readMobilePreferences(ownerId: string, workspaceId: string): Promise<MobileNotificationPreferencesResult> {
  const db = getPoolDbClient();
  await requireWorkspace(ownerId, workspaceId, db);
  const [row] = await db.select().from(preferences).where(and(eq(preferences.ownerId, ownerId), eq(preferences.workspaceId, workspaceId))).limit(1);
  return { preferences: row?.preferences ?? defaultMobileNotificationPreferences(workspaceId), providerAvailable: mobileProviderAvailable() };
}
export async function saveMobilePreferences(ownerId: string, input: MobileNotificationPreferences): Promise<MobileNotificationPreferencesResult> {
  await getPoolDbClient().transaction(async (transaction) => {
    const db = transaction as unknown as Database;
    await requireWorkspace(ownerId, input.workspaceId, db);
    await db.insert(preferences).values({ ownerId, workspaceId: input.workspaceId, preferences: input })
      .onConflictDoUpdate({ target: [preferences.ownerId, preferences.workspaceId], set: { preferences: input, updatedAt: new Date() } });
    await db.insert(audit).values({ id: randomUUID(), ownerId, action: 'preferences_changed' });
  });
  return { preferences: input, providerAvailable: mobileProviderAvailable() };
}
export interface EnqueueMobileNotificationInput {
  eventId?: string; ownerId: string; workspaceId: string; category: MobileNotificationCategory;
  destination: MobileNotificationDestination; deduplicationKey: string; notBefore?: Date; expiresAt?: Date;
}
export async function enqueueMobileNotification(input: EnqueueMobileNotificationInput, db = getPoolDbClient()): Promise<number> {
  const eventId = input.eventId ?? randomUUID();
  const payload = { schemaVersion: 1, eventId, category: input.category, destination: input.destination };
  if (!isMobileNotificationPayload(payload) || input.destination.workspaceId !== input.workspaceId || input.deduplicationKey.length > 512) {
    throw new MobileNotificationError(400, 'invalid_notification');
  }
  const devices = await db.select({ id: installations.id, tokenFingerprint: installations.tokenFingerprint }).from(installations)
    .where(and(eq(installations.ownerId, input.ownerId), isNull(installations.disabledAt)));
  if (!devices.length) return 0;
  const rows = await db.insert(outbox).values(devices.map((device) => ({
    id: randomUUID(), eventId, ownerId: input.ownerId, workspaceId: input.workspaceId, installationId: device.id,
    category: input.category, destination: input.destination, deduplicationKey: input.deduplicationKey, tokenFingerprint: device.tokenFingerprint,
    notBefore: input.notBefore ?? new Date(), expiresAt: input.expiresAt ?? new Date(Date.now() + 86_400_000),
  }))).onConflictDoNothing().returning({ id: outbox.id });
  mobileNotificationMetrics.queued += rows.length;
  return rows.length;
}
export async function destinationCurrentlyAccessible(ownerId: string, destination: MobileNotificationDestination, db = getPoolDbClient()): Promise<boolean> {
  if (!await ownsMobileWorkspace(ownerId, destination.workspaceId, db)) return false;
  if (destination.kind === 'pull_request') {
    const [row] = await db.select({ id: pullRequests.id }).from(pullRequests)
      .where(and(eq(pullRequests.id, destination.entityId), eq(pullRequests.workspaceId, destination.workspaceId))).limit(1);
    return !!row;
  }
  const [row] = await db.select({ id: workbenches.id }).from(workbenches)
    .where(and(eq(workbenches.id, destination.entityId), eq(workbenches.workspaceId, destination.workspaceId), eq(workbenches.kind, destination.kind))).limit(1);
  return !!row;
}
export async function resolveMobileNotification(ownerId: string, eventId: string) {
  const db = getPoolDbClient();
  const [row] = await db.select().from(outbox).where(and(eq(outbox.ownerId, ownerId), eq(outbox.eventId, eventId), gt(outbox.expiresAt, new Date()))).limit(1);
  if (!row || !isMobileNotificationPayload({ schemaVersion: 1, eventId, category: row.category, destination: row.destination }) ||
      !await destinationCurrentlyAccessible(ownerId, row.destination, db)) throw new MobileNotificationError(404, 'not_found');
  return { schemaVersion: 1 as const, eventId, category: row.category, destination: row.destination, expiresAt: row.expiresAt.toISOString() };
}
