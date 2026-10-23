import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { pullRequests, repositories, workbenches, workspaces } from '../db/schema.js';
import {
  liveWorkbenchesForPrs,
  liveWorkbenchesForPrsQuery,
  liveWorkbenchForPr,
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
