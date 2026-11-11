import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CheckFact, TaskResult } from '@talyn/shared';

/**
 * The wake half of CI park: a parked run (`waiting_ci`) is resumed with what
 * CI said, exactly once, through the box gate as unattended work. Or it is
 * finished, with its box deleted, when it can never be resumed.
 */

const { openInterval, closeInterval, billing, gate } = vi.hoisted(() => ({
  openInterval: vi.fn(),
  closeInterval: vi.fn(),
  billing: { enabled: false },
  gate: vi.fn(),
}));

vi.mock('../services/billing/usage/index.js', () => ({ openInterval, closeInterval }));
vi.mock('../services/billing/entitlements.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/billing/entitlements.js')>();
  return { ...actual, billingEnabled: () => billing.enabled, checkBoxGate: gate };
});
vi.mock('../services/workbenches/memory.js', () => ({ withMemoryIndex: async (prompt: string) => prompt }));
vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
}));

const schema = await import('../db/schema.js');
const { createTestDb, seedUser } = await import('./helpers/testDb.js');
const ciPark = await import('../services/ciPark.js');
const { drainTaskMetadata } = await import('../services/taskMetadataMutex.js');
const { resetUsageHookCacheForTests } = await import('../services/billing/usageHooks.js');
const { resetBoxDeferralsForTests } = await import('../services/billing/boxDeferral.js');
const { ConcurrentBoxLimitError } = await import('../services/billing/entitlements.js');
const { FleetCapacityError, FleetHttpError, FleetRunNotFoundError, FleetTaskRefusedError } = await import(
  '../services/selfHosted/client.js'
);
type FleetClient = import('../services/selfHosted/client.js').FleetClient;

const WS = 'ws-wake';
const OWNER = 'owner-wake';
const RUN = 'talyn-task-wake';
const TASK = 'task-wake';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

const fact = (name: string, state: CheckFact['state'], required: boolean | null = true): CheckFact => ({ name, state, required });

describe('settledOutcome', () => {
  it.each<[string, CheckFact[], ReturnType<typeof ciPark.settledOutcome>]>([
    ['no checks yet', [], null],
    ['one still pending', [fact('a', 'success'), fact('b', 'pending')], null],
    ['one still running, one failed', [fact('a', 'failure'), fact('b', 'in_progress')], null],
    ['all passing', [fact('a', 'success'), fact('b', 'skipped')], { kind: 'passing' }],
    ['only optional failing', [fact('a', 'success'), fact('lint', 'failure', false)], { kind: 'passing' }],
    ['a required failure', [fact('b-test', 'failure'), fact('a-test', 'failure'), fact('ok', 'success')], { kind: 'failing', checks: ['a-test', 'b-test'] }],
    ['an unknown-required failure', [fact('mystery', 'failure', null)], { kind: 'failing', checks: ['mystery'] }],
  ])('%s', (_label, facts, expected) => {
    expect(ciPark.settledOutcome(facts)).toEqual(expected);
  });
});

describe('decideParked', () => {
  const NOW = Date.parse('2026-11-11T12:00:00Z');
  const state = (fields: Partial<import('../services/ciPark.js').AwaitCiState> = {}) => ({
    headSha: SHA,
    wakeToken: 'w',
    fleetTaskId: 'f1',
    parkedAt: '2026-11-11T11:00:00Z',
    deadlineAt: '2026-11-11T14:00:00Z',
    parks: ['2026-11-11T11:00:00Z'],
    ...fields,
  });
  const row = (fields: Partial<import('../services/ciPark.js').ParkedRow> = {}) => ({
    id: 't', workspaceId: WS, pullRequestId: 'pr', awaitCi: null, remoteTaskId: RUN,
    prState: 'open', prHeadSha: SHA, owner: 'acme', repo: 'widgets', ...fields,
  });

  it.each<[string, ReturnType<typeof row>, ReturnType<typeof state> | null, unknown]>([
    ['no park state', row(), null, { kind: 'finish', status: 'completed' }],
    ['the PR merged', row({ prState: 'merged' }), state(), { kind: 'finish', status: 'completed' }],
    ['the PR closed', row({ prState: 'closed' }), state(), { kind: 'finish', status: 'cancelled' }],
    ['the PR row is gone', row({ prState: null }), state(), { kind: 'finish', status: 'cancelled' }],
    ['a wake deferred to later', row(), state({ deferredUntil: '2026-11-11T12:05:00Z' }), { kind: 'skip' }],
    ['the head moved', row({ prHeadSha: OTHER_SHA }), state(), { kind: 'wake', outcome: { kind: 'head_moved', headSha: OTHER_SHA } }],
    ['the PR row still names the commit before the push', row({ prHeadSha: OTHER_SHA }), state({ prHeadAtPark: OTHER_SHA }),
      { kind: 'check_ci', headSha: SHA, timedOut: false }],
    ['the head moved on from the pre-push commit', row({ prHeadSha: 'abcabcabcabcabcabcabcabcabcabcabcabcabca' }), state({ prHeadAtPark: OTHER_SHA }),
      { kind: 'wake', outcome: { kind: 'head_moved' } }],
    ['a short sha on the same head', row(), state({ headSha: SHA.slice(0, 7) }), { kind: 'check_ci', headSha: SHA, timedOut: false }],
    ['a full sha the PR row has not caught up to', row({ prHeadSha: null }), state(), { kind: 'check_ci', headSha: SHA, timedOut: false }],
    ['past the deadline', row(), state({ deadlineAt: '2026-11-11T11:59:00Z' }), { kind: 'check_ci', timedOut: true }],
    ['a due deferral', row(), state({ deferredUntil: '2026-11-11T11:59:00Z' }), { kind: 'check_ci', timedOut: false }],
  ])('%s', (_label, r, s, expected) => {
    expect(ciPark.decideParked(r, s, NOW)).toMatchObject(expected as object);
  });
});

describe('waking a parked run', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let client: {
    resumeSandbox: ReturnType<typeof vi.fn>;
    submitTask: ReturnType<typeof vi.fn>;
    suspendSandbox: ReturnType<typeof vi.fn>;
    deleteSandbox: ReturnType<typeof vi.fn>;
  };
  const clientFor = async () => client as unknown as FleetClient;
  const readFacts = vi.fn<(repo: string, sha: string) => Promise<CheckFact[]>>();

  beforeEach(async () => {
    resetUsageHookCacheForTests();
    resetBoxDeferralsForTests();
    ciPark.resetCiParkForTests();
    billing.enabled = false;
    gate.mockReset().mockResolvedValue({ enforced: true, tier: 'pro', size: 'small', downgraded: false });
    openInterval.mockReset().mockResolvedValue(undefined);
    closeInterval.mockReset().mockResolvedValue(undefined);
    readFacts.mockReset().mockResolvedValue([fact('ci', 'success')]);
    client = {
      resumeSandbox: vi.fn(async () => undefined),
      submitTask: vi.fn(async () => ({ taskId: `${RUN}-t2`, status: 'running' })),
      suspendSandbox: vi.fn(async () => undefined),
      deleteSandbox: vi.fn(async () => undefined),
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: OWNER });
    await testDb.db.insert(schema.workspaces).values({ id: WS, ownerId: OWNER, name: 'Wake' });
    await testDb.db.insert(schema.repositories).values({ id: 'repo-wake', workspaceId: WS, name: 'acme/widgets', url: 'https://github.com/acme/widgets' });
    await testDb.db.insert(schema.pullRequests).values({
      id: 'pr-wake', workspaceId: WS, repositoryId: 'repo-wake', owner: 'acme', repo: 'widgets', number: 7,
      state: 'open', lastPolledAt: new Date(), lastSummary: { headSha: SHA },
    });
  });

  afterEach(async () => {
    await drainTaskMetadata(TASK);
    await new Promise((r) => setTimeout(r, 20));
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  async function seedParked(awaitCi: Record<string, unknown> = {}) {
    await testDb.db.insert(schema.tasks).values({
      id: TASK, workspaceId: WS, type: 'pr_response', status: 'waiting_ci', title: 'Fix', description: 'd',
      repositoryId: 'repo-wake', pullRequestId: 'pr-wake',
      metadata: {
        ciPark: true,
        cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: RUN, extra: { sandboxSize: 'small', model: 'claude-sonnet-5' } },
        awaitCi: {
          headSha: SHA, wakeToken: 'token-1', fleetTaskId: `${RUN}-t1`, parkedAt: new Date().toISOString(),
          deadlineAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(), parks: [new Date().toISOString()],
          ...awaitCi,
        },
      },
    });
  }

  async function task() {
    await drainTaskMetadata(TASK);
    const [row] = await testDb.db
      .select({ status: schema.tasks.status, result: schema.tasks.result, metadata: schema.tasks.metadata })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, TASK));
    return { status: row.status, result: row.result as TaskResult | null, metadata: row.metadata as Record<string, unknown> };
  }

  async function parkedRow() {
    const rows = await ciPark.parkedTasksQuery();
    return rows.find((r) => r.id === TASK)!;
  }

  it('resumes once when two wakes race: one resume, one prompt', async () => {
    await seedParked();
    const results = await Promise.all([
      ciPark.wakeParkedTask(TASK, 'token-1', { kind: 'passing' }, { clientFor }),
      ciPark.wakeParkedTask(TASK, 'token-1', { kind: 'passing' }, { clientFor }),
    ]);
    expect(results.sort()).toEqual(['lost_claim', 'woken']);
    expect(client.resumeSandbox).toHaveBeenCalledTimes(1);
    expect(client.submitTask).toHaveBeenCalledTimes(1);
    expect(client.resumeSandbox.mock.calls[0]).toEqual([RUN, { maxLifetimeSec: 6 * 60 * 60 }]);
    const [, input] = client.submitTask.mock.calls[0] as [string, { prompt: string; model: string; taskType: string }];
    expect(input.prompt).toContain('acme/widgets#7');
    expect(input.prompt).toContain('TALYN_AWAIT_CI:');
    expect(input).toMatchObject({ taskType: 'pr_response', model: 'claude-sonnet-5' });

    const t = await task();
    expect(t.status).toBe('in_progress');
    expect((t.metadata.cloudTask as { extra: Record<string, unknown> }).extra.fleetTaskId).toBe(`${RUN}-t2`);
    expect(t.metadata.awaitCi).toMatchObject({ wakingAt: null, lastWake: { outcome: 'passing' } });
    expect(openInterval).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale token: a waker that read an older park cannot claim this one', async () => {
    await seedParked();
    expect(await ciPark.wakeParkedTask(TASK, 'token-0', { kind: 'passing' }, { clientFor })).toBe('lost_claim');
    expect(client.resumeSandbox).not.toHaveBeenCalled();
    expect((await task()).status).toBe('waiting_ci');
  });

  it('defers on a gate refusal and stays parked, never a 402', async () => {
    billing.enabled = true;
    gate.mockRejectedValue(new ConcurrentBoxLimitError(2, 2, 'free', WS));
    await seedParked();

    expect(await ciPark.wakeParkedTask(TASK, 'token-1', { kind: 'passing' }, { clientFor })).toBe('deferred');

    const t = await task();
    expect(t.status).toBe('waiting_ci');
    expect(t.metadata.awaitCi).toMatchObject({ wakingAt: null, deferral: { reason: 'box_limit_reached' } });
    expect(Date.parse((t.metadata.awaitCi as { deferredUntil: string }).deferredUntil)).toBeGreaterThan(Date.now());
    expect(client.resumeSandbox).not.toHaveBeenCalled();
    expect(gate.mock.calls[0][1]).toMatchObject({ unattended: true, existingBox: 'asleep', excludeTaskId: TASK, size: 'small' });
  });

  it.each([
    ['guest_too_old', () => new FleetHttpError('guest too old', 409, 'guest_too_old')],
    ['a box that is gone', () => new FleetRunNotFoundError('no such sandbox')],
  ])('finishes the run and deletes the box when resume says %s', async (_label, error) => {
    client.resumeSandbox.mockRejectedValue(error());
    await seedParked();

    expect(await ciPark.wakeParkedTask(TASK, 'token-1', { kind: 'passing' }, { clientFor })).toBe('finished');

    const t = await task();
    expect(t.status).toBe('completed');
    expect(t.result).toMatchObject({ success: true, summary: ciPark.RESUME_FAILED_SUMMARY });
    expect(client.deleteSandbox).toHaveBeenCalledWith(RUN);
    expect(closeInterval.mock.calls.map((c) => c[2])).toContain('deleted');
  });

  it('finishes when the guest cannot take a second task', async () => {
    client.submitTask.mockRejectedValue(new FleetTaskRefusedError('no tasks', 'tasks_unsupported'));
    await seedParked();

    expect(await ciPark.wakeParkedTask(TASK, 'token-1', { kind: 'passing' }, { clientFor })).toBe('finished');
    expect((await task()).status).toBe('completed');
    expect(client.deleteSandbox).toHaveBeenCalledWith(RUN);
  });

  it('stays parked for a full fleet, and tries again in two minutes', async () => {
    client.resumeSandbox.mockRejectedValue(new FleetCapacityError('full'));
    await seedParked();

    expect(await ciPark.wakeParkedTask(TASK, 'token-1', { kind: 'passing' }, { clientFor })).toBe('deferred');

    const t = await task();
    expect(t.status).toBe('waiting_ci');
    const until = Date.parse((t.metadata.awaitCi as { deferredUntil: string }).deferredUntil);
    expect(until - Date.now()).toBeGreaterThan(60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(2 * 60_000);
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it('puts a woken box back to sleep when it would not take the prompt', async () => {
    client.submitTask.mockRejectedValue(new FleetTaskRefusedError('not live', 'sandbox_not_live'));
    await seedParked();

    expect(await ciPark.wakeParkedTask(TASK, 'token-1', { kind: 'passing' }, { clientFor })).toBe('deferred');
    expect(client.suspendSandbox).toHaveBeenCalledWith(RUN);
    expect((await task()).status).toBe('waiting_ci');
  });

  it('gives up after repeated unexplained failures', async () => {
    client.resumeSandbox.mockRejectedValue(new Error('boom'));
    await seedParked({ wakeFailures: 4 });

    expect(await ciPark.wakeParkedTask(TASK, 'token-1', { kind: 'passing' }, { clientFor })).toBe('finished');
    expect((await task()).status).toBe('completed');
  });

  it('reads the park state and two PR facts, never the transcript or the summary blob', () => {
    const text = ciPark.parkedTasksQuery().toSQL().sql;
    expect(text).not.toMatch(/select \*/i);
    expect(text).not.toContain('"transcript"');
    expect(text).toContain(`->> 'headSha'`);
    expect(text).not.toMatch(/"last_summary"(?! ->>)/);
  });

  describe('the sweep and the checks event', () => {
    it('wakes with a timeout past the deadline while CI still runs', async () => {
      readFacts.mockResolvedValue([fact('ci', 'in_progress')]);
      await seedParked({ deadlineAt: new Date(Date.now() - 1000).toISOString() });

      expect(await ciPark.handleParked(await parkedRow(), { readFacts, clientFor })).toBe('woken');
      expect(client.submitTask.mock.calls[0][1].prompt).toMatch(/did not finish/);
    });

    it('wakes with head_moved when somebody pushed while it slept', async () => {
      await testDb.db.update(schema.pullRequests).set({ lastSummary: { headSha: OTHER_SHA } }).where(eq(schema.pullRequests.id, 'pr-wake'));
      await seedParked();

      expect(await ciPark.handleParked(await parkedRow(), { readFacts, clientFor })).toBe('woken');
      expect(client.submitTask.mock.calls[0][1].prompt).toMatch(/moved from/);
      expect(readFacts).not.toHaveBeenCalled();
    });

    it.each([
      ['closed', 'cancelled'],
      ['merged', 'completed'],
    ])('finishes a run whose PR %s, and deletes its box', async (state, expected) => {
      await testDb.db.update(schema.pullRequests).set({ state }).where(eq(schema.pullRequests.id, 'pr-wake'));
      await seedParked();

      expect(await ciPark.handleParked(await parkedRow(), { readFacts, clientFor })).toBe('finished');
      expect((await task()).status).toBe(expected);
      expect(client.resumeSandbox).not.toHaveBeenCalled();
      expect(client.deleteSandbox).toHaveBeenCalledWith(RUN);
    });

    it('wakes on a checks event for its head once CI settles', async () => {
      await seedParked();
      await ciPark.ciParkSweep.tick({ readFacts: async () => [fact('ci', 'pending')], clientFor });
      expect(client.resumeSandbox).not.toHaveBeenCalled();

      readFacts.mockResolvedValue([fact('ci', 'failure')]);
      const evt = {
        prs: [{ prId: 'pr-wake', workspaceId: WS, repositoryId: 'repo-wake', number: 7 }],
        repoFullName: 'acme/widgets',
        headSha: SHA,
        checks: { total: 1, failed: 1, inProgress: 0, passed: 0 } as never,
      };
      expect(await ciPark.onPrChecks(evt, { readFacts, clientFor })).toBe(1);
      expect(readFacts).toHaveBeenCalledWith('acme/widgets', SHA);
      expect(client.submitTask.mock.calls[0][1].prompt).toContain('`ci`');
    });

    it.each([
      ['another sha', { headSha: OTHER_SHA }, [fact('ci', 'success')]],
      ['pending checks', {}, [fact('ci', 'pending')]],
    ])('ignores a checks event with %s', async (_label, override, facts) => {
      await seedParked();
      await ciPark.ciParkSweep.tick({ readFacts: async () => [fact('ci', 'pending')], clientFor });
      readFacts.mockResolvedValue(facts);
      const evt = {
        prs: [{ prId: 'pr-wake', workspaceId: WS, repositoryId: 'repo-wake', number: 7 }],
        repoFullName: 'acme/widgets',
        headSha: SHA,
        checks: { total: 1, failed: 0, inProgress: 1, passed: 0 } as never,
        ...override,
      };
      expect(await ciPark.onPrChecks(evt, { readFacts, clientFor })).toBe(0);
      expect(client.resumeSandbox).not.toHaveBeenCalled();
      expect((await task()).status).toBe('waiting_ci');
    });

    it('does nothing at all with nothing parked: no query on a checks event', async () => {
      const select = vi.spyOn(testDb.db, 'select');
      const evt = {
        prs: [{ prId: 'pr-wake', workspaceId: WS, repositoryId: 'repo-wake', number: 7 }],
        repoFullName: 'acme/widgets',
        headSha: SHA,
        checks: { total: 1, failed: 0, inProgress: 0, passed: 1 } as never,
      };
      expect(await ciPark.onPrChecks(evt, { readFacts, clientFor })).toBe(0);
      expect(select).not.toHaveBeenCalled();
      expect(await ciPark.ciParkSweep.tick({ readFacts, clientFor })).toBe(0);
      expect(readFacts).not.toHaveBeenCalled();
    });
  });
});

