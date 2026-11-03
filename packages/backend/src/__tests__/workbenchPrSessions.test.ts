import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { pullRequests, repositories, workbenchChats, workbenches, workspaces } from '../db/schema.js';
import {
  classifySessionActivity,
  liveSessionActivityForPr,
  liveWorkbenchesForPrs,
  liveWorkbenchesForPrsQuery,
  liveWorkbenchForPr,
  sessionActivity,
  sessionActivityQuery,
} from '../services/workbenches/prSessions.js';

describe('live session lookup for pull requests', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  const wb = (id: string, name: string, pullRequestId: string | null, extra: object = {}) => ({
    id, workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name,
    branch: name, baseBranch: 'main', runtime: 'local', agent: 'claude', status: 'ready', pullRequestId, ...extra,
  });

  beforeEach(async () => {
    testDb = await createTestDb();
    const { db } = testDb;
    await seedUser(db, { id: 'owner-a' });
    await db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-a', name: 'B' },
    ]);
    await db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    await db.insert(pullRequests).values(
      [1, 2, 3].map((n) => ({
        id: `p${n}`, workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number: n, state: 'open', lastSummary: {},
      })),
    );
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it('selects three columns plus the key, never a whole row', () => {
    const sqlText = liveWorkbenchesForPrsQuery(['ws-a'], ['p1']).toSQL().sql;
    expect(sqlText).not.toMatch(/select \*/i);
    for (const col of ['settings', 'diff_stat', 'status_message', 'local_path']) expect(sqlText).not.toContain(col);
    expect(sqlText).toContain('"archived_at" is null');
  });

  it('maps each PR to its live session and skips archived ones', async () => {
    await testDb.db.insert(workbenches).values([
      wb('w1', 'paris', 'p1'),
      wb('w2', 'rome', 'p2', { archivedAt: new Date(), status: 'archived' }),
      wb('w3', 'oslo', null),
    ]);
    const map = await liveWorkbenchesForPrs('ws-a', ['p1', 'p2', 'p3']);
    expect([...map.entries()]).toEqual([['p1', { id: 'w1', name: 'paris', status: 'ready' }]]);
  });

  it('answers an empty map for no ids or no workspaces', async () => {
    expect((await liveWorkbenchesForPrs('ws-a', [])).size).toBe(0);
    expect((await liveWorkbenchesForPrs([], ['p1'])).size).toBe(0);
  });

  it('does not cross workspaces', async () => {
    await testDb.db.insert(workbenches).values(wb('w1', 'paris', 'p1'));
    expect((await liveWorkbenchesForPrs('ws-b', ['p1'])).size).toBe(0);
    expect((await liveWorkbenchesForPrs(['ws-a', 'ws-b'], ['p1'])).size).toBe(1);
  });

  it('prefers the most recently updated session when two share a PR', async () => {
    await testDb.db.insert(workbenches).values([
      wb('w1', 'paris', 'p1', { updatedAt: new Date(1000) }),
      wb('w2', 'rome', 'p1', { updatedAt: new Date(2000) }),
    ]);
    expect((await liveWorkbenchForPr('ws-a', 'p1'))?.id).toBe('w2');
    expect(await liveWorkbenchForPr('ws-a', 'p2')).toBeNull();
  });
});

// "Working" must mean working (Tom, 2026-11-03): a ready session whose chats
// are idle does not hold the merge queue back.
describe('what a live session does on its pull request now', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  const wb = (extra: object = {}) => ({
    id: 'w1', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: 'paris',
    branch: 'paris', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready', pullRequestId: 'p1',
    ...extra,
  });
  const chat = (id: string, extra: object = {}) => ({
    id, workbenchId: 'w1', workspaceId: 'ws-a', title: 'Chat', agent: 'claude', ...extra,
  });
  const queued = (extra: object = {}) => [{ id: 'm1', text: 'next', queuedAt: '2026-11-03T00:00:00Z', ...extra }];

  beforeEach(async () => {
    testDb = await createTestDb();
    const { db } = testDb;
    await seedUser(db, { id: 'owner-a' });
    await db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await db.insert(repositories).values({ id: 'repo-a', workspaceId: 'ws-a', name: 'o/r', url: 'https://github.com/o/r' });
    await db.insert(pullRequests).values({
      id: 'p1', workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'o', repo: 'r', number: 1, state: 'open', lastSummary: {},
    });
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  it.each([
    ['ready, no chat work', { status: 'ready', runtime: 'sandbox', archived: false, chatBusy: false }, 'idle'],
    ['ready, a chat works', { status: 'ready', runtime: 'sandbox', archived: false, chatBusy: true }, 'working'],
    ['provisioning', { status: 'provisioning', runtime: 'sandbox', archived: false, chatBusy: false }, 'working'],
    ['moving', { status: 'moving', runtime: 'sandbox', archived: false, chatBusy: false }, 'working'],
    ['in error', { status: 'error', runtime: 'sandbox', archived: false, chatBusy: false }, 'unavailable'],
    ['in error with a busy chat', { status: 'error', runtime: 'sandbox', archived: false, chatBusy: true }, 'unavailable'],
    ['archive error', { status: 'archiveError', runtime: 'sandbox', archived: false, chatBusy: false }, 'unavailable'],
    ['archived', { status: 'ready', runtime: 'sandbox', archived: true, chatBusy: true }, 'unavailable'],
    ['local', { status: 'ready', runtime: 'local', archived: false, chatBusy: false }, 'local'],
    ['an unknown status', { status: 'something_new', runtime: 'sandbox', archived: false, chatBusy: false }, 'unavailable'],
  ])('classifies a session that is %s', (_label, input, expected) => {
    expect(classifySessionActivity(input)).toBe(expected);
  });

  it('derives the chat state in SQL and never ships the queue or a whole row', () => {
    const sqlText = sessionActivityQuery('w1').toSQL().sql;
    expect(sqlText).not.toMatch(/select \*/i);
    expect(sqlText).toContain('jsonb_array_length(c.queued_messages)');
    expect(sqlText).not.toMatch(/select[^(]*"queued_messages"/i);
    for (const col of ['settings', 'diff_stat', 'turn_parser', 'agent_backup']) expect(sqlText).not.toContain(col);
  });

  it.each([
    ['no chat at all', [], 'idle'],
    ['an idle chat', [chat('c1')], 'idle'],
    ['a chat that waits for input', [chat('c1', { status: 'awaiting_input' })], 'idle'],
    ['a running chat', [chat('c1', { status: 'running' })], 'working'],
    ['a chat with queued messages', [chat('c1', { queuedMessages: queued() })], 'working'],
    [
      'a message that waits for a sandbox',
      [chat('c1', { queuedMessages: queued({ capacityWait: { turn: 2, retryAt: '2099-01-01T00:00:00Z' } }) })],
      'working',
    ],
    ['one busy chat among idle ones', [chat('c1'), chat('c2', { status: 'running' })], 'working'],
  ])('reads a ready session with %s', async (_label, chats, expected) => {
    await testDb.db.insert(workbenches).values(wb());
    if (chats.length) await testDb.db.insert(workbenchChats).values(chats as never);
    expect((await sessionActivity('w1'))?.activity).toBe(expected);
  });

  it('reads the last chat activity, and null for a session that is gone', async () => {
    await testDb.db.insert(workbenches).values(wb());
    await testDb.db.insert(workbenchChats).values(chat('c1', { updatedAt: new Date('2026-11-03T16:46:00Z') }) as never);
    expect((await sessionActivity('w1'))?.lastActivityAt).toBe('2026-11-03T16:46:00.000Z');
    expect(await sessionActivity('nope')).toBeNull();
  });

  it('gives the queue the live session with its activity', async () => {
    await testDb.db.insert(workbenches).values(wb());
    await testDb.db.insert(workbenchChats).values(chat('c1', { status: 'running' }) as never);
    expect(await liveSessionActivityForPr('ws-a', 'p1')).toEqual({
      id: 'w1', name: 'paris', status: 'ready', activity: 'working',
    });
    expect(await liveSessionActivityForPr('ws-a', 'p2')).toBeNull();
  });
});
