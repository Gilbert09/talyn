import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DbWatchdog } from '../services/dbWatchdog.js';
import { debugBus } from '../services/debugBus.js';

/**
 * Unit tests for the DB watchdog: the self-healing loop that exits the
 * process after sustained DB-pool failure (the Jul 2026 Supavisor
 * pooler-exhaustion incidents). Uses injected probe/onFatal so no timers or
 * real DB are involved except where fake timers drive the schedule.
 */

beforeEach(() => {
  debugBus._reset();
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
