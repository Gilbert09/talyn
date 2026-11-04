import { describe, it, expect } from 'vitest';
import type { AdminFleetHost, AdminRunRow } from '@talyn/shared';
import {
  HOST_STALE_AFTER_MS,
  WEDGE_WARN_SECONDS,
  boxSizeLabel,
  countRuns,
  isAsleep,
  isRealOrphan,
  runClaim,
  runKind,
  sleepSeconds,
  hostState,
  durationSeconds,
  idlePct,
  idleSeconds,
  looksStale,
  looksWedged,
  memoryPct,
  runRank,
  slotsPct,
  sortRuns,
} from '../lib/fleetView';
import { bytes, countdown, duration, mib, parseTime, pct, relativeAge, usd } from '../lib/format';

/**
 * The judgements an operator acts on.
 *
 * Every function here answers a question with consequences — "is this host
 * gone?", "is this run stuck?", "is memory full?" — and the failure mode is
 * always the same shape: an unknown value rendered as a definite one. A host
 * that never reported its memory budget must not read as 100% full, because
 * the response to that is draining a healthy box.
 */

const NOW = Date.parse('2026-08-04T12:00:00.000Z');

function host(overrides: Partial<AdminFleetHost> = {}): AdminFleetHost {
  return {
    name: 'hetzner-64',
    apiEndpoint: 'http://10.0.0.1:8080',
    version: '1.0.0',
    reportedAt: new Date(NOW - 5_000).toISOString(),
    draining: false,
    runsLive: 1,
    runsMax: 2,
    memReservedMib: 512,
    memBudgetMib: 2048,
    diskFreeMib: 40_000,
    maxIdleSeconds: 3,
    online: true,
    dispatchable: true,
    live: null,
    liveError: null,
    liveErrorCode: null,
    ...overrides,
  };
}

function run(overrides: Partial<AdminRunRow> = {}): AdminRunRow {
  return {
    runId: 'talyn-1',
    host: 'hetzner-64',
    taskId: 'task-1',
    workspaceId: 'ws-1',
    ownerEmail: 'a@b.test',
    repo: null,
    status: 'running',
    phase: 'agent',
    adopted: false,
    slot: 0,
    goldenLayer: 'repo',
    createdAt: new Date(NOW - 60_000).toISOString(),
    startedAt: new Date(NOW - 55_000).toISOString(),
    endedAt: null,
    deadline: new Date(NOW + 600_000).toISOString(),
    lastHeartbeat: new Date(NOW - 10_000).toISOString(),
    lastActivity: new Date(NOW - 5_000).toISOString(),
    costUsd: 0.25,
    memUsedMib: 512,
    memMib: 4096,
    prUrl: null,
    error: null,
    orphan: false,
    selfTest: false,
    ...overrides,
  };
}

describe('hostState', () => {
  it('reports ready for a healthy host', () => {
    expect(hostState(host())).toBe('ready');
  });

  it('reports offline whatever else the last report claimed', () => {
    // Precedence matters: an offline host is offline even if its final
    // snapshot said it had capacity.
    expect(hostState(host({ online: false, draining: false, runsLive: 0 }))).toBe('offline');
  });

  it('reports draining even with slots free', () => {
    expect(hostState(host({ draining: true, runsLive: 0 }))).toBe('draining');
  });

  it('reports full at capacity', () => {
    expect(hostState(host({ runsLive: 2, runsMax: 2 }))).toBe('full');
  });

  it('does NOT report full when the host never told us its cap', () => {
    // runsMax 0 is unknown, not zero-capacity. The backend's
    // hostIsDispatchable makes the same distinction.
    expect(hostState(host({ runsLive: 5, runsMax: 0 }))).toBe('ready');
  });
});

describe('looksStale', () => {
  it.each([
    ['just under the threshold', HOST_STALE_AFTER_MS - 1_000, false],
    ['just over the threshold', HOST_STALE_AFTER_MS + 1_000, true],
  ])('%s', (_label, age, expected) => {
    expect(looksStale(host({ reportedAt: new Date(NOW - age).toISOString() }), NOW)).toBe(expected);
  });

  it('treats an unparseable timestamp as stale', () => {
    // Fail toward "we do not know", not toward "everything is fine".
    expect(looksStale(host({ reportedAt: 'not a date' }), NOW)).toBe(true);
  });
});

describe('memoryPct / slotsPct', () => {
  it('computes a percentage', () => {
    expect(memoryPct(host({ memReservedMib: 512, memBudgetMib: 2048 }))).toBe(25);
    expect(slotsPct(host({ runsLive: 1, runsMax: 2 }))).toBe(50);
  });

  it('returns NULL for a zero budget rather than NaN or 100', () => {
    // The bug this prevents: a host that never reported a budget rendering as
    // full, and an operator draining it.
    expect(memoryPct(host({ memReservedMib: 0, memBudgetMib: 0 }))).toBeNull();
    expect(slotsPct(host({ runsLive: 3, runsMax: 0 }))).toBeNull();
  });

  it('clamps rather than exceeding 100', () => {
    expect(memoryPct(host({ memReservedMib: 4096, memBudgetMib: 2048 }))).toBe(100);
  });
});

describe('idleSeconds', () => {
  it('prefers lastActivity over lastHeartbeat', () => {
    // Load-bearing: the fleet killed healthy runs by watching heartbeats
    // alone (HANDOFF failure #2). A run busy enough not to heartbeat is still
    // plainly alive on any other frame.
    const r = run({
      lastActivity: new Date(NOW - 5_000).toISOString(),
      lastHeartbeat: new Date(NOW - 300_000).toISOString(),
    });
    expect(idleSeconds(r, NOW)).toBe(5);
  });

  it('falls back to lastHeartbeat when there is no activity', () => {
    const r = run({ lastActivity: null, lastHeartbeat: new Date(NOW - 30_000).toISOString() });
    expect(idleSeconds(r, NOW)).toBe(30);
  });

  it('is null when the fleet reported neither', () => {
    expect(idleSeconds(run({ lastActivity: null, lastHeartbeat: null }), NOW)).toBeNull();
  });

  // THE regression. It ran to `now` unconditionally, so a run that finished
  // yesterday reported 86,400 seconds idle and climbing — the column was only
  // readable on the few rows still in flight. Stopped at endedAt it answers
  // the question that matters about a finished run: how much of its life was
  // silence at the end.
  it('stops counting when the run ends', () => {
    // Ended at NOW, last frame nine minutes before that.
    const done = run({
      status: 'completed',
      endedAt: new Date(NOW).toISOString(),
      lastActivity: new Date(NOW - 540_000).toISOString(),
    });
    // A full day later it still reports the nine minutes, not the day.
    expect(idleSeconds(done, NOW + 86_400_000)).toBe(540);
  });

  // A run reaped as wedged shows ~5 minutes of trailing silence by definition;
  // one that ended cleanly shows a second or two. That difference is the whole
  // point of the column.
  it('separates a clean finish from a reaped one', () => {
    const ended = new Date(NOW).toISOString();
    const clean = run({
      status: 'completed',
      endedAt: ended,
      lastActivity: new Date(NOW - 1_000).toISOString(),
    });
    const reaped = run({
      status: 'cancelled',
      endedAt: ended,
      lastActivity: new Date(NOW - 300_000).toISOString(),
    });
    expect(idleSeconds(clean, NOW + 60_000)).toBe(1);
    expect(idleSeconds(reaped, NOW + 60_000)).toBe(300);
  });
});

describe('durationSeconds', () => {
  it('measures a finished run start to end', () => {
    const r = run({
      status: 'completed',
      startedAt: new Date(NOW - 3_600_000).toISOString(),
      endedAt: new Date(NOW - 600_000).toISOString(),
    });
    expect(durationSeconds(r, NOW)).toBe(3000);
  });

  it('runs to now while the run is still going', () => {
    const r = run({ startedAt: new Date(NOW - 90_000).toISOString(), endedAt: null });
    expect(durationSeconds(r, NOW)).toBe(90);
  });

  // A run that never started still spent time queued, and how long is exactly
  // what an operator wants to know about it.
  it('falls back to createdAt for a run that never started', () => {
    const r = run({
      status: 'queued',
      createdAt: new Date(NOW - 120_000).toISOString(),
      startedAt: null,
      endedAt: null,
    });
    expect(durationSeconds(r, NOW)).toBe(120);
  });

  it('is null with no timestamps at all', () => {
    expect(durationSeconds(run({ createdAt: null, startedAt: null }), NOW)).toBeNull();
  });
});

describe('idlePct', () => {
  it('reports idle as a share of the run', () => {
    const r = run({
      status: 'completed',
      startedAt: new Date(NOW - 600_000).toISOString(),
      endedAt: new Date(NOW).toISOString(),
      lastActivity: new Date(NOW - 300_000).toISOString(),
    });
    // Five minutes silent out of ten.
    expect(idlePct(r, NOW)).toBe(50);
  });

  // The proportion is what makes the raw number act on: nine minutes is
  // routine on a two-hour run and is the whole story on a ten-minute one.
  it('is small for a long run with the same absolute silence', () => {
    const r = run({
      status: 'completed',
      startedAt: new Date(NOW - 7_200_000).toISOString(),
      endedAt: new Date(NOW).toISOString(),
      lastActivity: new Date(NOW - 300_000).toISOString(),
    });
    expect(idlePct(r, NOW)).toBe(4);
  });

  it('is null when the duration is unknown', () => {
    expect(idlePct(run({ createdAt: null, startedAt: null }), NOW)).toBeNull();
  });
});

describe('looksWedged', () => {
  it('flags a long-silent running run', () => {
    const r = run({ lastActivity: new Date(NOW - (WEDGE_WARN_SECONDS + 10) * 1000).toISOString() });
    expect(looksWedged(r, NOW)).toBe(true);
  });

  it('does not flag a recently active run', () => {
    expect(looksWedged(run(), NOW)).toBe(false);
  });

  it.each([['completed'], ['failed'], ['cancelled']] as const)(
    'never flags a %s run, however long ago it stopped',
    (status) => {
      // A finished run stops sending frames BY DEFINITION. Flagging every one
      // as wedged would make the signal useless.
      const r = run({ status, lastActivity: new Date(NOW - 86_400_000).toISOString() });
      expect(looksWedged(r, NOW)).toBe(false);
    }
  );
});

describe('run ranking', () => {
  it('puts orphans first', () => {
    // A microVM with no task behind it is the thing this page exists to
    // catch; burying it below history would defeat the point.
    expect(runRank(run({ orphan: true }), NOW)).toBeLessThan(runRank(run(), NOW));
  });

  it('ranks wedged above healthy, and healthy above finished', () => {
    const wedged = run({ lastActivity: new Date(NOW - 600_000).toISOString() });
    const live = run();
    const done = run({ status: 'completed' });
    expect(runRank(wedged, NOW)).toBeLessThan(runRank(live, NOW));
    expect(runRank(live, NOW)).toBeLessThan(runRank(done, NOW));
  });

  it('sorts newest first within a rank', () => {
    const older = run({ runId: 'a', createdAt: new Date(NOW - 100_000).toISOString() });
    const newer = run({ runId: 'b', createdAt: new Date(NOW - 10_000).toISOString() });
    expect(sortRuns([older, newer], NOW).map((r) => r.runId)).toEqual(['b', 'a']);
  });

  it('does not mutate its input', () => {
    const rows = [run({ runId: 'a' }), run({ runId: 'b', orphan: true })];
    sortRuns(rows, NOW);
    expect(rows.map((r) => r.runId)).toEqual(['a', 'b']);
  });
});

describe('formatters', () => {
  it.each([
    [null, '—'],
    [0, '0 MiB'],
    [512, '512 MiB'],
    [2048, '2.0 GiB'],
    [1024 * 1024 * 3, '3.0 TiB'],
  ])('mib(%s) = %s', (input, expected) => {
    expect(mib(input as number | null)).toBe(expected);
  });

  it.each([
    [null, '—'],
    [512, '512 B'],
    [2048, '2.0 KiB'],
    [5 * 1024 * 1024 * 1024, '5.0 GiB'],
  ])('bytes(%s) = %s', (input, expected) => {
    expect(bytes(input as number | null)).toBe(expected);
  });

  // Two units, deliberately. Rounding a run to "1h" loses the difference
  // between a job that took an hour and one that took nearly two, and run
  // length is a number an operator compares between rows.
  it.each([
    [null, '—'],
    [-1, '—'],
    [0, '0s'],
    [45, '45s'],
    [60, '1m'],
    [260, '4m 20s'],
    [3600, '1h'],
    [3840, '1h 4m'],
    [86_400, '1d'],
    [97_200, '1d 3h'],
  ])('duration(%s) = %s', (input, expected) => {
    expect(duration(input as number | null)).toBe(expected);
  });

  it('formats cost, and unknown cost as a dash not $0.00', () => {
    // "$0.00" claims a run was free; "—" says we do not know.
    expect(usd(1.5)).toBe('$1.50');
    expect(usd(null)).toBe('—');
  });

  it('returns null from pct on a zero denominator', () => {
    expect(pct(1, 0)).toBeNull();
    expect(pct(null, 10)).toBeNull();
  });

  it.each([
    ['null', null, '—'],
    ['a Go zero-value time', '0001-01-01T00:00:00Z', '—'],
    ['garbage', 'not a date', '—'],
  ])('renders %s as a dash', (_label, input, expected) => {
    // fleetd serialises an unset time.Time as year 1 rather than omitting it.
    // "01/01/0001" on a dashboard reads as data corruption, not "not yet".
    expect(relativeAge(input, NOW)).toBe(expected);
    expect(parseTime(input)).toBeNull();
  });

  it.each([
    [5_000, '5s'],
    [90_000, '2m'],
    [7_200_000, '2h'],
    [3 * 86_400_000, '3d'],
  ])('renders an age of %sms as %s', (age, expected) => {
    expect(relativeAge(new Date(NOW - age).toISOString(), NOW)).toBe(expected);
  });

  it('says "expired" for a deadline in the past', () => {
    expect(countdown(new Date(NOW - 1_000).toISOString(), NOW)).toBe('expired');
  });

  it('counts down to a future deadline', () => {
    expect(countdown(new Date(NOW + 300_000).toISOString(), NOW)).toBe('5m');
  });
});

/**
 * Asleep is not wedged.
 *
 * On 2026-11-03 every suspended session box on the Runs page showed "wedged?"
 * with a red idle time: the backend folds `suspended` into the `running` run
 * status, and a sleeping box sends no frames, so its idle time grew without
 * bound. A box asleep costs no memory and no slot, and is the normal state of a
 * session between turns.
 */
describe('asleep, not wedged', () => {
  const silent = new Date(NOW - 3 * 3600_000).toISOString();

  it.each([
    ['a box suspended on its host', { sandboxStatus: 'suspended', sleep: { kind: 'local' as const, since: silent, suspendKind: 'memory' as const, uploadError: null } }],
    ['a hibernated box', { sandboxStatus: 'suspended', sleep: { kind: 'storage' as const, since: silent, suspendKind: 'rootfs' as const, uploadError: null } }],
    ['a suspended box whose backend sent no sleep detail', { sandboxStatus: 'suspended', sleep: null }],
  ])('never flags %s, however long it has slept', (_label, over) => {
    const r = run({ ...over, status: 'running', lastActivity: silent });
    expect(isAsleep(r)).toBe(true);
    expect(looksWedged(r, NOW)).toBe(false);
  });

  it.each([
    ['busy', true],
    ['idle', true],
    ['starting', true],
    ['stopped', false],
    ['failed', false],
  ])('flags a silent %s box: %s', (sandboxStatus, expected) => {
    expect(looksWedged(run({ sandboxStatus, lastActivity: silent }), NOW)).toBe(expected);
  });

  it('keeps the old rule for a row with no fleet state word', () => {
    expect(looksWedged(run({ sandboxStatus: null, lastActivity: silent }), NOW)).toBe(true);
    expect(looksWedged(run({ sandboxStatus: undefined, status: 'completed', lastActivity: silent }), NOW)).toBe(false);
  });

  it('says how long a box has slept', () => {
    const r = run({ sandboxStatus: 'suspended', sleep: { kind: 'local', since: new Date(NOW - 90_000).toISOString(), suspendKind: null, uploadError: null } });
    expect(sleepSeconds(r, NOW)).toBe(90);
    expect(sleepSeconds(run(), NOW)).toBeNull();
    expect(sleepSeconds(run({ sandboxStatus: 'suspended', sleep: null }), NOW)).toBeNull();
  });
});

describe('kind and claim', () => {
  it.each([
    ['a row with a kind', { kind: 'session' as const }, 'session'],
    ['an older row with a task', { kind: undefined, taskId: 't' }, 'task'],
    ['an older row with no task', { kind: undefined, taskId: null }, 'unknown'],
  ])('reads the kind of %s', (_label, over, expected) => {
    expect(runKind(run(over))).toBe(expected);
  });

  it.each([
    ['a row with a claim', { claim: 'superseded' as const, orphan: false }, 'superseded'],
    ['an older orphan', { claim: undefined, orphan: true }, 'orphan'],
    ['an older claimed row', { claim: undefined, orphan: false }, 'active'],
  ])('reads the claim of %s', (_label, over, expected) => {
    expect(runClaim(run(over))).toBe(expected);
  });

  it('does not count a deploy self-test as an orphan', () => {
    expect(isRealOrphan(run({ claim: 'orphan', orphan: true, selfTest: true }))).toBe(false);
    expect(isRealOrphan(run({ claim: 'orphan', orphan: true }))).toBe(true);
    expect(isRealOrphan(run({ claim: 'superseded' }))).toBe(false);
  });
});

describe('countRuns', () => {
  it('counts each header category', () => {
    const silent = new Date(NOW - 3600_000).toISOString();
    const counts = countRuns(
      [
        run({ sandboxStatus: 'busy' }),
        run({ sandboxStatus: 'busy', lastActivity: silent }),
        run({ sandboxStatus: 'suspended', lastActivity: silent, sleep: { kind: 'storage', since: silent, suspendKind: null, uploadError: null } }),
        run({ sandboxStatus: 'suspended', claim: 'superseded', lastActivity: silent }),
        run({ sandboxStatus: 'idle', claim: 'orphan', orphan: true }),
        run({ claim: 'orphan', orphan: true, selfTest: true }),
        run({ status: 'completed', sandboxStatus: null }),
      ],
      NOW,
    );
    expect(counts).toEqual({ running: 4, asleep: 2, superseded: 1, orphaned: 1, wedged: 1 });
  });
});

describe('boxSizeLabel', () => {
  it.each([
    ['the chosen size', { sandboxSize: 'large', memMib: 12288, vcpuCount: 6 }, 'Large · 12 GB'],
    ['a size read from the memory', { sandboxSize: null, memMib: 4096, vcpuCount: 4 }, 'Standard · 4 GB'],
    ['a chosen size the box does not match', { sandboxSize: 'large', memMib: 8192, vcpuCount: 4 }, 'Medium · 8 GB'],
    ['a memory no size has', { sandboxSize: null, memMib: 3000, vcpuCount: 2 }, `${mib(3000)} · 2 vCPU`],
    ['a chosen size with no live read', { sandboxSize: 'small', memMib: null, vcpuCount: null }, 'Small · 2 GB'],
    ['nothing known', { sandboxSize: null, memMib: null, vcpuCount: null }, null],
  ])('names %s', (_label, input, expected) => {
    expect(boxSizeLabel(input)).toBe(expected);
  });
});
