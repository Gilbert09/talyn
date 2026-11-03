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

  describe('session_sandbox_status', () => {
    const status = {
      workbenchId: 's1', checkedAt: '2099-01-01T12:00:00.000Z', state: 'idle', headline: 'Idle. It goes to sleep in 12 minutes.',
      detail: null, sleepsAt: '2099-01-01T12:12:00.000Z', since: '2099-01-01T10:30:00.000Z', replacementStarting: false,
      fleet: { known: true, status: 'idle', phase: 'agent', error: null }, host: 'hetzner-64',
      size: { key: 'standard', label: 'Standard · 4 GB, 4 vCPU', memMib: 4096, vcpus: 4 },
      activity: [{ kind: 'queued', text: '1 message queued.', since: null }],
      work: {
        savedAt: '2099-01-01T10:00:00.000Z', savedBytes: 1554, checkedAt: '2099-01-01T11:00:00.000Z', unpushedCommits: 1,
        uncommitted: { added: 3, removed: 1, files: 2 }, committed: null, branchPushed: false, failures: 3,
        lastFailureAt: '2099-01-01T11:59:00.000Z', lastFailure: 'disk I/O error', warning: 'Talyn could not save the work 3 times in a row.', warningLevel: 'danger',
      },
      problem: { text: 'The sandbox was lost.', at: '2099-01-01T09:00:00.000Z' },
      actions: [{ kind: 'resize', label: 'Move to a new size', confirm: null }],
    };

    it('is read-only and in the session allow-list', () => {
      expect(SESSION_TOKEN_TOOLS.has('talyn_session_sandbox_status')).toBe(true);
      expect(tool('session_sandbox_status').annotations.readOnlyHint).toBe(true);
    });

    it('reads the calling session by default and says every fact in words', async () => {
      const { calls } = mockApi({ 'GET /api/v1/workbenches/s1/sandbox-status': () => status });
      const text = await tool('session_sandbox_status').handler(OWNER, {}, SELF);
      expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/workbenches/s1/sandbox-status']);
      for (const part of [
        'Session s1: Idle. It goes to sleep in 12 minutes.',
        'Sandbox: host hetzner-64, size Standard · 4 GB, 4 vCPU.',
        'Started at: 2099-01-01T10:30:00.000Z',
        '  1 message queued.',
        'Last checkpoint: 2099-01-01T10:00:00.000Z; last check with no new changes: 2099-01-01T11:00:00.000Z',
        'Not committed: 2 file(s), +3/-1',
        'Commits not on GitHub: 1',
        'Saves failed in a row: 3, last at 2099-01-01T11:59:00.000Z: disk I/O error',
        'Warning: Talyn could not save the work 3 times in a row.',
        'Last problem (2099-01-01T09:00:00.000Z): The sandbox was lost.',
        'Actions in the app: Move to a new size.',
      ]) expect(text).toContain(part);
    });

    it('says nothing runs, and that the fleet did not answer', async () => {
      mockApi({ 'GET /api/v1/workbenches/s1/sandbox-status': () => ({
        ...status, state: 'unknown', headline: 'Talyn could not read the sandbox from the fleet.', sleepsAt: null, since: null,
        fleet: { known: false, status: null, phase: null, error: 'timeout' }, activity: [], work: null, problem: null, actions: [],
      }) });
      const text = await tool('session_sandbox_status').handler(OWNER, {}, SELF);
      expect(text).toContain('The fleet did not answer: timeout');
      expect(text).toContain('Doing:\n  Nothing.');
      expect(text).not.toContain('Work:');
    });

    it('reads a session of the calling thread', async () => {
      const { calls } = mockApi({
        'GET /api/v1/workbenches/s1': () => wb({ threadId: 'thread1' }),
        'GET /api/v1/workbenches/s1/sandbox-status': () => status,
      });
      await tool('session_sandbox_status').handler(OWNER, { session_id: 's1' }, THREAD);
      expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/workbenches/s1', '/api/v1/workbenches/s1/sandbox-status']);
    });

    it('refuses a session outside the caller and its thread', async () => {
      const { calls } = mockApi({ 'GET /api/v1/workbenches/other': () => wb({ id: 'other', threadId: 'thread9' }) });
      await expect(tool('session_sandbox_status').handler(OWNER, { session_id: 'other' }, SELF)).rejects.toThrow(/itself, or a session in its thread/);
      expect(calls.map((c) => c.url.pathname)).toEqual(['/api/v1/workbenches/other']);
    });

    it('reads any session for a user token, and needs a session id there', async () => {
      mockApi({ 'GET /api/v1/workbenches/other/sandbox-status': () => ({ ...status, workbenchId: 'other' }) });
      expect(await tool('session_sandbox_status').handler(OWNER, { session_id: 'other' })).toContain('Session other:');
      await expect(tool('session_sandbox_status').handler(OWNER, {})).rejects.toThrow('session_id is required');
    });
  });

  describe('record_setup_step', () => {
    const recorded = { steps: [{ id: 'st_1', command: 'cargo install sqlx-cli', kind: 'cargo', phase: 'install', state: 'waiting' }] };

    it("adds the step to the calling session's repository", async () => {
      const { calls } = mockApi({
        'GET /api/v1/workbenches/s1': () => wb(),
        'POST /api/v1/repositories/repo1/setup-recipe/steps': () => recorded,
      });
      const text = await tool('record_setup_step').handler(OWNER, { command: 'cargo install sqlx-cli', why: 'migrations need sqlx' }, SELF);
      expect(calls[1].body).toEqual({ command: 'cargo install sqlx-cli', why: 'migrations need sqlx', sessionId: 's1' });
      expect(text).toContain('Added to the Setup list of posthog/posthog');
      expect(text).toContain('st_1  suggested  [cargo, image]  cargo install sqlx-cli');
    });

    it.each([
      ['waiting', 'install', 'suggested  [cargo, image]'],
      ['live', 'install', 'active  [cargo, image]'],
      ['live', 'start', 'active  [cargo, box]'],
      ['reverted', 'install', 'dismissed  [cargo, image]'],
      ['failing', 'start', 'disabled  [cargo, box]'],
    ])('shows a %s %s step in Setup list words', async (state, phase, words) => {
      mockApi({
        'GET /api/v1/workbenches/s1': () => wb(),
        'POST /api/v1/repositories/repo1/setup-recipe/steps': () => ({ steps: [{ ...recorded.steps[0], state, phase }] }),
      });
      const text = await tool('record_setup_step').handler(OWNER, { command: 'cargo install sqlx-cli', why: 'y' }, SELF);
      expect(text).toContain(`st_1  ${words}  cargo install sqlx-cli`);
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
      expect(description).toContain('A new step is suggested');
      expect(description).not.toContain('revert');
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

  describe('setup step list and dismiss', () => {
    const step = (overrides: Record<string, unknown> = {}) => ({
      id: 'st_1', repositoryId: 'repo1', position: 0, name: 'cargo install sqlx-cli', command: 'cargo install sqlx-cli',
      kind: 'cargo', runOn: 'image', origin: 'learned', status: 'suggested', statusReason: null, statusChangedAt: null,
      acceptedBy: null, timeoutSec: null, boxOnlyReason: null, why: null, sourceWorkbenchId: 's1', seenCount: 2, sessionCount: 2,
      firstSeenAt: '2026-10-30T10:00:00.000Z', lastSeenAt: '2026-10-31T10:00:00.000Z', confirmedAt: null, imageAppliedAt: null,
      imageFailedAt: null, imageFailureReason: null, boxFailureCount: 0, boxLastFailure: null, lastDurationMs: null,
      typicalDurationMs: null, measuredBoxes: 0, createdAt: '2026-10-30T10:00:00.000Z', updatedAt: '2026-10-30T10:00:00.000Z',
      ...overrides,
    });
    const setup = (steps: unknown[], overrides: Record<string, unknown> = {}) => ({
      repositoryId: 'repo1', learningDisabled: false, windowDays: 14, maxLearnedSteps: 20,
      limits: { imageMaxSteps: 20, imageTotalSec: 3600, maxHosts: 10, maxUserSteps: 40, stepMaxSec: 3600 },
      repoSetup: { command: null, source: null, readAt: null, runOnBox: 'always' },
      steps, hosts: [], image: null, lastSetupTiming: null, timingHistory: [], ...overrides,
    });
    const SETUP = '/api/v1/repositories/repo1/setup';

    it('are scoped: list for a session token, dismiss for a user token only', () => {
      expect(SESSION_TOKEN_TOOLS.has('talyn_list_setup_steps')).toBe(true);
      expect(SESSION_TOKEN_TOOLS.has('talyn_revert_setup_step')).toBe(false);
      expect(tool('list_setup_steps').annotations.readOnlyHint).toBe(true);
      expect(tool('revert_setup_step').annotations.destructiveHint).toBe(true);
    });

    it('lists each step with its status, place, origin and name, and whether learning is on', async () => {
      const { calls } = mockApi({
        [`GET ${SETUP}`]: () => setup([
          step(),
          step({ id: 'st_2', name: 'Install jq', command: 'apt-get install -y jq', status: 'active', origin: 'agent', acceptedBy: 'talyn' }),
          step({ id: 'st_3', name: 'Start redis', command: 'redis-server --daemonize yes', runOn: 'box', origin: 'user', status: 'active' }),
          step({ id: 'st_4', status: 'dismissed', statusReason: 'Dismissed by a person.' }),
          step({ id: 'st_5', status: 'disabled', runOn: 'both', statusReason: 'Failed on 2 boxes in a row. Last: exit 1' }),
        ], { learningDisabled: true, repoSetup: { command: 'npm ci', source: 'talyn', readAt: null, runOnBox: 'moved' } }),
      });
      const text = await tool('list_setup_steps').handler(OWNER, { repository_id: 'repo1' });
      expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`GET ${SETUP}`]);
      for (const part of [
        'Setup list of repo1. Learning is off. 2 active, 1 suggested, 1 disabled, 1 dismissed.',
        'Repository setup: npm ci (on each box: moved).',
        '  st_1  suggested  [image, learned]  cargo install sqlx-cli\n',
        '  st_2  active  [image, agent]  Install jq\n    Command: apt-get install -y jq',
        '  st_3  active  [box, user]  Start redis\n    Command: redis-server --daemonize yes',
        '  st_4  dismissed  [image, learned]  cargo install sqlx-cli\n    Dismissed by a person.',
        '  st_5  disabled  [both, learned]  cargo install sqlx-cli\n    Failed on 2 boxes in a row. Last: exit 1',
      ]) expect(text).toContain(part);
    });

    it('shows how long each step and the last setup took, and why a step has its status', async () => {
      mockApi({
        [`GET ${SETUP}`]: () => setup([
          step({ lastDurationMs: 192_000, typicalDurationMs: 170_000, measuredBoxes: 4, verdictReason: 'Live: needed by 9 of 30 sessions in the last 14 days (30%).' }),
          step({ id: 'st_2', lastDurationMs: 5_000, typicalDurationMs: 5_000, measuredBoxes: 1 }),
          step({ id: 'st_3', status: 'suggested', statusReason: 'Talyn removed this step on 2026-11-02: needed by 2 of 31 sessions.', verdictReason: 'ignored' }),
          step({ id: 'st_4', status: 'active', imageFailureReason: 'The step failed in the image build with exit 2.' }),
        ], {
          lastSetupTiming: {
            totalMs: 580_000, repositoryMs: 125_000, learnedMs: 455_000, measuredAt: '2026-11-03T10:00:00.000Z', workbenchId: 's1',
            setupBoxStepsMs: 400_000,
          },
        }),
      });
      const text = await tool('list_setup_steps').handler(OWNER, { repository_id: 'repo1' });
      expect(text).toContain('Last setup took 9m 40s: repository setup 2m 5s, setup steps 6m 40s.');
      expect(text).toContain('sqlx-cli\n    Took 3m 12s (typical 2m 50s).\n    Live: needed by 9 of 30 sessions in the last 14 days (30%).');
      // One box: no typical time yet.
      expect(text).toContain('sqlx-cli\n    Took 5s.\n');
      expect(text).toContain('Talyn removed this step on 2026-11-02: needed by 2 of 31 sessions.');
      expect(text).not.toContain('ignored');
      expect(text).toContain('    Image build: The step failed in the image build with exit 2.');
    });

    it.each([
      [{ totalMs: 9_000, repositoryMs: null, learnedMs: 9_000, measuredAt: '2026-11-03T10:00:00.000Z', workbenchId: null }, 'Last setup took 9s: setup steps 9s.'],
      [{ totalMs: 9_000, repositoryMs: 4_000, learnedMs: 5_000, measuredAt: '2026-11-03T10:00:00.000Z', workbenchId: null, setupBoxStepsMs: null }, 'Last setup took 9s: repository setup 4s, setup steps 5s.'],
    ])('reads the old and the new timing fields', async (lastSetupTiming, line) => {
      mockApi({ [`GET ${SETUP}`]: () => setup([], { lastSetupTiming }) });
      expect(await tool('list_setup_steps').handler(OWNER, { repository_id: 'repo1' })).toContain(line);
    });

    it('says when there are no steps, and when the repository has no setup command', async () => {
      mockApi({ [`GET ${SETUP}`]: () => setup([]) });
      const text = await tool('list_setup_steps').handler(OWNER, { repository_id: 'repo1' });
      expect(text).toContain('No steps.');
      expect(text).toContain('The repository has no setup command of its own.');
    });

    it('dismisses a step, and shows the list after it', async () => {
      const { calls } = mockApi({
        [`POST ${SETUP}/steps/st_1/dismiss`]: () => setup([step({ status: 'dismissed', statusReason: 'Dismissed by a person.' })]),
      });
      const text = await tool('revert_setup_step').handler(OWNER, { repository_id: 'repo1', step_id: 'st_1' });
      expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([`POST ${SETUP}/steps/st_1/dismiss`]);
      expect(text).toContain('Dismissed st_1.');
      expect(text).toContain('0 active, 0 suggested, 0 disabled, 1 dismissed.');
    });

    it("passes on the refusal to dismiss a person's own step", async () => {
      mockApi({}, {
        [`POST ${SETUP}/steps/st_1/dismiss`]: { status: 409, error: 'This is your own step. Remove it from the list instead.', code: 'not_learned' },
      });
      await expect(tool('revert_setup_step').handler(OWNER, { repository_id: 'repo1', step_id: 'st_1' }))
        .rejects.toThrow('This is your own step. Remove it from the list instead.');
    });

    it.each(['list_setup_steps', 'revert_setup_step'])('answers not found for a repository of another workspace in %s', async (name) => {
      mockApi({}, {
        [`GET ${SETUP}`]: { status: 404, error: 'Repository not found.' },
        [`POST ${SETUP}/steps/st_1/dismiss`]: { status: 404, error: 'Repository not found.' },
      });
      await expect(tool(name).handler(OWNER, { repository_id: 'repo1', step_id: 'st_1' })).rejects.toThrow(/not found/i);
    });

    it('answers not found for an unknown step', async () => {
      mockApi({}, { [`POST ${SETUP}/steps/nope/dismiss`]: { status: 404, error: 'This repository has no such setup step.' } });
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
