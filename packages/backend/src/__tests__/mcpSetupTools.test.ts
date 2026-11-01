import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_TOKEN_TOOLS } from '../mcp/sessionScope.js';
import { TOOLS, type McpCallContext, type McpToolDefinition } from '../mcp/tools/index.js';

const OWNER = 'user-test';
const SELF: McpCallContext = { session: { tokenId: 'token-1', workbenchId: 's1', depth: 0 } };
const THREAD: McpCallContext = { session: { tokenId: 'token-2', workbenchId: 'thread1', depth: 0 } };

function tool(name: string): McpToolDefinition {
  const t = TOOLS.find((x) => x.name === `talyn_${name}`);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

type Route = (url: URL, body: unknown) => unknown;
function mockApi(routes: Record<string, Route>, failures: Record<string, { status: number; error: string; code?: string }> = {}) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      const key = `${method} ${url.pathname}`;
      const failure = failures[key];
      if (failure) {
        return { ok: false, status: failure.status, json: async () => ({ success: false, error: failure.error, code: failure.code }) } as Response;
      }
      const route = routes[key];
      if (!route) throw new Error(`Unexpected request: ${key}`);
      return { ok: true, status: 200, json: async () => ({ success: true, data: route(url, body) ?? null }) } as Response;
    })
  );
  return { calls };
}

const wb = (overrides: Record<string, unknown> = {}) => ({
  id: 's1', workspaceId: 'ws1', name: 's1', title: 'Session', kind: 'session', threadId: null,
  repositoryId: 'repo1', repoFullName: 'posthog/posthog', runtime: 'sandbox', agent: 'claude', settings: {}, chats: [], ...overrides,
});

const timing = {
  workbenchId: 's1',
  turns: 2,
  wallMs: 6_600_000,
  toolMs: 5_000_000,
  modelMs: 1_600_000,
  calls: 40,
  categories: {
    model: { ms: 1_600_000, count: 0 },
    waiting: { ms: 2_880_000, count: 12 },
    tests: { ms: 1_500_000, count: 4 },
    installs: { ms: 600_000, count: 2 },
  },
  slowest: [
    { category: 'tests', name: 'Bash', command: 'pytest posthog -x', ms: 1_200_000, isError: true },
    { category: 'installs', name: 'Bash', command: 'cargo install sqlx-cli', ms: 600_000 },
  ],
  recentTurns: [],
};

afterEach(() => vi.unstubAllGlobals());

describe('session setup and timing tools', () => {
  it('are in the session allow-list', () => {
    expect(SESSION_TOKEN_TOOLS.has('talyn_session_timing')).toBe(true);
    expect(SESSION_TOKEN_TOOLS.has('talyn_record_setup_step')).toBe(true);
    expect(tool('session_timing').annotations.readOnlyHint).toBe(true);
  });

  describe('session_timing', () => {
    it('reads the calling session by default and shows categories, largest first, and the slowest calls', async () => {
      const { calls } = mockApi({ 'GET /api/v1/workbenches/s1/timing': () => timing });
      const text = await tool('session_timing').handler(OWNER, {}, SELF);
      expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/workbenches/s1/timing']);
      expect(text).toContain('2 turn(s), 1h 50m in all, 40 tool call(s)');
      expect(text).toContain('Waiting (sleep and polling): 48m 0s (44%) in 12 call(s)');
      expect(text.indexOf('Waiting')).toBeLessThan(text.indexOf('Tests'));
      expect(text).toContain('Model: 26m 40s (24%)');
      expect(text).toContain('20m 0s  tests  pytest posthog -x  (failed)');
    });

    it('reads a session of the calling thread', async () => {
      const { calls } = mockApi({
        'GET /api/v1/workbenches/s1': () => wb({ threadId: 'thread1' }),
        'GET /api/v1/workbenches/s1/timing': () => timing,
      });
      await tool('session_timing').handler(OWNER, { session_id: 's1' }, THREAD);
      expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/workbenches/s1', '/api/v1/workbenches/s1/timing']);
    });

    it('refuses a session outside the caller and its thread', async () => {
      const { calls } = mockApi({ 'GET /api/v1/workbenches/other': () => wb({ id: 'other', threadId: 'thread9' }) });
      await expect(tool('session_timing').handler(OWNER, { session_id: 'other' }, SELF)).rejects.toThrow(/itself, or a session in its thread/);
      expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/workbenches/other']);
    });

    it('reads any session for a user token, and needs a session id there', async () => {
      mockApi({ 'GET /api/v1/workbenches/other/timing': () => ({ ...timing, workbenchId: 'other', turns: 0 }) });
      expect(await tool('session_timing').handler(OWNER, { session_id: 'other' })).toContain('has no time report yet');
      await expect(tool('session_timing').handler(OWNER, {})).rejects.toThrow('session_id is required');
    });
  });

  describe('record_setup_step', () => {
    const recorded = { steps: [{ id: 'st_1', command: 'cargo install sqlx-cli', kind: 'cargo', phase: 'install' }] };

    it("adds the step to the calling session's repository", async () => {
      const { calls } = mockApi({
        'GET /api/v1/workbenches/s1': () => wb(),
        'POST /api/v1/repositories/repo1/setup-recipe/steps': () => recorded,
      });
      const text = await tool('record_setup_step').handler(OWNER, { command: 'cargo install sqlx-cli', why: 'migrations need sqlx' }, SELF);
      expect(calls[1].body).toEqual({ command: 'cargo install sqlx-cli', why: 'migrations need sqlx', sessionId: 's1' });
      expect(text).toContain('Added to the setup of posthog/posthog');
      expect(text).toContain('st_1  [cargo, box setup and bake]  cargo install sqlx-cli');
    });

    it("passes on the backend's refusal", async () => {
      mockApi(
        { 'GET /api/v1/workbenches/s1': () => wb() },
        { 'POST /api/v1/repositories/repo1/setup-recipe/steps': { status: 400, error: 'The command looks like it contains a secret', code: 'setup_step_refused' } },
      );
      await expect(tool('record_setup_step').handler(OWNER, { command: 'export TOKEN=x', why: 'y' }, SELF)).rejects.toThrow(/secret/);
    });

    it.each([
      ['a thread', wb({ id: 's1', kind: 'thread', repositoryId: null, repoFullName: '' }), /thread has no repository/],
      ['a local session', wb({ runtime: 'local' }), /user's own machine/],
    ])('refuses %s', async (_name, session, error) => {
      const { calls } = mockApi({ 'GET /api/v1/workbenches/s1': () => session });
      await expect(tool('record_setup_step').handler(OWNER, { command: 'cargo install x', why: 'y' }, SELF)).rejects.toThrow(error);
      expect(calls.every((c) => c.method === 'GET')).toBe(true);
    });

    it('refuses a session outside the caller and its thread', async () => {
      const { calls } = mockApi({ 'GET /api/v1/workbenches/other': () => wb({ id: 'other', threadId: null }) });
      await expect(tool('record_setup_step').handler(OWNER, { command: 'cargo install x', why: 'y', session_id: 'other' }, SELF))
        .rejects.toThrow(/itself, or a session in its thread/);
      expect(calls.every((c) => c.method === 'GET')).toBe(true);
    });

    it.each([
      [{ why: 'y' }, 'command is required'],
      [{ command: 'cargo install x' }, 'why is required'],
    ])('needs %j', async (args, error) => {
      mockApi({});
      await expect(tool('record_setup_step').handler(OWNER, args, SELF)).rejects.toThrow(error);
    });
  });
});
