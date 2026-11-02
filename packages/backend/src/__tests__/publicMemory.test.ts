import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiScope } from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { callPublic, mintToken, startPublicApi, type Loose } from './helpers/publicApi.js';
import { repositories, workbenches, workspaceMemories, workspaces } from '../db/schema.js';
import { listMemoriesPageQuery } from '../services/public/workQueries.js';

const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

/**
 * `/v1/memories` end to end: the public shape, paging, filters, the upsert by
 * name, forget and restore, the scope rules and the 404 for another owner's
 * entry. The service is the app's own (`services/workbenches/memory.ts`).
 */

const SCOPES: ApiScope[] = ['memory:write'];

describe('/v1 memories', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let api: Awaited<ReturnType<typeof startPublicApi>>;
  let token: string;

  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>, as = token) =>
    callPublic(api.base, method, path, { token: as, body, headers });

  const entry = (extra: Record<string, unknown> = {}) => ({
    workspace_id: 'ws-a',
    scope: 'workspace',
    type: 'project',
    name: 'test-command',
    description: 'How to run the tests',
    body: 'Run `npm test` in packages/backend.',
    ...extra,
  });

  beforeEach(async () => {
    vi.stubEnv('PUBLIC_API_ENABLED', 'true');
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-a2', ownerId: 'owner-a', name: 'A2' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main' },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'other/app', url: 'https://github.com/other/app', defaultBranch: 'main' },
    ]);
    token = await mintToken('owner-a', { scopes: SCOPES });
    api = await startPublicApi();
  });

  afterEach(async () => {
    await api.close();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  describe('creating', () => {
    it('answers 201 in the public shape', async () => {
      const res = await call('POST', '/memories', entry());
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        object: 'memory',
        id: expect.any(String),
        workspace_id: 'ws-a',
        scope: 'workspace',
        repository_id: null,
        thread_id: null,
        type: 'project',
        name: 'test-command',
        description: 'How to run the tests',
        body: 'Run `npm test` in packages/backend.',
        bytes: 35,
        source: { kind: 'user', session_id: null },
        forgotten_at: null,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
      const [row] = await testDb.db.select({ ownerId: workspaceMemories.ownerId }).from(workspaceMemories);
      expect(row.ownerId).toBe('owner-a');
    });

    it('updates the live entry with the same name (any case) and answers 200', async () => {
      const first = await call('POST', '/memories', entry());
      const again = await call('POST', '/memories', entry({ name: 'TEST-COMMAND', body: 'Use vitest.' }));
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ id: first.body.id, name: 'TEST-COMMAND', body: 'Use vitest.' });
      expect(await testDb.db.select({ id: workspaceMemories.id }).from(workspaceMemories)).toHaveLength(1);
    });

    it('stores a repository entry', async () => {
      const res = await call('POST', '/memories', entry({ scope: 'repository', repository_id: 'repo-a' }));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ scope: 'repository', repository_id: 'repo-a' });
    });

    it.each([
      ['an unknown scope', { scope: 'global' }, 400, 'scope'],
      ['an unknown type', { type: 'secret' }, 400, 'type'],
      ['a camelCase field', { workspaceId: 'ws-a' }, 400, 'workspaceId'],
      ['a name too long', { name: 'n'.repeat(65) }, 400, 'name'],
      ['a repository entry with no repository', { scope: 'repository' }, 400, undefined],
      ['a workspace entry with a repository', { repository_id: 'repo-a' }, 400, undefined],
      ['a repository of another workspace', { scope: 'repository', repository_id: 'repo-b' }, 404, undefined],
      ['another owner’s workspace', { workspace_id: 'ws-b' }, 404, undefined],
    ])('refuses %s', async (_label, extra, status, param) => {
      const res = await call('POST', '/memories', entry(extra));
      expect(res.status).toBe(status);
      if (param) expect(res.body.error.param).toBe(param);
      expect(await testDb.db.select({ id: workspaceMemories.id }).from(workspaceMemories)).toHaveLength(0);
    });

    it('refuses a body over the size limit with 413', async () => {
      const res = await call('POST', '/memories', entry({ body: 'x'.repeat(9000) }));
      expect([res.status, res.body.error.code]).toEqual([413, 'memory_too_large']);
    });

    it('replays an idempotent create', async () => {
      const first = await call('POST', '/memories', entry(), { 'Idempotency-Key': 'mem-1' });
      const again = await call('POST', '/memories', entry(), { 'Idempotency-Key': 'mem-1' });
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect([again.status, again.body.id]).toEqual([201, first.body.id]);
    });
  });

  describe('reading', () => {
    async function insert(id: string, createdAt: string, extra: Partial<typeof workspaceMemories.$inferInsert> = {}) {
      await testDb.db.insert(workspaceMemories).values({
        id,
        workspaceId: 'ws-a',
        ownerId: 'owner-a',
        scope: 'workspace',
        type: 'project',
        name: id,
        description: `about ${id}`,
        body: `body of ${id}`,
        bytes: 10,
        createdAt: new Date(createdAt),
        ...extra,
      });
    }

    it('pages newest first, without bodies unless asked', async () => {
      await insert('m1', '2026-11-01T00:00:01Z');
      await insert('m2', '2026-11-01T00:00:02Z');
      await insert('m3', '2026-11-01T00:00:03Z');
      const first = await call('GET', '/memories?workspace_id=ws-a&limit=2');
      expect(first.body.data.map((m: Loose) => m.id)).toEqual(['m3', 'm2']);
      expect(first.body.data[0]).not.toHaveProperty('body');
      expect(first.body.has_more).toBe(true);
      const second = await call('GET', `/memories?workspace_id=ws-a&limit=2&cursor=${first.body.next_cursor}`);
      expect(second.body).toMatchObject({ has_more: false, next_cursor: null });
      expect(second.body.data.map((m: Loose) => m.id)).toEqual(['m1']);
      const bodies = await call('GET', '/memories?workspace_id=ws-a&include_body=true');
      expect(bodies.body.data[0].body).toBe('body of m3');
    });

    it.each([
      ['the default', '', ['live-ws', 'live-repo']],
      ['include_forgotten', '&include_forgotten=true', ['gone', 'live-ws', 'live-repo']],
      ['scope=repository', '&scope=repository', ['live-repo']],
      ['repository_id without scope', '&repository_id=repo-a', ['live-ws', 'live-repo']],
      ['q', '&q=repo', ['live-repo']],
    ])('filters by %s', async (_label, qs, expected) => {
      await insert('live-repo', '2026-11-01T00:00:01Z', { scope: 'repository', repositoryId: 'repo-a' });
      await insert('live-ws', '2026-11-01T00:00:02Z');
      await insert('gone', '2026-11-01T00:00:03Z', { forgottenAt: new Date() });
      const res = await call('GET', `/memories?workspace_id=ws-a${qs}`);
      expect(res.body.data.map((m: Loose) => m.id)).toEqual(expected);
    });

    it('gets one entry with its body', async () => {
      await insert('m1', '2026-11-01T00:00:01Z', { source: { kind: 'session', workbenchId: 'wb-1' } });
      const res = await call('GET', '/memories/m1');
      expect(res.body).toMatchObject({ id: 'm1', body: 'body of m1', source: { kind: 'session', session_id: 'wb-1' } });
    });

    it('does not ship a body the list did not ask for', () => {
      const sql = listMemoriesPageQuery('ws-a', { includeBody: false }, null, 50).toSQL().sql;
      expect(sql).not.toMatch(/"body"/);
      expect(sql).not.toMatch(/"source"\s*,/);
      expect(listMemoriesPageQuery('ws-a', { includeBody: true }, null, 50).toSQL().sql).toMatch(/"body"/);
    });
  });

  describe('changing', () => {
    let id: string;
    beforeEach(async () => {
      id = (await call('POST', '/memories', entry())).body.id;
    });

    it('updates fields and keeps the scope', async () => {
      const res = await call('PATCH', `/memories/${id}`, { description: 'New words', body: 'New body' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ description: 'New words', body: 'New body', bytes: 8, scope: 'workspace' });
    });

    it('refuses an update that changes the scope', async () => {
      const res = await call('PATCH', `/memories/${id}`, { scope: 'repository' });
      expect([res.status, res.body.error.param]).toEqual([400, 'scope']);
    });

    it('refuses an empty update', async () => {
      const res = await call('PATCH', `/memories/${id}`, {});
      expect(res.status).toBe(400);
    });

    it('forgets, forgets again without error, refuses an edit, then restores', async () => {
      const forgotten = await call('DELETE', `/memories/${id}`);
      expect(forgotten.status).toBe(200);
      expect(forgotten.body.forgotten_at).toBeTruthy();
      expect((await call('DELETE', `/memories/${id}`)).status).toBe(200);
      const edit = await call('PATCH', `/memories/${id}`, { body: 'x' });
      expect([edit.status, edit.body.error.code]).toEqual([409, 'memory_forgotten']);
      expect((await call('GET', '/memories?workspace_id=ws-a')).body.data).toEqual([]);
      const restored = await call('POST', `/memories/${id}/restore`);
      expect([restored.status, restored.body.forgotten_at]).toEqual([200, null]);
    });

    it('refuses to restore over a live entry that took the name', async () => {
      await call('DELETE', `/memories/${id}`);
      await call('POST', '/memories', entry());
      const res = await call('POST', `/memories/${id}/restore`);
      expect([res.status, res.body.error.code]).toEqual([409, 'memory_name_taken']);
    });
  });

  describe('access', () => {
    beforeEach(async () => {
      await testDb.db.insert(workbenches).values({
        id: 'thread-b', workspaceId: 'ws-b', kind: 'thread', repoFullName: '', name: 'tb', branch: '', baseBranch: '',
        runtime: 'sandbox', agent: 'claude', status: 'ready',
      });
      await testDb.db.insert(workspaceMemories).values({
        id: 'mb', workspaceId: 'ws-b', ownerId: 'owner-b', scope: 'workspace', type: 'project', name: 'b', description: 'b', body: 'b',
      });
    });

    it.each([
      ['GET', '/memories/mb', undefined],
      ['PATCH', '/memories/mb', { body: 'x' }],
      ['DELETE', '/memories/mb', undefined],
      ['POST', '/memories/mb/restore', undefined],
      ['GET', '/memories/missing', undefined],
    ])('answers 404 memory_not_found for %s %s', async (method, path, body) => {
      const res = await call(method, path, body);
      expect([res.status, res.body.error.code]).toEqual([404, 'memory_not_found']);
    });

    it('answers 404 for a list in another owner’s workspace', async () => {
      expect((await call('GET', '/memories?workspace_id=ws-b')).status).toBe(404);
    });

    it('needs memory:write to change, and memory:read to read', async () => {
      const reader = await mintToken('owner-a', { scopes: ['memory:read'] });
      expect((await call('GET', '/memories?workspace_id=ws-a', undefined, undefined, reader)).status).toBe(200);
      const refused = await call('POST', '/memories', entry(), undefined, reader);
      expect([refused.status, refused.body.error.code]).toEqual([403, 'insufficient_scope']);
      const none = await mintToken('owner-a', { scopes: ['sessions:read'] });
      expect((await call('GET', '/memories?workspace_id=ws-a', undefined, undefined, none)).status).toBe(403);
    });

    it('keeps a workspace-bound token to its workspace, and takes the workspace from it', async () => {
      const bound = await mintToken('owner-a', { scopes: SCOPES, workspaceIds: ['ws-a2'] });
      const created = await call('POST', '/memories', { ...entry(), workspace_id: undefined }, undefined, bound);
      expect([created.status, created.body.workspace_id]).toEqual([201, 'ws-a2']);
      const other = (await call('POST', '/memories', entry())).body.id;
      expect((await call('GET', `/memories/${other}`, undefined, undefined, bound)).status).toBe(404);
      expect((await call('GET', '/memories?workspace_id=ws-a', undefined, undefined, bound)).status).toBe(404);
    });

    it('needs sessions to be on for the account', async () => {
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      const res = await call('GET', '/memories?workspace_id=ws-a');
      expect([res.status, res.body.error.code]).toEqual([403, 'workbenches_unavailable']);
    });
  });
});
