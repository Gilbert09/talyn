import { afterEach, describe, expect, it } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SandboxUsageHistory, SandboxUsagePoint } from '@talyn/shared';
import { formatMib, SandboxUsageChart, usageSegments } from '../components/workbench/SandboxUsageChart';

const MIN = 60_000;
const NOW = new Date('2099-01-01T12:00:00Z').getTime();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();

function usage(points: SandboxUsagePoint[], over: Partial<SandboxUsageHistory> = {}): SandboxUsageHistory {
  return { windowMinutes: 60, stepSeconds: 60, memoryLimitMib: 4096, cpuReported: true, points, ...over };
}

const point = (minutesAgo: number, memoryUsedMib: number | null, cpuPercent: number | null): SandboxUsagePoint => ({
  at: at(minutesAgo),
  memoryUsedMib,
  cpuPercent,
});

afterEach(cleanup);

describe('formatMib', () => {
  it.each([
    [512, '512 MB'],
    [1023.6, '1024 MB'],
    [1024, '1 GB'],
    [1536, '1.5 GB'],
    [16384, '16 GB'],
  ])('%s MiB reads %s', (mib, text) => {
    expect(formatMib(mib)).toBe(text);
  });
});

describe('usageSegments', () => {
  const domain = { start: NOW - 60 * MIN, end: NOW, stepMs: MIN };
  const cpu = (p: SandboxUsagePoint) => p.cpuPercent;

  it('places points on the time and value scales', () => {
    const [seg] = usageSegments([point(60, null, 0), point(30, null, 50), point(0, null, 100)], cpu, 100, { ...domain, stepMs: 30 * MIN });
    expect(seg.map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([[0, 52], [150, 26], [300, 0]]);
  });

  it.each([
    ['a null value', [point(3, null, 10), point(2, null, null), point(1, null, 10)], [1, 1]],
    ['a gap longer than the step allows', [point(10, null, 10), point(9, null, 10), point(2, null, 10)], [2, 1]],
    ['no break', [point(3, null, 10), point(2, null, 10), point(1, null, 10)], [3]],
  ])('splits the line at %s', (_label, points, lengths) => {
    expect(usageSegments(points, cpu, 100, domain).map((s) => s.length)).toEqual(lengths);
  });

  it('clamps values and times into the chart', () => {
    const [seg] = usageSegments([point(70, null, -5), point(0, null, 150)], cpu, 100, { ...domain, stepMs: 70 * MIN });
    expect(seg[0]).toMatchObject({ x: 0, y: 52 });
    expect(seg[1]).toMatchObject({ x: 300, y: 0 });
  });
});

describe('SandboxUsageChart', () => {
  const checkedAt = new Date(NOW).toISOString();

  it('shows the newest value of each series and the time axis', () => {
    render(<SandboxUsageChart usage={usage([point(2, 1024, null), point(1, 1536, 40), point(0, 3072, 75)])} checkedAt={checkedAt} />);
    expect(screen.getByTestId('sandbox-usage-cpu-value')).toHaveTextContent('75%');
    expect(screen.getByTestId('sandbox-usage-memory-value')).toHaveTextContent('3 GB of 4 GB');
    expect(screen.getByText('60 min ago')).toBeInTheDocument();
    expect(screen.getByText('4 GB limit')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /CPU over the last 60 minutes, now 75%/ })).toBeInTheDocument();
  });

  it('shows the latest known value when the newest point has none', () => {
    render(<SandboxUsageChart usage={usage([point(2, 1024, 3.25), point(0, 2048, null)])} checkedAt={checkedAt} />);
    expect(screen.getByTestId('sandbox-usage-cpu-value')).toHaveTextContent('3.3%');
  });

  it('says when the fleet sends no CPU counter', () => {
    render(<SandboxUsageChart usage={usage([point(0, 1024, null)], { cpuReported: false })} checkedAt={checkedAt} />);
    expect(screen.getByText('The fleet does not report CPU use for this box yet.')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-usage-cpu-value')).toHaveTextContent('—');
  });

  it('says CPU needs two samples when the counter exists but no figure is ready', () => {
    render(<SandboxUsageChart usage={usage([point(0, 1024, null)])} checkedAt={checkedAt} />);
    expect(screen.getByText(/CPU use shows after two samples/)).toBeInTheDocument();
  });

  it('scales memory to its peak when the limit is unknown', () => {
    render(<SandboxUsageChart usage={usage([point(1, 1000, 1), point(0, 2000, 1)], { memoryLimitMib: null })} checkedAt={checkedAt} />);
    expect(screen.getByText('2.3 GB')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-usage-memory-value')).toHaveTextContent(/^2 GB$/);
  });

  it('shows the hovered point in both series, then the newest again', () => {
    render(<SandboxUsageChart usage={usage([point(30, 1024, 20), point(0, 2048, 80)])} checkedAt={checkedAt} />);
    const svg = screen.getByRole('img', { name: /^CPU/ });
    svg.getBoundingClientRect = () => ({ left: 0, width: 300, top: 0, height: 52, right: 300, bottom: 52, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.mouseMove(svg, { clientX: 150 });
    expect(screen.getByTestId('sandbox-usage-cpu-value')).toHaveTextContent('20% · 30 min ago');
    expect(screen.getByTestId('sandbox-usage-memory-value')).toHaveTextContent('1 GB of 4 GB · 30 min ago');
    fireEvent.mouseLeave(svg);
    expect(screen.getByTestId('sandbox-usage-cpu-value')).toHaveTextContent('80%');
  });
});
