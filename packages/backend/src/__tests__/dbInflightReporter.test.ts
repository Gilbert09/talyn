import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { _resetInflight, beginInflight, endInflight, transactionOpened } from '../db/inflight.js';
import { DB_POOL_MAX } from '../db/client.js';
import { collectInflightReport, DbInflightReporter } from '../services/dbInflightReporter.js';
import { debugBus } from '../services/debugBus.js';

const T0 = 1_000_000;
const s = (seconds: number) => T0 + seconds * 1000;

beforeEach(() => {
  _resetInflight();
  debugBus._reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('collectInflightReport thresholds', () => {
  it.each([
    { age: 0, logged: false },
    { age: 29, logged: false },
    { age: 30, logged: true },
    { age: 300, logged: true },
  ])('an entry open $age s is logged=$logged', ({ age, logged }) => {
    beginInflight('owner_tx', 'GET /api/v1/pull-requests/7302', {}, T0);
    const lines = collectInflightReport(s(age));
    expect(lines.length).toBe(logged ? 1 : 0);
  });

  it.each([
    ['owner_tx', 'GET /api/v1/pull-requests/7302', {}, '[db-inflight] owner transaction open 47s: GET /api/v1/pull-requests/7302'],
    ['lock_tx', 'workflowRetrySweep:tick', {}, '[db-inflight] lock transaction open 47s: workflowRetrySweep:tick'],
    [
      'query',
      'select "id" from "pull_requests" where "id" = $1',
      { connection: 'transaction', ownerScope: true },
      '[db-inflight] query open 47s: select "pull_requests" (owner scope)',
    ],
    ['query', 'begin ', { connection: 'pool' }, '[db-inflight] query open 47s: begin (pool)'],
  ] as const)('formats a %s entry', (kind, label, extra, expected) => {
    beginInflight(kind, label, extra, T0);
    expect(collectInflightReport(s(47))).toEqual([expected]);
  });
});

describe('collectInflightReport throttling', () => {
  it('logs once at the threshold, then at most once per 60 s', () => {
    beginInflight('lock_tx', 'loopScheduler:tick', {}, T0);
    const loggedAt = [30, 45, 60, 89, 90, 105, 149, 150].filter(
      (age) => collectInflightReport(s(age)).length > 0,
    );
    expect(loggedAt).toEqual([30, 90, 150]);
  });

  it('throttles each entry on its own clock', () => {
    beginInflight('owner_tx', 'GET /a', {}, T0);
    expect(collectInflightReport(s(30))).toHaveLength(1);
    beginInflight('owner_tx', 'GET /b', {}, s(10));
    expect(collectInflightReport(s(40))).toEqual(['[db-inflight] owner transaction open 30s: GET /b']);
  });

  it('stops logging an entry once it settles', () => {
    const id = beginInflight('owner_tx', 'GET /a', {}, T0);
    expect(collectInflightReport(s(30))).toHaveLength(1);
    endInflight(id);
    expect(collectInflightReport(s(200))).toEqual([]);
  });

  it.each([
    { thresholdMs: 5_000, repeatMs: 10_000, ages: [4, 5, 10, 15, 16], expected: [5, 15] },
    { thresholdMs: 0, repeatMs: 0, ages: [0, 1, 2], expected: [0, 1, 2] },
  ])('honours custom options $thresholdMs / $repeatMs', ({ thresholdMs, repeatMs, ages, expected }) => {
    beginInflight('lock_tx', 'x', {}, T0);
    const loggedAt = ages.filter(
      (age) => collectInflightReport(s(age), { thresholdMs, repeatMs }).length > 0,
    );
    expect(loggedAt).toEqual(expected);
  });
});

describe('collectInflightReport line cap', () => {
  it.each([
    { open: 14, lines: 14, more: null },
    { open: 15, lines: 15, more: null },
    { open: 16, lines: 15, more: '[db-inflight] +1 more' },
    { open: 40, lines: 15, more: '[db-inflight] +25 more' },
  ])('$open old entries print $lines lines', ({ open, lines, more }) => {
    for (let i = 0; i < open; i++) beginInflight('lock_tx', `lock-${i}`, {}, T0 + i);
    const out = collectInflightReport(s(100), { poolMax: 1_000 });
    const entryLines = out.filter((l) => !l.includes('more'));
    expect(entryLines).toHaveLength(lines);
    expect(out.find((l) => l.includes('more')) ?? null).toBe(more);
  });

  it('prints the oldest first and gives the rest their turn on the next tick', () => {
    for (let i = 0; i < 20; i++) beginInflight('lock_tx', `lock-${i}`, {}, T0 + i * 1000);
    const first = collectInflightReport(s(100), { poolMax: 1_000 });
    expect(first[0]).toContain('lock-0');
    expect(first[14]).toContain('lock-14');
    const second = collectInflightReport(s(115), { poolMax: 1_000 });
    expect(second.map((l) => l.split(': ')[1])).toEqual([
      'lock-15',
      'lock-16',
      'lock-17',
      'lock-18',
      'lock-19',
    ]);
  });
});

describe('collectInflightReport pool warning', () => {
  it('reads the pool max from the client', () => {
    expect(DB_POOL_MAX).toBe(20);
  });

  it.each([
    { owner: 10, lock: 2, pool: 8, warns: false },
    { owner: 10, lock: 2, pool: 9, warns: true },
    { owner: 21, lock: 0, pool: 0, warns: true },
    { owner: 0, lock: 0, pool: 0, warns: false },
  ])('owner=$owner lock=$lock pool=$pool warns=$warns', ({ owner, lock, pool, warns }) => {
    for (let i = 0; i < owner; i++) beginInflight('owner_tx', 'o', {}, T0);
    for (let i = 0; i < lock; i++) beginInflight('lock_tx', 'l', {}, T0);
    for (let i = 0; i < pool; i++) beginInflight('query', 'select 1', { connection: 'pool' }, T0);
    const out = collectInflightReport(s(1));
    expect(out.some((l) => l.includes('pool demand'))).toBe(warns);
  });

  it('counts plain transactions and ignores queries that share a transaction', () => {
    for (let i = 0; i < 21; i++) transactionOpened();
    for (let i = 0; i < 30; i++) beginInflight('query', 'select 1', { connection: 'transaction' }, T0);
    expect(collectInflightReport(s(1))).toEqual([
      '[db-inflight] pool demand 21 > max 20: callers are queueing for a connection ' +
        '(0 pool queries, 21 open transactions, 0 owner, 0 lock)',
    ]);
  });

  it('warns on every tick while demand stays high, on top of the capped lines', () => {
    for (let i = 0; i < 25; i++) beginInflight('owner_tx', `GET /${i}`, {}, T0);
    const first = collectInflightReport(s(31));
    expect(first[0]).toContain('pool demand 25 > max 20');
    expect(first).toHaveLength(1 + 15 + 1);
    expect(collectInflightReport(s(46))[0]).toContain('pool demand');
  });
});

describe('DbInflightReporter', () => {
  it('logs the report lines and records a poller tick', () => {
    const log = vi.fn();
    const reporter = new DbInflightReporter(15_000, log);
    reporter.init();
    beginInflight('owner_tx', 'GET /a', {}, T0);
    reporter.tick(s(31));
    expect(log).toHaveBeenCalledWith('[db-inflight] owner transaction open 31s: GET /a');
    const poller = debugBus.snapshot().pollers.find((p) => p.name === 'db_inflight');
    expect(poller?.lastOk).toBe(true);
    expect(poller?.intervalMs).toBe(15_000);
    reporter.shutdown();
  });

  it('records a failed tick when logging throws, and does not throw itself', () => {
    const reporter = new DbInflightReporter(15_000, () => {
      throw new Error('stdout closed');
    });
    beginInflight('owner_tx', 'GET /a', {}, T0);
    expect(() => reporter.tick(s(31))).not.toThrow();
    const poller = debugBus.snapshot().pollers.find((p) => p.name === 'db_inflight');
    expect(poller?.lastOk).toBe(false);
  });

  it('runs on its interval until shutdown, and init is idempotent', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const reporter = new DbInflightReporter(1_000, log);
    const tick = vi.spyOn(reporter, 'tick');
    reporter.init();
    reporter.init();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(tick).toHaveBeenCalledTimes(3);
    reporter.shutdown();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});
