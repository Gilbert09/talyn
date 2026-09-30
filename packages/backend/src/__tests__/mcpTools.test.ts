import { describe, it, expect, afterEach, vi } from 'vitest';
import { callApi, McpApiError } from '../mcp/api.js';
import { buildMcpServer, listToolsFor } from '../mcp/server.js';
import { emptyLoopInput, type Features } from '@talyn/shared';
import { TOOLS, type McpToolDefinition } from '../mcp/tools/index.js';

const OWNER = 'user-test';

function tool(name: string): McpToolDefinition {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

/** Build a fetch mock that routes by `${method} ${pathname}` to a JSON body. */
type Route = (url: URL, init: RequestInit) => unknown;
function mockApi(routes: Record<string, Route>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  const fn = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    const data = route(url, init);
    const response =
      data && typeof data === 'object' && 'status' in data && 'body' in data
        ? (data as { status: number; body: unknown })
        : { status: 200, body: { success: true, data } };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

function pr(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pr1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'acme',
    repo: 'web',
    number: 42,
    state: 'open',
    reviewRequested: false,
    authored: true,
    autoKeepMergeable: false,
    mergeQueued: false,
    mergeMethod: 'squash',
    mergeQueue: null,
    summary: {
      title: 'Add widget',
      author: 'me',
      draft: false,
      headBranch: 'feat',
      baseBranch: 'main',
      url: 'https://github.com/acme/web/pull/42',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      effectiveReviewDecision: null,
      blockingReason: 'mergeable',
      checks: { total: 3, passed: 3, failed: 0, inProgress: 0, skipped: 0 },
      unresolvedReviewThreads: 0,
    },
    ...overrides,
  };
}

describe('mcp tool registry', () => {
  it('every tool has a unique talyn_ name and an object input schema', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^talyn_/);
      expect(t.description.length).toBeGreaterThan(0);
      expect((t.inputSchema as { type?: string }).type).toBe('object');
      expect(t.annotations).toBeDefined();
      const schema = t.inputSchema as { properties: Record<string, unknown>; required?: string[] };
      for (const key of schema.required ?? []) expect(schema.properties).toHaveProperty(key);
      if (/delete|remove|cancel|untrack/.test(t.name))
        expect(t.annotations.destructiveHint).toBe(true);
      if (/talyn_(list|get)_/.test(t.name)) expect(t.annotations.readOnlyHint).toBe(true);
    }
  });

  it('covers the full surface (listing, context, actions, tasks)', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toHaveLength(65);
    for (const expected of [
      'talyn_list_workspaces',
      'talyn_get_workspace',
      'talyn_list_repositories',
      'talyn_add_repository',
      'talyn_remove_repository',
      'talyn_list_github_repos',
      'talyn_list_pull_requests',
      'talyn_get_pull_request',
      'talyn_get_pull_request_description',
      'talyn_get_pull_request_diff',
      'talyn_get_pull_request_reviews',
      'talyn_refresh_pull_request',
      'talyn_track_pull_request',
      'talyn_untrack_pull_request',
      'talyn_set_review_hidden',
      'talyn_set_auto_keep_mergeable',
      'talyn_merge_pull_request',
      'talyn_fix_pull_request',
      'talyn_set_merge_queue',
      'talyn_set_merge_queue_stack',
      'talyn_get_merge_queue_timeline',
      'talyn_get_code_review',
      'talyn_start_code_review',
      'talyn_cancel_code_review',
      'talyn_get_code_review_finding',
      'talyn_fix_code_review_findings',
      'talyn_dismiss_code_review_finding',
      'talyn_list_code_reviews',
      'talyn_create_task',
      'talyn_list_tasks',
      'talyn_get_task',
      'talyn_stop_task',
      'talyn_retry_task',
      'talyn_delete_task',
      'talyn_list_skills',
      'talyn_get_skill',
      'talyn_create_skill',
      'talyn_update_skill',
      'talyn_delete_skill',
      'talyn_list_workflows',
      'talyn_get_workflow',
      'talyn_create_workflow',
      'talyn_update_workflow',
      'talyn_get_workflow_vocabulary',
      'talyn_set_workflow_enabled',
      'talyn_delete_workflow',
      'talyn_list_workflow_runs',
      'talyn_list_loops',
      'talyn_get_loop',
      'talyn_create_loop',
      'talyn_update_loop',
      'talyn_set_loop_enabled',
      'talyn_delete_loop',
      'talyn_list_loop_runs',
      'talyn_run_loop_now',
      'talyn_list_mcp_servers',
      'talyn_get_mcp_server',
      'talyn_test_mcp_server',
      'talyn_set_mcp_server_enabled',
      'talyn_delete_mcp_server',
      'talyn_connect_mcp_server',
      'talyn_create_mcp_server',
      'talyn_get_billing_status',
      'talyn_list_cloud_providers',
      'talyn_whats_new',
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe('mcp tool handlers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('list_pull_requests maps bucket → relationship and includes state', async () => {
    const { calls } = mockApi({ 'GET /api/v1/pull-requests': () => [pr()] });
    await tool('talyn_list_pull_requests').handler(OWNER, {
      workspace_id: 'ws1',
      bucket: 'review_requested',
    });
    const url = calls[0].url;
    expect(url.searchParams.get('relationship')).toBe('review_requested');
    expect(url.searchParams.get('workspaceId')).toBe('ws1');
    expect(url.searchParams.get('state')).toBe('open');
  });

  it('needs_attention filters to PRs with a blocker', async () => {
    const clean = pr({ id: 'clean' });
    const failing = pr({
      id: 'failing',
      number: 7,
      summary: {
        ...pr().summary,
        checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 },
      },
    });
    mockApi({ 'GET /api/v1/pull-requests': () => [clean, failing] });
    const out = await tool('talyn_list_pull_requests').handler(OWNER, {
      workspace_id: 'ws1',
      bucket: 'needs_attention',
    });
    expect(out).toContain('failing');
    expect(out).not.toContain('clean');
  });

  it('get_pull_request_diff omits the patch unless asked', async () => {
    const files = [
      { filename: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: 'PATCHTEXT' },
    ];
    mockApi({ 'GET /api/v1/pull-requests/pr1/files': () => files });

    const without = await tool('talyn_get_pull_request_diff').handler(OWNER, {
      pull_request_id: 'pr1',
    });
    expect(without).toContain('a.ts');
    expect(without).not.toContain('PATCHTEXT');

    const withPatch = await tool('talyn_get_pull_request_diff').handler(OWNER, {
      pull_request_id: 'pr1',
      include_patch: true,
    });
    expect(withPatch).toContain('PATCHTEXT');
  });

  it('fix_pull_request calls the standard /fix action (no freeform params)', async () => {
    const { calls } = mockApi({
      'POST /api/v1/pull-requests/pr1/fix': () => ({
        id: 'task1',
        type: 'pr_response',
        title: 'Get acme/web#42 mergeable',
        status: 'queued',
      }),
    });

    const out = await tool('talyn_fix_pull_request').handler(OWNER, {
      pull_request_id: 'pr1',
      model: 'claude-opus-4-8',
    });

    // Hits the dedicated fix endpoint — the backend builds the standard prompt.
    const post = calls.find(
      (c) => c.method === 'POST' && c.url.pathname === '/api/v1/pull-requests/pr1/fix'
    );
    expect(post).toBeTruthy();
    expect(post!.body).toEqual({ model: 'claude-opus-4-8' });
    expect(out).toContain('task1');
    expect(out).toContain('Get acme/web#42 mergeable');
  });

  it('passes internal-proxy headers identifying the owner', async () => {
    let seenHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init: RequestInit = {}) => {
        seenHeaders = (init.headers as Record<string, string>) ?? {};
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [] }),
        } as Response;
      })
    );
    await tool('talyn_list_workspaces').handler(OWNER, {});
    expect(seenHeaders['x-fastowl-internal-user']).toBe(OWNER);
    expect(seenHeaders['x-fastowl-internal-token']).toBeTruthy();
  });
});

const features: Features = {
  workflows: true,
  loops: true,
  mcpServers: true,
  codeReview: true,
  reviewPriority: true,
  reviewRankingCandidate: false,
  reviewRankingExport: false,
  teams: false,
  reviewPriorityMode: true,
};
const workflow = {
  id: 'w1',
  workspaceId: 'ws1',
  name: 'Check PRs',
  enabled: true,
  events: ['pr_opened'],
  conditions: { repos: ['acme/web'] },
  actions: [{ type: 'watch_pr' }],
  maxRunsPerPrPerHour: 5,
  createdAt: '2026-09-29T10:00:00Z',
  updatedAt: '2026-09-29T10:00:00Z',
  stats: { runsTotal: 2, lastStatus: 'succeeded', failures7d: 0 },
};
const workflowBody = {
  name: workflow.name,
  enabled: workflow.enabled,
  events: workflow.events,
  conditions: workflow.conditions,
  actions: workflow.actions,
  maxRunsPerPrPerHour: 5,
};
const loopBody = {
  ...emptyLoopInput('UTC'),
  name: 'Daily check',
  prompt: 'Check the code',
  repositoryId: 'r1',
  repoFullName: 'acme/web',
};
const loop = { ...loopBody, id: 'l1', workspaceId: 'ws1', nextRunAt: '2026-10-01T09:00:00Z' };
const serverBody = {
  name: 'docs',
  displayName: 'Docs',
  description: 'Read docs',
  url: 'https://docs.example.com/mcp',
  catalogHandle: null,
  authKind: 'bearer',
  inject: null,
  tools: ['search'],
  enabled: true,
};
const mcpServer = {
  ...serverBody,
  id: 'm1',
  workspaceId: 'ws1',
  hasSecret: true,
  oauth: { status: 'connected' },
};
const review = {
  id: 'review1',
  phase: 'completed',
  headSha: 'abcdef123',
  preset: 'standard',
  failureReason: null,
};
const skill = {
  id: 's1',
  name: 'Check',
  description: 'Check code',
  content: 'Read the code',
  source: 'platform',
};

const writeCases: {
  name: string;
  args: Record<string, unknown>;
  method: string;
  path: string;
  body?: unknown;
  response?: unknown;
}[] = [
  {
    name: 'add_repository',
    args: { workspace_id: 'ws1', repo: 'acme/web' },
    method: 'POST',
    path: '/repositories',
    body: { workspaceId: 'ws1', owner: 'acme', repo: 'web' },
    response: { id: 'r1', fullName: 'acme/web', defaultBranch: 'main' },
  },
  {
    name: 'add_repository',
    args: { workspace_id: 'ws1', owner: 'acme', repo: 'web' },
    method: 'POST',
    path: '/repositories',
    body: { workspaceId: 'ws1', owner: 'acme', repo: 'web' },
    response: { id: 'r1', fullName: 'acme/web', defaultBranch: 'main' },
  },
  {
    name: 'remove_repository',
    args: { repository_id: 'r1' },
    method: 'DELETE',
    path: '/repositories/r1',
  },
  {
    name: 'track_pull_request',
    args: { workspace_id: 'ws1', url: 'https://github.com/acme/web/pull/42', add_repository: true },
    method: 'POST',
    path: '/pull-requests/watch',
    body: { workspaceId: 'ws1', url: 'https://github.com/acme/web/pull/42', confirmAddRepo: true },
    response: pr(),
  },
  {
    name: 'untrack_pull_request',
    args: { pull_request_id: 'pr1' },
    method: 'POST',
    path: '/pull-requests/pr1/watch',
    body: { enabled: false },
  },
  {
    name: 'set_review_hidden',
    args: { pull_request_id: 'pr1', hidden: false },
    method: 'POST',
    path: '/pull-requests/pr1/review-hidden',
    body: { hidden: false },
  },
  {
    name: 'set_merge_queue_stack',
    args: { pull_request_id: 'pr1', enabled: true, include_descendants: true, method: 'rebase' },
    method: 'POST',
    path: '/pull-requests/pr1/merge-queue/stack',
    body: { enabled: true, includeDescendants: true, method: 'rebase' },
    response: { pullRequestIds: ['pr1'], skipped: [] },
  },
  {
    name: 'start_code_review',
    args: { pull_request_id: 'pr1', preset: 'deep', reset: true },
    method: 'POST',
    path: '/pull-requests/pr1/code-review',
    body: { preset: 'deep', reset: true },
    response: review,
  },
  {
    name: 'cancel_code_review',
    args: { pull_request_id: 'pr1' },
    method: 'DELETE',
    path: '/pull-requests/pr1/code-review',
    response: review,
  },
  {
    name: 'fix_code_review_findings',
    args: { pull_request_id: 'pr1', finding_ids: ['f1', 'f2'] },
    method: 'POST',
    path: '/pull-requests/pr1/code-review/fix',
    body: { findingIds: ['f1', 'f2'] },
    response: { taskId: 't1', review },
  },
  {
    name: 'dismiss_code_review_finding',
    args: { pull_request_id: 'pr1', finding_id: 'f1', reason: 'not_a_problem' },
    method: 'POST',
    path: '/pull-requests/pr1/code-review/findings/f1/dismiss',
    body: { reason: 'not_a_problem' },
    response: review,
  },
  {
    name: 'dismiss_code_review_finding',
    args: { pull_request_id: 'pr1', finding_id: 'f1', undo: true },
    method: 'DELETE',
    path: '/pull-requests/pr1/code-review/findings/f1/dismiss',
    response: review,
  },
  { name: 'delete_task', args: { task_id: 't1' }, method: 'DELETE', path: '/tasks/t1' },
  {
    name: 'create_skill',
    args: { workspace_id: 'ws1', name: 'Check', content: 'Read the code' },
    method: 'POST',
    path: '/skills',
    body: { workspaceId: 'ws1', name: 'Check', description: '', content: 'Read the code' },
    response: skill,
  },
  {
    name: 'update_skill',
    args: { skill_id: 's1', description: '', content: 'New content' },
    method: 'PATCH',
    path: '/skills/s1',
    body: { description: '', content: 'New content' },
    response: skill,
  },
  { name: 'delete_skill', args: { skill_id: 's1' }, method: 'DELETE', path: '/skills/s1' },
  {
    name: 'create_workflow',
    args: { workspace_id: 'ws1', workflow: workflowBody },
    method: 'POST',
    path: '/workflows',
    body: { ...workflowBody, workspaceId: 'ws1' },
    response: workflow,
  },
  {
    name: 'update_workflow',
    args: { workspace_id: 'ws1', workflow_id: 'w1', workflow: { name: 'Renamed' } },
    method: 'PATCH',
    path: '/workflows/w1',
    body: { ...workflowBody, name: 'Renamed' },
    response: workflow,
  },
  {
    name: 'set_workflow_enabled',
    args: { workspace_id: 'ws1', workflow_id: 'w1', enabled: false },
    method: 'PATCH',
    path: '/workflows/w1',
    body: { ...workflowBody, enabled: false },
    response: workflow,
  },
  { name: 'delete_workflow', args: { workflow_id: 'w1' }, method: 'DELETE', path: '/workflows/w1' },
  {
    name: 'create_loop',
    args: {
      workspace_id: 'ws1',
      repository_id: 'r1',
      name: 'Daily check',
      prompt: 'Check the code',
    },
    method: 'POST',
    path: '/loops',
    body: { ...loopBody, workspaceId: 'ws1' },
    response: loop,
  },
  {
    name: 'update_loop',
    args: { workspace_id: 'ws1', loop_id: 'l1', loop: { prompt: 'New prompt' } },
    method: 'PATCH',
    path: '/loops/l1',
    body: { ...loopBody, prompt: 'New prompt' },
    response: loop,
  },
  {
    name: 'set_loop_enabled',
    args: { workspace_id: 'ws1', loop_id: 'l1', enabled: false },
    method: 'PATCH',
    path: '/loops/l1',
    body: { ...loopBody, enabled: false },
    response: loop,
  },
  { name: 'delete_loop', args: { loop_id: 'l1' }, method: 'DELETE', path: '/loops/l1' },
  {
    name: 'run_loop_now',
    args: { loop_id: 'l1' },
    method: 'POST',
    path: '/loops/l1/run',
    response: {
      id: 'lr1',
      status: 'waiting_slot',
      scheduledFor: '2026-09-30T10:00:00Z',
      taskId: null,
      retryAfter: '2026-09-30T10:01:00Z',
    },
  },
  {
    name: 'create_mcp_server',
    args: { workspace_id: 'ws1', name: 'docs', url: serverBody.url, authKind: 'oauth' },
    method: 'POST',
    path: '/mcp-servers',
    body: {
      workspaceId: 'ws1',
      name: 'docs',
      url: serverBody.url,
      authKind: 'bearer',
      enabled: true,
    },
    response: mcpServer,
  },
  {
    name: 'create_mcp_server',
    args: {
      workspace_id: 'ws1',
      name: 'docs',
      url: serverBody.url,
      authKind: 'none',
      enabled: false,
      tools: [],
    },
    method: 'POST',
    path: '/mcp-servers',
    body: {
      workspaceId: 'ws1',
      name: 'docs',
      url: serverBody.url,
      authKind: 'none',
      enabled: false,
      tools: [],
    },
    response: mcpServer,
  },
  {
    name: 'test_mcp_server',
    args: { mcp_server_id: 'm1' },
    method: 'POST',
    path: '/mcp-servers/m1/test',
    response: { ok: true, toolNames: ['search'] },
  },
  {
    name: 'set_mcp_server_enabled',
    args: { mcp_server_id: 'm1', enabled: false },
    method: 'PATCH',
    path: '/mcp-servers/m1',
    body: { ...serverBody, enabled: false },
    response: mcpServer,
  },
  {
    name: 'delete_mcp_server',
    args: { mcp_server_id: 'm1' },
    method: 'DELETE',
    path: '/mcp-servers/m1',
  },
  {
    name: 'connect_mcp_server',
    args: { mcp_server_id: 'm1' },
    method: 'POST',
    path: '/mcp-servers/m1/connect',
    response: { authorizeUrl: 'https://example.com/authorize' },
  },
];

describe('MCP product coverage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(writeCases)(
    '$name sends $method $path with the expected body',
    async ({ name, args, method, path, body, response }) => {
      const { calls } = mockApi({
        'GET /api/v1/workflows': () => [workflow],
        'GET /api/v1/loops': () => [loop],
        'GET /api/v1/repositories': () => [{ id: 'r1', fullName: 'acme/web' }],
        'GET /api/v1/mcp-servers/m1': () => mcpServer,
        [`${method} /api/v1${path}`]: () => response ?? null,
      });
      await tool(`talyn_${name}`).handler(OWNER, args);
      expect(
        calls.filter((call) => call.method === method && call.url.pathname === `/api/v1${path}`)
      ).toHaveLength(1);
      expect(calls.at(-1)?.body).toEqual(body);
      if (
        [
          'update_workflow',
          'set_workflow_enabled',
          'update_loop',
          'set_loop_enabled',
          'set_mcp_server_enabled',
        ].includes(name)
      ) {
        expect(calls[0].method).toBe('GET');
        if (name !== 'set_mcp_server_enabled')
          expect(calls[0].url.searchParams.get('workspaceId')).toBe('ws1');
        expect(calls.at(-1)?.body).not.toHaveProperty('stats');
      }
    }
  );

  it.each(['workflows', 'loops', 'mcpServers', 'codeReview'] as const)(
    'hides tools when %s is off',
    (feature) => {
      const visible = listToolsFor({ ...features, [feature]: false });
      expect(visible.map((entry) => entry.name)).toEqual(
        TOOLS.filter((entry) => entry.feature !== feature).map((entry) => entry.name)
      );
      expect(visible[0].annotations).toEqual(TOOLS[0].annotations);
    }
  );

  it.each([false, true])('ListTools reads features once; failure=%s', async (failure) => {
    const { calls } = mockApi({
      'GET /api/v1/features': () =>
        failure
          ? { status: 503, body: { success: false, error: 'Unavailable' } }
          : { ...features, workflows: false },
    });
    const server = buildMcpServer(OWNER);
    const handlers = (
      server as unknown as {
        _requestHandlers: Map<
          string,
          (request: unknown, extra: unknown) => Promise<{ tools: { name: string }[] }>
        >;
      }
    )._requestHandlers;
    const result = await handlers.get('tools/list')!({ method: 'tools/list', params: {} }, {});
    expect(result.tools.map((entry) => entry.name)).toEqual(
      listToolsFor(failure ? null : { ...features, workflows: false }).map((entry) => entry.name)
    );
    expect(calls).toHaveLength(1);
    await server.close();
  });

  it('CallTool leaves feature checks to the route', async () => {
    const { calls } = mockApi({
      'GET /api/v1/workflows': () => ({
        status: 403,
        body: { success: false, error: 'Workflows unavailable', code: 'workflows_unavailable' },
      }),
    });
    const server = buildMcpServer(OWNER);
    const handlers = (
      server as unknown as {
        _requestHandlers: Map<
          string,
          (
            request: unknown,
            extra: unknown
          ) => Promise<{ isError?: boolean; content: { text: string }[] }>
        >;
      }
    )._requestHandlers;
    const result = await handlers.get('tools/call')!(
      {
        method: 'tools/call',
        params: { name: 'talyn_list_workflows', arguments: { workspace_id: 'ws1' } },
      },
      {}
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('workflows_unavailable');
    expect(calls).toHaveLength(1);
    await server.close();
  });

  it('reports submission to the external merge queue', async () => {
    mockApi({ 'POST /api/v1/pull-requests/pr1/merge': () => ({ merged: false, submitted: true }) });
    expect(await tool('talyn_merge_pull_request').handler(OWNER, { pull_request_id: 'pr1' })).toBe(
      "Submitted PR pr1 to the repository's merge queue; it merges when the queue lands it."
    );
  });

  it.each([402, 403, 409])('preserves the API error code for HTTP %s', async (status) => {
    mockApi({
      'POST /api/v1/tasks': () => ({
        status,
        body: { success: false, error: 'Limit reached', code: 'task_limit_reached' },
      }),
    });
    const error = await callApi(OWNER, 'POST', '/tasks', {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(McpApiError);
    expect(error).toMatchObject({ status, code: 'task_limit_reached' });
    expect((error as Error).message).toContain('Limit reached (code: task_limit_reached)');
    expect((error as Error).message.includes('Settings → Billing')).toBe(status === 402);
  });

  it('gives a retry hint for an unwatched repository', async () => {
    mockApi({
      'POST /api/v1/pull-requests/watch': () => ({
        status: 409,
        body: { success: false, error: 'Repository is not watched', code: 'repo_not_watched' },
      }),
    });
    expect(
      await tool('talyn_track_pull_request').handler(OWNER, {
        workspace_id: 'ws1',
        url: 'https://github.com/acme/web/pull/42',
      })
    ).toContain('add_repository: true');
  });

  it.each([
    { secret: 'sensitive' },
    { apiKey: 'sensitive' },
    { api_key: 'sensitive' },
    { inject: { extra: { Authorization: 'sensitive' } } },
    { authKind: 'bearer' },
    { authKind: 'header' },
    { url: 'https://example.com/mcp?key=sensitive' },
    { url: 'https://user:sensitive@example.com/mcp' },
  ])('refuses credential arguments: %j', async (unsafe) => {
    const { calls } = mockApi({});
    await expect(
      tool('talyn_create_mcp_server').handler(OWNER, {
        workspace_id: 'ws1',
        name: 'docs',
        url: serverBody.url,
        authKind: 'oauth',
        ...unsafe,
      })
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(tool('talyn_create_mcp_server').inputSchema.properties).not.toHaveProperty('secret');
  });
});

const finding = {
  id: 'f1',
  severity: 'major',
  disposition: 'open',
  filePath: 'src/a.ts',
  lineStart: 8,
  title: 'Check input',
  lenses: ['security'],
  verdict: 'confirmed',
  body: 'Full finding body',
  suggestion: 'Validate input',
  anchor: 'const input',
  verdictReason: 'The input is not checked',
};
const workspace = {
  id: 'ws1',
  name: 'Work',
  repos: [{ id: 'r1', name: 'acme/web', url: 'https://github.com/acme/web' }],
  integrations: { github: { enabled: true, accessToken: 'NEVER_SHOW' } },
  settings: {
    defaultAutoKeepMergeable: true,
    mergeQueueMode: 'eager',
    codeReview: { autoReview: true },
    prompts: { skill: { template: 'PRIVATE_PROMPT', basedOnHash: '12345678' } },
  },
};
const readCases: {
  name: string;
  args: Record<string, unknown>;
  path: string;
  query?: Record<string, string>;
  response: unknown;
  expected: string;
}[] = [
  {
    name: 'get_workspace',
    args: { workspace_id: 'ws1' },
    path: '/workspaces/ws1',
    response: workspace,
    expected: 'r1  acme/web',
  },
  {
    name: 'list_repositories',
    args: { workspace_id: 'ws1' },
    path: '/repositories',
    query: { workspaceId: 'ws1' },
    response: [{ id: 'r1', fullName: 'acme/web', defaultBranch: 'main' }],
    expected: 'r1  acme/web',
  },
  {
    name: 'list_github_repos',
    args: { workspace_id: 'ws1', search: 'WEB' },
    path: '/github/all-repos',
    query: { workspaceId: 'ws1' },
    response: [
      { id: 1, full_name: 'acme/web', private: true, html_url: 'https://github.com/acme/web' },
    ],
    expected: '1  acme/web  private',
  },
  {
    name: 'get_pull_request_description',
    args: { pull_request_id: 'pr1' },
    path: '/pull-requests/pr1/description',
    response: { body: 'The PR description' },
    expected: 'The PR description',
  },
  {
    name: 'get_merge_queue_timeline',
    args: { pull_request_id: 'pr1' },
    path: '/pull-requests/pr1/merge-queue/timeline',
    response: {
      events: [
        {
          at: '2026-09-30',
          fromStatus: 'queued',
          toStatus: 'blocked',
          trigger: 'check',
          code: 'human_gate',
          message: 'Review needed',
          detail: null,
        },
      ],
    },
    expected: 'queued → blocked',
  },
  {
    name: 'get_code_review',
    args: { pull_request_id: 'pr1' },
    path: '/pull-requests/pr1/code-review',
    response: { review, findings: [finding], defaultPreset: 'standard' },
    expected: 'f1 [major] [open] src/a.ts:8',
  },
  {
    name: 'get_code_review_finding',
    args: { pull_request_id: 'pr1', finding_id: 'f1' },
    path: '/pull-requests/pr1/code-review/findings/f1',
    response: finding,
    expected: 'verdict reason: The input is not checked',
  },
  {
    name: 'list_code_reviews',
    args: { workspace_id: 'ws1', limit: 20 },
    path: '/code-reviews',
    query: { workspaceId: 'ws1', limit: '20' },
    response: { reviews: [{ review, pullRequest: pr() }] },
    expected: 'review1  [completed]',
  },
  {
    name: 'list_skills',
    args: { workspace_id: 'ws1', repository_id: 'r1' },
    path: '/skills',
    query: { workspaceId: 'ws1', repositoryId: 'r1' },
    response: {
      platform: [{ ...skill, key: 'platform:s1' }],
      repo: [{ key: 'repo:r1:check', name: 'check', source: 'repo', description: 'Repo checks' }],
    },
    expected: 'repo:r1:check  check  [repo]',
  },
  {
    name: 'get_skill',
    args: { skill_id: 's1' },
    path: '/skills/s1',
    response: skill,
    expected: 'Read the code',
  },
  {
    name: 'get_skill',
    args: { workspace_id: 'ws1', repository_id: 'r1', name: 'check' },
    path: '/skills/repo/content',
    query: { workspaceId: 'ws1', repositoryId: 'r1', name: 'check' },
    response: { content: 'Full repo skill', repoPath: '.agents/skills/check/SKILL.md' },
    expected: 'Full repo skill',
  },
  {
    name: 'list_workflows',
    args: { workspace_id: 'ws1' },
    path: '/workflows',
    query: { workspaceId: 'ws1' },
    response: [workflow],
    expected: 'runs: 2',
  },
  {
    name: 'get_workflow',
    args: { workspace_id: 'ws1', workflow_id: 'w1' },
    path: '/workflows',
    query: { workspaceId: 'ws1' },
    response: [workflow],
    expected: '"events": [',
  },
  {
    name: 'get_workflow_vocabulary',
    args: { workspace_id: 'ws1', repos: ['acme/web'] },
    path: '/workflows/suggestions',
    query: { workspaceId: 'ws1', github: '1', repos: 'acme/web' },
    response: {
      repos: ['acme/web'],
      labels: ['bug'],
      branches: ['main'],
      people: [{ login: 'tom' }],
      teams: ['dev'],
      partial: true,
    },
    expected: 'labels: bug',
  },
  {
    name: 'list_workflow_runs',
    args: { workflow_id: 'w1', limit: 1, cursor: '2026-10-01T09:00:00Z' },
    path: '/workflows/w1/runs',
    query: { limit: '1', cursor: '2026-10-01T09:00:00Z' },
    response: [
      {
        id: 'wr1',
        status: 'succeeded',
        createdAt: '2026-09-30T09:00:00Z',
        repoFullName: 'acme/web',
        prNumber: 42,
        event: 'pr_opened',
      },
    ],
    expected: 'more: pass cursor=2026-09-30T09:00:00Z',
  },
  {
    name: 'list_loops',
    args: { workspace_id: 'ws1' },
    path: '/loops',
    query: { workspaceId: 'ws1' },
    response: [loop],
    expected: 'next: 2026-10-01T09:00:00Z',
  },
  {
    name: 'get_loop',
    args: { workspace_id: 'ws1', loop_id: 'l1' },
    path: '/loops',
    query: { workspaceId: 'ws1' },
    response: [loop],
    expected: '"prompt": "Check the code"',
  },
  {
    name: 'list_loop_runs',
    args: { loop_id: 'l1', limit: 1, cursor: '2026-10-01T09:00:00Z' },
    path: '/loops/l1/runs',
    query: { limit: '1', cursor: '2026-10-01T09:00:00Z' },
    response: [
      {
        id: 'lr1',
        status: 'dispatched',
        scheduledFor: '2026-09-30T09:00:00Z',
        createdAt: '2026-09-30T09:00:00Z',
        taskId: 't1',
      },
    ],
    expected: 'more: pass cursor=2026-09-30T09:00:00Z',
  },
  {
    name: 'list_mcp_servers',
    args: { workspace_id: 'ws1' },
    path: '/mcp-servers',
    query: { workspaceId: 'ws1' },
    response: [mcpServer],
    expected: 'connection: connected',
  },
  {
    name: 'get_mcp_server',
    args: { mcp_server_id: 'm1' },
    path: '/mcp-servers/m1',
    response: mcpServer,
    expected: 'tools: search',
  },
  {
    name: 'get_billing_status',
    args: {},
    path: '/billing/status',
    response: {
      plan: 'free',
      activeTasks: 1,
      activeTaskLimit: 3,
      queuedPrs: 2,
      mergeQueueLimit: 3,
      workflows: 1,
      workflowLimit: 3,
      loops: 0,
      loopLimit: null,
    },
    expected: 'loops: 0/unlimited',
  },
  {
    name: 'whats_new',
    args: {},
    path: '/release-notes/latest',
    response: {
      version: '1.2.3',
      publishedAt: '2026-09-30',
      highlights: [{ title: 'New tools', description: 'Use more tools' }],
    },
    expected: 'New tools: Use more tools',
  },
  {
    name: 'whats_new',
    args: { since: '1.2.3' },
    path: '/release-notes',
    query: { since: '1.2.3' },
    response: [],
    expected: 'No release notes.',
  },
];

describe('MCP reads and edge cases', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(readCases)(
    '$name reads $path and formats its result',
    async ({ name, args, path, query, response, expected }) => {
      const { calls } = mockApi({ [`GET /api/v1${path}`]: () => response });
      const output = await tool(`talyn_${name}`).handler(OWNER, args);
      expect(output).toContain(expected);
      expect(calls).toHaveLength(1);
      expect(Object.fromEntries(calls[0].url.searchParams)).toEqual(query ?? {});
      expect(output).not.toContain('NEVER_SHOW');
      expect(output).not.toContain('PRIVATE_PROMPT');
    }
  );

  it('returns provider state without credentials', async () => {
    mockApi({
      'GET /api/v1/cloud-providers': () => [
        {
          type: 'selfhosted',
          connected: true,
          connectedAgents: ['codex'],
          reauthAgents: ['claude'],
          secret: 'NEVER_SHOW',
        },
      ],
      'GET /api/v1/workspaces/ws1': () => ({
        ...workspace,
        settings: { defaultCloudProvider: 'selfhosted' },
      }),
    });
    const out = await tool('talyn_list_cloud_providers').handler(OWNER, { workspace_id: 'ws1' });
    expect(out).toContain('agents: codex  reauth needed: claude');
    expect(out).toContain('default provider: selfhosted');
    expect(out).not.toContain('NEVER_SHOW');
  });

  it('includes prompt text only when requested', async () => {
    mockApi({ 'GET /api/v1/workspaces/ws1': () => workspace });
    expect(
      await tool('talyn_get_workspace').handler(OWNER, {
        workspace_id: 'ws1',
        include_prompts: true,
      })
    ).toContain('PRIVATE_PROMPT');
  });

  it('caps the GitHub repository list after filtering', async () => {
    mockApi({
      'GET /api/v1/github/all-repos': () =>
        Array.from({ length: 120 }, (_, id) => ({
          id,
          full_name: `acme/web-${id}`,
          html_url: 'https://github.com/acme/web',
          private: false,
        })),
    });
    const out = await tool('talyn_list_github_repos').handler(OWNER, { workspace_id: 'ws1' });
    expect(out.split('\n')).toHaveLength(101);
    expect(out).toContain('20 more — narrow with search');
    const filtered = await tool('talyn_list_github_repos').handler(OWNER, {
      workspace_id: 'ws1',
      search: 'web-119',
    });
    expect(filtered.split('\n')).toHaveLength(1);
    expect(filtered).toContain('119  acme/web-119');
  });

  it('passes watching and task-only filters', async () => {
    const { calls } = mockApi({ 'GET /api/v1/pull-requests': () => [] });
    await tool('talyn_list_pull_requests').handler(OWNER, {
      workspace_id: 'ws1',
      bucket: 'watching',
      task_only: true,
    });
    expect(calls[0].url.searchParams.get('relationship')).toBe('watching');
    expect(calls[0].url.searchParams.get('taskOnly')).toBe('true');
  });

  it.each([1, 50, 100])('paginates tasks with a limit of %s', async (limit) => {
    const tasks = Array.from({ length: limit }, (_, id) => ({
      id: `t${id}`,
      title: 'Task',
      type: 'code_writing',
      status: 'completed',
      createdAt: `2026-09-29T09:00:00.000Z`,
    }));
    const { calls } = mockApi({ 'GET /api/v1/tasks': () => tasks });
    const out = await tool('talyn_list_tasks').handler(OWNER, {
      workspace_id: 'ws1',
      limit,
      before: '2026-09-30T09:00:00Z',
      status: 'completed,failed',
    });
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      workspaceId: 'ws1',
      limit: String(limit),
      before: '2026-09-30T09:00:00Z',
      status: 'completed,failed',
    });
    expect(out).toContain('more: pass before=2026-09-29T09:00:00.000Z');
  });

  it('defaults to 50 tasks and omits the cursor hint on short pages', async () => {
    const { calls } = mockApi({ 'GET /api/v1/tasks': () => [] });
    expect(await tool('talyn_list_tasks').handler(OWNER, { workspace_id: 'ws1' })).toBe(
      'No tasks.'
    );
    expect(calls[0].url.searchParams.get('limit')).toBe('50');
  });

  it.each([0, 101, 1.5, '50', NaN])('rejects invalid task limit %s', async (limit) => {
    const { calls } = mockApi({});
    await expect(
      tool('talyn_list_tasks').handler(OWNER, { workspace_id: 'ws1', limit })
    ).rejects.toThrow('limit');
    expect(calls).toHaveLength(0);
  });

  it('passes the structured task skill reference', async () => {
    const descriptor = {
      key: 'platform:s1',
      name: 'Check',
      source: 'platform',
      platformSkillId: 's1',
    };
    const { calls } = mockApi({
      'POST /api/v1/tasks': () => ({
        id: 't1',
        title: 'Check',
        type: 'code_writing',
        status: 'queued',
      }),
    });
    await tool('talyn_create_task').handler(OWNER, {
      workspace_id: 'ws1',
      repository_id: 'r1',
      prompt: 'Read the skill instructions',
      skill: descriptor,
      pull_request_id: 'pr1',
    });
    expect(calls[0].body).toMatchObject({
      skill: descriptor,
      pullRequestId: 'pr1',
      repositoryId: 'r1',
    });
  });

  it('prints human intervention and quota failover details', async () => {
    mockApi({
      'GET /api/v1/tasks/t1': () => ({
        id: 't1',
        status: 'needs_human',
        type: 'pr_response',
        title: 'Fix',
        metadata: {
          quotaFailover: { exhausted: 'claude', movedTo: 'codex', note: 'Moved to Codex' },
        },
        result: { success: false, needsHuman: { reason: 'Approve the visual review' } },
      }),
    });
    const out = await tool('talyn_get_task').handler(OWNER, { task_id: 't1' });
    expect(out).toContain('\nneeds human: Approve the visual review');
    expect(out).toContain(
      'quota failover: exhausted: claude; movedTo: codex; note: Moved to Codex'
    );
  });

  it('prints CI and human gates from the PR summary', async () => {
    mockApi({
      'GET /api/v1/pull-requests/pr1': () => ({
        row: pr({
          summary: {
            ...pr().summary,
            ciStatus: 'needs_human',
            humanGates: [
              {
                id: 'visual',
                label: 'Visual review',
                name: 'storybook',
                url: 'https://example.com/review',
              },
            ],
          },
        }),
      }),
    });
    const out = await tool('talyn_get_pull_request').handler(OWNER, { pull_request_id: 'pr1' });
    expect(out).toContain('CI: needs_human');
    expect(out).toContain(
      'human gate: visual Visual review — storybook https://example.com/review'
    );
  });

  it.each(['open', 'dismissed', 'all'])('filters findings by %s', async (status) => {
    mockApi({
      'GET /api/v1/pull-requests/pr1/code-review': () => ({
        review,
        findings: [finding, { ...finding, id: 'f2', disposition: 'dismissed' }],
      }),
    });
    const out = await tool('talyn_get_code_review').handler(OWNER, {
      pull_request_id: 'pr1',
      status,
    });
    expect(out.includes('f1 [')).toBe(status !== 'dismissed');
    expect(out.includes('f2 [')).toBe(status !== 'open');
  });

  it.each(['workflow', 'loop'])('does not update a missing %s', async (area) => {
    const { calls } = mockApi({ [`GET /api/v1/${area}s`]: () => [] });
    await expect(
      tool(`talyn_update_${area}`).handler(OWNER, {
        workspace_id: 'ws1',
        [`${area}_id`]: 'missing',
        [area]: { name: 'New name' },
      })
    ).rejects.toThrow('not found');
    expect(calls).toHaveLength(1);
  });

  it('resolves the sole workspace and refuses an ambiguous workspace', async () => {
    mockApi({ 'GET /api/v1/workspaces': () => [workspace], 'GET /api/v1/repositories': () => [] });
    expect(await tool('talyn_list_repositories').handler(OWNER, {})).toBe('None.');
    mockApi({ 'GET /api/v1/workspaces': () => [workspace, { ...workspace, id: 'ws2' }] });
    await expect(tool('talyn_list_repositories').handler(OWNER, {})).rejects.toThrow(
      'pass workspace_id'
    );
  });
});
