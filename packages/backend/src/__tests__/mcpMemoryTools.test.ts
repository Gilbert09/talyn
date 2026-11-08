import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Features } from '@talyn/shared';
import { listToolsFor } from '../mcp/server.js';
import { TOOLS, type McpCallContext, type McpToolDefinition } from '../mcp/tools/index.js';
import { announceMemoryChange, sessionMemoryEnabled } from '../services/workbenches/memory.js';
import { getWorkbench } from '../services/workbenches/store.js';

vi.mock('../services/workbenches/memory.js', async (original) => ({
  ...(await original<typeof import('../services/workbenches/memory.js')>()),
  announceMemoryChange: vi.fn(async () => undefined),
  sessionMemoryEnabled: vi.fn(async () => true),
}));
vi.mock('../services/workbenches/store.js', async (original) => ({
  ...(await original<typeof import('../services/workbenches/store.js')>()),
  getWorkbench: vi.fn(async (id: string) => ({
    s1: { id: 's1', workspaceId: 'ws1', repositoryId: 'r1', kind: 'session', threadId: null },
    t1: { id: 't1', workspaceId: 'ws1', repositoryId: null, kind: 'thread', threadId: null },
    k1: { id: 'k1', workspaceId: 'ws1', repositoryId: 'r1', kind: 'session', threadId: 't1' },
    rv: {
      id: 'rv', workspaceId: 'ws1', repositoryId: null, kind: 'thread', threadId: null,
      source: { kind: 'memory_review', runId: 'run-1' },
    },
  })[id] ?? null),
}));

const OWNER = 'user-test';
const SELF: McpCallContext = { session: { tokenId: 'token-1', workbenchId: 's1', depth: 0 } };
const USER: McpCallContext = {};
const THREAD: McpCallContext = { session: { tokenId: 'token-2', workbenchId: 't1', depth: 0 } };
const CHILD: McpCallContext = { session: { tokenId: 'token-3', workbenchId: 'k1', depth: 1 } };
const REVIEW: McpCallContext = { session: { tokenId: 'token-4', workbenchId: 'rv', depth: 0 } };

const features: Features = {
  workflows: true,
  loops: true,
  mcpServers: true,
  reviewPriority: true,
  reviewRankingCandidate: false,
  reviewRankingExport: false,
  teams: false,
  workbenches: true,
  trunkMergeEta: false,
  reviewPriorityMode: true,
};

function tool(name: string): McpToolDefinition {
  const t = TOOLS.find((x) => x.name === `talyn_${name}`);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

type Route = (url: URL, body: unknown) => unknown;
function mockApi(routes: Record<string, Route>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      const route = routes[`${method} ${url.pathname}`];
      if (!route) throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      return { ok: true, status: 200, json: async () => ({ success: true, data: route(url, body) ?? null }) } as Response;
    }),
  );
  return { calls };
}

const memory = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1',
  workspaceId: 'ws1',
  scope: 'repository',
  repositoryId: 'r1',
  threadId: null,
  type: 'project',
  name: 'build command',
  description: 'How to build',
  bytes: 10,
  source: { kind: 'user' },
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  forgottenAt: null,
  body: 'npm run build',
  ...overrides,
});

const writeArgs = { name: 'build command', description: 'How to build', body: 'npm run build', type: 'project' };

beforeEach(() => {
  vi.mocked(sessionMemoryEnabled).mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('memory tool registry', () => {
  const names = ['memory_write', 'memory_search', 'memory_read', 'memory_forget', 'memory_list'];

  it('has five memory tools behind the workbenches flag', () => {
    const memoryTools = TOOLS.filter((t) => /^talyn_memory_/.test(t.name));
    expect(memoryTools.map((t) => t.name.replace('talyn_', ''))).toEqual(names);
    for (const t of memoryTools) expect(t.feature).toBe('workbenches');
    expect(listToolsFor({ ...features, workbenches: false }).some((t) => /memory/.test(t.name))).toBe(false);
  });

  it('lists every memory tool for a session token', () => {
    const listed = listToolsFor(features, SELF).map((t) => t.name);
    for (const name of names) expect(listed).toContain(`talyn_${name}`);
  });

  it.each([
    ['memory_write', {}],
    ['memory_search', { readOnlyHint: true }],
    ['memory_read', { readOnlyHint: true }],
    ['memory_list', { readOnlyHint: true }],
    ['memory_forget', { destructiveHint: true, idempotentHint: true }],
  ])('%s has the right annotations', (name, expected) => {
    expect(tool(name).annotations).toEqual(expected);
  });
});

describe('memory_write', () => {
  it.each<[string, McpCallContext, Record<string, unknown>, Record<string, unknown>]>([
    ['a session, by default', SELF, {}, { scope: 'repository', repositoryId: 'r1', source: { kind: 'session', workbenchId: 's1' } }],
    ['a session, for the workspace', SELF, { scope: 'workspace' }, { scope: 'workspace', repositoryId: null }],
    ['a session naming its own repository', SELF, { repository_id: 'r1' }, { scope: 'repository', repositoryId: 'r1' }],
    ['a user token, by default', USER, { workspace_id: 'ws1' }, { scope: 'workspace', repositoryId: null }],
    ['a user token with a repository', USER, { workspace_id: 'ws1', repository_id: 'r9' }, { scope: 'repository', repositoryId: 'r9' }],
    ['a user token with a repository, for the workspace', USER, { workspace_id: 'ws1', repository_id: 'r9', scope: 'workspace' }, { scope: 'workspace', repositoryId: null }],
    ['a thread, by default', THREAD, {}, { scope: 'thread', repositoryId: null, threadId: 't1', source: { kind: 'session', workbenchId: 't1' } }],
    ['a thread, for the workspace', THREAD, { scope: 'workspace' }, { scope: 'workspace', repositoryId: null, threadId: null }],
    ['a session in a thread, by default', CHILD, {}, { scope: 'repository', repositoryId: 'r1', threadId: null }],
    ['a session in a thread, for its thread', CHILD, { scope: 'thread' }, { scope: 'thread', repositoryId: null, threadId: 't1' }],
    ['an ordinary thread that names another thread', THREAD, { scope: 'thread', thread_id: 't9' }, { scope: 'thread', threadId: 't1' }],
    ['a review thread, by default', REVIEW, {}, { scope: 'workspace', repositoryId: null, threadId: null, source: { kind: 'session', workbenchId: 'rv' } }],
    ['a review thread, for any repository', REVIEW, { scope: 'repository', repository_id: 'r7' }, { scope: 'repository', repositoryId: 'r7', threadId: null }],
    ['a review thread, for any thread', REVIEW, { scope: 'thread', thread_id: 't9' }, { scope: 'thread', repositoryId: null, threadId: 't9' }],
    ['a review thread, for the workspace with targets', REVIEW, { scope: 'workspace', repository_id: 'r7', thread_id: 't9' }, { scope: 'workspace', repositoryId: null, threadId: null }],
  ])('writes from %s', async (_label, ctx, args, expected) => {
    const { calls } = mockApi({
      'POST /api/v1/workbenches/memory': (_url, body) => ({ entry: memory(body as object), outcome: 'created' }),
    });
    const text = await tool('memory_write').handler(OWNER, { ...writeArgs, ...args }, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ workspaceId: 'ws1', ...writeArgs, ...expected });
    if (!ctx.session) expect(calls[0].body).not.toHaveProperty('source');
    expect(text).toMatch(/^Saved memory entry:/);
  });

  it.each(['created', 'updated'] as const)('adds a %s card to the session transcript', async (outcome) => {
    mockApi({ 'POST /api/v1/workbenches/memory': () => ({ entry: memory(), outcome }) });
    const text = await tool('memory_write').handler(OWNER, writeArgs, SELF);
    expect(announceMemoryChange).toHaveBeenCalledWith('s1', {
      action: outcome, memoryId: 'm1', name: 'build command', memoryType: 'project', scope: 'repository',
    });
    expect(text).toMatch(outcome === 'created' ? /^Saved/ : /^Updated/);
  });

  it('adds no card for a user token', async () => {
    mockApi({ 'POST /api/v1/workbenches/memory': () => ({ entry: memory(), outcome: 'created' }) });
    await tool('memory_write').handler(OWNER, { ...writeArgs, workspace_id: 'ws1' }, USER);
    expect(announceMemoryChange).not.toHaveBeenCalled();
  });

  it.each<[string, McpCallContext, Record<string, unknown>, RegExp]>([
    ['another repository from a session', SELF, { repository_id: 'r2' }, /own repository/],
    ['another workspace from a session', SELF, { workspace_id: 'ws2' }, /own workspace/],
    ['a thread scope outside a thread', SELF, { scope: 'thread' }, /thread entry can only be written/],
    ['a repository scope from a thread', THREAD, { scope: 'repository' }, /thread has no repository/],
    ['an unknown scope', SELF, { scope: 'org' }, /scope must be/],
    ['a repository scope with no repository', USER, { workspace_id: 'ws1', scope: 'repository' }, /needs repository_id/],
    ['an unknown type', SELF, { type: 'note' }, /type must be one of/],
    ['a repository scope with no repository from a review', REVIEW, { scope: 'repository' }, /needs repository_id/],
    ['a thread scope with no thread from a review', REVIEW, { scope: 'thread' }, /needs thread_id/],
    ['an unknown scope from a review', REVIEW, { scope: 'org' }, /scope must be/],
  ])('refuses %s without a write', async (_label, ctx, args, message) => {
    const { calls } = mockApi({});
    await expect(tool('memory_write').handler(OWNER, { ...writeArgs, ...args }, ctx)).rejects.toThrow(message);
    expect(calls).toHaveLength(0);
    expect(announceMemoryChange).not.toHaveBeenCalled();
  });

  it('refuses when the session no longer exists', async () => {
    const { calls } = mockApi({});
    const gone: McpCallContext = { session: { tokenId: 't', workbenchId: 'gone', depth: 0 } };
    await expect(tool('memory_write').handler(OWNER, writeArgs, gone)).rejects.toThrow(/no longer exists/);
    expect(calls).toHaveLength(0);
  });
});

describe('when memory is off', () => {
  it.each<[string, Record<string, unknown>, McpCallContext]>([
    ['memory_write', writeArgs, SELF],
    ['memory_search', { query: 'x' }, SELF],
    ['memory_read', { memory_id: 'm1' }, SELF],
    ['memory_forget', { memory_id: 'm1' }, SELF],
    ['memory_list', {}, SELF],
    ['memory_list', { workspace_id: 'ws1' }, USER],
  ])('%s refuses and calls nothing', async (name, args, ctx) => {
    vi.mocked(sessionMemoryEnabled).mockResolvedValue(false);
    const { calls } = mockApi({});
    await expect(tool(name).handler(OWNER, args, ctx)).rejects.toThrow(/memory is off/);
    expect(calls).toHaveLength(0);
    expect(sessionMemoryEnabled).toHaveBeenCalledWith('ws1', OWNER);
  });
});

describe('memory_search and memory_list', () => {
  it.each<[string, McpCallContext, Record<string, unknown>, Record<string, string>]>([
    ['a session', SELF, {}, { workspaceId: 'ws1', repositoryId: 'r1', q: 'build' }],
    ['a thread', THREAD, {}, { workspaceId: 'ws1', threadId: 't1', q: 'build' }],
    ['a session in a thread', CHILD, {}, { workspaceId: 'ws1', repositoryId: 'r1', threadId: 't1', q: 'build' }],
    ['a user token', USER, { workspace_id: 'ws1' }, { workspaceId: 'ws1', q: 'build' }],
    ['a user token with a repository', USER, { workspace_id: 'ws1', repository_id: 'r9' }, { workspaceId: 'ws1', repositoryId: 'r9', q: 'build' }],
    ['a review thread', REVIEW, {}, { workspaceId: 'ws1', q: 'build' }],
    ['a review thread naming a repository', REVIEW, { repository_id: 'r9' }, { workspaceId: 'ws1', q: 'build' }],
  ])('search from %s asks for what it can see', async (_label, ctx, args, expected) => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches/memory': () => [memory()] });
    const text = await tool('memory_search').handler(OWNER, { ...args, query: 'build' }, ctx);
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual(expected);
    expect(text).toBe('m1  build command  (project, repository r1)  How to build');
  });

  it('search requires a query', async () => {
    await expect(tool('memory_search').handler(OWNER, {}, SELF)).rejects.toThrow(/query is required/);
  });

  it.each([
    [undefined, ['m1', 'm2']],
    ['workspace', ['m2']],
    ['repository', ['m1']],
  ])('list with scope %s', async (scope, ids) => {
    mockApi({
      'GET /api/v1/workbenches/memory': () => [memory(), memory({ id: 'm2', scope: 'workspace', repositoryId: null })],
    });
    const text = await tool('memory_list').handler(OWNER, scope ? { scope } : {}, SELF);
    expect(text.split('\n').map((line) => line.split('  ')[0])).toEqual(ids);
  });

  it('list says None when empty', async () => {
    mockApi({ 'GET /api/v1/workbenches/memory': () => [] });
    expect(await tool('memory_list').handler(OWNER, {}, SELF)).toBe('None.');
  });
});

describe('memory_read and memory_forget', () => {
  it.each<[string, Record<string, unknown>, McpCallContext, boolean]>([
    ['its own repository entry', {}, SELF, true],
    ['a workspace entry', { scope: 'workspace', repositoryId: null }, SELF, true],
    ['a thread entry with its own id, outside a thread', { scope: 'thread', repositoryId: null, threadId: 's1' }, SELF, false],
    ['its own thread entry, as a thread', { scope: 'thread', repositoryId: null, threadId: 't1' }, THREAD, true],
    ['its thread entry, as a session in the thread', { scope: 'thread', repositoryId: null, threadId: 't1' }, CHILD, true],
    ['a repository entry, as a thread', {}, THREAD, false],
    ['another repository entry', { repositoryId: 'r2' }, SELF, false],
    ['another thread entry', { scope: 'thread', repositoryId: null, threadId: 's9' }, SELF, false],
    ['another workspace entry', { workspaceId: 'ws2', scope: 'workspace', repositoryId: null }, SELF, false],
    ['another repository entry, as a user token', { repositoryId: 'r2' }, { }, true],
    ['any repository entry, as a review thread', { repositoryId: 'r2' }, REVIEW, true],
    ['any thread entry, as a review thread', { scope: 'thread', repositoryId: null, threadId: 's9' }, REVIEW, true],
    ['another workspace entry, as a review thread', { workspaceId: 'ws2', scope: 'workspace', repositoryId: null }, REVIEW, false],
  ])('a session reads %s: %s', async (_label, overrides, ctx, visible) => {
    mockApi({ 'GET /api/v1/workbenches/memory/m1': () => memory(overrides) });
    const read = tool('memory_read').handler(OWNER, { memory_id: 'm1', ...(ctx.session ? {} : { workspace_id: 'ws1' }) }, ctx);
    if (visible) expect(await read).toMatch(/\n\nnpm run build$/);
    else await expect(read).rejects.toThrow('Memory entry not found.');
  });

  it('forgets a visible entry and adds a card', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/memory/m1': () => memory(),
      'DELETE /api/v1/workbenches/memory/m1': () => memory({ forgottenAt: '2026-10-02T10:00:00Z' }),
    });
    const text = await tool('memory_forget').handler(OWNER, { memory_id: 'm1' }, SELF);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(text).toMatch(/^Forgot memory entry:/);
    expect(announceMemoryChange).toHaveBeenCalledWith('s1', {
      action: 'forgotten', memoryId: 'm1', name: 'build command', memoryType: 'project', scope: 'repository',
    });
  });

  it.each([
    ['an entry it cannot see', { repositoryId: 'r2' }, 'Memory entry not found.'],
  ])('does not forget %s', async (_label, overrides, message) => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches/memory/m1': () => memory(overrides) });
    await expect(tool('memory_forget').handler(OWNER, { memory_id: 'm1' }, SELF)).rejects.toThrow(message);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(announceMemoryChange).not.toHaveBeenCalled();
  });

  it('answers an already forgotten entry without a second forget', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/memory/m1': () => memory({ forgottenAt: '2026-10-02T10:00:00Z' }),
    });
    expect(await tool('memory_forget').handler(OWNER, { memory_id: 'm1' }, SELF)).toMatch(/^Already forgotten/);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
    expect(announceMemoryChange).not.toHaveBeenCalled();
  });

  it('a session loads its workbench, not the workspace list', async () => {
    mockApi({ 'GET /api/v1/workbenches/memory/m1': () => memory() });
    await tool('memory_read').handler(OWNER, { memory_id: 'm1' }, SELF);
    expect(getWorkbench).toHaveBeenCalledWith('s1');
  });
});

describe('memory_read and memory_forget by name', () => {
  const NAME = 'sandbox-docker-and-test-db-setup';
  const summary = (overrides: Record<string, unknown> = {}) => {
    const { body: _body, ...rest } = memory({ name: NAME, ...overrides });
    return rest;
  };

  /** No entry has the name as its id; the list answers `rows`; an id read answers from `byId`. */
  function mockNames(rows: Record<string, unknown>[], byId: Record<string, Record<string, unknown>> = {}) {
    const calls: { method: string; url: URL }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        const method = (init.method ?? 'GET').toUpperCase();
        calls.push({ method, url });
        const respond = (status: number, payload: unknown) => ({ ok: status < 300, status, json: async () => payload }) as Response;
        if (method === 'GET' && url.pathname === '/api/v1/workbenches/memory') return respond(200, { success: true, data: rows });
        const id = decodeURIComponent(url.pathname.replace('/api/v1/workbenches/memory/', ''));
        const found = byId[id];
        if (!found) return respond(404, { success: false, error: 'Memory entry not found', code: 'memory_not_found' });
        if (method === 'DELETE') return respond(200, { success: true, data: { ...found, forgottenAt: '2026-11-03T10:00:00Z' } });
        return respond(200, { success: true, data: found });
      }),
    );
    return { calls };
  }

  it('reads by id without a name lookup', async () => {
    const { calls } = mockNames([], { m1: memory() });
    expect(await tool('memory_read').handler(OWNER, { memory_id: 'm1' }, SELF)).toMatch(/\n\nnpm run build$/);
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/workbenches/memory/m1']);
  });

  it('reads by the name the index shows, in the scopes the session sees', async () => {
    const { calls } = mockNames([summary()], { m1: memory({ name: NAME }) });
    const text = await tool('memory_read').handler(OWNER, { memory_id: NAME }, SELF);
    expect(text).toMatch(new RegExp(`^m1  ${NAME}  \\(project, repository r1\\)`));
    expect(text).toMatch(/\n\nnpm run build$/);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      `GET /api/v1/workbenches/memory/${NAME}`,
      'GET /api/v1/workbenches/memory',
      'GET /api/v1/workbenches/memory/m1',
    ]);
    expect(Object.fromEntries(calls[1].url.searchParams)).toEqual({ workspaceId: 'ws1', repositoryId: 'r1', name: NAME });
  });

  it.each<[string, McpCallContext, Record<string, unknown>[], string]>([
    ['the repository entry over the workspace one', SELF, [summary({ id: 'w1', scope: 'workspace', repositoryId: null }), summary()], 'm1'],
    ['the thread entry over the repository one', CHILD, [summary(), summary({ id: 't9', scope: 'thread', repositoryId: null, threadId: 't1' })], 't9'],
  ])('prefers %s, and names the other', async (_label, ctx, rows, expected) => {
    const byId = Object.fromEntries(rows.map((row) => [row.id as string, { ...row, body: `body of ${row.id as string}` }]));
    mockNames(rows, byId);
    const text = await tool('memory_read').handler(OWNER, { memory_id: NAME }, ctx);
    expect(text.split('\n')[0]).toMatch(new RegExp(`^${expected}  `));
    expect(text).toMatch(new RegExp(`\\n\\nbody of ${expected}$`));
    expect(text).toContain('Other entries with this name, in wider scopes:');
  });

  it('refuses a name two repositories have, for a user token, and lists both', async () => {
    const { calls } = mockNames([summary(), summary({ id: 'm2', repositoryId: 'r2' })]);
    const read = tool('memory_read').handler(OWNER, { workspace_id: 'ws1', memory_id: NAME }, USER);
    await expect(read).rejects.toThrow(/More than one memory entry is named "sandbox-docker-and-test-db-setup"/);
    await expect(tool('memory_read').handler(OWNER, { workspace_id: 'ws1', memory_id: NAME }, USER)).rejects.toThrow(
      /m1 .*repository r1[\s\S]*m2 .*repository r2/,
    );
    expect(calls.some((c) => c.url.pathname.endsWith('/m1') || c.url.pathname.endsWith('/m2'))).toBe(false);
  });

  it('narrows a user token to the repository it names', async () => {
    const { calls } = mockNames([summary()], { m1: memory({ name: NAME }) });
    await tool('memory_read').handler(OWNER, { workspace_id: 'ws1', repository_id: 'r1', memory_id: NAME }, USER);
    expect(calls[1].url.searchParams.get('repositoryId')).toBe('r1');
  });

  it.each<[string, Record<string, unknown>[]]>([
    ['no entry has the name', []],
    ['the only match is in another workspace', [summary({ workspaceId: 'ws2' })]],
    ['the only match is another repository', [summary({ repositoryId: 'r2' })]],
    ['the only match is forgotten', [summary({ forgottenAt: '2026-11-01T10:00:00Z' })]],
  ])('answers not found when %s', async (_label, rows) => {
    const { calls } = mockNames(rows, Object.fromEntries(rows.map((row) => [row.id as string, { ...row, body: 'b' }])));
    await expect(tool('memory_read').handler(OWNER, { memory_id: NAME }, SELF)).rejects.toThrow(
      `Memory entry not found. No entry you can see has the id or name "${NAME}". Find it with talyn_memory_search or talyn_memory_list.`,
    );
    expect(calls).toHaveLength(2);
  });

  it('forgets by a name only one entry has', async () => {
    const { calls } = mockNames([summary()], { m1: memory({ name: NAME }) });
    expect(await tool('memory_forget').handler(OWNER, { memory_id: NAME }, SELF)).toMatch(/^Forgot memory entry:\nm1 /);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`).at(-1)).toBe('DELETE /api/v1/workbenches/memory/m1');
    expect(announceMemoryChange).toHaveBeenCalledWith('s1', expect.objectContaining({ action: 'forgotten', memoryId: 'm1' }));
  });

  it.each<[string, McpCallContext, Record<string, unknown>, Record<string, unknown>[]]>([
    ['a session that sees it in two scopes', SELF, {}, [summary(), summary({ id: 'w1', scope: 'workspace', repositoryId: null })]],
    ['a user token that sees it in two repositories', USER, { workspace_id: 'ws1' }, [summary(), summary({ id: 'm2', repositoryId: 'r2' })]],
  ])('refuses to forget a name that %s', async (_label, ctx, args, rows) => {
    const byId = Object.fromEntries(rows.map((row) => [row.id as string, { ...row, body: 'b' }]));
    const { calls } = mockNames(rows, byId);
    await expect(tool('memory_forget').handler(OWNER, { ...args, memory_id: NAME }, ctx)).rejects.toThrow(
      /More than one memory entry is named[\s\S]*Send the id/,
    );
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(announceMemoryChange).not.toHaveBeenCalled();
  });
});
