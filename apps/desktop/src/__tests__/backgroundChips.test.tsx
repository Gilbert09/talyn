import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

jest.mock('../renderer/lib/api', () => ({ api: { workbenches: { cancelWakeup: jest.fn() } } }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn() } }));

import { api } from '../renderer/lib/api';
import { useSessionBackgroundStore } from '../renderer/stores/sessionBackground';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import type { WorkbenchBackgroundJob, WorkbenchWakeup } from '@talyn/shared';
import { BackgroundChips } from '../renderer/components/workbench/BackgroundChips';

const wakeup: WorkbenchWakeup = {
  id: 'wake-1', workbenchId: 'wb-1', chatId: 'chat-1', wakeAt: '2026-11-08T10:12:00Z',
  reason: 'Check build status', status: 'scheduled', failureDetail: null, createdBy: 'user',
  sourceJobId: null, ci: null, createdAt: '2026-11-08T10:00:00Z', firedAt: null,
};

function job(overrides: Partial<WorkbenchBackgroundJob> = {}): WorkbenchBackgroundJob {
  return {
    id: 'job-1', workbenchId: 'wb-1', chatId: 'chat-2', name: 'backend tests', command: 'npm test',
    cwd: '/work/repo', status: 'running', exitCode: null, detail: null,
    startedAt: '2026-11-08T09:58:00Z', endedAt: null, keepAwakeUntil: null, notifyOnExit: true,
    lastCheckedAt: null, ...overrides,
  };
}

function setBackground(jobs: WorkbenchBackgroundJob[], wakeups: WorkbenchWakeup[]) {
  useSessionBackgroundStore.getState().applyBackground({ workbenchId: 'wb-1', jobs, wakeups });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-08T10:00:00Z'));
  setBackground([], [wakeup]);
  useWorkbenchStore.setState({ sideTab: 'changes', rightPanelOpen: false });
  (api.workbenches.cancelWakeup as jest.Mock).mockResolvedValue(wakeup);
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.clearAllMocks();
});

describe('wake-ups', () => {
  it('updates the countdown every 15 seconds', () => {
    render(<BackgroundChips workbenchId="wb-1" chatId="chat-1" canOpen />);
    expect(screen.getByTestId('wakeup-chip')).toHaveTextContent('Wakes in 12 min');
    act(() => { jest.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('wakeup-chip')).toHaveTextContent('Wakes in 11 min');
  });

  it('says a CI wake-up waits for CI, and its latest time in the title', () => {
    setBackground([], [{ ...wakeup, ci: { pullRequestId: 'pr-1', headSha: 'abcdef1234567890abcdef1234567890abcdef12' } }]);
    render(<BackgroundChips workbenchId="wb-1" chatId="chat-1" canOpen />);
    const chip = screen.getByTestId('wakeup-chip');
    expect(chip).toHaveTextContent('Waits for CI on abcdef1: Check build status');
    expect(chip).toHaveAttribute('title', 'Waits for CI on abcdef1. Wakes in 12 min at the latest: Check build status');
  });

  it('cancels a wake-up in the current chat', () => {
    render(<BackgroundChips workbenchId="wb-1" chatId="chat-1" canOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel wake-up: Check build status' }));
    expect(api.workbenches.cancelWakeup).toHaveBeenCalledWith('wb-1', 'wake-1');
    expect(useWorkbenchStore.getState().sideTab).toBe('changes');
  });

  it('opens the Background tab from the wake-up text', () => {
    render(<BackgroundChips workbenchId="wb-1" chatId="chat-1" canOpen />);
    fireEvent.click(screen.getByText(/Check build status/));
    expect(useWorkbenchStore.getState()).toMatchObject({ sideTab: 'background', rightPanelOpen: true });
  });

  it.each([
    ['another chat', 'chat-2', { ...wakeup }],
    ['a fired wake-up', 'chat-1', { ...wakeup, status: 'fired' as const }],
    ['a cancelled wake-up', 'chat-1', { ...wakeup, status: 'cancelled' as const }],
  ])('hides %s', (_name, chatId, item) => {
    setBackground([], [item]);
    render(<BackgroundChips workbenchId="wb-1" chatId={chatId} canOpen />);
    expect(screen.queryByTestId('wakeup-chip')).not.toBeInTheDocument();
  });
});

describe('background jobs', () => {
  it('shows a running job from any chat with a live run time', () => {
    setBackground([job()], []);
    render(<BackgroundChips workbenchId="wb-1" chatId="chat-1" canOpen />);
    expect(screen.getByTestId('job-chip')).toHaveTextContent('backend tests2m 00s');
    act(() => { jest.advanceTimersByTime(5_000); });
    expect(screen.getByTestId('job-chip')).toHaveTextContent('2m 05s');
  });

  it('shows running jobs when there is no chat', () => {
    setBackground([job()], [wakeup]);
    render(<BackgroundChips workbenchId="wb-1" chatId={null} canOpen />);
    expect(screen.getByTestId('job-chip')).toBeInTheDocument();
    expect(screen.queryByTestId('wakeup-chip')).not.toBeInTheDocument();
  });

  it.each(['exited', 'stopped', 'lost'] as const)('hides a %s job', (status) => {
    setBackground([job({ status, endedAt: '2026-11-08T09:59:00Z' })], []);
    const { container } = render(<BackgroundChips workbenchId="wb-1" chatId="chat-1" canOpen />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the Background tab when clicked', () => {
    setBackground([job()], []);
    render(<BackgroundChips workbenchId="wb-1" chatId="chat-1" canOpen />);
    fireEvent.click(screen.getByRole('button', { name: /Background job backend tests/ }));
    expect(useWorkbenchStore.getState()).toMatchObject({ sideTab: 'background', rightPanelOpen: true });
  });

  it('does not offer the Background tab to someone who cannot open it', () => {
    setBackground([job()], [wakeup]);
    render(<BackgroundChips workbenchId="wb-1" chatId="chat-1" canOpen={false} />);
    expect(screen.getByTestId('job-chip').tagName).toBe('SPAN');
    expect(screen.queryByRole('button', { name: /Background job/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('job-chip'));
    expect(useWorkbenchStore.getState().sideTab).toBe('changes');
  });

  it.each<[number, number, string | null]>([
    [3, 3, null],
    [4, 3, '+1 more'],
    [6, 3, '+3 more'],
  ])('with %i running jobs shows %i chips and %s', (count, shown, more) => {
    setBackground(Array.from({ length: count }, (_, i) => job({ id: `job-${i}`, name: `job ${i}` })), []);
    render(<BackgroundChips workbenchId="wb-1" chatId="chat-1" canOpen />);
    expect(screen.getAllByTestId('job-chip')).toHaveLength(shown);
    if (more) expect(screen.getByTestId('job-chip-more')).toHaveTextContent(more);
    else expect(screen.queryByTestId('job-chip-more')).not.toBeInTheDocument();
  });
});

it('draws nothing when nothing runs or waits', () => {
  setBackground([], []);
  const { container } = render(<BackgroundChips workbenchId="wb-1" chatId="chat-1" canOpen />);
  expect(container).toBeEmptyDOMElement();
});
