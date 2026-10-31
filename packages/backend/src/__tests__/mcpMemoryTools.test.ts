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
  getWorkbench: vi.fn(async (id: string) =>
    id === 's1' ? { id: 's1', workspaceId: 'ws1', repositoryId: 'r1' } : null,
  ),
}));

const OWNER = 'user-test';
const SELF: McpCallContext = { session: { tokenId: 'token-1', workbenchId: 's1', depth: 0 } };
const USER: McpCallContext = {};

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
    ['a thread scope', SELF, { scope: 'thread' }, /scope must be/],
    ['a repository scope with no repository', USER, { workspace_id: 'ws1', scope: 'repository' }, /needs repository_id/],
    ['an unknown type', SELF, { type: 'note' }, /type must be one of/],
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
    ['a session', SELF, {}, { workspaceId: 'ws1', repositoryId: 'r1', threadId: 's1', q: 'build' }],
    ['a user token', USER, { workspace_id: 'ws1' }, { workspaceId: 'ws1', q: 'build' }],
    ['a user token with a repository', USER, { workspace_id: 'ws1', repository_id: 'r9' }, { workspaceId: 'ws1', repositoryId: 'r9', q: 'build' }],
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
    ['its own thread entry', { scope: 'thread', repositoryId: null, threadId: 's1' }, SELF, true],
    ['another repository entry', { repositoryId: 'r2' }, SELF, false],
    ['another thread entry', { scope: 'thread', repositoryId: null, threadId: 's9' }, SELF, false],
    ['another workspace entry', { workspaceId: 'ws2', scope: 'workspace', repositoryId: null }, SELF, false],
    ['another repository entry, as a user token', { repositoryId: 'r2' }, { }, true],
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
