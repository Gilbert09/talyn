import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DbWatchdog } from '../services/dbWatchdog.js';
import { debugBus } from '../services/debugBus.js';
import { _resetInflight, beginInflight } from '../db/inflight.js';

/**
 * Unit tests for the DB watchdog: the self-healing loop that exits the
 * process after sustained DB-pool failure (the Jul 2026 Supavisor
 * pooler-exhaustion incidents). Uses injected probe/onFatal so no timers or
 * real DB are involved except where fake timers drive the schedule.
 */

beforeEach(() => {
  debugBus._reset();
  _resetInflight();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeWatchdog(opts: {
  probe: () => Promise<unknown>;
  onFatal?: (reason: string) => void;
  maxConsecutiveFailures?: number;
  intervalMs?: number;
  probeTimeoutMs?: number;
}) {
  return new DbWatchdog({
    intervalMs: opts.intervalMs ?? 1_000,
    probeTimeoutMs: opts.probeTimeoutMs ?? 100,
    maxConsecutiveFailures: opts.maxConsecutiveFailures ?? 3,
    probe: opts.probe,
    onFatal: opts.onFatal ?? (() => undefined),
  });
}

describe('DbWatchdog.tick', () => {
  it('does not fire onFatal while probes succeed', async () => {
    const onFatal = vi.fn();
    const dog = makeWatchdog({ probe: async () => 1, onFatal });
    for (let i = 0; i < 10; i++) await dog.tick();
    expect(onFatal).not.toHaveBeenCalled();
  });

  it.each([
    { failures: 2, fires: false },
    { failures: 3, fires: true },
    { failures: 5, fires: true },
  ])('after $failures consecutive failures (threshold 3) fires=$fires', async ({ failures, fires }) => {
    const onFatal = vi.fn();
    const dog = makeWatchdog({ probe: async () => { throw new Error('ECHECKOUTTIMEOUT'); }, onFatal });
    for (let i = 0; i < failures; i++) await dog.tick();
    expect(onFatal.mock.calls.length).toBe(fires ? 1 : 0);
  });

  it('a success resets the consecutive-failure counter', async () => {
    const onFatal = vi.fn();
    let fail = true;
    const dog = makeWatchdog({
      probe: async () => {
        if (fail) throw new Error('down');
        return 1;
      },
      onFatal,
    });
    await dog.tick();
    await dog.tick(); // 2 failures — one short of the threshold
    fail = false;
    await dog.tick(); // success resets
    fail = true;
    await dog.tick();
    await dog.tick(); // 2 failures again — still under threshold
    expect(onFatal).not.toHaveBeenCalled();
    await dog.tick(); // 3rd — fires
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('fires onFatal at most once even if ticks continue', async () => {
    const onFatal = vi.fn();
    const dog = makeWatchdog({ probe: async () => { throw new Error('down'); }, onFatal });
    for (let i = 0; i < 6; i++) await dog.tick();
    expect(onFatal).toHaveBeenCalledTimes(1);
  });

  it('counts a probe that hangs past the timeout as a failure', async () => {
    vi.useFakeTimers();
    const onFatal = vi.fn();
    const dog = makeWatchdog({
      probe: () => new Promise(() => undefined), // never settles
      onFatal,
      maxConsecutiveFailures: 1,
      probeTimeoutMs: 100,
    });
    const tick = dog.tick();
    await vi.advanceTimersByTimeAsync(101);
    await tick;
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal.mock.calls[0][0]).toContain('1 consecutive probes');
  });

  it('reports the accumulated outage duration in the fatal reason', async () => {
    const onFatal = vi.fn();
    const dog = makeWatchdog({
      probe: async () => { throw new Error('down'); },
      onFatal,
      maxConsecutiveFailures: 3,
      intervalMs: 1_000,
    });
    for (let i = 0; i < 3; i++) await dog.tick();
    expect(onFatal.mock.calls[0][0]).toContain('3 consecutive probes');
    expect(onFatal.mock.calls[0][0]).toContain('~3s');
  });

  it('records poller ticks on the debug bus', async () => {
    const dog = makeWatchdog({ probe: async () => 1 });
    dog.init(); // registers the poller
    await dog.tick();
    const pollers = debugBus.snapshot().pollers;
    const entry = pollers.find((p) => p.name === 'db_watchdog');
    expect(entry).toBeDefined();
    expect(entry?.lastOk).toBe(true);
    dog.shutdown();
  });
});

describe('DbWatchdog scheduling', () => {
  it('probes on the interval and stops after shutdown', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => 1);
    const dog = makeWatchdog({ probe, intervalMs: 1_000 });
    dog.init();
    await vi.advanceTimersByTimeAsync(3_100);
    expect(probe).toHaveBeenCalledTimes(3);
    dog.shutdown();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('init is idempotent — a second call does not double the probe rate', async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async () => 1);
    const dog = makeWatchdog({ probe, intervalMs: 1_000 });
    dog.init();
    dog.init();
    await vi.advanceTimersByTimeAsync(2_100);
    expect(probe).toHaveBeenCalledTimes(2);
    dog.shutdown();
  });

  it('stops rescheduling after the fatal fires', async () => {
    vi.useFakeTimers();
    const onFatal = vi.fn();
    const probe = vi.fn(async () => { throw new Error('down'); });
    const dog = makeWatchdog({ probe, onFatal, intervalMs: 1_000, maxConsecutiveFailures: 2 });
    dog.init();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(2); // no probes after the fatal
    dog.shutdown();
  });
});

describe('DbWatchdog in-flight dump', () => {
  const failing = async () => {
    throw new Error('ECHECKOUTTIMEOUT');
  };
  const errorLines = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c: unknown[]) => c.map(String).join(' '));

  it('logs no summary while the probe succeeds', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dog = makeWatchdog({ probe: async () => 1 });
    await dog.tick();
    expect(errorLines(spy).some((l) => l.includes('in flight'))).toBe(false);
    spy.mockRestore();
  });

  it.each([
    { owner: 0, lock: 0, queries: 0, expected: '0 queries in flight (0 on the pool), 0 owner transactions, 0 lock transactions' },
    { owner: 3, lock: 1, queries: 2, expected: '2 queries in flight (2 on the pool), 3 owner transactions, 1 lock transactions' },
  ])('logs a one-line summary on each failed probe ($owner owner, $lock lock)', async ({ owner, lock, queries, expected }) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let i = 0; i < owner; i++) beginInflight('owner_tx', `GET /${i}`, {}, Date.now() - 60_000);
    for (let i = 0; i < lock; i++) beginInflight('lock_tx', 'mergeQueue:tick');
    for (let i = 0; i < queries; i++) beginInflight('query', 'select 1 from "tasks"', { connection: 'pool' });
    const dog = makeWatchdog({ probe: failing, maxConsecutiveFailures: 5 });
    await dog.tick();
    await dog.tick();
    const summaries = errorLines(spy).filter((l) => l.startsWith('[dbWatchdog] in flight:'));
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain(expected);
    if (owner > 0) expect(summaries[0]).toMatch(/oldest 60s \(owner transaction: GET \/0\)/);
    else expect(summaries[0]).toContain('nothing in flight');
    spy.mockRestore();
  });

  it('dumps the 15 oldest entries of each kind before it calls onFatal, and only then', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const now = Date.now();
    for (let i = 0; i < 20; i++) beginInflight('owner_tx', `GET /api/v1/r/${i}`, {}, now - (100 - i) * 1000);
    beginInflight('lock_tx', 'loopScheduler:tick', {}, now - 400_000);
    beginInflight('query', 'select "id" from "pull_requests"', { connection: 'transaction', ownerScope: true }, now - 52_000);
    let linesAtFatal: string[] = [];
    const onFatal = vi.fn(() => {
      linesAtFatal = errorLines(spy);
    });
    const dog = makeWatchdog({ probe: failing, onFatal, maxConsecutiveFailures: 2 });

    await dog.tick();
    expect(errorLines(spy).some((l) => l.includes('oldest in-flight entries'))).toBe(false);
    await dog.tick();

    expect(onFatal).toHaveBeenCalledTimes(1);
    const dump = linesAtFatal.filter((l) => l.startsWith('[dbWatchdog]   '));
    expect(dump).toContain('[dbWatchdog]   owner transaction: 20 open');
    expect(dump).toContain('[dbWatchdog]     100s GET /api/v1/r/0');
    expect(dump).toContain('[dbWatchdog]     86s GET /api/v1/r/14');
    expect(dump.some((l) => l.includes('GET /api/v1/r/15'))).toBe(false);
    expect(dump).toContain('[dbWatchdog]     +5 more');
    expect(dump).toContain('[dbWatchdog]     400s loopScheduler:tick');
    expect(dump).toContain('[dbWatchdog]     52s select "pull_requests" (owner scope)');
    spy.mockRestore();
  });

  it('dumps only once, even if ticks continue after the fatal', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dog = makeWatchdog({ probe: failing, maxConsecutiveFailures: 1 });
    for (let i = 0; i < 4; i++) await dog.tick();
    expect(errorLines(spy).filter((l) => l.includes('oldest in-flight entries'))).toHaveLength(1);
    spy.mockRestore();
  });
});
