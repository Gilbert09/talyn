import { cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import type { Workbench, WorkbenchStartProgress } from '@talyn/shared';
import { isStarting, StartingHint, START_PROGRESS_TICK_MS } from '../components/workbench/WorkbenchStarting';

const wb = (over: Partial<Workbench> = {}) =>
  ({
    id: 'wb1',
    runtime: 'sandbox',
    status: 'provisioning',
    sandboxState: 'creating',
    statusMessage: null,
    ...over,
  }) as Workbench;

describe('isStarting', () => {
  it.each<[string, Partial<Workbench>, boolean]>([
    ['provisioning', { status: 'provisioning', sandboxState: 'creating' }, true],
    ['ready but the box is still creating', { status: 'ready', sandboxState: 'creating' }, true],
    ['ready', { status: 'ready', sandboxState: 'running' }, false],
    ['lost', { status: 'provisioning', sandboxState: 'lost' }, true],
    ['failed while the box says creating', { status: 'error', sandboxState: 'creating' }, false],
    ['provisioning with a failed box', { status: 'provisioning', sandboxState: 'error' }, false],
  ])('%s → %s', (_name, over, expected) => {
    expect(isStarting(wb(over))).toBe(expected);
  });
});

describe('StartingHint', () => {
  it('says what the sandbox is doing', () => {
    render(<StartingHint workbench={wb({ statusMessage: 'Cloning the repository' })} queued={0} />);
    expect(screen.getByText('Starting the sandbox')).toBeInTheDocument();
    expect(screen.getByText('Cloning the repository')).toBeInTheDocument();
    expect(screen.getByText(/write your first message now/)).toBeInTheDocument();
  });

  it.each<[number, RegExp]>([
    [1, /^Your message is queued\. It is sent when the sandbox is ready\.$/],
    [3, /^3 messages are queued\. They are sent in order when the sandbox is ready\.$/],
  ])('names %i queued message(s)', (queued, text) => {
    render(<StartingHint workbench={wb()} queued={queued} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('shows the recovery message', () => {
    render(
      <StartingHint
        workbench={wb({
          status: 'provisioning',
          sandboxState: 'lost',
          statusMessage: 'The sandbox was lost. Talyn is starting a new one.',
        })}
        queued={0}
      />,
    );
    expect(screen.getByText('Starting a new sandbox')).toBeInTheDocument();
    expect(screen.getByText('The sandbox was lost. Talyn is starting a new one.')).toBeInTheDocument();
  });
});

describe('StartingHint with start progress', () => {
  const NOW = new Date('2099-01-01T12:00:00.000Z');
  const progress = (over: Partial<WorkbenchStartProgress> = {}): WorkbenchStartProgress => ({
    step: 'code', stepIndex: 1, stepCount: 3, stepStartedAt: NOW.toISOString(), expectedMs: 60_000,
    percent: null, detail: null, ...over,
  });
  const bar = () => screen.getByRole('progressbar');
  const fill = () => Number(bar().getAttribute('aria-valuenow'));

  afterEach(() => { vi.useRealTimers(); });

  it.each<[string, Partial<WorkbenchStartProgress>, string]>([
    ['the box', { step: 'sandbox', stepIndex: 0 }, 'Step 1 of 3 · Starting the sandbox'],
    ['the code', {}, 'Step 2 of 3 · Getting the code'],
    ['the setup', { step: 'setup', stepIndex: 2 }, 'Step 3 of 3 · Running the setup script'],
    ['a thread', { step: 'sandbox', stepIndex: 0, stepCount: 1 }, 'Starting the sandbox'],
  ])('names the step: %s', (_name, over, label) => {
    vi.useFakeTimers({ now: NOW });
    render(<StartingHint workbench={wb({ startProgress: progress(over), statusMessage: 'Cloning the repository' })} queued={1} />);
    expect(screen.getByText(label, { selector: '[data-attr="workbench-start-progress"] p' })).toBeInTheDocument();
    expect(screen.getByText('Cloning the repository')).toBeInTheDocument();
    expect(screen.getByText(/^Your message is queued/)).toBeInTheDocument();
    expect(bar()).toHaveAttribute('aria-label', expect.stringContaining(label));
  });

  it('shows git progress as a fill and in words', () => {
    vi.useFakeTimers({ now: NOW });
    render(<StartingHint workbench={wb({ startProgress: progress({ percent: 42, detail: 'Receiving objects' }) })} queued={0} />);
    expect(screen.getByText('Receiving objects · 42%')).toBeInTheDocument();
    expect(fill()).toBeCloseTo((1 + 0.42) / 3, 3);
  });

  it('estimates from the usual time and keeps moving without git', () => {
    vi.useFakeTimers({ now: NOW });
    render(<StartingHint workbench={wb({ startProgress: progress() })} queued={0} />);
    expect(fill()).toBeCloseTo(1 / 3, 3);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(fill()).toBeCloseTo((1 + 0.8) / 3, 2);
    act(() => { vi.advanceTimersByTime(60 * 60_000); });
    expect(fill()).toBeCloseTo((1 + 0.95) / 3, 2);
    expect(screen.queryByText(/%$/)).toBeNull();
  });

  it('is indeterminate with no history', () => {
    vi.useFakeTimers({ now: NOW });
    render(<StartingHint workbench={wb({ startProgress: progress({ expectedMs: null }) })} queued={0} />);
    expect(bar()).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('Step 2 of 3 · Getting the code')).toBeInTheDocument();
  });

  it('never moves backwards within a step', () => {
    vi.useFakeTimers({ now: NOW });
    const { rerender } = render(<StartingHint workbench={wb({ startProgress: progress({ percent: 90, detail: 'Receiving objects' }) })} queued={0} />);
    const high = fill();
    // A broadcast from another server carries no git percentage.
    rerender(<StartingHint workbench={wb({ startProgress: progress() })} queued={0} />);
    expect(fill()).toBeCloseTo(high, 5);
    rerender(<StartingHint workbench={wb({ startProgress: progress({ expectedMs: null }) })} queued={0} />);
    expect(fill()).toBeCloseTo(high, 5);
    // The next step starts from its own place.
    rerender(<StartingHint workbench={wb({ startProgress: progress({ step: 'setup', stepIndex: 2, stepStartedAt: new Date(NOW.getTime() + 1).toISOString() }) })} queued={0} />);
    expect(fill()).toBeCloseTo(2 / 3, 2);
  });

  it('ticks only while it estimates', () => {
    vi.useFakeTimers({ now: NOW });
    render(<StartingHint workbench={wb({ startProgress: progress({ percent: 10 }) })} queued={0} />);
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
    render(<StartingHint workbench={wb({ startProgress: progress() })} queued={0} />);
    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(START_PROGRESS_TICK_MS); });
    expect(fill()).toBeGreaterThan(1 / 3);
  });

  it.each<[string, Partial<Workbench>]>([
    ['no start progress (an older server)', {}],
    ['a null start progress', { startProgress: null }],
  ])('falls back to the spinner with %s', (_name, over) => {
    render(<StartingHint workbench={wb({ statusMessage: 'Cloning the repository', ...over })} queued={0} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('Starting the sandbox')).toBeInTheDocument();
    expect(screen.getByText('Cloning the repository')).toBeInTheDocument();
  });
});

afterEach(cleanup);
