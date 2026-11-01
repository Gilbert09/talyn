import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_TOKEN_TOOLS } from '../mcp/sessionScope.js';
import { TOOLS, type McpCallContext, type McpToolDefinition } from '../mcp/tools/index.js';

const OWNER = 'user-test';
const SELF: McpCallContext = { session: { tokenId: 'token-1', workbenchId: 'thread1', depth: 0 } };

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
    })
  );
  return { calls };
}

const wb = (overrides: Record<string, unknown> = {}) => ({
  id: 'thread1', workspaceId: 'ws1', name: 'thread', title: 'Thread', kind: 'thread', threadId: null,
  runtime: 'sandbox', agent: 'claude', settings: { fleetAccountId: 'a1' }, chats: [], ...overrides,
});

const accounts = {
  accounts: [
    { id: 'a1', agent: 'claude', kind: 'claude_oauth', label: 'Todiex', priority: 1, needsReauth: false, over: true,
      held: { until: '2026-11-01T16:00:00.000Z' },
      usage: { fetchedAt: 'x', windows: [{ key: 'session', label: '5-hour', usedPercent: 100, resetsAt: null }] } },
    { id: 'a2', agent: 'claude', kind: 'claude_oauth', label: 'Teams', priority: 2, needsReauth: false, over: false, held: null,
      usage: { fetchedAt: 'x', windows: [{ key: 'session', label: '5-hour', usedPercent: 12, resetsAt: null }] } },
    { id: 'c1', agent: 'codex', kind: 'codex_oauth', label: 'Codex', priority: 1, needsReauth: true, over: true, held: null, usage: null },
  ],
  switchAtPercent: 95,
  active: { claude: 'a2', codex: null },
};

afterEach(() => vi.unstubAllGlobals());

describe('session account tools', () => {
  it('are in the session allow-list', () => {
    expect(SESSION_TOKEN_TOOLS.has('talyn_list_accounts')).toBe(true);
    expect(SESSION_TOKEN_TOOLS.has('talyn_set_session_account')).toBe(true);
  });

  it('list_accounts shows usage, holds, reauth and each thread session account, with no secrets', async () => {
    mockApi({
      'GET /api/v1/workbenches/thread1': () => wb(),
      'GET /api/v1/workbenches/thread1/sessions': () => [
        wb({ id: 's2', name: 'child', title: 'Child', kind: 'session', threadId: 'thread1', settings: { fleetAccountId: 'a2' } }),
        wb({ id: 's3', name: 'fresh', title: 'Fresh', kind: 'session', threadId: 'thread1', settings: {} }),
      ],
      'GET /api/v1/cloud-providers/selfhosted/accounts': () => accounts,
    });
    const text = await tool('list_accounts').handler(OWNER, {}, SELF);
    expect(text).toContain('"Todiex"');
    expect(text).toContain('rate limited or out of usage until 2026-11-01T16:00:00.000Z');
    expect(text).toContain('5-hour 100%');
    expect(text).toContain('5-hour 12%');
    expect(text).toContain('needs to be signed in again');
    expect(text).toMatch(/thread1.*\(this session\).*account: "Todiex" a1/);
    expect(text).toMatch(/s2.*account: "Teams" a2/);
    expect(text).toMatch(/s3.*not chosen yet/);
    expect(text).not.toMatch(/token|secret|credential/i);
  });

  it('list_accounts says so when no account is connected', async () => {
    mockApi({
      'GET /api/v1/workbenches/thread1': () => wb({ kind: 'session' }),
      'GET /api/v1/cloud-providers/selfhosted/accounts': () => ({ accounts: [], switchAtPercent: 95, active: {} }),
    });
    expect(await tool('list_accounts').handler(OWNER, {}, SELF)).toBe('No Claude or Codex accounts are connected.');
  });

  it('set_session_account sets the caller session by default', async () => {
    const { calls } = mockApi({ 'PUT /api/v1/workbenches/thread1/account': () => wb() });
    const text = await tool('set_session_account').handler(OWNER, { account_id: 'a2' }, SELF);
    expect(text).toContain('next turn');
    expect(calls[0].body).toEqual({ accountId: 'a2' });
  });

  it('set_session_account may change a session of the thread', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/s2': () => wb({ id: 's2', kind: 'session', threadId: 'thread1' }),
      'PUT /api/v1/workbenches/s2/account': () => wb({ id: 's2' }),
    });
    await tool('set_session_account').handler(OWNER, { session_id: 's2', account_id: 'a2' }, SELF);
    expect(calls.at(-1)?.method).toBe('PUT');
  });

  it('set_session_account refuses a session outside the thread', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workbenches/other': () => wb({ id: 'other', kind: 'session', threadId: 'thread9' }),
    });
    await expect(tool('set_session_account').handler(OWNER, { session_id: 'other', account_id: 'a2' }, SELF)).rejects.toThrow(
      'its own account, or the account of a session in its thread'
    );
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('set_session_account needs an account id', async () => {
    mockApi({});
    await expect(tool('set_session_account').handler(OWNER, {}, SELF)).rejects.toThrow();
  });
});
