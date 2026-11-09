import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultMobileNotificationPreferences, type RegisterMobileInstallationInput } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { mobileInstallations, mobileNotificationAudit, mobileNotificationOutbox as outbox,
  mobileNotificationPreferences, users, workbenches, workspaces } from '../db/schema.js';
import { decryptString } from '../services/tokenCrypto.js';
import { enqueueMobileNotification, heartbeatMobileInstallation, readMobilePreferences, registerMobileInstallation,
  removeMobileInstallation, resolveMobileNotification, saveMobilePreferences } from '../services/mobileNotifications/store.js';
import { claimMobileNotifications, dispatchMobileNotifications, processMobileNotificationReceipts, sweepMobileNotificationStorage } from '../services/mobileNotifications/worker.js';
import { PushProviderError } from '../services/mobileNotifications/provider.js';
import { installationInput, preferencesInput } from '../services/mobileNotifications/validation.js';
import { internalProxyHeaders, requireAuth } from '../middleware/auth.js';
import { mobileNotificationRoutes } from '../routes/mobileNotifications.js';

const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const workspaceId = '00000000-0000-4000-8000-000000000003';
const otherWorkspace = '00000000-0000-4000-8000-000000000004';
const entityId = '00000000-0000-4000-8000-000000000005';
const destination = { kind: 'session' as const, workspaceId, entityId };
let fixture: Awaited<ReturnType<typeof createTestDb>>;
let server: Server;
let url: string;
function input(overrides: Partial<RegisterMobileInstallationInput> = {}): RegisterMobileInstallationInput {
  return { schemaVersion: 1, installationId: randomUUID(), workspaceId, provider: 'expo',
    token: `ExpoPushToken[synthetic_${randomUUID().replaceAll('-', '')}]`, platform: 'ios', environment: 'preview',
    appIdentity: 'dev.talyn.mobile.preview', appVersion: '1', locale: 'en-GB', timezone: 'UTC', ...overrides };
}
async function routeFetch(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has('x-test-unauthenticated')) {
    for (const [key, value] of Object.entries(internalProxyHeaders(headers.get('x-test-owner') === other ? other : owner))) headers.set(key, value);
  }
  return fetch(path, { ...options, headers });
}
async function setupNotification() {
  const registration = input();
  await registerMobileInstallation(owner, registration);
  await saveMobilePreferences(owner, { ...defaultMobileNotificationPreferences(workspaceId), enabled: true });
  const eventId = randomUUID();
  await enqueueMobileNotification({ ownerId: owner, workspaceId, destination, category: 'session_update', eventId, deduplicationKey: eventId });
  return { registration, eventId };
}
beforeAll(async () => {
  vi.stubEnv('TALYN_ALLOWED_EMAILS', '');
  vi.stubEnv('TALYN_TOKEN_KEY', 'synthetic-unit-test-key');
  vi.stubEnv('TALYN_MOBILE_PUSH_ENABLED', 'true');
  vi.stubEnv('TALYN_MOBILE_PUSH_APP_IDENTITIES', 'dev.talyn.mobile.preview@preview');
  fixture = await createTestDb();
  const app = express(); app.use(express.json());
  app.use(requireAuth);
  app.use('/mobile', mobileNotificationRoutes());
  server = createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mobile`;
});
beforeEach(async () => {
  await fixture.db.delete(users);
  await seedUser(fixture.db, { id: owner }); await seedUser(fixture.db, { id: other });
  await fixture.db.insert(workspaces).values([{ id: workspaceId, ownerId: owner, name: 'Fixture' }, { id: otherWorkspace, ownerId: other, name: 'Fixture' }]);
  await fixture.db.insert(workbenches).values({ id: entityId, workspaceId, kind: 'session', repoFullName: '', branch: 'b', baseBranch: 'main',
    name: 'Fixture', runtime: 'sandbox', agent: 'claude', status: 'ready' });
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await fixture.cleanup(); vi.unstubAllEnvs(); });
describe('mobile registration and preferences', () => {
  it('encrypts tokens and returns no token material', async () => {
    const registration = input();
    const result = await registerMobileInstallation(owner, registration);
    expect(result).toEqual({ schemaVersion: 1, installationId: registration.installationId, enabled: true, providerAvailable: true });
    const [row] = await fixture.db.select().from(mobileInstallations);
    expect(JSON.stringify(row)).not.toContain(registration.token);
    expect(decryptString(row.tokenEnvelope)).toBe(registration.token);
    expect(await fixture.db.select().from(mobileNotificationAudit)).toHaveLength(1);
  });
  it('is idempotent, rotates tokens, and supports several devices', async () => {
    const registration = input(); await registerMobileInstallation(owner, registration); await registerMobileInstallation(owner, registration);
    await registerMobileInstallation(owner, { ...registration, token: input().token });
    await registerMobileInstallation(owner, input());
    const rows = await fixture.db.select().from(mobileInstallations); expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === registration.installationId)?.tokenFingerprint).not.toBeUndefined();
  });
  it('prevents takeover but releases an explicitly removed active token', async () => {
    const registration = input(); await registerMobileInstallation(owner, registration);
    await expect(registerMobileInstallation(other, { ...registration, installationId: randomUUID(), workspaceId: otherWorkspace })).rejects.toMatchObject({ status: 409 });
    await expect(registerMobileInstallation(other, { ...input(), installationId: registration.installationId, workspaceId: otherWorkspace })).rejects.toMatchObject({ status: 409 });
    await removeMobileInstallation(owner, registration.installationId);
    await expect(registerMobileInstallation(other, { ...registration, installationId: randomUUID(), workspaceId: otherWorkspace })).resolves.toMatchObject({ enabled: true });
  });
  it('checks workspace authorization for registration, heartbeat, and preferences', async () => {
    const registration = input(); await registerMobileInstallation(owner, registration);
    await expect(registerMobileInstallation(other, input())).rejects.toMatchObject({ status: 404 });
    await expect(heartbeatMobileInstallation(other, registration.installationId, { schemaVersion: 1, workspaceId, appVersion: '2', locale: 'en', timezone: 'UTC' })).rejects.toMatchObject({ status: 404 });
    await expect(readMobilePreferences(other, workspaceId)).rejects.toMatchObject({ status: 404 });
    await expect(saveMobilePreferences(other, defaultMobileNotificationPreferences(workspaceId))).rejects.toMatchObject({ status: 404 });
  });
  it.each([['platform', 'web'], ['environment', 'bad'], ['provider', 'fcm'], ['token', 'bad'], ['timezone', 'wrong/zone'],
    ['locale', '@bad'], ['appVersion', 'x'.repeat(65)], ['appIdentity', '../private']])('validates %s', (field, value) => {
    expect(installationInput.safeParse({ ...input(), [field]: value }).success).toBe(false);
  });
  it('validates quiet hours and reserved preview without private content', () => {
    expect(preferencesInput.safeParse({ ...defaultMobileNotificationPreferences(workspaceId), quietHours: { enabled: true, start: '25:00', end: '08:00' } }).success).toBe(false);
  });
  it('stores preferences and heartbeat metadata', async () => {
    const registration = input(); await registerMobileInstallation(owner, registration);
    await heartbeatMobileInstallation(owner, registration.installationId, { schemaVersion: 1, workspaceId, appVersion: '2', locale: 'fr', timezone: 'Europe/Paris' });
    const preference = { ...defaultMobileNotificationPreferences(workspaceId), enabled: true, sensitivePreview: true };
    await saveMobilePreferences(owner, preference); expect((await readMobilePreferences(owner, workspaceId)).preferences).toEqual(preference);
    const [row] = await fixture.db.select().from(mobileInstallations); expect(row.appVersion).toBe('2');
  });
});
describe('durable outbox', () => {
  it('deduplicates each event across devices', async () => {
    const { eventId } = await setupNotification(); await registerMobileInstallation(owner, input());
    const event = { ownerId: owner, workspaceId, destination, category: 'session_update' as const, eventId, deduplicationKey: eventId };
    await enqueueMobileNotification(event); await enqueueMobileNotification(event);
    expect(await fixture.db.select().from(outbox)).toHaveLength(2);
  });
  it('claims concurrently without duplicate rows', async () => {
    await setupNotification();
    const batches = await Promise.all([claimMobileNotifications(), claimMobileNotifications()]);
    expect(batches.flat()).toHaveLength(1);
  });
  it('rejects a disabled installation reactivation at the active device limit', async () => {
    const disabled = input(); await registerMobileInstallation(owner, disabled); await removeMobileInstallation(owner, disabled.installationId);
    for (let index = 0; index < 20; index++) await registerMobileInstallation(owner, input());
    await expect(registerMobileInstallation(owner, disabled)).rejects.toMatchObject({ status: 429 });
    const [active] = await fixture.db.select().from(mobileInstallations).where(eq(mobileInstallations.id, disabled.installationId));
    expect(active.disabledAt).not.toBeNull();
  });
  it('serializes concurrent registrations at the device limit', async () => {
    for (let index = 0; index < 19; index++) await registerMobileInstallation(owner, input());
    const result = await Promise.allSettled([registerMobileInstallation(owner, input()), registerMobileInstallation(owner, input())]);
    expect(result.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((item) => item.status === 'rejected')).toHaveLength(1);
  });
  it('expires a recent row before retention removes it', async () => {
    await setupNotification(); await fixture.db.update(outbox).set({ expiresAt: new Date(Date.now() - 1000) });
    await sweepMobileNotificationStorage(); expect((await fixture.db.select().from(outbox))[0].state).toBe('expired');
  });
  it('does not claim or dispatch without provider configuration', async () => {
    await setupNotification(); vi.stubEnv('TALYN_MOBILE_PUSH_ENABLED', 'false');
    const send = vi.fn(async () => []); await dispatchMobileNotifications({ send, receipts: async () => [] });
    expect(send).not.toHaveBeenCalled(); expect((await fixture.db.select().from(outbox))[0].attempts).toBe(0);
    vi.stubEnv('TALYN_MOBILE_PUSH_ENABLED', 'true');
  });
  it('bounds repeated temporary failures', async () => {
    await setupNotification();
    const provider = { send: vi.fn(async () => [{ status: 'error' as const, errorClass: 'temporary' as const }]), receipts: async () => [] };
    let now = new Date();
    for (let attempt = 0; attempt < 8; attempt++) {
      await dispatchMobileNotifications(provider, now); now = new Date(now.getTime() + 3_600_001);
    }
    const [row] = await fixture.db.select().from(outbox); expect(row.state).toBe('failed'); expect(row.attempts).toBe(6); expect(provider.send).toHaveBeenCalledTimes(6);
  });
  it('disables the rejected current token and stops future sends', async () => {
    await setupNotification();
    const provider = { send: vi.fn(async () => [{ status: 'error' as const, errorClass: 'device_not_registered' as const }]), receipts: async () => [] };
    await dispatchMobileNotifications(provider); expect((await fixture.db.select().from(mobileInstallations))[0].disabledAt).not.toBeNull();
    await enqueueMobileNotification({ ownerId: owner, workspaceId, destination, category: 'session_update', deduplicationKey: randomUUID() });
    await dispatchMobileNotifications(provider); expect(provider.send).toHaveBeenCalledTimes(1);
  });
  it('bounds missing receipt polling and keeps delivery unknown', async () => {
    await setupNotification();
    const provider = { send: async () => [{ status: 'ok' as const, ticketId: randomUUID() }], receipts: vi.fn(async () => []) };
    let now = new Date(); await dispatchMobileNotifications(provider, now);
    for (let attempt = 0; attempt < 9; attempt++) {
      now = new Date(now.getTime() + 3_600_001); await processMobileNotificationReceipts(provider, now);
    }
    const [row] = await fixture.db.select().from(outbox); expect(row.state).toBe('ticketed'); expect(row.receiptState).toBe('unknown'); expect(provider.receipts).toHaveBeenCalledTimes(8);
  });
  it('does not retry permanent receipt request errors', async () => {
    await setupNotification();
    const provider = { send: async () => [{ status: 'ok' as const, ticketId: randomUUID() }],
      receipts: vi.fn(async () => { throw new PushProviderError('permanent'); }) };
    await dispatchMobileNotifications(provider);
    const now = new Date(Date.now() + 1_000_000);
    await processMobileNotificationReceipts(provider, now);
    await processMobileNotificationReceipts(provider, new Date(now.getTime() + 3_600_000));
    expect(provider.receipts).toHaveBeenCalledTimes(1);
    expect((await fixture.db.select().from(outbox))[0].receiptState).toBe('unknown');
  });
  it('removes revoked workspace data and expires inactive installation storage', async () => {
    const { registration } = await setupNotification();
    await fixture.db.update(workspaces).set({ ownerId: other }).where(eq(workspaces.id, workspaceId));
    await sweepMobileNotificationStorage(); expect(await fixture.db.select().from(outbox)).toHaveLength(0);
    expect(await fixture.db.select().from(mobileNotificationPreferences)).toHaveLength(0);
    await fixture.db.update(mobileInstallations).set({ lastSeenAt: new Date(0) }).where(eq(mobileInstallations.id, registration.installationId));
    await sweepMobileNotificationStorage(); expect((await fixture.db.select().from(mobileInstallations))[0].disabledAt).not.toBeNull();
    await sweepMobileNotificationStorage(new Date(Date.now() + 31 * 86_400_000)); expect(await fixture.db.select().from(mobileInstallations)).toHaveLength(0);
  });
  it('claims once and recovers an expired lease', async () => {
    await setupNotification(); const now = new Date();
    const first = await claimMobileNotifications(now); expect(first).toHaveLength(1);
    expect(await claimMobileNotifications(now)).toHaveLength(0);
    const recovered = await claimMobileNotifications(new Date(now.getTime() + 301_000));
    expect(recovered).toHaveLength(1); expect(recovered[0].attempts).toBe(2); expect(recovered[0].leaseId).not.toBe(first[0].leaseId);
  });
  it('expires stale rows and enforces maximum attempts', async () => {
    await setupNotification(); await fixture.db.update(outbox).set({ attempts: 6 });
    await sweepMobileNotificationStorage(); expect((await fixture.db.select().from(outbox))[0].state).toBe('failed');
    await fixture.db.update(outbox).set({ attempts: 0, state: 'pending', expiresAt: new Date(0) });
    await sweepMobileNotificationStorage(); expect(await fixture.db.select().from(outbox)).toHaveLength(0);
  });
  it('retries temporary failures then stores tickets separately from delivery', async () => {
    await setupNotification(); const now = new Date();
    const provider = { send: vi.fn(async () => [{ status: 'error' as const, errorClass: 'temporary' as const }]), receipts: vi.fn(async () => []) };
    await dispatchMobileNotifications(provider, now);
    let [row] = await fixture.db.select().from(outbox); expect(row.state).toBe('pending'); expect(row.notBefore.getTime()).toBe(now.getTime() + 30_000);
    provider.send.mockResolvedValueOnce([{ status: 'ok', ticketId: randomUUID() }] as never);
    await dispatchMobileNotifications(provider, new Date(now.getTime() + 30_001));
    [row] = await fixture.db.select().from(outbox); expect(row.state).toBe('ticketed'); expect(row.receiptState).toBe('pending');
    const receipts = { ...provider, receipts: vi.fn(async () => [{ status: 'ok' as const, ticketId: row.providerTicketId! }]) };
    await processMobileNotificationReceipts(receipts, new Date(now.getTime() + 1_000_000));
    expect((await fixture.db.select().from(outbox))[0].state).toBe('delivered');
  });
  it('disables only the token generation rejected by the provider', async () => {
    const { registration } = await setupNotification();
    const ticketId = randomUUID();
    await dispatchMobileNotifications({ send: async () => [{ status: 'ok', ticketId }], receipts: async () => [] });
    await registerMobileInstallation(owner, { ...registration, token: input().token });
    await processMobileNotificationReceipts({ send: async () => [], receipts: async () => [{ status: 'error', ticketId, errorClass: 'device_not_registered' }] }, new Date(Date.now() + 1_000_000));
    expect((await fixture.db.select().from(mobileInstallations))[0].disabledAt).toBeNull();
  });
  it.each(['removed', 'preferences', 'access', 'deleted'] as const)('suppresses delivery after %s', async (reason) => {
    const { registration } = await setupNotification();
    if (reason === 'removed') await removeMobileInstallation(owner, registration.installationId);
    if (reason === 'preferences') await saveMobilePreferences(owner, defaultMobileNotificationPreferences(workspaceId));
    if (reason === 'access') await fixture.db.update(workspaces).set({ ownerId: other }).where(eq(workspaces.id, workspaceId));
    if (reason === 'deleted') await fixture.db.delete(workbenches).where(eq(workbenches.id, entityId));
    const send = vi.fn(async () => []); await dispatchMobileNotifications({ send, receipts: async () => [] }); expect(send).not.toHaveBeenCalled();
  });
  it('defers quiet hours without consuming attempts', async () => {
    await setupNotification();
    const preference = { ...defaultMobileNotificationPreferences(workspaceId), enabled: true, quietHours: { enabled: true, start: '00:00', end: '00:00' } };
    await saveMobilePreferences(owner, preference); const send = vi.fn(async () => []);
    await dispatchMobileNotifications({ send, receipts: async () => [] });
    const [row] = await fixture.db.select().from(outbox); expect(row.state).toBe('pending'); expect(row.attempts).toBe(0); expect(send).not.toHaveBeenCalled();
  });
  it('checks current access and expiry before resolving a tap', async () => {
    const { eventId } = await setupNotification(); expect(await resolveMobileNotification(owner, eventId)).toMatchObject({ eventId, destination });
    await expect(resolveMobileNotification(other, eventId)).rejects.toMatchObject({ status: 404 });
    await fixture.db.update(outbox).set({ expiresAt: new Date(0) });
    await expect(resolveMobileNotification(owner, eventId)).rejects.toMatchObject({ status: 404 });
  });
  it('removes installations, preferences, outbox, and audit on account deletion', async () => {
    await setupNotification(); await fixture.db.delete(users).where(eq(users.id, owner));
    for (const table of [mobileInstallations, mobileNotificationPreferences, outbox, mobileNotificationAudit]) {
      expect(await fixture.db.select().from(table)).toHaveLength(0);
    }
  });
  it('denies direct Data API and scoped role access', async () => {
    for (const role of ['anon', 'authenticated', 'service_role', 'talyn_backend']) {
      for (const table of ['mobile_installations', 'mobile_notification_preferences', 'mobile_notification_outbox', 'mobile_notification_audit']) {
        const result = await fixture.pglite.query<{ allowed: boolean }>(`SELECT has_table_privilege('${role}','${table}','SELECT') AS allowed`);
        expect(result.rows[0].allowed).toBe(false);
      }
    }
    expect((await fixture.db.execute(sql`SELECT count(*) FROM mobile_installations`))).toBeDefined();
  });
});
describe('mobile routes', () => {
  it('returns safe validation failures and owner-scoped idempotent removal', async () => {
    const registration = input();
    const invalid = await routeFetch(`${url}/installations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...registration, token: 'bad' }) });
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain('bad');
    const registered = await routeFetch(`${url}/installations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registration) });
    expect(registered.status).toBe(200); expect(await registered.text()).not.toContain(registration.token);
    const wrong = await routeFetch(`${url}/installations/${registration.installationId}`, { method: 'DELETE', headers: { 'x-test-owner': other } });
    expect(wrong.status).toBe(200); expect((await fixture.db.select().from(mobileInstallations))[0].disabledAt).toBeNull();
    for (let i = 0; i < 2; i++) expect((await routeFetch(`${url}/installations/${registration.installationId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await fixture.db.select().from(mobileInstallations))[0].disabledAt).not.toBeNull();
  });
  it.each([
    ['POST', '/installations'], ['PATCH', '/installations/00000000-0000-4000-8000-000000000001'],
    ['DELETE', '/installations/00000000-0000-4000-8000-000000000001'], ['PUT', '/notification-preferences'],
    ['GET', '/notification-preferences'],
  ])('requires authentication for %s %s', async (method, path) => {
    expect((await routeFetch(`${url}${path}`, { method, headers: { 'x-test-unauthenticated': 'true' } })).status).toBe(401);
  });
  it('authorizes preference reads, writes, and heartbeats at the route', async () => {
    const registration = input(); await registerMobileInstallation(owner, registration);
    const preference = { ...defaultMobileNotificationPreferences(workspaceId), enabled: true };
    const saved = await routeFetch(`${url}/notification-preferences`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preference) });
    expect(saved.status).toBe(200);
    const read = await routeFetch(`${url}/notification-preferences?workspaceId=${workspaceId}`); expect((await read.json()).data.preferences).toEqual(preference);
    const denied = { 'Content-Type': 'application/json', 'x-test-owner': other };
    expect((await routeFetch(`${url}/notification-preferences?workspaceId=${workspaceId}`, { headers: denied })).status).toBe(404);
    expect((await routeFetch(`${url}/notification-preferences`, { method: 'PUT', headers: denied, body: JSON.stringify(preference) })).status).toBe(404);
    expect((await routeFetch(`${url}/installations/${registration.installationId}`, { method: 'PATCH', headers: denied,
      body: JSON.stringify({ schemaVersion: 1, workspaceId: otherWorkspace, appVersion: '2', locale: 'en', timezone: 'UTC' }) })).status).toBe(404);
  });
  it('rate limits preference writes', async () => {
    const preference = defaultMobileNotificationPreferences(workspaceId);
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const response = await routeFetch(`${url}/notification-preferences`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-owner': other }, body: JSON.stringify({ ...preference, workspaceId: otherWorkspace }) });
      last = response.status;
    }
    expect(last).toBe(429);
    expect(await fixture.db.select().from(mobileNotificationPreferences).where(and(eq(mobileNotificationPreferences.ownerId, owner), eq(mobileNotificationPreferences.workspaceId, otherWorkspace)))).toHaveLength(0);
  });
});
