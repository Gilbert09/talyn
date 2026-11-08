import { describe, expect, it } from 'vitest';
import {
  cpuPercentBetween,
  describeUsageHistory,
  sampleFromFleet,
  USAGE_WINDOW_MINUTES,
  type ResourceSample,
} from '../services/workbenches/resourceSamples.js';

const NOW = new Date('2099-01-01T12:00:00Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const sample = (overrides: Partial<ResourceSample> = {}): ResourceSample => ({
  workbenchId: 'wb1',
  sandboxId: 'box',
  sampledAt: ago(MIN),
  memUsedMib: 1024,
  memLimitMib: 4096,
  cpuSeconds: 100,
  vcpus: 2,
  ...overrides,
});

describe('sampleFromFleet', () => {
  it.each([
    ['memory and CPU', { id: 'box', memUsedMib: 800, cpuSeconds: 12.5, memMib: 4096, milliVcpu: 4000 }, { memUsedMib: 800, cpuSeconds: 12.5, memLimitMib: 4096, vcpus: 4 }],
    ['memory only, from an older fleet', { id: 'box', memUsedMib: 800, memMib: 4096, vcpuCount: 2 }, { memUsedMib: 800, cpuSeconds: null, vcpus: 2 }],
    ['CPU only', { id: 'box', cpuSeconds: 3 }, { memUsedMib: null, cpuSeconds: 3, memLimitMib: null, vcpus: null }],
    ['milliVcpu wins over vcpuCount', { id: 'box', memUsedMib: 1, milliVcpu: 2500, vcpuCount: 3 }, { vcpus: 2.5 }],
    ['a zero CPU counter is a real value', { id: 'box', cpuSeconds: 0 }, { cpuSeconds: 0 }],
  ])('reads %s', (_label, box, expected) => {
    expect(sampleFromFleet('wb1', box, NOW)).toMatchObject({ workbenchId: 'wb1', sandboxId: 'box', sampledAt: NOW, ...expected });
  });

  it.each([
    ['no use figures', { id: 'box', memMib: 4096 }],
    ['a non-number figure', { id: 'box', memUsedMib: Number.NaN }],
  ])('returns null for %s', (_label, box) => {
    expect(sampleFromFleet('wb1', box, NOW)).toBeNull();
  });
});

describe('cpuPercentBetween', () => {
  const prev = sample({ sampledAt: ago(2 * MIN), cpuSeconds: 100 });
  it.each([
    ['half of two vCPUs', sample({ cpuSeconds: 160 }), 50],
    ['idle', sample({ cpuSeconds: 100 }), 0],
    ['clamped at 100', sample({ cpuSeconds: 400 }), 100],
    ['rounded to one decimal', sample({ cpuSeconds: 100.1 }), 0.1],
    ['one vCPU fully busy', sample({ cpuSeconds: 160, vcpus: 1 }), 100],
  ])('%s', (_label, cur, expected) => {
    expect(cpuPercentBetween(prev, cur)).toBe(expected);
  });

  it.each([
    ['no sample before', undefined, sample()],
    ['another box', prev, sample({ sandboxId: 'other', cpuSeconds: 160 })],
    ['a lower counter (a new VMM)', prev, sample({ cpuSeconds: 50 })],
    ['no CPU before', sample({ sampledAt: ago(2 * MIN), cpuSeconds: null }), sample()],
    ['no CPU now', prev, sample({ cpuSeconds: null })],
    ['no vCPU count', prev, sample({ cpuSeconds: 160, vcpus: null })],
    ['a gap longer than three steps', sample({ sampledAt: ago(10 * MIN) }), sample({ cpuSeconds: 160 })],
    ['the same instant', sample(), sample({ cpuSeconds: 160 })],
  ])('is null for %s', (_label, before, cur) => {
    expect(cpuPercentBetween(before, cur)).toBeNull();
  });
});

describe('describeUsageHistory', () => {
  it('is null with no samples and no live read', () => {
    expect(describeUsageHistory([], null, NOW)).toBeNull();
  });

  it('orders points, computes CPU from the sample before the window, and adds the live read', () => {
    const stored = [
      sample({ sampledAt: ago(2 * MIN), cpuSeconds: 160 }),
      sample({ sampledAt: ago((USAGE_WINDOW_MINUTES + 1) * MIN), cpuSeconds: 40 }),
      sample({ sampledAt: ago(USAGE_WINDOW_MINUTES * MIN), cpuSeconds: 100 }),
    ];
    const live = sample({ sampledAt: NOW, cpuSeconds: 166, memUsedMib: 2048 });
    const usage = describeUsageHistory(stored, live, NOW);
    expect(usage).toMatchObject({ windowMinutes: USAGE_WINDOW_MINUTES, stepSeconds: 60, memoryLimitMib: 4096, cpuReported: true });
    expect(usage!.points).toEqual([
      { at: ago(USAGE_WINDOW_MINUTES * MIN).toISOString(), memoryUsedMib: 1024, cpuPercent: 50 },
      // 58 minutes since the sample before: a gap, so no CPU figure.
      { at: ago(2 * MIN).toISOString(), memoryUsedMib: 1024, cpuPercent: null },
      { at: NOW.toISOString(), memoryUsedMib: 2048, cpuPercent: 2.5 },
    ]);
  });

  it('drops a live read too close to the newest sample', () => {
    const usage = describeUsageHistory([sample({ sampledAt: ago(2_000) })], sample({ sampledAt: NOW }), NOW);
    expect(usage!.points).toHaveLength(1);
  });

  it('charts the live read alone before the sweep stored anything', () => {
    const usage = describeUsageHistory([], sample({ sampledAt: NOW, cpuSeconds: null }), NOW);
    expect(usage).toMatchObject({ cpuReported: false, points: [{ at: NOW.toISOString(), memoryUsedMib: 1024, cpuPercent: null }] });
  });

  it('is null when every sample is older than the window', () => {
    expect(describeUsageHistory([sample({ sampledAt: ago(2 * USAGE_WINDOW_MINUTES * MIN) })], null, NOW)).toBeNull();
  });

  it('keeps the newest memory limit after a resize', () => {
    const usage = describeUsageHistory(
      [sample({ sampledAt: ago(3 * MIN), memLimitMib: 4096 }), sample({ sampledAt: ago(2 * MIN), sandboxId: 'box2', memLimitMib: 8192 })],
      null,
      NOW,
    );
    expect(usage!.memoryLimitMib).toBe(8192);
    expect(usage!.points[1].cpuPercent).toBeNull();
  });
});
