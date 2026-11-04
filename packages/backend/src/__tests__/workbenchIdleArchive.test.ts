import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { normaliseAutoArchiveIdleDays } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeFleet } from './helpers/fakeFleet.js';
import {
  mergeQueueEntries, pullRequests, repositories, workbenchChats, workbenchScriptRuns, workbenches, workspaces,
} from '../db/schema.js';
import { tryWithAdvisoryLock } from '../services/advisoryLock.js';
import { idleArchiveTick, sweepIdleSessions } from '../services/workbenches/idleArchive.js';
import { restoreWorkbench, settleArchivesForTests } from '../services/workbenches/lifecycle.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import { getWorkbench, insertChat, insertWorkbench, listEvents, touchWorkbenchActivity } from '../services/workbenches/store.js';

vi.mock('../services/websocket.js', async (original) => ({
  ...await original<typeof import('../services/websocket.js')>(), broadcastToWorkspace: vi.fn(),
}));
vi.mock('../services/workbenches/agentBackups.js', async (original) => ({
  ...await original<typeof import('../services/workbenches/agentBackups.js')>(), scheduleAgentBackup: vi.fn(),
}));

const lock = vi.hoisted(() => ({ acquired: true }));
vi.mock('../services/advisoryLock.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/advisoryLock.js')>(),
  tryWithAdvisoryLock: vi.fn(async (_db: unknown, _name: string, fn: () => Promise<unknown>) =>
    lock.acquired ? { acquired: true, result: await fn() } : { acquired: false }),
}));

const DAY = 86_400_000;
const now = new Date();
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('archive idle sessions', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;

  /** A ready session whose every timestamp is `idleMs` old, unless a test moves one. */
  async function seed(id: string, idleMs = 8 * DAY, extra: Partial<typeof workbenches.$inferInsert> = {}) {
    await insertWorkbench({
      id, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'acme/widget', name: id,
      branch: `b-${id}`, baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      sandboxId: `box-${id}`, sandboxState: 'running', createdAt: ago(idleMs), ...extra,
    });
    await insertChat({ id: `chat-${id}`, workbenchId: id, workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    await setChat(id, { updatedAt: ago(idleMs), turnStartedAt: ago(idleMs) });
  }
  const setChat = (id: string, set: Partial<typeof workbenchChats.$inferInsert>) =>
    testDb.db.update(workbenchChats).set(set).where(eq(workbenchChats.id, `chat-${id}`));
  const setWb = (id: string, set: Partial<typeof workbenches.$inferInsert>) =>
    testDb.db.update(workbenches).set(set).where(eq(workbenches.id, id));
  const setSettings = (settings: Record<string, unknown>) =>
    testDb.db.update(workspaces).set({ settings }).where(eq(workspaces.id, 'ws'));
  const row = async (id: string) => (await getWorkbench(id))!;
  const activityAt = async (id: string) => (await testDb.db.select({ at: workbenches.lastActivityAt })
    .from(workbenches).where(eq(workbenches.id, id)))[0].at;

  beforeEach(async () => {
    lock.acquired = true;
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Workspace' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'acme/widget', url: 'https://github.com/acme/widget' });
    fleet = new FakeFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
  });

  afterEach(async () => {
    await settleArchivesForTests();
    setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  it('archives an idle session through the normal archive path and says why', async () => {
    await seed('wb');
    expect(await sweepIdleSessions(now)).toEqual(['wb']);
    await settleArchivesForTests();
    const archived = await row('wb');
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.settings).toMatchObject({ autoArchivedReason: 'idle' });
    expect(fleet.deleted).toEqual(['box-wb']);
    const events = (await listEvents('chat-wb', 0, 100)).events.filter((e) => e.event.subtype === 'idle_archive');
    expect(events).toHaveLength(1);
    expect(events[0].event).toMatchObject({ type: 'system', text: 'Archived after 7 days with no activity.' });
  });

  it.each([
    ['one minute inside the window', 7 * DAY - 60_000, false],
    ['one minute past the window', 7 * DAY + 60_000, true],
  ])('window boundary: %s', async (_name, idleMs, archives) => {
    await seed('wb', idleMs);
    expect(await sweepIdleSessions(now)).toEqual(archives ? ['wb'] : []);
  });

  it.each([
    ['unset uses 7 days, 6d idle', undefined, 6 * DAY, false],
    ['unset uses 7 days, 8d idle', undefined, 8 * DAY, true],
    ['custom 3 days, 4d idle', 3, 4 * DAY, true],
    ['custom 3 days, 2d idle', 3, 2 * DAY, false],
    ['custom 30 days, 10d idle', 30, 10 * DAY, false],
    ['0 is off', 0, 400 * DAY, false],
    ['null is off', null, 400 * DAY, false],
    ['junk is off', 'soon', 400 * DAY, false],
  ])('workspace setting: %s', async (_name, days, idleMs, archives) => {
    await setSettings(days === undefined ? {} : { autoArchiveIdleDays: days });
    await seed('wb', idleMs as number);
    expect(await sweepIdleSessions(now)).toEqual(archives ? ['wb'] : []);
  });

  it('names the custom window in the note', async () => {
    await setSettings({ autoArchiveIdleDays: 1 });
    await seed('wb', 2 * DAY);
    await sweepIdleSessions(now);
    const [note] = (await listEvents('chat-wb', 0, 100)).events.filter((e) => e.event.subtype === 'idle_archive');
    expect(note.event.text).toBe('Archived after 1 day with no activity.');
  });

  describe('never archives', () => {
    const cases: Array<[string, (id: string) => Promise<unknown> | unknown]> = [
      ['a thread', (id) => setWb(id, { kind: 'thread' })],
      ['an already archived session', (id) => setWb(id, { archivedAt: ago(DAY), status: 'archived' })],
      ['a provisioning session', (id) => setWb(id, { status: 'provisioning' })],
      ['a moving session', (id) => setWb(id, { status: 'moving' })],
      ['a session whose archive failed', (id) => setWb(id, { status: 'archiveError', archivedAt: ago(DAY) })],
      ['a local session', (id) => setWb(id, { runtime: 'local' })],
      ['a session with a restore requested', (id) => setWb(id, { restoreRequestedAt: ago(DAY) })],
      ['a session with a resize waiting', (id) => setWb(id, { settings: { resizeTo: 'large' } as never })],
      ['a session asked to archive after its turn', (id) => setWb(id, { settings: { archiveAfterTurn: 'x' } as never })],
      ['a running turn', (id) => setChat(id, { status: 'running' })],
      ['a queued message', (id) => setChat(id, { queuedMessages: [{ id: 'm', text: 'hi', queuedAt: now.toISOString() }] })],
      ['a pending queue drain', (id) => setChat(id, { drainPending: true })],
      ['a chat that spoke recently', (id) => setChat(id, { updatedAt: ago(DAY) })],
      ['a turn that started recently', (id) => setChat(id, { turnStartedAt: ago(DAY) })],
      ['recent terminal input or a restore', (id) => setWb(id, { lastActivityAt: ago(DAY) })],
      ['a running script', (id) => testDb.db.insert(workbenchScriptRuns).values({
        id: `${id}:run`, workbenchId: id, workspaceId: 'ws', sandboxId: `box-${id}`, name: 'run',
        generation: 'g', owner: 'o', running: true,
      })],
    ];
    it.each(cases)('%s', async (_name, arrange) => {
      await seed('wb');
      await arrange('wb');
      expect(await sweepIdleSessions(now)).toEqual([]);
      const after = await row('wb');
      expect(after.settings).not.toMatchObject({ autoArchivedReason: 'idle' });
      expect(fleet.deleted).toEqual([]);
    });

    const prCases: Array<[string, Partial<typeof pullRequests.$inferInsert>, 'queued' | 'merged' | 'removed' | null]> = [
      ['a PR flagged merge-queued', { mergeQueued: true }, null],
      ['a PR with an active queue entry', {}, 'queued'],
      ['a PR kept green by auto-keep', { autoKeepMergeable: true }, null],
    ];
    it.each(prCases)('%s', async (_name, prValues, entry) => {
      await seed('wb');
      await testDb.db.insert(pullRequests).values({ id: 'pr', workspaceId: 'ws', repositoryId: 'repo', owner: 'acme', repo: 'widget', number: 1, state: 'open', ...prValues });
      if (entry) await testDb.db.insert(mergeQueueEntries).values({ id: 'e', pullRequestId: 'pr', workspaceId: 'ws', repositoryId: 'repo', status: entry });
      await setWb('wb', { pullRequestId: 'pr' });
      expect(await sweepIdleSessions(now)).toEqual([]);
    });
  });

  describe('still archives', () => {
    it.each([
      ['an open PR outside the queue', null],
      ['a PR whose queue entry merged', 'merged'],
      ['a PR whose queue entry was removed', 'removed'],
    ] as const)('%s', async (_name, entry) => {
      await seed('wb');
      await testDb.db.insert(pullRequests).values({ id: 'pr', workspaceId: 'ws', repositoryId: 'repo', owner: 'acme', repo: 'widget', number: 1, state: 'open' });
      if (entry) await testDb.db.insert(mergeQueueEntries).values({ id: 'e', pullRequestId: 'pr', workspaceId: 'ws', repositoryId: 'repo', status: entry });
      await setWb('wb', { pullRequestId: 'pr' });
      expect(await sweepIdleSessions(now)).toEqual(['wb']);
    });

    it('a session whose updated_at is fresh from background writes', async () => {
      await seed('wb');
      await setWb('wb', { updatedAt: now });
      expect(await sweepIdleSessions(now)).toEqual(['wb']);
    });

    it('a session in error', async () => {
      await seed('wb', 8 * DAY, { status: 'error' });
      expect(await sweepIdleSessions(now)).toEqual(['wb']);
    });
  });

  it('a restore resets the clock, so the next pass leaves the session alone', async () => {
    await seed('wb');
    await sweepIdleSessions(now);
    await settleArchivesForTests();
    await restoreWorkbench('wb');
    await settleArchivesForTests();
    const restored = await row('wb');
    expect(restored.archivedAt).toBeNull();
    expect((await activityAt('wb'))!.getTime()).toBeGreaterThan(now.getTime() - 60_000);
    expect(await sweepIdleSessions(new Date())).toEqual([]);
    await setWb('wb', { status: 'ready' });
    expect(await sweepIdleSessions(new Date(Date.now() + 8 * DAY))).toEqual(['wb']);
  });

  it('a later manual archive does not wear the idle reason', async () => {
    await seed('wb');
    await sweepIdleSessions(now);
    await settleArchivesForTests();
    await restoreWorkbench('wb');
    await settleArchivesForTests();
    const { archiveWorkbench } = await import('../services/workbenches/lifecycle.js');
    const manual = await archiveWorkbench('wb');
    expect(manual.settings).not.toMatchObject({ autoArchivedReason: 'idle' });
  });

  it('two sweeps at once archive a session once', async () => {
    await seed('wb');
    const results = await Promise.all([sweepIdleSessions(now), sweepIdleSessions(now)]);
    await settleArchivesForTests();
    expect(results.flat()).toEqual(['wb']);
    expect(fleet.deleted).toEqual(['box-wb']);
    expect((await listEvents('chat-wb', 0, 100)).events.filter((e) => e.event.subtype === 'idle_archive')).toHaveLength(1);
  });

  it('the tick takes the advisory try-lock and does nothing without it', async () => {
    await seed('wb');
    lock.acquired = false;
    expect(await idleArchiveTick(now)).toEqual([]);
    expect((await row('wb')).archivedAt).toBeNull();
    lock.acquired = true;
    expect(await idleArchiveTick(now)).toEqual(['wb']);
    expect(vi.mocked(tryWithAdvisoryLock)).toHaveBeenCalledWith(expect.anything(), 'workbench-idle-archive', expect.any(Function));
  });

  it('a session that wakes between the pick and the claim is left alone', async () => {
    await seed('wb');
    const { markArchive } = await import('../services/workbenches/store.js');
    const { idleArchiveGuard } = await import('../services/workbenches/idleArchive.js');
    await setChat('wb', { status: 'running' });
    expect(await markArchive('wb', false, { guard: idleArchiveGuard(now), days: 7 })).toBeNull();
    expect((await row('wb')).archivedAt).toBeNull();
  });

  it('archives at most the pass limit, oldest first', async () => {
    await seed('a', 10 * DAY);
    await seed('b', 12 * DAY);
    await seed('c', 9 * DAY);
    expect(await sweepIdleSessions(now, 2)).toEqual(['b', 'a']);
    expect(await sweepIdleSessions(now, 2)).toEqual(['c']);
  });

  it('touchWorkbenchActivity records the time, and a burst is one write', async () => {
    await seed('wb');
    touchWorkbenchActivity('wb', true);
    await vi.waitFor(async () => expect(await activityAt('wb')).not.toBeNull());
    const first = (await activityAt('wb'))!;
    await setWb('wb', { lastActivityAt: null });
    touchWorkbenchActivity('wb');
    await new Promise((r) => setTimeout(r, 50));
    expect(await activityAt('wb')).toBeNull();
    expect(first.getTime()).toBeGreaterThan(now.getTime() - 60_000);
  });
});

describe('normaliseAutoArchiveIdleDays', () => {
  it.each([[1, 1], [7, 7], [365, 365], [0, null], [null, null]])('accepts %s', (input, value) => {
    expect(normaliseAutoArchiveIdleDays(input)).toEqual({ ok: true, value });
  });
  it.each([[-1], [1.5], [366], ['7'], [undefined], [NaN], [true]])('refuses %s', (input) => {
    expect(normaliseAutoArchiveIdleDays(input).ok).toBe(false);
  });
});
