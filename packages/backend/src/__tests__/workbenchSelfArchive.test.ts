import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repositories, workspaces } from '../db/schema.js';
import {
  archiveAfterTurnIfRequested,
  archiveIdleSession,
  requestArchiveAfterTurn,
  sweepMergeArchives,
} from '../services/workbenches/autoArchive.js';
import * as changes from '../services/workbenches/changes.js';
import { settleArchivesForTests } from '../services/workbenches/lifecycle.js';
import { setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import { claimOrEnqueue, getWorkbench, insertChat, insertWorkbench, markArchive, updateChat, updateWorkbench } from '../services/workbenches/store.js';
import { cancelTurn } from '../services/workbenches/turns.js';
import { FakeFleet } from './helpers/fakeFleet.js';
import { createTestDb, seedUser } from './helpers/testDb.js';

vi.mock('../services/websocket.js', async (original) => ({
  ...(await original<typeof import('../services/websocket.js')>()), broadcastToWorkspace: vi.fn(),
}));
vi.mock('../services/workbenches/agentBackups.js', async (original) => ({
  ...(await original<typeof import('../services/workbenches/agentBackups.js')>()), scheduleAgentBackup: vi.fn(),
}));

const BOX = 'talyn-wb-self';
const message = (id: string) => ({ id, text: id, queuedAt: '2999-01-01T00:00:00.000Z' });

describe('a session archiving itself', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  const row = async () => (await getWorkbench('wb'))!;
  const settings = async () => (await row()).settings as Record<string, unknown>;

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'a/b', url: 'https://github.com/a/b' });
    await insertWorkbench({ id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'a/b', name: 'self',
      branch: 'self', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      sandboxState: 'running', sandboxId: BOX, settings: { autoCreatePr: false } });
    await insertChat({ id: 'chat', workbenchId: 'wb', workspaceId: 'ws', title: 'Chat', agent: 'claude' });
    fleet = new FakeFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    vi.spyOn(changes, 'refreshDiffStat').mockImplementation(async (wb) => wb);
  });

  afterEach(async () => {
    await settleArchivesForTests();
    setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  it('waits for the running turn, then archives when it ends', async () => {
    await updateChat('chat', { status: 'running', turnCount: 1 });
    expect(await requestArchiveAfterTurn('wb')).toBe('deferred');
    expect((await row()).archivedAt).toBeNull();
    expect(await settings()).toMatchObject({ archiveAfterTurn: expect.any(String) });
    // Nothing was cancelled or deleted while the turn ran.
    await settleArchivesForTests();
    expect(fleet.deleted).toEqual([]);

    // The turn-end hook in turns.ts (here: a cancel settled by this process).
    await cancelTurn('chat');
    expect((await row()).archivedAt).toBeInstanceOf(Date);
    expect(await settings()).not.toHaveProperty('archiveAfterTurn');
    await settleArchivesForTests();
    expect(fleet.deleted).toEqual([BOX]);
  });

  it('starts no new turn while the archive waits', async () => {
    await updateChat('chat', { status: 'running', turnCount: 1 });
    await requestArchiveAfterTurn('wb');
    await updateChat('chat', { status: 'idle' });
    const claim = await claimOrEnqueue('chat', message('later'), true);
    expect(claim?.started).toBeNull();
    expect(claim?.chat.queuedMessages).toHaveLength(1);
  });

  it('keeps waiting while another chat of the session is running', async () => {
    await insertChat({ id: 'other', workbenchId: 'wb', workspaceId: 'ws', title: 'Other', agent: 'claude' });
    await updateChat('chat', { status: 'running' });
    await updateChat('other', { status: 'running' });
    await requestArchiveAfterTurn('wb');
    await updateChat('chat', { status: 'idle' });
    await archiveIdleSession('wb');
    expect((await row()).archivedAt).toBeNull();
    await updateChat('other', { status: 'idle' });
    await archiveIdleSession('wb');
    expect((await row()).archivedAt).toBeInstanceOf(Date);
  });

  it('archives at once when no turn is running', async () => {
    expect(await requestArchiveAfterTurn('wb')).toBe('archived');
    expect((await row()).archivedAt).toBeInstanceOf(Date);
  });

  it('answers null for an archived session', async () => {
    await markArchive('wb');
    expect(await requestArchiveAfterTurn('wb')).toBeNull();
  });

  it('does nothing for a session that did not ask', async () => {
    expect(await archiveAfterTurnIfRequested('wb')).toBe(false);
    await archiveIdleSession('wb');
    expect((await row()).archivedAt).toBeNull();
  });

  it('recovers a request a crash left behind through the sweep', async () => {
    await updateChat('chat', { status: 'running' });
    await requestArchiveAfterTurn('wb');
    // The process died at the end of the turn, before the hook ran.
    await updateChat('chat', { status: 'idle' });
    await sweepMergeArchives();
    expect((await row()).archivedAt).toBeInstanceOf(Date);
  });

  it('does not archive again after a restore', async () => {
    await updateChat('chat', { status: 'running', turnCount: 1 });
    await requestArchiveAfterTurn('wb');
    await cancelTurn('chat');
    await settleArchivesForTests();
    // What a restore leaves: the session live again, its settings as the archive left them.
    await updateWorkbench('wb', { archivedAt: null, archivePendingAt: null, status: 'ready', sandboxState: 'running' });
    await archiveIdleSession('wb');
    expect((await row()).archivedAt).toBeNull();
  });
});
