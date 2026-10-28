import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Features } from '@talyn/shared';
import { listToolsFor } from '../mcp/server.js';
import { TOOLS, type McpToolDefinition } from '../mcp/tools/index.js';

const OWNER = 'user-test';
const LOCAL_MESSAGE =
  "This session runs on the user's own machine in the Talyn desktop app; open it there.";

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
      const out = route(url, body);
      const response =
        out && typeof out === 'object' && 'status' in out && 'body' in out
          ? (out as { status: number; body: unknown })
          : { status: 200, body: { success: true, data: out ?? null } };
      return {
        ok: response.status < 300,
        status: response.status,
        json: async () => response.body,
      } as Response;
    })
  );
  return { calls };
}

const chat = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  workbenchId: 's1',
  title: 'Chat',
  agent: 'claude',
  model: null,
  effort: null,
  planMode: false,
  agentSessionId: null,
  status: 'idle',
  queuedMessages: [],
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  ...overrides,
});
const session = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  workspaceId: 'ws1',
  repositoryId: 'r1',
  repoFullName: 'acme/web',
  name: 'oslo',
  branch: 'tom/oslo',
  baseBranch: 'main',
  runtime: 'sandbox',
  agent: 'claude',
  sandboxState: 'running',
  status: 'ready',
  pullRequestId: null,
  settings: {},
  diffStat: null,
  archivedAt: null,
  chats: [chat(), chat({ id: 'c2', title: 'Second' })],
  ...overrides,
});
const local = () => session({ runtime: 'local', id: 'sl' });

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
  slack: false,
  reviewPriorityMode: true,
};

const userEvent = (seq: number, text: string) => ({
  chatId: 'c1',
  seq,
  turn: 1,
  event: {
    seq,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    talyn: { kind: 'user_message', messageId: `m${seq}` },
  },
});
const assistantEvent = (seq: number, text: string) => ({
  chatId: 'c1',
  seq,
  turn: 1,
  event: { seq, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
});

describe('session tools', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hides the group when the workbenches flag is off', () => {
    const names = listToolsFor({ ...features, workbenches: false }).map((t) => t.name);
    expect(names.some((n) => /session/.test(n))).toBe(false);
    expect(listToolsFor(features).map((t) => t.name)).toContain('talyn_list_sessions');
    expect(listToolsFor(null).map((t) => t.name)).toContain('talyn_list_sessions');
  });

  it('marks every session tool with the workbenches feature', () => {
    const sessions = TOOLS.filter((t) => /^talyn_\w*session/.test(t.name));
    expect(sessions).toHaveLength(13);
    for (const t of sessions) expect(t.feature).toBe('workbenches');
  });

  it.each([
    ['archive_session', { destructiveHint: true, idempotentHint: true }],
    ['cancel_session_turn', { destructiveHint: true, idempotentHint: true }],
    ['list_sessions', { readOnlyHint: true }],
    ['get_session_diff', { readOnlyHint: true }],
    ['create_session', { openWorldHint: true }],
    ['open_session_pull_request', { openWorldHint: true }],
  ])('%s has the right annotations', (name, expected) => {
    expect(tool(name).annotations).toMatchObject(expected);
  });

  it.each([
    [{ workspace_id: 'ws1' }, 'ws1', null],
    [{ workspace_id: 'ws1', include_archived: true }, 'ws1', 'true'],
  ])('list_sessions %j', async (args, workspaceId, archived) => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches': () => [session()] });
    const text = await tool('list_sessions').handler(OWNER, args);
    expect(calls[0].url.searchParams.get('workspaceId')).toBe(workspaceId);
    expect(calls[0].url.searchParams.get('includeArchived')).toBe(archived);
    expect(text).toContain('s1  oslo  [ready]  sandbox/claude  acme/web@tom/oslo');
  });

  it('get_session lists its chats', async () => {
    mockApi({ 'GET /api/v1/workbenches/s1': () => session() });
    const text = await tool('get_session').handler(OWNER, { session_id: 's1' });
    expect(text).toContain('c1  "Chat"  [idle]');
    expect(text).toContain('c2  "Second"');
  });

  it.each([
    [
      { workspace_id: 'ws1', repository_id: 'r1', agent: 'codex', prompt: 'Fix it', internet_access: false },
      { workspaceId: 'ws1', repositoryId: 'r1', runtime: 'sandbox', agent: 'codex', prompt: 'Fix it', internetAccess: false },
    ],
    [
      { workspace_id: 'ws1', repository_id: 'r1', agent: 'claude', pull_request_id: 'pr1', base_branch: 'dev', auto_create_pr: true, name: 'x' },
      { workspaceId: 'ws1', repositoryId: 'r1', runtime: 'sandbox', agent: 'claude', fromPullRequestId: 'pr1', baseBranch: 'dev', autoCreatePr: true, name: 'x' },
    ],
  ])('create_session %j', async (args, body) => {
    const { calls } = mockApi({ 'POST /api/v1/workbenches': () => session() });
    await tool('create_session').handler(OWNER, args);
    expect(calls[0].body).toEqual(body);
  });

  it('create_session rejects an unknown agent', async () => {
    mockApi({});
    await expect(
      tool('create_session').handler(OWNER, { workspace_id: 'ws1', repository_id: 'r1', agent: 'gpt' })
    ).rejects.toThrow('agent must be');
  });

  it('send_session_message uses the first chat of a session', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'POST /api/v1/workbenches/chats/c1/messages': () => ({ queued: false }),
    });
    const text = await tool('send_session_message').handler(OWNER, {
      session_id: 's1',
      text: 'hello',
      effort: 'low',
    });
    expect(calls[1].body).toEqual({ text: 'hello', effort: 'low' });
    expect(text).toContain('A turn started');
  });

  it('send_session_message with a chat id skips the session lookup and reports a queue', async () => {
    const { calls } = mockApi({
      'POST /api/v1/workbenches/chats/c2/messages': () => ({ queued: true }),
    });
    const text = await tool('send_session_message').handler(OWNER, { chat_id: 'c2', text: 'again' });
    expect(calls).toHaveLength(1);
    expect(text).toContain('queued');
  });

  it('send_session_message needs a target', async () => {
    mockApi({});
    await expect(tool('send_session_message').handler(OWNER, { text: 'x' })).rejects.toThrow(
      'session_id or chat_id is required'
    );
  });

  it.each([
    ['send_session_message', { session_id: 'sl', text: 'x' }],
    ['cancel_session_turn', { session_id: 'sl' }],
    ['run_session_script', { session_id: 'sl', name: 'dev' }],
    ['stop_session_script', { session_id: 'sl', name: 'dev' }],
    ['get_session_changes', { session_id: 'sl' }],
    ['get_session_diff', { session_id: 'sl' }],
    ['open_session_pull_request', { session_id: 'sl', title: 'T' }],
  ])('%s refuses a local session', async (name, args) => {
    const { calls } = mockApi({ 'GET /api/v1/workbenches/sl': () => local() });
    await expect(tool(name).handler(OWNER, args)).rejects.toThrow(LOCAL_MESSAGE);
    expect(calls).toHaveLength(1);
  });

  it('maps the route refusal for a local chat to the same message', async () => {
    mockApi({
      'POST /api/v1/workbenches/chats/cl/cancel': () => ({
        status: 409,
        body: { success: false, error: 'This session runs on your machine.', code: 'local_runtime' },
      }),
    });
    await expect(tool('cancel_session_turn').handler(OWNER, { chat_id: 'cl' })).rejects.toThrow(
      LOCAL_MESSAGE
    );
  });

  it('passes other route errors through with their code', async () => {
    mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'POST /api/v1/workbenches/chats/c1/messages': () => ({
        status: 409,
        body: { success: false, error: 'This session is archived.', code: 'not_ready' },
      }),
    });
    await expect(
      tool('send_session_message').handler(OWNER, { session_id: 's1', text: 'x' })
    ).rejects.toThrow('This session is archived. (code: not_ready)');
  });

  it('cancel_session_turn posts to the cancel route', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'POST /api/v1/workbenches/chats/c1/cancel': () => null,
    });
    await tool('cancel_session_turn').handler(OWNER, { session_id: 's1' });
    expect(calls.at(-1)?.method).toBe('POST');
  });

  it('get_session_transcript renders text and a cursor', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'GET /api/v1/workbenches/chats/c1/events': () => ({
        events: [userEvent(1, 'Fix the bug'), assistantEvent(2, 'On it.')],
        cursor: 2,
      }),
    });
    const text = await tool('get_session_transcript').handler(OWNER, {
      session_id: 's1',
      cursor: 0,
      limit: 2,
    });
    expect(calls[1].url.searchParams.get('after')).toBe('0');
    expect(calls[1].url.searchParams.get('limit')).toBe('2');
    expect(text).toContain('user: Fix the bug\nassistant: On it.');
    expect(text).toContain('pass cursor=2');
  });

  it('get_session_transcript says when the transcript ends', async () => {
    mockApi({
      'GET /api/v1/workbenches/chats/c1/events': () => ({ events: [assistantEvent(5, 'Done')], cursor: 5 }),
    });
    const text = await tool('get_session_transcript').handler(OWNER, { chat_id: 'c1', cursor: 4 });
    expect(text).toContain('End of the transcript so far');
    expect(text).toContain('cursor=5');
  });

  it('get_session_transcript reads an empty page', async () => {
    mockApi({ 'GET /api/v1/workbenches/chats/c1/events': () => ({ events: [], cursor: 9 }) });
    expect(await tool('get_session_transcript').handler(OWNER, { chat_id: 'c1', cursor: 9 })).toBe(
      'No events after cursor 9.'
    );
  });

  it('get_session_transcript cuts by whole events and gives the cursor to continue', async () => {
    const big = 'x'.repeat(12_000);
    mockApi({
      'GET /api/v1/workbenches/chats/c1/events': () => ({
        events: [1, 2, 3, 4].map((seq) => assistantEvent(seq, big)),
        cursor: 4,
      }),
    });
    const text = await tool('get_session_transcript').handler(OWNER, { chat_id: 'c1' });
    expect(text.match(/assistant:/g)).toHaveLength(2);
    expect(text).toContain('Output cut');
    expect(text).toContain('pass cursor=2');
  });

  it.each([{ limit: 0 }, { limit: 5000 }, { cursor: -1 }, { cursor: 'a' }])(
    'get_session_transcript rejects %j',
    async (extra) => {
      mockApi({});
      await expect(
        tool('get_session_transcript').handler(OWNER, { chat_id: 'c1', ...extra })
      ).rejects.toThrow();
    }
  );

  it('get_session_changes lists files', async () => {
    mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'GET /api/v1/workbenches/s1/changes': () => ({
        files: [
          { path: 'a.ts', status: 'modified', added: 3, removed: 1, binary: false },
          { path: 'b.png', status: 'added', added: 0, removed: 0, binary: true },
        ],
        base: 'abc',
        headSha: 'def',
      }),
    });
    const text = await tool('get_session_changes').handler(OWNER, { session_id: 's1' });
    expect(text).toContain('a.ts  modified  +3/-1');
    expect(text).toContain('b.png  added  binary');
    expect(text).toContain('head: def');
  });

  it.each([
    [{ session_id: 's1' }, null],
    [{ session_id: 's1', path: 'src/a b.ts' }, 'src/a b.ts'],
  ])('get_session_diff %j', async (args, path) => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'GET /api/v1/workbenches/s1/diff': () => ({ patch: 'diff --git a b' }),
    });
    expect(await tool('get_session_diff').handler(OWNER, args)).toBe('diff --git a b');
    expect(calls[1].url.searchParams.get('path')).toBe(path);
  });

  it('get_session_diff caps a large diff and says how to read less', async () => {
    mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'GET /api/v1/workbenches/s1/diff': () => ({ patch: 'y'.repeat(50_000) }),
    });
    const text = await tool('get_session_diff').handler(OWNER, { session_id: 's1' });
    expect(text.length).toBeLessThan(31_000);
    expect(text).toContain('Output cut at 30000 of 50000 characters');
    expect(text).toContain('Pass path');
  });

  it('get_session_diff reports an empty diff', async () => {
    mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'GET /api/v1/workbenches/s1/diff': () => ({ patch: '' }),
    });
    expect(await tool('get_session_diff').handler(OWNER, { session_id: 's1' })).toBe('No diff.');
  });

  it.each([
    [{ title: 'Add x' }, { title: 'Add x' }, false],
    [
      { title: 'Add x', body: 'Why', base: 'dev', draft: true, commit_message: 'wip' },
      { title: 'Add x', body: 'Why', base: 'dev', draft: true, commitMessage: 'wip' },
      true,
    ],
  ])('open_session_pull_request %j', async (extra, body, existing) => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      'POST /api/v1/workbenches/s1/pull-request': () => ({
        workbench: session(),
        pullRequest: { number: 7, url: 'https://github.com/acme/web/pull/7' },
        existing,
      }),
    });
    const text = await tool('open_session_pull_request').handler(OWNER, { session_id: 's1', ...extra });
    expect(calls[1].body).toEqual(body);
    expect(text).toContain(existing ? 'Linked the open pull request #7' : 'Opened pull request #7');
  });

  it.each([
    ['run_session_script', '/scripts/dev%20server'],
    ['stop_session_script', '/scripts/dev%20server/stop'],
  ])('%s calls its route', async (name, suffix) => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/s1': () => session(),
      [`POST /api/v1/workbenches/s1${suffix}`]: () => null,
    });
    await tool(name).handler(OWNER, { session_id: 's1', name: 'dev server' });
    expect(calls[1].method).toBe('POST');
  });

  it.each([
    ['archive_session', 'archive'],
    ['restore_session', 'restore'],
  ])('%s calls POST /%s', async (name, action) => {
    const { calls } = mockApi({
      [`POST /api/v1/workbenches/s1/${action}`]: () => session({ archivedAt: action === 'archive' ? 'now' : null }),
    });
    const text = await tool(name).handler(OWNER, { session_id: 's1' });
    expect(calls).toHaveLength(1);
    expect(text).toContain('s1  oslo');
  });

  it.each([
    'get_session',
    'archive_session',
    'restore_session',
    'get_session_changes',
    'get_session_diff',
    'run_session_script',
  ])('%s requires a session id', async (name) => {
    mockApi({});
    await expect(tool(name).handler(OWNER, { name: 'dev' })).rejects.toThrow('session_id is required');
  });
});
