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

    it('says why a recorded step waits, and tells the agent to record only what every session needs', async () => {
      mockApi({
        'GET /api/v1/workbenches/s1': () => wb(),
        'POST /api/v1/repositories/repo1/setup-recipe/steps': () => ({
          steps: [{ ...recorded.steps[0], stateReason: 'Waiting: needed by 1 of 12 sessions in the last 14 days.' }],
        }),
      });
      const text = await tool('record_setup_step').handler(OWNER, { command: 'cargo install sqlx-cli', why: 'y' }, SELF);
      expect(text).toContain('cargo install sqlx-cli\n    Waiting: needed by 1 of 12 sessions in the last 14 days.');
      const description = tool('record_setup_step').description;
      expect(description).toContain('Record only a step that every session on this repository needs');
      expect(description).toContain('a browser for one test');
      expect(description).toContain('at least 3 sessions and 30%');
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

  describe('setup step list and revert', () => {
    const step = (overrides: Record<string, unknown> = {}) => ({
      id: 'st_1', command: 'cargo install sqlx-cli', kind: 'cargo', phase: 'install', why: null, source: 'learned',
      sourceWorkbenchId: 's1', firstSeenAt: '2026-10-30T10:00:00.000Z', lastSeenAt: '2026-10-31T10:00:00.000Z', seenCount: 2,
      appliedAt: null, disabledAt: null, disabledReason: null, bakeDisabledAt: null, bakeDisabledReason: null, ...overrides,
    });
    const recipe = (steps: unknown[], learningDisabled = false) => ({ repositoryId: 'repo1', learningDisabled, maxSteps: 20, steps });
    const RECIPE = '/api/v1/repositories/repo1/setup-recipe';

    it('are scoped: list for a session token, revert for a user token only', () => {
      expect(SESSION_TOKEN_TOOLS.has('talyn_list_setup_steps')).toBe(true);
      expect(SESSION_TOKEN_TOOLS.has('talyn_revert_setup_step')).toBe(false);
      expect(tool('list_setup_steps').annotations.readOnlyHint).toBe(true);
      expect(tool('revert_setup_step').annotations.destructiveHint).toBe(true);
    });

    it('lists each step with its state and whether learning is on', async () => {
      const { calls } = mockApi({
        [`GET ${RECIPE}`]: () => recipe([
          step(),
          step({ id: 'st_2', command: 'apt-get install -y jq', appliedAt: '2026-11-01T00:00:00.000Z', sourceWorkbenchId: null, source: 'agent' }),
          step({ id: 'st_3', command: 'brew install x', disabledAt: '2026-11-02T09:00:00.000Z', disabledReason: 'not needed' }),
        ], true),
      });
      const text = await tool('list_setup_steps').handler(OWNER, { repository_id: 'repo1' });
      expect(calls).toHaveLength(1);
      expect(text).toContain('Learning is off. 2 of 20 live.');
      expect(text).toContain('st_1  cargo install sqlx-cli  [cargo, install]  session s1, learned, 2026-10-30  box setup only');
      expect(text).toContain('st_2  apt-get install -y jq  [cargo, install]  no session, agent, 2026-10-30  settled into the bake');
      expect(text).toContain('st_3  brew install x  [cargo, install]  session s1, learned, 2026-10-30  reverted 2026-11-02 (not needed)');
    });

    it('shows how long each step and the last setup took, and why a step is in its state', async () => {
      mockApi({
        [`GET ${RECIPE}`]: () => ({
          ...recipe([
            step({ lastDurationMs: 192_000, typicalDurationMs: 170_000, measuredBoxes: 4, stateReason: 'Live: needed by 9 of 30 sessions in the last 14 days (30%).' }),
            step({ id: 'st_2', lastDurationMs: 5_000, typicalDurationMs: 5_000, measuredBoxes: 1 }),
            step({ id: 'st_3', stateReason: 'Waiting: needed by 2 of 31 sessions in the last 14 days.' }),
          ]),
          lastSetupTiming: { totalMs: 580_000, repositoryMs: 125_000, learnedMs: 455_000, measuredAt: '2026-11-03T10:00:00.000Z', workbenchId: 's1' },
        }),
      });
      const text = await tool('list_setup_steps').handler(OWNER, { repository_id: 'repo1' });
      expect(text).toContain('Last setup took 9m 40s: repository setup 2m 5s, learned steps 7m 35s.');
      expect(text).toContain('box setup only\n    took 3m 12s (typical 2m 50s). Live: needed by 9 of 30 sessions in the last 14 days (30%).');
      // One box: no typical time yet.
      expect(text).toContain('box setup only\n    took 5s\n');
      expect(text).toContain('box setup only\n    Waiting: needed by 2 of 31 sessions in the last 14 days.');
    });

    it('says only learned steps when the repository has no setup of its own', async () => {
      mockApi({
        [`GET ${RECIPE}`]: () => ({ ...recipe([]), lastSetupTiming: { totalMs: 9_000, repositoryMs: null, learnedMs: 9_000, measuredAt: '2026-11-03T10:00:00.000Z', workbenchId: null } }),
      });
      expect(await tool('list_setup_steps').handler(OWNER, { repository_id: 'repo1' })).toContain('Last setup took 9s: learned steps 9s.');
    });

    it('says when there are no steps', async () => {
      mockApi({ [`GET ${RECIPE}`]: () => recipe([]) });
      expect(await tool('list_setup_steps').handler(OWNER, { repository_id: 'repo1' })).toContain('No steps.');
    });

    it('reverts a step, and a second list shows it reverted', async () => {
      let reverted = false;
      const { calls } = mockApi({
        [`DELETE ${RECIPE}/steps/st_1`]: () => {
          reverted = true;
          return recipe([step({ disabledAt: '2026-11-03T00:00:00.000Z' })]);
        },
        [`GET ${RECIPE}`]: () => recipe([reverted ? step({ disabledAt: '2026-11-03T00:00:00.000Z' }) : step()]),
      });
      const text = await tool('revert_setup_step').handler(OWNER, { repository_id: 'repo1', step_id: 'st_1' });
      expect(calls[0].method).toBe('DELETE');
      expect(text).toContain('Reverted st_1.');
      expect(text).toContain('0 of 20 live.');
      expect(await tool('list_setup_steps').handler(OWNER, { repository_id: 'repo1' })).toContain('reverted 2026-11-03');
    });

    it.each(['list_setup_steps', 'revert_setup_step'])('answers not found for a repository of another workspace in %s', async (name) => {
      mockApi({}, {
        [`GET ${RECIPE}`]: { status: 404, error: 'Repository not found.' },
        [`DELETE ${RECIPE}/steps/st_1`]: { status: 404, error: 'Repository not found.' },
      });
      await expect(tool(name).handler(OWNER, { repository_id: 'repo1', step_id: 'st_1' })).rejects.toThrow(/not found/i);
    });

    it('answers not found for an unknown step', async () => {
      mockApi({}, { [`DELETE ${RECIPE}/steps/nope`]: { status: 404, error: 'This repository has no such setup step.' } });
      await expect(tool('revert_setup_step').handler(OWNER, { repository_id: 'repo1', step_id: 'nope' })).rejects.toThrow(/no such setup step/);
    });

    it.each([
      ['list_setup_steps', {}, 'repository_id is required'],
      ['revert_setup_step', { repository_id: 'repo1' }, 'step_id is required'],
    ])('needs its ids in %s', async (name, args, error) => {
      mockApi({});
      await expect(tool(name).handler(OWNER, args)).rejects.toThrow(error);
    });
  });
});
