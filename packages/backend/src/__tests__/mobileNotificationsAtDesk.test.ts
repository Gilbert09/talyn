import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  defaultMobileNotificationPreferences, normalizeMobileNotificationPreferences,
  type MobileNotificationPreferencesInput,
} from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { mobileNotificationOutbox as outbox, mobileNotificationPreferences, users, workbenches, workspaces } from '../db/schema.js';
import { enqueueMobileNotification, readMobilePreferences, registerMobileInstallation,
  saveMobilePreferences } from '../services/mobileNotifications/store.js';
import { dispatchMobileNotifications, mobileNotificationMetrics } from '../services/mobileNotifications/worker.js';
import { preferencesInput } from '../services/mobileNotifications/validation.js';
import { deskPresence } from '../services/deskPresence.js';

const owner = '00000000-0000-4000-8000-000000000011';
const other = '00000000-0000-4000-8000-000000000012';
const workspaceId = '00000000-0000-4000-8000-000000000013';
const otherWorkspace = '00000000-0000-4000-8000-000000000014';
const entityId = '00000000-0000-4000-8000-000000000015';
const otherEntity = '00000000-0000-4000-8000-000000000016';
let fixture: Awaited<ReturnType<typeof createTestDb>>;

/** What an app build from before `onlyWhenAway` sends. */
function legacy(overrides: Partial<MobileNotificationPreferencesInput> = {}): MobileNotificationPreferencesInput {
  const { onlyWhenAway: _dropped, ...rest } = defaultMobileNotificationPreferences(workspaceId);
  return { ...rest, ...overrides };
}

async function enqueue(ownerId = owner, workspace = workspaceId, entity = entityId) {
  const eventId = randomUUID();
  await enqueueMobileNotification({ ownerId, workspaceId: workspace, destination: { kind: 'session', workspaceId: workspace, entityId: entity },
    category: 'session_update', eventId, deduplicationKey: eventId });
}

async function register(ownerId = owner, workspace = workspaceId) {
  await registerMobileInstallation(ownerId, { schemaVersion: 1, installationId: randomUUID(), workspaceId: workspace, provider: 'expo',
    token: `ExpoPushToken[synthetic_${randomUUID().replaceAll('-', '')}]`, platform: 'ios', environment: 'preview',
    appIdentity: 'dev.talyn.mobile.preview', appVersion: '1', locale: 'en-GB', timezone: 'UTC' });
}

function provider() {
  return { send: vi.fn(async (messages: unknown[]) => messages.map(() => ({ status: 'ok' as const, ticketId: randomUUID() }))), receipts: async () => [] };
}

beforeAll(async () => {
  vi.stubEnv('TALYN_ALLOWED_EMAILS', '');
  vi.stubEnv('TALYN_TOKEN_KEY', 'synthetic-unit-test-key');
  vi.stubEnv('TALYN_MOBILE_PUSH_ENABLED', 'true');
  vi.stubEnv('TALYN_MOBILE_PUSH_APP_IDENTITIES', 'dev.talyn.mobile.preview@preview');
  fixture = await createTestDb();
});
beforeEach(async () => {
  await fixture.db.delete(users);
  await seedUser(fixture.db, { id: owner }); await seedUser(fixture.db, { id: other });
  await fixture.db.insert(workspaces).values([{ id: workspaceId, ownerId: owner, name: 'Fixture' }, { id: otherWorkspace, ownerId: other, name: 'Fixture' }]);
  const session = { kind: 'session' as const, repoFullName: '', branch: 'b', baseBranch: 'main', name: 'Fixture', runtime: 'sandbox' as const, agent: 'claude' as const, status: 'ready' as const };
  await fixture.db.insert(workbenches).values([{ id: entityId, workspaceId, ...session }, { id: otherEntity, workspaceId: otherWorkspace, ...session }]);
});
afterEach(async () => {
  for (const id of [owner, other]) for (const socket of ['desktop', 'web']) await deskPresence.forget(id, socket);
  vi.useRealTimers();
});
afterAll(async () => { await fixture.cleanup(); vi.unstubAllEnvs(); });

describe('onlyWhenAway preference', () => {
  it.each([
    ['missing with nothing stored', undefined, undefined, true],
    ['missing keeps a stored false', undefined, false, false],
    ['missing keeps a stored true', undefined, true, true],
    ['explicit false', false, undefined, false],
    ['explicit true over a stored false', true, false, true],
    ['explicit false over a stored true', false, true, false],
  ] as const)('normalizes %s', (_name, sent, stored, expected) => {
    const input = sent === undefined ? legacy() : { ...legacy(), onlyWhenAway: sent };
    expect(normalizeMobileNotificationPreferences(input, stored === undefined ? undefined : { onlyWhenAway: stored }).onlyWhenAway).toBe(expected);
  });

  it('defaults to on', () => {
    expect(defaultMobileNotificationPreferences(workspaceId).onlyWhenAway).toBe(true);
  });

  it.each([[true, true], [false, true], [undefined, true], ['yes', false], [1, false]])('validates onlyWhenAway %j', (value, ok) => {
    const body: Record<string, unknown> = { ...legacy() };
    if (value !== undefined) body.onlyWhenAway = value;
    expect(preferencesInput.safeParse(body).success).toBe(ok);
  });

  it('reads a row saved before the field existed as on', async () => {
    await fixture.db.insert(mobileNotificationPreferences).values({ ownerId: owner, workspaceId, preferences: legacy({ enabled: true }) });
    expect((await readMobilePreferences(owner, workspaceId)).preferences).toMatchObject({ enabled: true, onlyWhenAway: true });
  });

  it('keeps a stored false when an older app saves without the field', async () => {
    await saveMobilePreferences(owner, { ...defaultMobileNotificationPreferences(workspaceId), onlyWhenAway: false });
    const result = await saveMobilePreferences(owner, legacy({ enabled: true }));
    expect(result.preferences).toMatchObject({ enabled: true, onlyWhenAway: false });
    expect((await readMobilePreferences(owner, workspaceId)).preferences).toMatchObject({ enabled: true, onlyWhenAway: false });
  });

  it('stores true when the first save has no field', async () => {
    expect((await saveMobilePreferences(owner, legacy())).preferences.onlyWhenAway).toBe(true);
    const [row] = await fixture.db.select().from(mobileNotificationPreferences);
    expect(row.preferences.onlyWhenAway).toBe(true);
  });
});

describe('away-only delivery', () => {
  async function setup(onlyWhenAway: boolean | undefined) {
    await register();
    if (onlyWhenAway === undefined) {
      await fixture.db.insert(mobileNotificationPreferences).values({ ownerId: owner, workspaceId, preferences: legacy({ enabled: true }) });
    } else {
      await saveMobilePreferences(owner, { ...defaultMobileNotificationPreferences(workspaceId), enabled: true, onlyWhenAway });
    }
    await enqueue();
  }

  it.each([['on', true], ['absent from an old row', undefined]] as const)('cancels as at_desk while at the desk with the preference %s', async (_name, value) => {
    await setup(value);
    await deskPresence.report(owner, 'desktop', true);
    const before = mobileNotificationMetrics.atDesk;
    const push = provider();
    await dispatchMobileNotifications(push);
    expect(push.send).not.toHaveBeenCalled();
    const [row] = await fixture.db.select().from(outbox);
    expect(row).toMatchObject({ state: 'cancelled', lastErrorClass: 'at_desk' });
    expect(mobileNotificationMetrics.atDesk).toBe(before + 1);
  });

  it('sends while at the desk when the preference is off', async () => {
    await setup(false);
    await deskPresence.report(owner, 'desktop', true);
    const push = provider();
    await dispatchMobileNotifications(push);
    expect(push.send).toHaveBeenCalledOnce();
    expect((await fixture.db.select().from(outbox))[0].state).toBe('ticketed');
  });

  it.each(['never reported', 'reported away', 'expired'] as const)('sends when the desk presence is %s', async (how) => {
    await setup(true);
    if (how === 'reported away') {
      await deskPresence.report(owner, 'desktop', true);
      await deskPresence.report(owner, 'desktop', false);
    }
    if (how === 'expired') {
      vi.useFakeTimers({ toFake: ['Date'] });
      await deskPresence.report(owner, 'desktop', true);
      vi.setSystemTime(Date.now() + 60_000);
    }
    const push = provider();
    await dispatchMobileNotifications(push, new Date());
    expect(push.send).toHaveBeenCalledOnce();
  });

  it('checks each owner on their own presence', async () => {
    await setup(true);
    await register(other, otherWorkspace);
    await saveMobilePreferences(other, { ...defaultMobileNotificationPreferences(otherWorkspace), enabled: true });
    await enqueue(other, otherWorkspace, otherEntity);
    await deskPresence.report(owner, 'desktop', true);
    const push = provider();
    await dispatchMobileNotifications(push);
    expect(push.send).toHaveBeenCalledOnce();
    const rows = await fixture.db.select().from(outbox);
    expect(rows.find((row) => row.ownerId === owner)).toMatchObject({ state: 'cancelled', lastErrorClass: 'at_desk' });
    expect(rows.find((row) => row.ownerId === other)?.state).toBe('ticketed');
  });

  it('looks up presence once per owner in a batch', async () => {
    await setup(true);
    await enqueue(); await enqueue();
    const lookup = vi.spyOn(deskPresence, 'inspect');
    await dispatchMobileNotifications(provider());
    expect(lookup).toHaveBeenCalledTimes(1);
    lookup.mockRestore();
  });

  it('sends when the presence store fails', async () => {
    await setup(true);
    const lookup = vi.spyOn(deskPresence, 'inspect').mockRejectedValue(new Error('redis down'));
    const push = provider();
    await dispatchMobileNotifications(push);
    expect(push.send).toHaveBeenCalledOnce();
    lookup.mockRestore();
  });

  it('does not look up presence for a push the preferences already cancel', async () => {
    await register();
    await saveMobilePreferences(owner, defaultMobileNotificationPreferences(workspaceId));
    await enqueue();
    const lookup = vi.spyOn(deskPresence, 'inspect');
    await dispatchMobileNotifications(provider());
    expect(lookup).not.toHaveBeenCalled();
    expect((await fixture.db.select().from(outbox).where(eq(outbox.ownerId, owner)))[0].lastErrorClass).toBe('preferences_disabled');
    lookup.mockRestore();
  });
});
