import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PostHogInboxBacklogPage, PostHogInboxBacklogRow, PostHogInboxRunResponse } from '@talyn/shared';
import { buildMcpServer } from '../mcp/server.js';
import { SESSION_TOKEN_TOOLS } from '../mcp/sessionScope.js';
import { TOOLS, type McpCallContext, type McpToolDefinition } from '../mcp/tools/index.js';

/**
 * The PostHog Inbox backlog MCP tools: `talyn_list_posthog_inbox_backlog`
 * and `talyn_run_posthog_inbox_reports`. Both find the rule first, refuse a
 * rule that is not a PostHog Inbox rule, call the routes (so the routes'
 * checks come back as tool errors) and write plain text. A session token may
 * read the backlog but not run reports.
 */

const OWNER = 'user-test';
const SELF: McpCallContext = { session: { tokenId: 'token-1', workbenchId: 's1', depth: 0 } };

function tool(name: string): McpToolDefinition {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

class Refusal {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly code?: string
  ) {}
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
      if (out instanceof Refusal) {
        return {
          ok: false,
          status: out.status,
          json: async () => ({ success: false, error: out.error, ...(out.code ? { code: out.code } : {}) }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ success: true, data: out ?? null }) } as Response;
    })
  );
  return { calls };
}

const inboxRule = {
  id: 'w1',
  workspaceId: 'ws1',
  integration: 'posthog_inbox',
  name: 'Fix ready reports',
  enabled: true,
  events: ['report_ready'],
  conditions: {},
  actions: [{ type: 'start_session', repositoryId: null, prompt: 'Fix it.' }],
  maxRunsPerPrPerHour: 3,
  maxRunsPerDay: 10,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  stats: { runs: 0, lastRunAt: null },
};
const githubRule = { ...inboxRule, id: 'w2', integration: 'github', name: 'Label PRs', events: ['pr_opened'] };
const legacyRule = { ...inboxRule, id: 'w3', integration: undefined, name: 'Old rule' };

function row(overrides: Partial<PostHogInboxBacklogRow> = {}): PostHogInboxBacklogRow {
  return {
    id: 'rep-1',
    title: 'Checkout crashes',
    url: 'https://us.posthog.com/project/2/inbox/rep-1',
    priority: 'P1',
    actionability: 'immediately_actionable',
    repository: 'acme/web-app',
    sourceProducts: ['error_tracking'],
    signalCount: 3,
    createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T01:00:00Z',
    state: 'not_run',
    selectable: true,
    runId: null,
    workbenchId: null,
    pullRequestId: null,
    prUrl: null,
    ...overrides,
  };
}

function backlogPage(overrides: Partial<PostHogInboxBacklogPage> = {}): PostHogInboxBacklogPage {
  return {
    rows: [row()],
    scanned: 25,
    nextOffset: 25,
    total: 60,
    days: 7,
    workflowId: 'w1',
    runnable: true,
    notRunnableReason: null,
    dailyCap: 10,
    runsToday: 4,
    ...overrides,
  };
}

const runResponse: PostHogInboxRunResponse = {
  results: [
    { reportId: 'rep-1', outcome: 'started', message: 'Talyn started a session.', runId: 'run-1', workbenchId: 'wb-1' },
    { reportId: 'rep-2', outcome: 'claimed_elsewhere', message: 'Another person or agent claimed this report in PostHog first.', runId: 'run-2', workbenchId: null },
    { reportId: 'rep-3', outcome: 'daily_cap', message: 'The daily cap of 10 is reached.', runId: null, workbenchId: null },
  ],
  requested: 3,
  started: 1,
  dailyCap: 10,
  summary: '1 of 3 started; the daily cap of 10 is reached.',
};

const rules = () => [inboxRule, githubRule, legacyRule];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('talyn_list_posthog_inbox_backlog', () => {
  it('reads the saved rule and posts the page request', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/posthog-inbox/backlog': () => backlogPage(),
    });
    await tool('talyn_list_posthog_inbox_backlog').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w1', days: 30, offset: 25 });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /api/v1/workflows',
      'POST /api/v1/workflows/posthog-inbox/backlog',
    ]);
    expect(calls[0].url.searchParams.get('workspaceId')).toBe('ws1');
    expect(calls[1].body).toEqual({ workspaceId: 'ws1', workflowId: 'w1', days: 30, offset: 25 });
  });

  it('leaves days and offset to the route when not given', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/posthog-inbox/backlog': () => backlogPage(),
    });
    await tool('talyn_list_posthog_inbox_backlog').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w1' });
    expect(calls[1].body).toEqual({ workspaceId: 'ws1', workflowId: 'w1' });
  });

  it('writes each row with its state, and the paging and cap', async () => {
    mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/posthog-inbox/backlog': () =>
        backlogPage({
          rows: [
            row(),
            row({ id: 'rep-2', state: 'running', selectable: false, workbenchId: 'wb-9', prUrl: 'https://github.com/acme/web-app/pull/31' }),
            row({ id: 'rep-3', state: 'held_back', selectable: false, priority: null, repository: null, title: '', createdAt: null }),
            row({ id: 'rep-4', state: 'claimed_elsewhere', selectable: false }),
            row({ id: 'rep-5', state: 'already_run', selectable: false }),
            row({ id: 'rep-6', state: 'already_addressed', selectable: false }),
            row({ id: 'rep-7', state: 'repository_not_connected', selectable: false }),
          ],
        }),
    });
    const text = await tool('talyn_list_posthog_inbox_backlog').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w1' });
    expect(text).toContain('Reports created in the last 7 days that match, newest first. Talyn read 25 report(s) from PostHog of 60.');
    expect(text).toContain('Only rows marked [selectable] can run. Daily cap: 4 of 10 runs used in the last 24 hours.');
    expect(text).toContain(
      'rep-1  [Not run] [selectable]  P1  acme/web-app  Checkout crashes  created 2026-11-15T00:00:00Z  https://us.posthog.com/project/2/inbox/rep-1'
    );
    expect(text).toContain('rep-2  [Running / PR open]  P1');
    expect(text).toContain('session: wb-9  pr: https://github.com/acme/web-app/pull/31');
    expect(text).toContain('rep-3  [Held back for safety]  no priority  no repository  (no title)  created unknown');
    for (const label of ['[Claimed elsewhere]', '[Already run]', '[Already addressed]', '[Repository not connected]']) {
      expect(text).toContain(label);
    }
    expect(text.match(/\[selectable\]/g)).toHaveLength(2); // the head line and rep-1
    expect(text).toContain('More reports: call again with offset 25.');
  });

  it('says why reports cannot run, and leaves out the cap and paging when there are none', async () => {
    mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/posthog-inbox/backlog': () =>
        backlogPage({
          rows: [],
          total: null,
          nextOffset: null,
          dailyCap: null,
          runnable: false,
          notRunnableReason: 'Turn the automation on first. Then you can run reports.',
        }),
    });
    const text = await tool('talyn_list_posthog_inbox_backlog').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w1' });
    expect(text).toContain('Talyn read 25 report(s) from PostHog.');
    expect(text).toContain('Reports cannot run now: Turn the automation on first. Then you can run reports.');
    expect(text).toContain('None.');
    expect(text).not.toContain('More reports');
    expect(text).not.toContain('Daily cap');
  });

  it('runnable without a cap says nothing about a cap', async () => {
    mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/posthog-inbox/backlog': () => backlogPage({ dailyCap: null }),
    });
    const text = await tool('talyn_list_posthog_inbox_backlog').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w1' });
    expect(text).toContain('Run reports with talyn_run_posthog_inbox_reports.');
    expect(text).not.toContain('Daily cap');
  });

  it.each([
    ['a GitHub rule', 'w2'],
    ['a rule with no integration (GitHub)', 'w3'],
  ])('refuses %s without calling the backlog route', async (_name, id) => {
    const { calls } = mockApi({ 'GET /api/v1/workflows': rules });
    await expect(
      tool('talyn_list_posthog_inbox_backlog').handler(OWNER, { workspace_id: 'ws1', workflow_id: id })
    ).rejects.toThrow(`Workflow ${id} is not a PostHog Inbox automation.`);
    expect(calls).toHaveLength(1);
  });

  it("answers not found for a rule outside the workspace's list", async () => {
    const { calls } = mockApi({ 'GET /api/v1/workflows': rules });
    await expect(
      tool('talyn_list_posthog_inbox_backlog').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w-theirs' })
    ).rejects.toThrow('Workflow w-theirs was not found in this workspace.');
    expect(calls).toHaveLength(1);
  });

  it('needs a workflow id', async () => {
    mockApi({ 'GET /api/v1/workflows': rules });
    await expect(tool('talyn_list_posthog_inbox_backlog').handler(OWNER, { workspace_id: 'ws1' })).rejects.toThrow(/workflow_id/);
  });

  it.each<[string, Refusal, RegExp]>([
    ['the flag is off', new Refusal(404, 'PostHog Inbox automations are not available for this account.', 'posthog_inbox_rules_unavailable'), /not available for this account\. \(code: posthog_inbox_rules_unavailable\)/],
    ['no connection', new Refusal(409, "Talyn cannot read this workspace's PostHog Inbox.", 'posthog_inbox_unavailable'), /\(code: posthog_inbox_unavailable\)/],
    ['PostHog refuses', new Refusal(502, 'PostHog refused to show the Inbox.', 'posthog_inbox_forbidden'), /\(code: posthog_inbox_forbidden\)/],
    ['PostHog is down', new Refusal(502, 'Talyn could not read the PostHog Inbox.', 'posthog_inbox_unreachable'), /\(code: posthog_inbox_unreachable\)/],
    ['a bad offset', new Refusal(400, 'offset must be a whole number of 0 or more'), /^offset must be a whole number of 0 or more$/],
    ['no access', new Refusal(403, 'Forbidden'), /^Forbidden$/],
  ])('surfaces the route error when %s', async (_name, refusal, message) => {
    mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/posthog-inbox/backlog': () => refusal,
    });
    await expect(
      tool('talyn_list_posthog_inbox_backlog').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w1' })
    ).rejects.toThrow(message);
  });

  it('is read-only and offers 7, 30 and 90 days', () => {
    const t = tool('talyn_list_posthog_inbox_backlog');
    expect(t.annotations.readOnlyHint).toBe(true);
    const schema = t.inputSchema as { properties: Record<string, { enum?: number[] }>; required: string[] };
    expect(schema.properties.days.enum).toEqual([7, 30, 90]);
    expect(schema.required).toEqual(['workflow_id']);
  });
});

describe('talyn_run_posthog_inbox_reports', () => {
  it('posts the ids and writes the summary, then one line a report', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/w1/posthog-inbox/run': () => runResponse,
    });
    const text = await tool('talyn_run_posthog_inbox_reports').handler(OWNER, {
      workspace_id: 'ws1',
      workflow_id: 'w1',
      report_ids: ['rep-1', 'rep-2', 'rep-3'],
    });
    expect(calls[1].body).toEqual({ reportIds: ['rep-1', 'rep-2', 'rep-3'] });
    expect(text.split('\n')).toEqual([
      '1 of 3 started; the daily cap of 10 is reached.',
      'rep-1  [started]  Talyn started a session.  session: wb-1',
      'rep-2  [claimed_elsewhere]  Another person or agent claimed this report in PostHog first.',
      'rep-3  [daily_cap]  The daily cap of 10 is reached.',
    ]);
  });

  it('sends ids as strings', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/w1/posthog-inbox/run': () => ({ ...runResponse, results: [], summary: '0 of 0 started.' }),
    });
    const text = await tool('talyn_run_posthog_inbox_reports').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w1', report_ids: [12, 'rep-1'] });
    expect(calls[1].body).toEqual({ reportIds: ['12', 'rep-1'] });
    expect(text).toBe('0 of 0 started.\nNone.');
  });

  it.each([['rep-1'], [undefined], [{ 0: 'rep-1' }]])('refuses report_ids %j without calling the run route', async (reportIds) => {
    const { calls } = mockApi({ 'GET /api/v1/workflows': rules });
    await expect(
      tool('talyn_run_posthog_inbox_reports').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w1', report_ids: reportIds })
    ).rejects.toThrow('report_ids must be a list of report ids.');
    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/workflows']);
  });

  it.each(['w2', 'w3'])('refuses rule %s, which is not a PostHog Inbox rule', async (id) => {
    const { calls } = mockApi({ 'GET /api/v1/workflows': rules });
    await expect(
      tool('talyn_run_posthog_inbox_reports').handler(OWNER, { workspace_id: 'ws1', workflow_id: id, report_ids: ['rep-1'] })
    ).rejects.toThrow(`Workflow ${id} is not a PostHog Inbox automation.`);
    expect(calls).toHaveLength(1);
  });

  it("answers not found for another workspace's rule", async () => {
    const { calls } = mockApi({ 'GET /api/v1/workflows': rules });
    await expect(
      tool('talyn_run_posthog_inbox_reports').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w-theirs', report_ids: ['rep-1'] })
    ).rejects.toThrow('Workflow w-theirs was not found in this workspace.');
    expect(calls).toHaveLength(1);
  });

  it.each<[string, Refusal, RegExp]>([
    ['too many reports', new Refusal(400, 'Select at most 20 reports at a time.', 'too_many_reports'), /Select at most 20 reports at a time\. \(code: too_many_reports\)/],
    ['a disabled rule', new Refusal(409, 'Turn the automation on first. Then you can run reports.', 'workflow_not_runnable'), /\(code: workflow_not_runnable\)/],
    ['no claim-capable connection', new Refusal(409, 'Talyn cannot claim reports with this PostHog connection.', 'posthog_inbox_unavailable'), /\(code: posthog_inbox_unavailable\)/],
    ['the flag is off', new Refusal(404, 'PostHog Inbox automations are not available for this account.', 'posthog_inbox_rules_unavailable'), /\(code: posthog_inbox_rules_unavailable\)/],
    ['bad ids', new Refusal(400, 'reportIds must be a list of report ids.'), /^reportIds must be a list of report ids\.$/],
  ])('surfaces the route error for %s', async (_name, refusal, message) => {
    mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/w1/posthog-inbox/run': () => refusal,
    });
    await expect(
      tool('talyn_run_posthog_inbox_reports').handler(OWNER, { workspace_id: 'ws1', workflow_id: 'w1', report_ids: ['rep-1'] })
    ).rejects.toThrow(message);
  });

  it('is not read-only, and caps the ids at 20 in its schema', () => {
    const t = tool('talyn_run_posthog_inbox_reports');
    expect(t.annotations.readOnlyHint).not.toBe(true);
    const schema = t.inputSchema as { properties: Record<string, { maxItems?: number }>; required: string[] };
    expect(schema.properties.report_ids.maxItems).toBe(20);
    expect(schema.required).toEqual(['workflow_id', 'report_ids']);
  });
});

describe('the run history line', () => {
  it.each<[Record<string, unknown>, string | null]>([
    [{ trigger: 'manual', triggeredBy: 'tom' }, '  manual by tom'],
    [{ trigger: 'manual', triggeredBy: null }, '  manual'],
    [{ trigger: 'event', triggeredBy: null }, null],
    [{}, null],
  ])('writes %j', async (extra, expected) => {
    mockApi({
      'GET /api/v1/workflows/w1/runs': () => [
        { id: 'wr1', status: 'succeeded', createdAt: '2026-11-16T09:00:00Z', subjectLabel: 'Checkout crashes', event: 'report_ready', ...extra },
      ],
    });
    const text = await tool('talyn_list_workflow_runs').handler(OWNER, { workflow_id: 'w1' });
    if (expected) expect(text).toContain(`report_ready${expected}`);
    else expect(text).not.toContain('manual');
  });
});

describe('session token scope', () => {
  type Handler = (request: unknown, extra: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
  async function callTool(ctx: McpCallContext, name: string, args: Record<string, unknown>) {
    const server = buildMcpServer(OWNER, ctx);
    try {
      const handlers = (server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
      return await handlers.get('tools/call')!({ method: 'tools/call', params: { name, arguments: args } }, {});
    } finally {
      await server.close();
    }
  }

  it('allows the backlog read and not the run', () => {
    expect(SESSION_TOKEN_TOOLS.has('talyn_list_posthog_inbox_backlog')).toBe(true);
    expect(SESSION_TOKEN_TOOLS.has('talyn_run_posthog_inbox_reports')).toBe(false);
  });

  it('a session token reads the backlog', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/posthog-inbox/backlog': () => backlogPage(),
    });
    const result = await callTool(SELF, 'talyn_list_posthog_inbox_backlog', { workspace_id: 'ws1', workflow_id: 'w1' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('[Not run]');
    expect(calls).toHaveLength(2);
  });

  it('a session token cannot run reports, and nothing is called', async () => {
    const { calls } = mockApi({});
    const result = await callTool(SELF, 'talyn_run_posthog_inbox_reports', { workspace_id: 'ws1', workflow_id: 'w1', report_ids: ['rep-1'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'talyn_run_posthog_inbox_reports is not available inside a session. Ask the person to do it in the Talyn app.'
    );
    expect(calls).toHaveLength(0);
  });

  it('a user token can run reports', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/w1/posthog-inbox/run': () => runResponse,
    });
    const result = await callTool({}, 'talyn_run_posthog_inbox_reports', { workspace_id: 'ws1', workflow_id: 'w1', report_ids: ['rep-1'] });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('a tool error comes back as an error result', async () => {
    mockApi({
      'GET /api/v1/workflows': rules,
      'POST /api/v1/workflows/posthog-inbox/backlog': () => new Refusal(502, 'PostHog refused to show the Inbox.', 'posthog_inbox_forbidden'),
    });
    const result = await callTool(SELF, 'talyn_list_posthog_inbox_backlog', { workspace_id: 'ws1', workflow_id: 'w1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('PostHog refused to show the Inbox. (code: posthog_inbox_forbidden)');
  });
});
