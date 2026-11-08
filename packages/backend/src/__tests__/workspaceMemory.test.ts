import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  MAX_LIVE_MEMORIES_PER_WORKSPACE,
  MAX_MEMORY_INDEX_BYTES,
  renderMemoryIndex,
  type MemoryIndexEntry,
} from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workspaceMemories, workspaceMemoryUses, workspaces } from '../db/schema.js';

/**
 * Workspace memory: the store, the routes and the index. Owner isolation is
 * through the routes, because the service runs on the pool.
 */

const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { insertChat, insertWorkbench, listEvents } = await import('../services/workbenches/store.js');
const {
  announceMemoryChange,
  listMemories,
  listMemoriesQuery,
  listMemoriesUsedBy,
  memoryIndexFor,
  recordMemoryUse,
  sessionMemoryEnabled,
} = await import(
  '../services/workbenches/memory.js'
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const entry = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: 'ws-a',
  scope: 'workspace',
  type: 'project',
  name: 'build command',
  description: 'How to build the app',
  body: 'Run `npm run build` in the repo root.',
  ...overrides,
});

describe('workspace memory', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;

  async function call(method: string, url: string, body?: unknown, user = 'owner-a') {
    const resp = await fetch(`${base}${url}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: (await resp.json()) as { success: boolean; data?: Loose; error?: string; code?: string } };
  }

  const create = async (overrides: Record<string, unknown> = {}, user = 'owner-a') =>
    call('POST', '/workbenches/memory', entry(overrides), user);

  beforeEach(async () => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await seedUser(testDb.db, { id: 'owner-b' });
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'owner-a', name: 'A' },
      { id: 'ws-b', ownerId: 'owner-b', name: 'B' },
    ]);
    await testDb.db.insert(repositories).values([
      { id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app' },
      { id: 'repo-a2', workspaceId: 'ws-a', name: 'acme/other', url: 'https://github.com/acme/other' },
      { id: 'repo-b', workspaceId: 'ws-b', name: 'bee/hive', url: 'https://github.com/bee/hive' },
    ]);
    for (const [id, ws, repo] of [['wb-a', 'ws-a', 'repo-a'], ['wb-b', 'ws-b', 'repo-b']]) {
      await insertWorkbench({
        id, workspaceId: ws, repositoryId: repo, repoFullName: 'o/r', name: id,
        branch: `tom/${id}`, baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      });
    }
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
  });

  describe('create, read, update', () => {
    it('creates an entry and reads it back with its body', async () => {
      const res = await create();
      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('created');
      expect(res.body.data.entry).toMatchObject({
        workspaceId: 'ws-a', scope: 'workspace', repositoryId: null, threadId: null, type: 'project',
        name: 'build command', bytes: 37, source: { kind: 'user' }, forgottenAt: null,
      });
      const got = await call('GET', `/workbenches/memory/${res.body.data.entry.id}`);
      expect(got.body.data.body).toBe('Run `npm run build` in the repo root.');
    });

    it('trims the name and the description', async () => {
      const res = await create({ name: '  spaced  ', description: '  a note  ' });
      expect(res.body.data.entry).toMatchObject({ name: 'spaced', description: 'a note' });
    });

    it('stores the owner of the workspace', async () => {
      await create();
      const rows = await testDb.db.select({ ownerId: workspaceMemories.ownerId }).from(workspaceMemories);
      expect(rows).toEqual([{ ownerId: 'owner-a' }]);
    });

    it.each([
      ['the same name', 'build command'],
      ['the name in another case', 'Build Command'],
      ['the name with spaces round it', '  build command '],
    ])('updates the live entry with %s instead of adding one', async (_label, name) => {
      const first = await create();
      const second = await create({ name, body: 'Run `make`.' });
      expect(second.body.data.outcome).toBe('updated');
      expect(second.body.data.entry.id).toBe(first.body.data.entry.id);
      expect(second.body.data.entry.body).toBe('Run `make`.');
      expect(await testDb.db.select({ id: workspaceMemories.id }).from(workspaceMemories)).toHaveLength(1);
    });

    it.each([
      ['a repository', { scope: 'repository', repositoryId: 'repo-a' }],
      ['another repository', { scope: 'repository', repositoryId: 'repo-a2' }],
      ['a thread', { scope: 'thread', threadId: 'wb-a' }],
    ])('keeps a same-named entry in %s apart from the workspace entry', async (_label, overrides) => {
      await create();
      const res = await create(overrides);
      expect(res.body.data.outcome).toBe('created');
      expect(await testDb.db.select({ id: workspaceMemories.id }).from(workspaceMemories)).toHaveLength(2);
    });

    it('edits fields of an entry and keeps its scope', async () => {
      const { body } = await create({ scope: 'repository', repositoryId: 'repo-a' });
      const res = await call('PUT', `/workbenches/memory/${body.data.entry.id}`, { description: 'New text', type: 'reference' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ description: 'New text', type: 'reference', scope: 'repository', repositoryId: 'repo-a' });
    });

    it('refuses to rename an entry onto a live name in its scope', async () => {
      await create({ name: 'one' });
      const two = await create({ name: 'two' });
      const res = await call('PUT', `/workbenches/memory/${two.body.data.entry.id}`, { name: 'ONE' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('memory_name_taken');
    });

    it('records a session as the source when the session is in the workspace', async () => {
      const res = await create({ source: { kind: 'session', workbenchId: 'wb-a', chatId: 'c1', turn: 3 } });
      expect(res.body.data.entry.source).toEqual({ kind: 'session', workbenchId: 'wb-a', chatId: 'c1', turn: 3 });
    });

    it.each([
      ['a session of another workspace', { kind: 'session', workbenchId: 'wb-b' }],
      ['a session that does not exist', { kind: 'session', workbenchId: 'nope' }],
      ['a session without an id', { kind: 'session' }],
      ['an unknown kind', { kind: 'auto' }],
    ])('refuses %s as the source', async (_label, source) => {
      const res = await create({ source });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('bad_memory');
    });
  });

  describe('validation', () => {
    it.each([
      ['an unknown scope', { scope: 'org' }, /scope must be one of/],
      ['an unknown type', { type: 'note' }, /type must be one of/],
      ['no name', { name: '' }, /name is required/],
      ['a name of whitespace', { name: '   ' }, /name is required/],
      ['a name over 64 characters', { name: 'n'.repeat(65) }, /name can be at most 64 characters; this one is 65/],
      ['a name on two lines', { name: 'one\ntwo' }, /one line/],
      ['no description', { description: '' }, /description is required/],
      ['a description over 200 characters', { description: 'd'.repeat(201) }, /at most 200 characters; this one is 201/],
      ['a description on two lines', { description: 'a\nb' }, /one line/],
      ['no body', { body: '' }, /body is required/],
      ['a body that is not a string', { body: 42 }, /body is required/],
      ['a workspace entry with a repository', { repositoryId: 'repo-a' }, /workspace entry has no repositoryId/],
      ['a repository entry without a repository', { scope: 'repository' }, /needs a repositoryId/],
      ['a thread entry without a thread', { scope: 'thread' }, /needs a threadId/],
    ])('refuses %s with a clear message', async (_label, overrides, message) => {
      const res = await create(overrides);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('bad_memory');
      expect(res.body.error).toMatch(message);
    });

    it.each([
      ['exactly 8 KB', 'x'.repeat(8 * 1024), 200],
      ['one byte over 8 KB', 'x'.repeat(8 * 1024 + 1), 413],
      ['8 KB of characters that take 3 bytes each', '€'.repeat(3000), 413],
    ])('body of %s answers %i', async (_label, body, status) => {
      const res = await create({ body });
      expect(res.status).toBe(status);
      if (status === 413) {
        expect(res.body.code).toBe('memory_too_large');
        expect(res.body.error).toMatch(/at most 8 KB; this one is 9 KB/);
      }
    });

    it.each([
      ['a repository of another workspace', { scope: 'repository', repositoryId: 'repo-b' }, 'repository_not_found'],
      ['a thread of another workspace', { scope: 'thread', threadId: 'wb-b' }, 'thread_not_found'],
    ])('refuses %s', async (_label, overrides, code) => {
      const res = await create(overrides);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(code);
    });

    it('refuses an empty update', async () => {
      const { body } = await create();
      const res = await call('PUT', `/workbenches/memory/${body.data.entry.id}`, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least one of/);
    });

    it('refuses an unknown scope filter on the list', async () => {
      const res = await call('GET', '/workbenches/memory?workspaceId=ws-a&scope=org');
      expect(res.status).toBe(400);
    });
  });

  describe('the live entry cap', () => {
    async function fill(count: number) {
      await testDb.db.insert(workspaceMemories).values(
        Array.from({ length: count }, (_, i) => ({
          id: `m-${i}`, workspaceId: 'ws-a', ownerId: 'owner-a', scope: 'workspace', type: 'project',
          name: `entry ${i}`, description: 'd', body: 'b', bytes: 1,
        })),
      );
    }

    it('refuses a new entry at the cap and says why', async () => {
      await fill(MAX_LIVE_MEMORIES_PER_WORKSPACE);
      const res = await create({ name: 'one more' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('memory_limit_reached');
      expect(res.body.error).toBe('This workspace has 500 memory entries, which is the limit. Forget some entries first.');
    });

    it('still updates an existing entry at the cap', async () => {
      await fill(MAX_LIVE_MEMORIES_PER_WORKSPACE);
      const res = await create({ name: 'entry 7', body: 'new' });
      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('updated');
    });

    it('does not count forgotten entries or other workspaces', async () => {
      await fill(MAX_LIVE_MEMORIES_PER_WORKSPACE);
      await call('DELETE', '/workbenches/memory/m-0');
      expect((await create({ name: 'one more' })).status).toBe(200);
      expect((await create({ workspaceId: 'ws-b' }, 'owner-b')).status).toBe(200);
    });

    it('refuses a restore at the cap', async () => {
      await fill(MAX_LIVE_MEMORIES_PER_WORKSPACE);
      await call('DELETE', '/workbenches/memory/m-0');
      await create({ name: 'fills the gap' });
      const res = await call('POST', '/workbenches/memory/m-0/restore');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('memory_limit_reached');
    });
  });

  describe('forget and restore', () => {
    it('hides a forgotten entry from the list and the index, and restore brings it back', async () => {
      const { body } = await create();
      const id = body.data.entry.id;
      const forgotten = await call('DELETE', `/workbenches/memory/${id}`);
      expect(forgotten.status).toBe(200);
      expect(forgotten.body.data.forgottenAt).not.toBeNull();
      expect((await call('GET', '/workbenches/memory?workspaceId=ws-a')).body.data).toEqual([]);
      expect(await memoryIndexFor({ workspaceId: 'ws-a' })).toEqual([]);
      const all = await call('GET', '/workbenches/memory?workspaceId=ws-a&includeForgotten=true');
      expect(all.body.data.map((e: Loose) => e.id)).toEqual([id]);

      const restored = await call('POST', `/workbenches/memory/${id}/restore`);
      expect(restored.status).toBe(200);
      expect(restored.body.data).toMatchObject({ id, forgottenAt: null, body: 'Run `npm run build` in the repo root.' });
      expect(await memoryIndexFor({ workspaceId: 'ws-a' })).toHaveLength(1);
    });

    it('404s a second forget', async () => {
      const { body } = await create();
      await call('DELETE', `/workbenches/memory/${body.data.entry.id}`);
      expect((await call('DELETE', `/workbenches/memory/${body.data.entry.id}`)).status).toBe(404);
    });

    it('lets a new entry take a forgotten name, then refuses to restore the old one over it', async () => {
      const old = await create();
      await call('DELETE', `/workbenches/memory/${old.body.data.entry.id}`);
      const fresh = await create({ body: 'New way' });
      expect(fresh.body.data.outcome).toBe('created');
      const res = await call('POST', `/workbenches/memory/${old.body.data.entry.id}/restore`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('memory_name_taken');
    });

    it('refuses to edit a forgotten entry', async () => {
      const { body } = await create();
      await call('DELETE', `/workbenches/memory/${body.data.entry.id}`);
      const res = await call('PUT', `/workbenches/memory/${body.data.entry.id}`, { body: 'x' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('memory_forgotten');
    });

    it('answers a restore of a live entry with the entry', async () => {
      const { body } = await create();
      const res = await call('POST', `/workbenches/memory/${body.data.entry.id}/restore`);
      expect(res.status).toBe(200);
      expect(res.body.data.forgottenAt).toBeNull();
    });
  });

  describe('owner isolation', () => {
    it.each([
      ['GET', (id: string) => `/workbenches/memory/${id}`, undefined],
      ['PUT', (id: string) => `/workbenches/memory/${id}`, { body: 'hijack' }],
      ['DELETE', (id: string) => `/workbenches/memory/${id}`, undefined],
      ['POST', (id: string) => `/workbenches/memory/${id}/restore`, undefined],
    ])('refuses %s on another owner’s entry', async (method, url, payload) => {
      const { body } = await create();
      const id = body.data.entry.id;
      const res = await call(method, url(id), payload, 'owner-b');
      expect([403, 404]).toContain(res.status);
      const got = await call('GET', `/workbenches/memory/${id}`);
      expect(got.body.data).toMatchObject({ body: 'Run `npm run build` in the repo root.', forgottenAt: null });
    });

    it('refuses to list or write another owner’s workspace', async () => {
      await create();
      expect([403, 404]).toContain((await call('GET', '/workbenches/memory?workspaceId=ws-a', undefined, 'owner-b')).status);
      expect([403, 404]).toContain((await create({}, 'owner-b')).status);
      expect((await call('GET', '/workbenches/memory?workspaceId=ws-b', undefined, 'owner-b')).body.data).toEqual([]);
    });

    it('404s an unknown entry', async () => {
      expect((await call('GET', '/workbenches/memory/nope')).status).toBe(404);
    });

    it('requires a workspaceId for the list and for a create', async () => {
      expect((await call('GET', '/workbenches/memory')).status).toBe(400);
      expect((await call('POST', '/workbenches/memory', { ...entry(), workspaceId: undefined })).status).toBe(400);
    });

    it('refuses everything when the workbenches flag is off', async () => {
      const { body } = await create();
      vi.stubEnv('WORKBENCHES_ENABLED', 'false');
      resetFeatureFlagsForTests();
      expect((await call('GET', '/workbenches/memory?workspaceId=ws-a')).status).toBe(403);
      expect((await call('GET', `/workbenches/memory/${body.data.entry.id}`)).status).toBe(403);
    });
  });

  describe('list and index scoping', () => {
    beforeEach(async () => {
      await create({ name: 'ws note' });
      await create({ name: 'repo note', scope: 'repository', repositoryId: 'repo-a', body: 'Uses pnpm workspaces' });
      await create({ name: 'other repo note', scope: 'repository', repositoryId: 'repo-a2' });
      await create({ name: 'thread note', scope: 'thread', threadId: 'wb-a' });
    });

    const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);

    it.each([
      ['every entry', '', ['ws note', 'other repo note', 'repo note', 'thread note']],
      ['visible from a repository', '&repositoryId=repo-a', ['ws note', 'repo note']],
      ['visible from a repository and thread', '&repositoryId=repo-a&threadId=wb-a', ['ws note', 'repo note', 'thread note']],
      ['one scope', '&scope=repository', ['other repo note', 'repo note']],
      ['one scope and target', '&scope=repository&repositoryId=repo-a2', ['other repo note']],
      ['workspace scope only', '&scope=workspace', ['ws note']],
      ['a search on the body', '&q=PNPM', ['repo note']],
      ['a search on the name', '&q=thread', ['thread note']],
      ['a search with a LIKE wildcard', '&q=%25', []],
      ['one name, in another case', '&name=REPO%20NOTE', ['repo note']],
      ['one name, trimmed', '&name=%20ws%20note%20', ['ws note']],
      ['one name, not a part of one', '&name=repo', []],
      ['one name, not a LIKE pattern', '&name=repo%25', []],
      ['one name visible from another repository', '&name=repo%20note&repositoryId=repo-a2', []],
      ['one name visible from its repository', '&name=repo%20note&repositoryId=repo-a', ['repo note']],
    ])('lists %s', async (_label, query, expected) => {
      const res = await call('GET', `/workbenches/memory?workspaceId=ws-a${query}`);
      expect(res.status).toBe(200);
      expect(names(res.body.data)).toEqual(expected);
    });

    it('ships no bodies unless asked', async () => {
      const plain = await call('GET', '/workbenches/memory?workspaceId=ws-a');
      expect(JSON.stringify(plain.body)).not.toContain('pnpm');
      for (const row of plain.body.data) expect(row).not.toHaveProperty('body');
      const full = await call('GET', '/workbenches/memory?workspaceId=ws-a&includeBody=true');
      expect(JSON.stringify(full.body)).toContain('pnpm');
    });

    it('the list query selects no body unless asked', () => {
      expect(listMemoriesQuery('ws-a', {}).toSQL().sql).not.toMatch(/"body"/);
      expect(listMemoriesQuery('ws-a', { includeBody: true }).toSQL().sql).toMatch(/"body"/);
    });

    it.each([
      ['the workspace only', {}, ['ws note']],
      ['a repository', { repositoryId: 'repo-a' }, ['ws note', 'repo note']],
      ['another repository', { repositoryId: 'repo-a2' }, ['ws note', 'other repo note']],
      ['a repository and a thread', { repositoryId: 'repo-a', threadId: 'wb-a' }, ['ws note', 'repo note', 'thread note']],
    ])('the index for %s', async (_label, opts, expected) => {
      const index = await memoryIndexFor({ workspaceId: 'ws-a', ...opts });
      expect(names(index)).toEqual(expected);
      for (const item of index) expect(Object.keys(item).sort()).toEqual(['description', 'id', 'name', 'scope', 'type']);
    });

    it('finds a name in this workspace only, and never a forgotten entry', async () => {
      await create({ workspaceId: 'ws-b', name: 'shared name' }, 'owner-b');
      const forgotten = await create({ name: 'gone note' });
      await call('DELETE', `/workbenches/memory/${forgotten.body.data.entry.id}`);
      expect(names(await listMemories('ws-a', { name: 'shared name' }))).toEqual([]);
      expect(names(await listMemories('ws-b', { name: 'shared name' }))).toEqual(['shared name']);
      expect(names(await listMemories('ws-a', { name: 'gone note' }))).toEqual([]);
      const other = await call('GET', '/workbenches/memory?workspaceId=ws-b&name=shared%20name');
      expect(other.status).not.toBe(200);
    });

    it('does not show another workspace in the index', async () => {
      expect(await memoryIndexFor({ workspaceId: 'ws-b', repositoryId: 'repo-a' })).toEqual([]);
      expect(await listMemories('ws-b')).toEqual([]);
    });
  });

  describe('the entries one thread used', () => {
    const ids: Record<string, string> = {};
    const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);
    const usedBy = async (query = '') => {
      const res = await call('GET', `/workbenches/memory?workspaceId=ws-a&usedBy=wb-a${query}`);
      expect(res.status).toBe(200);
      return res.body.data as Array<{ name: string; use: { wrote: boolean; read: boolean; lastUsedAt: string } }>;
    };

    beforeEach(async () => {
      await insertWorkbench({
        id: 'wb-a2', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'o/r', name: 'wb-a2',
        branch: 'tom/wb-a2', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'ready',
      });
      const make = async (name: string, overrides: Record<string, unknown> = {}) => {
        const res = await create({ name, ...overrides });
        expect(res.status).toBe(200);
        ids[name] = res.body.data.entry.id;
      };
      await make('saved here', { source: { kind: 'session', workbenchId: 'wb-a' } });
      await make('saved elsewhere', { source: { kind: 'session', workbenchId: 'wb-a2' } });
      await make('read here');
      await make('read elsewhere');
      await make('never used');
      await make('thread note', { scope: 'thread', threadId: 'wb-a', source: { kind: 'session', workbenchId: 'wb-a2' } });
      await testDb.db.insert(workspaceMemoryUses).values([
        { memoryId: ids['read here'], workbenchId: 'wb-a', read: true, lastUsedAt: new Date('2099-01-01T00:00:00Z') },
        { memoryId: ids['saved here'], workbenchId: 'wb-a', wrote: true, lastUsedAt: new Date('2000-01-01T00:00:00Z') },
        { memoryId: ids['read elsewhere'], workbenchId: 'wb-a2', read: true },
      ]);
    });

    it('lists what it saved, read, and its own thread entries, the most recent use first', async () => {
      const rows = await usedBy();
      expect(names(rows)).toEqual(['read here', 'thread note', 'saved here']);
      expect(rows.map((r) => r.use)).toEqual([
        { wrote: false, read: true, lastUsedAt: '2099-01-01T00:00:00.000Z' },
        { wrote: false, read: false, lastUsedAt: expect.any(String) },
        { wrote: true, read: false, lastUsedAt: '2000-01-01T00:00:00.000Z' },
      ]);
    });

    it('counts an entry it saved before uses were recorded', async () => {
      await testDb.db.delete(workspaceMemoryUses);
      const rows = await usedBy();
      expect(names(rows)).toContain('saved here');
      expect(rows.find((r) => r.name === 'saved here')?.use).toMatchObject({ wrote: true, read: false });
    });

    it('records a read and a write as one use, and moves it to the top', async () => {
      await recordMemoryUse(ids['saved here'], 'wb-a', 'read');
      await recordMemoryUse(ids['never used'], 'wb-a', 'wrote');
      await recordMemoryUse(ids['never used'], 'wb-a', 'read');
      const rows = await listMemoriesUsedBy('ws-a', 'wb-a');
      expect(names(rows)).toEqual(['read here', 'never used', 'saved here', 'thread note']);
      expect(rows.find((r) => r.name === 'saved here')?.use).toMatchObject({ wrote: true, read: true });
      expect(rows.find((r) => r.name === 'never used')?.use).toMatchObject({ wrote: true, read: true });
      const stored = await testDb.db.select().from(workspaceMemoryUses);
      expect(stored.filter((r) => r.memoryId === ids['never used'])).toHaveLength(1);
    });

    it('does not throw when the use cannot be stored', async () => {
      await expect(recordMemoryUse('no-such-entry', 'wb-a', 'read')).resolves.toBeUndefined();
    });

    it('hides a forgotten entry unless asked, and ships no body unless asked', async () => {
      await call('DELETE', `/workbenches/memory/${ids['read here']}`);
      expect(names(await usedBy())).not.toContain('read here');
      expect(names(await usedBy('&includeForgotten=true'))).toContain('read here');
      for (const row of await usedBy()) expect(row).not.toHaveProperty('body');
      for (const row of await usedBy('&includeBody=true')) expect(row).toHaveProperty('body');
    });

    it('lists nothing from another workspace', async () => {
      expect(await listMemoriesUsedBy('ws-b', 'wb-a')).toEqual([]);
      const other = await call('GET', '/workbenches/memory?workspaceId=ws-b&usedBy=wb-a');
      expect(other.status).not.toBe(200);
    });
  });

  describe('announceMemoryChange', () => {
    const change = { action: 'created', memoryId: 'm1', name: 'build command', memoryType: 'project', scope: 'repository' } as const;
    const chat = (id: string, status: string, updatedAt: string, closedAt: string | null = null) =>
      insertChat({
        id, workbenchId: 'wb-a', workspaceId: 'ws-a', title: id, agent: 'claude', status,
        turnCount: 2, updatedAt: new Date(updatedAt), closedAt: closedAt ? new Date(closedAt) : null,
      });
    const memoryEvents = async (chatId: string) =>
      (await listEvents(chatId, -1, 100)).events.filter((e: Loose) => e.event.type === 'talyn_memory');

    it.each([
      ['the running chat', [['c-run', 'running', '2026-10-01'], ['c-new', 'idle', '2026-10-05']], 'c-run'],
      ['the latest open chat when none runs', [['c-old', 'idle', '2026-10-01'], ['c-new', 'idle', '2026-10-05']], 'c-new'],
      ['an open chat over a newer closed one', [['c-old', 'idle', '2026-10-01'], ['c-closed', 'running', '2026-10-05', '2026-10-06']], 'c-old'],
    ])('appends the event to %s', async (_label, chats, target) => {
      for (const [id, status, updatedAt, closedAt] of chats) await chat(id, status, updatedAt, closedAt ?? null);
      await announceMemoryChange('wb-a', change);
      for (const [id] of chats) {
        const events = await memoryEvents(id);
        if (id === target) {
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({ turn: 2, event: { type: 'talyn_memory', ...change } });
        } else {
          expect(events).toEqual([]);
        }
      }
    });

    it('does nothing for a session without chats, or one that does not exist', async () => {
      await expect(announceMemoryChange('wb-a', change)).resolves.toBeUndefined();
      await expect(announceMemoryChange('nope', change)).resolves.toBeUndefined();
    });
  });

  describe('settings.sessionMemory', () => {
    it.each([
      [undefined, true],
      [true, true],
      [false, false],
    ])('reads %j as %j', async (value, expected) => {
      await testDb.db
        .update(workspaces)
        .set({ settings: value === undefined ? {} : { sessionMemory: value } })
        .where((await import('drizzle-orm')).eq(workspaces.id, 'ws-a'));
      expect(await sessionMemoryEnabled('ws-a')).toBe(expected);
    });

    it('reads a missing workspace as on', async () => {
      expect(await sessionMemoryEnabled('ws-missing')).toBe(true);
    });

    it('reads another owner’s workspace as on, so the answer says nothing', async () => {
      await testDb.db.update(workspaces).set({ settings: { sessionMemory: false } });
      expect(await sessionMemoryEnabled('ws-a', 'owner-a')).toBe(false);
      expect(await sessionMemoryEnabled('ws-a', 'owner-b')).toBe(true);
    });
  });
});

describe('renderMemoryIndex', () => {
  const item = (i: number, description = 'A note about something'): MemoryIndexEntry => ({
    name: `entry ${i}`,
    type: 'project',
    scope: 'workspace',
    description,
  });

  it('is empty when there are no entries', () => {
    expect(renderMemoryIndex([])).toBe('');
  });

  it('lists name, type, scope and description, and names the read tool', () => {
    const out = renderMemoryIndex([item(1), { name: 'style', type: 'feedback', scope: 'repository', description: 'Use tabs' }]);
    expect(out).toContain('- entry 1 (project, workspace): A note about something\n');
    expect(out).toContain('- style (feedback, repository): Use tabs\n');
    expect(out).toContain('talyn_memory_read');
    expect(out).not.toMatch(/not shown/);
  });

  it.each([
    ['a few entries over', 10],
    ['many entries over', 2000],
  ])('cuts at 24 KiB with %s and says how many were left out', (_label, extra) => {
    const description = 'd'.repeat(180);
    const fit = Math.floor(MAX_MEMORY_INDEX_BYTES / 200);
    const entries = Array.from({ length: fit + extra }, (_, i) => item(i, description));
    const out = renderMemoryIndex(entries);
    const bytes = new TextEncoder().encode(out).length;
    expect(bytes).toBeLessThanOrEqual(MAX_MEMORY_INDEX_BYTES);
    const shown = out.split('\n').filter((line) => line.startsWith('- ')).length;
    expect(out.trimEnd().split('\n').at(-1)).toBe(
      `${entries.length - shown} more entries are not shown. Use \`talyn_memory_search\` to find them.`,
    );
    expect(shown).toBeGreaterThan(0);
  });

  it('says "1 more entry is" for one entry left out', () => {
    const max = new TextEncoder().encode(renderMemoryIndex([item(1)])).length + 80;
    const out = renderMemoryIndex([item(1), item(2, 'x'.repeat(200))], max);
    expect(out).toContain('- entry 1 ');
    expect(out).toMatch(/\n1 more entry is not shown/);
  });

  it('keeps every entry when they fit exactly', () => {
    const entries = [item(1), item(2)];
    const full = renderMemoryIndex(entries);
    expect(renderMemoryIndex(entries, new TextEncoder().encode(full).length)).toBe(full);
  });

  it('counts bytes, not characters', () => {
    const wide = Array.from({ length: 100 }, (_, i) => item(i, '€'.repeat(150)));
    const out = renderMemoryIndex(wide);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(MAX_MEMORY_INDEX_BYTES);
    expect(out).toMatch(/not shown/);
  });
});
