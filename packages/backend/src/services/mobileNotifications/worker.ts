import { mobileNotificationMetrics } from './metrics.js';
export { mobileNotificationMetrics, mobileNotificationMetricsSnapshot } from './metrics.js';
import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { MobileNotificationPreferences } from '@talyn/shared';
import { isMobileNotificationPayload } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { mobileInstallations as installations, mobileNotificationOutbox as outbox,
  mobileNotificationPreferences as preferences, mobileNotificationAudit as audit, workspaces } from '../../db/schema.js';
import { decryptString } from '../tokenCrypto.js';
import { notificationStillActionable, reconcileMobileNotificationEvents } from '../mobileNotificationEvents.js';
import { destinationCurrentlyAccessible } from './store.js';
import { ExpoPushProvider, mobileProviderAvailable, PushProviderError,
  type MobilePushProvider, type PushErrorClass, type PushMessage } from './provider.js';

export const MAX_PUSH_ATTEMPTS = 6;
export const MOBILE_INSTALLATION_MAX_AGE_MS = 30 * 86_400_000;
export function retryDelayMs(attempt: number): number { return Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempt - 1)); }
export function inMobileQuietHours(preference: MobileNotificationPreferences, now: Date): boolean {
  if (!preference.quietHours.enabled) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: preference.timezone,
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const minute = Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value);
  const parse = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const start = parse(preference.quietHours.start), end = parse(preference.quietHours.end);
  return start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end);
}
type OutboxRow = typeof outbox.$inferSelect;
export async function claimMobileNotifications(now = new Date(), limit = 50): Promise<OutboxRow[]> {
  return getPoolDbClient().transaction(async (transaction) => {
    const rows = await transaction.select().from(outbox).where(and(
      or(eq(outbox.state, 'pending'), and(eq(outbox.state, 'sending'), lte(outbox.leaseUntil, now))),
      lte(outbox.notBefore, now), gt(outbox.expiresAt, now), lt(outbox.attempts, MAX_PUSH_ATTEMPTS),
    )).orderBy(outbox.notBefore).limit(Math.max(1, Math.min(100, limit))).for('update', { skipLocked: true });
    if (!rows.length) return [];
    const leaseId = randomUUID();
    return transaction.update(outbox).set({ state: 'sending', leaseId,
      leaseUntil: new Date(now.getTime() + 300_000), attempts: sql`${outbox.attempts} + 1`, updatedAt: now })
      .where(inArray(outbox.id, rows.map((row) => row.id))).returning();
  });
}
async function settle(row: OutboxRow, changes: Partial<typeof outbox.$inferInsert>): Promise<void> {
  await getPoolDbClient().update(outbox).set({ ...changes, updatedAt: new Date(), leaseId: null, leaseUntil: null })
    .where(and(eq(outbox.id, row.id), eq(outbox.leaseId, row.leaseId!)));
}
async function failed(row: OutboxRow, errorClass: PushErrorClass, now: Date): Promise<void> {
  const permanent = errorClass !== 'temporary' || row.attempts >= MAX_PUSH_ATTEMPTS;
  if (errorClass === 'device_not_registered') {
    await getPoolDbClient().update(installations).set({ disabledAt: now, failureState: errorClass, updatedAt: now })
      .where(and(eq(installations.id, row.installationId), eq(installations.ownerId, row.ownerId), eq(installations.tokenFingerprint, row.tokenFingerprint)));
  }
  await settle(row, { state: permanent ? 'failed' : 'pending', lastErrorClass: errorClass,
    notBefore: new Date(now.getTime() + retryDelayMs(row.attempts)) });
  mobileNotificationMetrics[permanent ? 'permanentFailure' : 'retry']++;
}
async function preflight(row: OutboxRow, now: Date): Promise<PushMessage | null> {
  const db = getPoolDbClient();
  const [device] = await db.select().from(installations).where(and(eq(installations.id, row.installationId),
    eq(installations.ownerId, row.ownerId), eq(installations.tokenFingerprint, row.tokenFingerprint), isNull(installations.disabledAt), gt(installations.lastSeenAt, new Date(now.getTime() - MOBILE_INSTALLATION_MAX_AGE_MS)))).limit(1);
  if (!device || !await destinationCurrentlyAccessible(row.ownerId, row.destination, db) ||
      !await notificationStillActionable(row.category, row.destination, db)) {
    await settle(row, { state: 'cancelled', lastErrorClass: 'access_or_state_changed' }); return null;
  }
  const [setting] = await db.select().from(preferences).where(and(eq(preferences.ownerId, row.ownerId), eq(preferences.workspaceId, row.workspaceId))).limit(1);
  if (!setting?.preferences.enabled || !setting.preferences.categories[row.category]) {
    await settle(row, { state: 'cancelled', lastErrorClass: 'preferences_disabled' }); return null;
  }
  if (inMobileQuietHours(setting.preferences, now)) {
    await settle(row, { state: 'pending', attempts: Math.max(0, row.attempts - 1), notBefore: new Date(now.getTime() + 900_000) }); return null;
  }
  const allowed = (process.env.TALYN_MOBILE_PUSH_APP_IDENTITIES ?? '').split(',').map((item) => item.trim());
  if (!allowed.includes(`${device.appIdentity}@${device.environment}`)) {
    await settle(row, { state: 'cancelled', lastErrorClass: 'app_identity_disabled' }); return null;
  }
  const data = { schemaVersion: 1 as const, eventId: row.eventId, category: row.category, destination: row.destination };
  if (!isMobileNotificationPayload(data)) { await failed(row, 'permanent', now); return null; }
  try { return { token: decryptString(device.tokenEnvelope), data, ttlSeconds: Math.max(1, Math.min(3600, Math.floor((row.expiresAt.getTime() - now.getTime()) / 1000))) }; }
  catch { await failed(row, 'permanent', now); return null; }
}
export async function dispatchMobileNotifications(provider: MobilePushProvider = new ExpoPushProvider(), now = new Date()): Promise<void> {
  if (!mobileProviderAvailable()) return;
  const claimed = await claimMobileNotifications(now);
  const ready: { row: OutboxRow; message: PushMessage }[] = [];
  for (const row of claimed) {
    const message = await preflight(row, now);
    if (message) ready.push({ row, message });
  }
  if (!ready.length) return;
  try {
    const tickets = await provider.send(ready.map((item) => item.message));
    if (tickets.length !== ready.length) throw new PushProviderError('temporary');
    for (let index = 0; index < ready.length; index++) {
      const { row } = ready[index], ticket = tickets[index];
      if (ticket.status === 'error') { await failed(row, ticket.errorClass, now); continue; }
      await settle(row, { state: 'ticketed', providerTicketId: ticket.ticketId, receiptState: 'pending',
        receiptAfter: new Date(now.getTime() + 900_000), lastErrorClass: null });
      mobileNotificationMetrics.sent++;
      mobileNotificationMetrics.latencyMsTotal += Math.max(0, now.getTime() - row.createdAt.getTime());
      mobileNotificationMetrics.latencyCount++;
    }
  } catch (error) {
    const errorClass = error instanceof PushProviderError ? error.errorClass : 'temporary';
    for (const { row } of ready) await failed(row, errorClass, now);
  }
}
async function claimReceipts(now: Date): Promise<OutboxRow[]> {
  return getPoolDbClient().transaction(async (transaction) => {
    const rows = await transaction.select().from(outbox).where(and(eq(outbox.state, 'ticketed'),
      eq(outbox.receiptState, 'pending'), lte(outbox.receiptAfter, now),
      or(isNull(outbox.leaseUntil), lte(outbox.leaseUntil, now)), lt(outbox.receiptAttempts, 8)))
      .orderBy(outbox.receiptAfter).limit(100).for('update', { skipLocked: true });
    if (!rows.length) return [];
    return transaction.update(outbox).set({ leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + 300_000),
      receiptAttempts: sql`${outbox.receiptAttempts} + 1` }).where(inArray(outbox.id, rows.map((row) => row.id))).returning();
  });
}
export async function processMobileNotificationReceipts(provider: MobilePushProvider = new ExpoPushProvider(), now = new Date()): Promise<void> {
  if (!mobileProviderAvailable()) return;
  const rows = await claimReceipts(now);
  if (!rows.length) return;
  try {
    const receipts = await provider.receipts(rows.flatMap((row) => row.providerTicketId ? [row.providerTicketId] : []));
    for (const row of rows) {
      const receipt = receipts.find((item) => item.ticketId === row.providerTicketId);
      if (!receipt) {
        await settle(row, { receiptState: row.receiptAttempts >= 8 ? 'unknown' : 'pending', receiptAfter: new Date(now.getTime() + retryDelayMs(row.receiptAttempts)) });
        mobileNotificationMetrics.receiptMissing++; continue;
      }
      if (receipt.status === 'ok') {
        await settle(row, { state: 'delivered', receiptState: 'ok', lastErrorClass: null }); mobileNotificationMetrics.receiptOk++;
      } else {
        mobileNotificationMetrics.receiptError++;
        await failed(row, receipt.errorClass ?? 'permanent', now);
        await getPoolDbClient().update(outbox).set({ receiptState: 'error', providerTicketId: null })
          .where(and(eq(outbox.id, row.id), eq(outbox.providerTicketId, row.providerTicketId!)));
      }
    }
  } catch (error) {
    const errorClass = error instanceof PushProviderError ? error.errorClass : 'temporary';
    for (const row of rows) await settle(row, { receiptState: errorClass !== 'temporary' || row.receiptAttempts >= 8 ? 'unknown' : 'pending',
      receiptAfter: new Date(now.getTime() + retryDelayMs(row.receiptAttempts)), lastErrorClass: errorClass });
    if (errorClass !== 'temporary') mobileNotificationMetrics.receiptError += rows.length;
  }
}
export async function sweepMobileNotificationStorage(now = new Date()): Promise<void> {
  const db = getPoolDbClient();
  const expired = await db.update(outbox).set({ state: 'expired', updatedAt: now, leaseId: null, leaseUntil: null })
    .where(and(lte(outbox.expiresAt, now), inArray(outbox.state, ['pending', 'sending']))).returning({ id: outbox.id });
  mobileNotificationMetrics.expired += expired.length;
  const exhausted = await db.update(outbox).set({ state: 'failed', lastErrorClass: 'attempt_limit', updatedAt: now })
    .where(and(gteAttempts(), or(eq(outbox.state, 'pending'), and(eq(outbox.state, 'sending'), lte(outbox.leaseUntil, now))))).returning({ id: outbox.id });
  mobileNotificationMetrics.permanentFailure += exhausted.length;
  await db.update(installations).set({ disabledAt: now, failureState: 'last_seen_expired', updatedAt: now })
    .where(and(isNull(installations.disabledAt), lt(installations.lastSeenAt, new Date(now.getTime() - MOBILE_INSTALLATION_MAX_AGE_MS))));
  // Remove preference and outbox rows after workspace ownership changes.
  await db.delete(preferences).where(sql`NOT EXISTS (SELECT 1 FROM ${workspaces} w WHERE w.id = ${preferences.workspaceId} AND w.owner_id = ${preferences.ownerId})`);
  await db.delete(outbox).where(sql`NOT EXISTS (SELECT 1 FROM ${workspaces} w WHERE w.id = ${outbox.workspaceId} AND w.owner_id = ${outbox.ownerId})`);
  await db.delete(installations).where(lt(installations.disabledAt, new Date(now.getTime() - MOBILE_INSTALLATION_MAX_AGE_MS)));
  const cutoff = new Date(now.getTime() - 7 * 86_400_000);
  await db.delete(outbox).where(lt(outbox.expiresAt, cutoff));
  await db.delete(audit).where(lt(audit.createdAt, new Date(now.getTime() - 30 * 86_400_000)));
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(installations).where(isNull(installations.disabledAt));
  mobileNotificationMetrics.activeInstallations = count;
}
function gteAttempts() { return sql`${outbox.attempts} >= ${MAX_PUSH_ATTEMPTS}`; }
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;
export function startMobileNotifications(): void {
  if (timer) return;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await sweepMobileNotificationStorage();
      await reconcileMobileNotificationEvents();
      await dispatchMobileNotifications();
      await processMobileNotificationReceipts();
    } catch { console.warn('[mobile-push] Sweep failed.'); }
    finally { running = false; }
  };
  timer = setInterval(() => void sweep(), 30_000);
  timer.unref();
  void sweep();
}
export function stopMobileNotifications(): void { if (timer) clearInterval(timer); timer = undefined; }
