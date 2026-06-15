import { describe, it, expect, afterEach, vi } from 'vitest';
import { TOOLS, type McpToolDefinition } from '../mcp/tools.js';

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
    const data = route ? route(url, init) : null;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data }),
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
    mergeQueueState: null,
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
  it('every tool has a unique fastowl_ name and an object input schema', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^fastowl_/);
      expect(t.description.length).toBeGreaterThan(0);
      expect((t.inputSchema as { type?: string }).type).toBe('object');
    }
  });

  it('covers the full surface (listing, context, actions, tasks)', () => {
    const names = TOOLS.map((t) => t.name);
    for (const expected of [
      'fastowl_list_workspaces',
      'fastowl_list_pull_requests',
      'fastowl_get_pull_request',
      'fastowl_get_pull_request_diff',
      'fastowl_get_pull_request_reviews',
      'fastowl_set_auto_keep_mergeable',
      'fastowl_set_merge_queue',
      'fastowl_merge_pull_request',
      'fastowl_fix_pull_request',
      'fastowl_review_pull_request',
      'fastowl_create_task',
      'fastowl_get_task',
      'fastowl_stop_task',
      'fastowl_retry_task',
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
    await tool('fastowl_list_pull_requests').handler(OWNER, {
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
      summary: { ...pr().summary, checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 } },
    });
    mockApi({ 'GET /api/v1/pull-requests': () => [clean, failing] });
    const out = await tool('fastowl_list_pull_requests').handler(OWNER, {
      workspace_id: 'ws1',
      bucket: 'needs_attention',
    });
    expect(out).toContain('failing');
    expect(out).not.toContain('clean');
  });

  it('get_pull_request_diff omits the patch unless asked', async () => {
    const files = [{ filename: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: 'PATCHTEXT' }];
    mockApi({ 'GET /api/v1/pull-requests/pr1/files': () => files });

    const without = await tool('fastowl_get_pull_request_diff').handler(OWNER, {
      pull_request_id: 'pr1',
    });
    expect(without).toContain('a.ts');
    expect(without).not.toContain('PATCHTEXT');

    const withPatch = await tool('fastowl_get_pull_request_diff').handler(OWNER, {
      pull_request_id: 'pr1',
      include_patch: true,
    });
    expect(withPatch).toContain('PATCHTEXT');
  });

  it('fix_pull_request resolves repo/PR from the PR and posts the right task type', async () => {
    const { calls } = mockApi({
      'GET /api/v1/pull-requests/pr1': () => ({ row: pr() }),
      'POST /api/v1/tasks': () => ({ id: 'task1', type: 'pr_review', title: 't', status: 'queued' }),
    });

    await tool('fastowl_fix_pull_request').handler(OWNER, {
      pull_request_id: 'pr1',
      instructions: 'fix the lint',
      mode: 'review',
    });

    const post = calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/v1/tasks');
    expect(post).toBeTruthy();
    const body = post!.body as Record<string, unknown>;
    expect(body.type).toBe('pr_review');
    expect(body.repositoryId).toBe('repo1');
    expect(body.pullRequestId).toBe('pr1');
    expect(body.workspaceId).toBe('ws1');
    expect(body.prompt).toBe('fix the lint');
  });

  it('passes internal-proxy headers identifying the owner', async () => {
    let seenHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init: RequestInit = {}) => {
        seenHeaders = (init.headers as Record<string, string>) ?? {};
        return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) } as Response;
      })
    );
    await tool('fastowl_list_workspaces').handler(OWNER, {});
    expect(seenHeaders['x-fastowl-internal-user']).toBe(OWNER);
    expect(seenHeaders['x-fastowl-internal-token']).toBeTruthy();
  });
});
