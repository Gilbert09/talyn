import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../services/prCache.js', () => ({ forceFetchAndUpsert: vi.fn() }));
vi.mock('../services/prMonitor.js', () => ({ prMonitorService: { refreshPrAcrossWorkspaces: vi.fn() } }));
vi.mock('../services/webhookIndex.js', () => ({ targetsForRepo: vi.fn() }));

import {
  RECOMPUTE_COALESCE_MS,
  VerdictRecomputeCoalescer,
  type PendingRecompute,
} from '../services/checkCounts.js';

interface Run {
  key: string;
  repoIds: string[];
  announceUnchanged: boolean;
  finish: () => void;
}

describe('VerdictRecomputeCoalescer', () => {
  const WINDOW = RECOMPUTE_COALESCE_MS;
  let runs: Run[];
  let autoFinish: boolean;
  let coalescer: VerdictRecomputeCoalescer;

  beforeEach(() => {
    vi.useFakeTimers();
    runs = [];
    autoFinish = true;
    coalescer = new VerdictRecomputeCoalescer(WINDOW, (p: PendingRecompute) => {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      runs.push({
        key: `${p.repoFullName} ${p.headSha}`,
        repoIds: [...p.repoIds].sort(),
        announceUnchanged: p.announceUnchanged,
        finish,
      });
      if (autoFinish) finish();
      return done;
    });
  });

  afterEach(() => {
    coalescer._reset();
    vi.useRealTimers();
  });

  it('waits for the window, then runs once', async () => {
    coalescer.request('acme/w', 'sha-A', ['r1'], true);
    await vi.advanceTimersByTimeAsync(WINDOW - 1);
    expect(runs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(1);
    expect(coalescer._keys()).toEqual([]);
  });

  it('collapses a burst for one commit into one run with the union of repo ids', async () => {
    for (let i = 0; i < 50; i++) {
      coalescer.request('acme/w', 'sha-A', [`r${i % 3}`], true);
      await vi.advanceTimersByTimeAsync(WINDOW / 100);
    }
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ key: 'acme/w sha-A', repoIds: ['r0', 'r1', 'r2'] });
  });

  it('does not let a steady stream starve the recompute (the window is not reset by a request)', async () => {
    for (let i = 0; i < 40; i++) {
      coalescer.request('acme/w', 'sha-A', ['r1'], true);
      await vi.advanceTimersByTimeAsync(WINDOW / 4);
    }
    // 40 requests over 10 windows: one run per window, never zero.
    expect(runs.length).toBeGreaterThanOrEqual(9);
    expect(runs.length).toBeLessThanOrEqual(10);
  });

  it.each([
    { flags: [false], expected: false },
    { flags: [true], expected: true },
    { flags: [false, false, false], expected: false },
    { flags: [false, true], expected: true },
    { flags: [true, false], expected: true },
    { flags: [false, false, true, false], expected: true },
  ])('ORs announceUnchanged across a window: $flags → $expected', async ({ flags, expected }) => {
    for (const flag of flags) coalescer.request('acme/w', 'sha-A', ['r1'], flag);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(runs).toHaveLength(1);
    expect(runs[0].announceUnchanged).toBe(expected);
  });

  it('keeps commits independent', async () => {
    coalescer.request('acme/w', 'sha-A', ['r1'], true);
    coalescer.request('acme/w', 'sha-B', ['r2'], false);
    coalescer.request('other/x', 'sha-A', ['r3'], true);
    coalescer.request('acme/w', 'sha-A', ['r4'], false);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(runs.map((r) => [r.key, r.repoIds, r.announceUnchanged]).sort()).toEqual([
      ['acme/w sha-A', ['r1', 'r4'], true],
      ['acme/w sha-B', ['r2'], false],
      ['other/x sha-A', ['r3'], true],
    ]);
  });

  it('a request during a running recompute schedules exactly one follow-up, a window after it ends', async () => {
    autoFinish = false;
    coalescer.request('acme/w', 'sha-A', ['r1'], false);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(runs).toHaveLength(1);

    // Three requests while the first run is still in flight.
    coalescer.request('acme/w', 'sha-A', ['r2'], false);
    coalescer.request('acme/w', 'sha-A', ['r3'], true);
    await vi.advanceTimersByTimeAsync(WINDOW * 5);
    coalescer.request('acme/w', 'sha-A', ['r2'], false);
    expect(runs).toHaveLength(1);

    runs[0].finish();
    await vi.advanceTimersByTimeAsync(WINDOW - 1);
    expect(runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ repoIds: ['r2', 'r3'], announceUnchanged: true });

    runs[1].finish();
    await vi.advanceTimersByTimeAsync(WINDOW * 3);
    expect(runs).toHaveLength(2);
    expect(coalescer._keys()).toEqual([]);
  });

  it('a request during a run of ANOTHER commit is not held back', async () => {
    autoFinish = false;
    coalescer.request('acme/w', 'sha-A', ['r1'], true);
    await vi.advanceTimersByTimeAsync(WINDOW);
    coalescer.request('acme/w', 'sha-B', ['r1'], true);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(runs.map((r) => r.key)).toEqual(['acme/w sha-A', 'acme/w sha-B']);
    runs.forEach((r) => r.finish());
  });

  it('flushAllNow runs pending work at once and waits for follow-ups', async () => {
    autoFinish = false;
    coalescer.request('acme/w', 'sha-A', ['r1'], true);
    coalescer.request('acme/w', 'sha-B', ['r1'], true);
    const flushed = coalescer.flushAllNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(2);

    // A follow-up for sha-A arrives mid-run; flushAllNow must cover it too.
    coalescer.request('acme/w', 'sha-A', ['r9'], false);
    let settled = false;
    void flushed.then(() => {
      settled = true;
    });
    runs[0].finish();
    runs[1].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toHaveLength(3);
    expect(runs[2]).toMatchObject({ key: 'acme/w sha-A', repoIds: ['r9'] });
    expect(settled).toBe(false);
    runs[2].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(coalescer._keys()).toEqual([]);
  });

  it('flushAllNow with nothing pending resolves at once', async () => {
    await expect(coalescer.flushAllNow()).resolves.toBeUndefined();
    expect(runs).toHaveLength(0);
  });

  it('_reset cancels pending timers without running them', async () => {
    coalescer.request('acme/w', 'sha-A', ['r1'], true);
    coalescer.request('acme/w', 'sha-B', ['r1'], true);
    coalescer._reset();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WINDOW * 2);
    expect(runs).toHaveLength(0);
    expect(coalescer._keys()).toEqual([]);
  });

  it('leaves no timer behind once the commit goes quiet', async () => {
    coalescer.request('acme/w', 'sha-A', ['r1'], true);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(vi.getTimerCount()).toBe(0);
    expect(coalescer._keys()).toEqual([]);
  });
});
