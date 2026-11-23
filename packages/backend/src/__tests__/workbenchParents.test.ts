import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { pullRequests, repositories, workbenches, workspaces } from '../db/schema.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { appendEvents, childSessions, getWorkbench, insertChat, insertWorkbench, listEvents, rowToWorkbench, updateChat, updateWorkbench } from '../services/workbenches/store.js';

vi.mock('../services/workbenches/turns.js', () => ({ sendMessage: vi.fn(async () => ({ queued: true })) }));
vi.mock('../services/workbenches/emit.js', () => ({ emitWorkbenchEvents: vi.fn() }));
const { sendMessage } = await import('../services/workbenches/turns.js');
const { notifyThread, notifyThreadsOfMergedPr } = await import('../services/workbenches/threads.js');

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  testDb = await createTestDb();
  await seedUser(testDb.db, { id: 'owner' });
  await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Test' });
  await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'acme/app', url: 'https://github.com/acme/app' });
  for (const id of ['parent', 'child', 'other']) {
    await insertWorkbench({ id, workspaceId: 'ws', repoFullName: 'acme/app', name: id, branch: id,
      baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      ...(id === 'child' ? { parentWorkbenchId: 'parent' } : {}),
    });
    await insertChat({ id: `${id}-chat`, workbenchId: id, workspaceId: 'ws', title: 'Chat', agent: 'claude', turnCount: 1 });
  }
  vi.stubEnv('SESSION_SUBAGENTS_ENABLED', '1');
  resetFeatureFlagsForTests();
});
afterEach(async () => { vi.clearAllMocks(); vi.unstubAllEnvs(); resetFeatureFlagsForTests(); await testDb.cleanup(); });
const cards = async () => (await listEvents('parent-chat', 0, 100)).events.map((entry) => entry.event);
const child = async () => (await getWorkbench('child'))!;

describe('parent notifications', () => {
  it.each(['session_finished', 'pr_opened', 'pr_merged'] as const)('adds a %s card without a wake by default', async (action) => {
    await notifyThread(await child(), action, { chatId: 'child-chat' });
    expect(await cards()).toEqual([expect.objectContaining({ type: 'talyn_thread', action, sessionId: 'child' })]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await childSessions('parent')).map((row) => row.id)).toEqual(['child']);
  });

  it('wakes once per child turn, including simultaneous notifications and later user messages', async () => {
    await updateWorkbench('child', { notifyParent: true });
    const row = await child();
    await Promise.all([notifyThread(row, 'session_finished'), notifyThread(row, 'session_finished')]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('parent-chat', { text: expect.stringContaining('Other child sessions') }, { origin: 'talyn' });
    await appendEvents('parent-chat', [{ turn: 2, event: { type: 'user', talyn: { kind: 'user_message' }, message: { content: 'Continue' } } }]);
    await notifyThread(row, 'session_finished');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await updateChat('child-chat', { turnCount: 2 });
    await updateWorkbench('child', { pushedHeadShas: ['new-head'] });
    await notifyThread(await child(), 'session_finished');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(rowToWorkbench(await child()).settings).not.toHaveProperty('parentWakeTurns');
  });

  it('claims the ended turn when the next child turn has already started', async () => {
    await updateWorkbench('child', { notifyParent: true });
    await updateChat('child-chat', { turnCount: 2, status: 'running' });
    await notifyThread(await child(), 'session_finished', { chatId: 'child-chat', turn: 1, status: 'idle' });
    expect(await child()).toMatchObject({ settings: { parentWakeTurns: { 'child-chat': 1 } } });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the progress guard and coalesces a waiting wake', async () => {
    await updateWorkbench('child', { notifyParent: true });
    await notifyThread(await child(), 'session_finished');
    await updateChat('child-chat', { turnCount: 2 });
    await notifyThread(await child(), 'session_finished');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(await cards()).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'paused' })]));
    await updateChat('parent-chat', { queuedMessages: [{ id: 'queued', text: 'Read children', queuedAt: new Date().toISOString(), origin: 'talyn' }] });
    await updateWorkbench('child', { pushedHeadShas: ['new-head'] });
    await notifyThread(await child(), 'session_finished');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['self', 'archived', 'flag'] as const)('does not notify for %s', async (guard) => {
    await updateWorkbench('child', { notifyParent: true });
    if (guard === 'self') await updateWorkbench('child', { parentWorkbenchId: 'child' });
    if (guard === 'archived') await updateWorkbench('parent', { archivedAt: new Date() });
    if (guard === 'flag') { vi.stubEnv('SESSION_SUBAGENTS_ENABLED', '0'); resetFeatureFlagsForTests(); }
    await notifyThread(await child(), 'session_finished');
    expect(await cards()).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('notifies both the parent and a separate thread without duplicate cards', async () => {
    await updateWorkbench('other', { kind: 'thread' });
    await updateWorkbench('child', { threadId: 'other' });
    await notifyThread(await child(), 'session_finished');
    expect(await cards()).toHaveLength(1);
    expect((await listEvents('other-chat', 0, 100)).events).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('other-chat', expect.anything(), { origin: 'talyn' });
  });

  it('sends a merged PR card once without waking a normal parent', async () => {
    await testDb.db.insert(pullRequests).values({ id: 'pr', workspaceId: 'ws', repositoryId: 'repo', owner: 'acme', repo: 'app', number: 1, state: 'merged', mergedAt: new Date(Date.now() + 1000) });
    await testDb.db.update(workbenches).set({ pullRequestId: 'pr', pullRequestLinkExplicit: true, pullRequestLinkedAt: new Date(), notifyParent: true }).where(eq(workbenches.id, 'child'));
    await notifyThreadsOfMergedPr('pr');
    await notifyThreadsOfMergedPr('pr');
    expect(await cards()).toEqual([expect.objectContaining({ action: 'pr_merged', prUrl: 'https://github.com/acme/app/pull/1' })]);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
