import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  startProgressFraction,
  startStepFraction,
  START_ESTIMATE_CAP,
  type WorkbenchStartProgress,
} from '@talyn/shared';
import { FakeFleet } from './helpers/fakeFleet.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, workspaces } from '../db/schema.js';
import {
  clearLiveStartProgress,
  createProgressThrottle,
  publicStartProgress,
  setLiveGitProgress,
  startStep,
} from '../services/workbenches/startProgress.js';
import {
  parseStartStepHistory,
  readStartStepMedians,
  startStepHistoryQuery,
  startStepMedians,
  type StartStepEntry,
} from '../services/workbenches/boxStart.js';
import { runCapture, setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import type { WorkbenchRow } from '../services/workbenches/store.js';

const NOW = new Date('2099-01-01T12:00:00.000Z');

describe('startStep', () => {
  it.each([
    ['sandbox', false, 0, 3],
    ['code', false, 1, 3],
    ['setup', false, 2, 3],
    ['sandbox', true, 0, 1],
  ] as const)('%s (thread %s) is step %i of %i', (step, thread, index, count) => {
    expect(startStep(step, { thread, expectedMs: 1_000, now: NOW })).toEqual({
      step, stepIndex: index, stepCount: count, stepStartedAt: NOW.toISOString(), expectedMs: 1_000,
    });
  });

  it.each([
    [null, null],
    [0, null],
    [-5, null],
    [Number.NaN, null],
    [1234.6, 1235],
  ])('keeps an expected time of %s as %s', (expectedMs, kept) => {
    expect(startStep('code', { thread: false, expectedMs, now: NOW }).expectedMs).toBe(kept);
  });
});

describe('publicStartProgress', () => {
  const stored = startStep('code', { thread: false, expectedMs: 60_000, now: NOW });
  afterEach(() => clearLiveStartProgress('wb'));

  it('answers the stored step with no percentage', () => {
    expect(publicStartProgress({ id: 'wb', status: 'provisioning', startProgress: stored }))
      .toEqual({ ...stored, percent: null, detail: null });
  });

  it('merges git progress for the same step', () => {
    setLiveGitProgress('wb', stored.stepStartedAt, 42, 'Receiving objects');
    expect(publicStartProgress({ id: 'wb', status: 'provisioning', startProgress: stored }))
      .toMatchObject({ percent: 42, detail: 'Receiving objects' });
  });

  it('ignores git progress left by another step', () => {
    setLiveGitProgress('wb', '2098-01-01T00:00:00.000Z', 42, 'Receiving objects');
    expect(publicStartProgress({ id: 'wb', status: 'provisioning', startProgress: stored }))
      .toMatchObject({ percent: null, detail: null });
  });

  it('forgets git progress once cleared', () => {
    setLiveGitProgress('wb', stored.stepStartedAt, 42, 'Receiving objects');
    clearLiveStartProgress('wb');
    expect(publicStartProgress({ id: 'wb', status: 'provisioning', startProgress: stored })?.percent).toBeNull();
  });

  it.each([
    ['a ready row', { status: 'ready', startProgress: stored }],
    ['an error row', { status: 'error', startProgress: stored }],
    ['a moving row', { status: 'moving', startProgress: stored }],
    ['no progress', { status: 'provisioning', startProgress: null }],
    ['an absent column (an older row shape)', { status: 'provisioning' }],
    ['an unknown step', { status: 'provisioning', startProgress: { ...stored, step: 'deploy' } }],
    ['a broken value', { status: 'provisioning', startProgress: 'junk' }],
  ])('answers null for %s', (_name, row) => {
    expect(publicStartProgress({ id: 'wb', ...row })).toBeNull();
  });
});

describe('createProgressThrottle', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('emits at most once per interval, only on a new whole percentage, and always the last one', async () => {
    vi.useFakeTimers({ now: NOW });
    const emit = vi.fn(async () => undefined);
    const throttle = createProgressThrottle(emit, 1_000);
    throttle.note(1.2);
    expect(emit).toHaveBeenCalledTimes(1);
    throttle.note(1.9);
    throttle.note(2);
    throttle.note(3);
    expect(emit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(emit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledTimes(2);
    // The same whole percentage again: nothing to say.
    await vi.advanceTimersByTimeAsync(5_000);
    throttle.note(3.7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(emit).toHaveBeenCalledTimes(2);
    throttle.note(100);
    expect(emit).toHaveBeenCalledTimes(3);
    throttle.stop();
  });

  it('drops a pending emit when stopped', async () => {
    vi.useFakeTimers({ now: NOW });
    const emit = vi.fn(async () => undefined);
    const throttle = createProgressThrottle(emit, 1_000);
    throttle.note(1);
    throttle.note(2);
    throttle.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    throttle.note(3);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does not throw when an emit fails', async () => {
    vi.useFakeTimers({ now: NOW });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const throttle = createProgressThrottle(async () => { throw new Error('socket gone'); }, 1_000);
    expect(() => throttle.note(5)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalled();
    throttle.stop();
  });
});

describe('the bar the front ends draw', () => {
  const progress = (over: Partial<WorkbenchStartProgress> = {}): WorkbenchStartProgress => ({
    step: 'code', stepIndex: 1, stepCount: 3, stepStartedAt: NOW.toISOString(), expectedMs: 60_000,
    percent: null, detail: null, ...over,
  });
  const at = (ms: number) => NOW.getTime() + ms;

  it.each([
    ['git progress wins over the estimate', progress({ percent: 50 }), at(10 * 60_000), 0.5],
    ['git progress of 100', progress({ percent: 100 }), at(0), 1],
    ['the estimate at the start', progress(), at(0), 0],
    ['the estimate at the median', progress(), at(60_000), 0.8],
    ['the estimate long after the median stops at the cap', progress(), at(60 * 60_000), START_ESTIMATE_CAP],
    ['a clock behind the step start', progress(), at(-5_000), 0],
    ['no history', progress({ expectedMs: null }), at(60_000), null],
    ['a broken start time', progress({ stepStartedAt: 'nope' }), at(60_000), null],
  ])('step fraction: %s', (_name, p, now, expected) => {
    const got = startStepFraction(p, now);
    if (expected === null) expect(got).toBeNull();
    else expect(got).toBeCloseTo(expected, 5);
  });

  it.each([
    ['the second of three steps, half done', progress({ percent: 50 }), at(0), (1 + 0.5) / 3],
    ['the first step at its start', progress({ step: 'sandbox', stepIndex: 0 }), at(0), 0],
    ['a thread, its one step at the median', progress({ step: 'sandbox', stepIndex: 0, stepCount: 1 }), at(60_000), 0.8],
    ['the last step, done', progress({ step: 'setup', stepIndex: 2, percent: 100 }), at(0), 1],
    ['an index past the count stays in range', progress({ stepIndex: 7, percent: 100 }), at(0), 1],
    ['no basis', progress({ expectedMs: null }), at(0), null],
    ['no steps', progress({ stepCount: 0, percent: 50 }), at(0), null],
  ])('overall: %s', (_name, p, now, expected) => {
    const got = startProgressFraction(p, now);
    if (expected === null) expect(got).toBeNull();
    else expect(got).toBeCloseTo(expected, 5);
  });
});

describe('the per-step medians', () => {
  const entry = (over: Partial<StartStepEntry>): StartStepEntry => ({
    readyMs: null, checkoutMs: null, setupMs: null, layer: null, ...over,
  });

  it.each([
    ['nothing', [], { sandbox: null, checkout: null, clone: null, setup: null }],
    [
      'too few samples',
      [entry({ readyMs: 10, checkoutMs: 5, setupMs: 7, layer: 'repo' }), entry({ readyMs: 20, checkoutMs: 6, setupMs: 8, layer: 'repo' })],
      { sandbox: null, checkout: null, clone: null, setup: null },
    ],
    [
      'enough samples',
      [
        entry({ readyMs: 10, checkoutMs: 5, setupMs: 7, layer: 'repo' }),
        entry({ readyMs: 30, checkoutMs: 6, setupMs: 9, layer: 'user' }),
        entry({ readyMs: 20, checkoutMs: 4, setupMs: 8, layer: 'legacy' }),
      ],
      { sandbox: 20, checkout: 5, clone: null, setup: 8 },
    ],
    [
      'clones and checkouts apart, and an entry with no layer in neither',
      [
        entry({ readyMs: 1, checkoutMs: 100, layer: 'base' }),
        entry({ readyMs: 2, checkoutMs: 300, layer: 'base' }),
        entry({ readyMs: 3, checkoutMs: 200, layer: 'base' }),
        entry({ readyMs: 4, checkoutMs: 5, layer: 'repo' }),
        entry({ readyMs: 5, checkoutMs: 1, layer: null }),
      ],
      { sandbox: 3, checkout: null, clone: 200, setup: null },
    ],
    [
      'starts with no setup script count for no setup median',
      [entry({ readyMs: 1 }), entry({ readyMs: 2 }), entry({ readyMs: 3, setupMs: 50 })],
      { sandbox: 2, checkout: null, clone: null, setup: null },
    ],
    [
      'an even count averages the middle two',
      [entry({ readyMs: 10 }), entry({ readyMs: 20 }), entry({ readyMs: 30 }), entry({ readyMs: 41 })],
      { sandbox: 25, checkout: null, clone: null, setup: null },
    ],
  ])('%s', (_name, entries, expected) => {
    expect(startStepMedians(entries)).toEqual(expected);
  });

  it.each([
    [null, []],
    ['not json', []],
    ['{"a":1}', []],
    [JSON.stringify([{ readyMs: 1, checkoutMs: 'x', setupMs: null, layer: 'repo' }, 'junk']), [{ readyMs: 1, checkoutMs: null, setupMs: null, layer: 'repo' }]],
  ])('parses %j', (value, expected) => {
    expect(parseStartStepHistory(value as never)).toEqual(expected);
  });
});

describe('the per-step history in SQL', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
  });

  afterAll(async () => { await testDb.cleanup(); });

  it('reads each step, leaves out entries with no box time, and counts a zero setup as none', async () => {
    await testDb.db.update(repositories).set({
      settings: {
        setupTiming: { big: 'x'.repeat(5000) },
        setupTimingHistory: [
          { measuredAt: '2099-01-01T10:00:00.000Z', boxReadyMs: 10_000.4, checkoutMs: 2_000, totalMs: 30_000, layer: 'repo' },
          { measuredAt: '2099-01-01T09:00:00.000Z', boxReadyMs: 12_000, checkoutMs: null, totalMs: 0, layer: 'base' },
          { measuredAt: '2099-01-01T08:00:00.000Z', totalMs: 99_000, repositoryMs: null, learnedMs: 99_000 },
          'junk',
        ],
      } as never,
    });
    const [found] = await startStepHistoryQuery('repo');
    expect(parseStartStepHistory(found.steps)).toEqual([
      { readyMs: 10_000, checkoutMs: 2_000, setupMs: 30_000, layer: 'repo' },
      { readyMs: 12_000, checkoutMs: null, setupMs: null, layer: 'base' },
    ]);
    const query = startStepHistoryQuery('repo').toSQL().sql;
    const selected = query.slice(0, query.lastIndexOf(' from "repositories"'));
    expect(selected.replace(/"repositories"\."settings" -> 'setupTimingHistory'/g, '')).not.toContain('"settings"');
  });

  it.each([
    ['a missing repository', 'nope'],
    ['no repository', null],
  ])('answers no medians for %s', async (_name, id) => {
    expect(await readStartStepMedians(id)).toEqual({ sandbox: null, checkout: null, clone: null, setup: null });
  });

  it('answers no medians for a history that is not a list', async () => {
    await testDb.db.update(repositories).set({ settings: { setupTimingHistory: 'not a list' } as never });
    expect(await readStartStepMedians('repo')).toEqual({ sandbox: null, checkout: null, clone: null, setup: null });
  });
});

describe('runCapture with a stderr line handler', () => {
  const row = { id: 'wb', workspaceId: 'ws', runtime: 'sandbox', sandboxId: 'box', fleetHost: null, repoFullName: 'o/r' } as unknown as WorkbenchRow;
  let fleet: FakeFleet;

  beforeAll(() => {
    fleet = new FakeFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
  });
  afterAll(() => { setWorkbenchFleetClientForTests(null); });

  it.each([
    ['a success', { stdout: ['one', 'two'], stderr: 'Receiving objects:  10% (1/10)\nfatal: no', exitCode: 0 }],
    ['a failure', { stdout: [], stderr: 'fatal: repository not found', exitCode: 128 }],
  ])('streams the command and answers its lines and exit code: %s', async (_name, reply) => {
    fleet.handler = () => reply;
    const seen: string[] = [];
    const result = await runCapture(row, 'git clone x', { cwd: '/', timeoutMs: 1_000, onStderrLine: (line) => seen.push(line) });
    expect(fleet.execs.at(-1)).toMatchObject({ follow: true });
    expect(result.exitCode).toBe(reply.exitCode);
    expect(result.stdout).toBe(reply.stdout.join('\n'));
    expect(result.stdoutBytes.toString('utf8')).toBe(result.stdout);
    expect(result.stderr).toBe(reply.stderr);
    expect(seen).toEqual(reply.stderr.split('\n'));
  });

  it('keeps going when the handler throws', async () => {
    fleet.handler = () => ({ stdout: 'done', stderr: 'a\nb', exitCode: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await runCapture(row, 'git clone x', { cwd: '/', onStderrLine: () => { throw new Error('bad handler'); } });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'done', stderr: 'a\nb' });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('answers -1 when the command died without its exit line', async () => {
    fleet.handler = () => ({ stdout: 'x', killed: true, hold: Promise.reject(new Error('gone')) });
    const result = await runCapture(row, 'git clone x', { cwd: '/', onStderrLine: () => undefined });
    expect(result.exitCode).toBe(-1);
  });
});
