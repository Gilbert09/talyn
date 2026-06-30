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
  it('every tool has a unique talyn_ name and an object input schema', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^talyn_/);
      expect(t.description.length).toBeGreaterThan(0);
      expect((t.inputSchema as { type?: string }).type).toBe('object');
    }
  });

  it('covers the full surface (listing, context, actions, tasks)', () => {
    const names = TOOLS.map((t) => t.name);
    for (const expected of [
      'talyn_list_workspaces',
      'talyn_list_pull_requests',
      'talyn_get_pull_request',
      'talyn_get_pull_request_diff',
      'talyn_get_pull_request_reviews',
      'talyn_set_auto_keep_mergeable',
      'talyn_set_merge_queue',
      'talyn_merge_pull_request',
      'talyn_fix_pull_request',
      'talyn_create_task',
      'talyn_get_task',
      'talyn_stop_task',
      'talyn_retry_task',
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
      summary: { ...pr().summary, checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 } },
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
    const files = [{ filename: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: 'PATCHTEXT' }];
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
        return { ok: true, status: 200, json: async () => ({ success: true, data: [] }) } as Response;
      })
    );
    await tool('talyn_list_workspaces').handler(OWNER, {});
    expect(seenHeaders['x-fastowl-internal-user']).toBe(OWNER);
    expect(seenHeaders['x-fastowl-internal-token']).toBeTruthy();
  });
});
