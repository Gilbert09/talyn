import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { WorkbenchBackgroundLogs } from '@talyn/shared';

jest.mock('../renderer/lib/api', () => ({ api: { workbenches: { backgroundJobLogs: jest.fn() } } }));

import { api } from '../renderer/lib/api';
import { useJobLogs } from '../renderer/hooks/useJobLogs';

const response = (asleep: boolean, lines: string[] = []): WorkbenchBackgroundLogs => ({ jobId: 'job-1', status: 'running', exitCode: null, lines, asleep });

function Probe({ expanded = true, running = true }: { expanded?: boolean; running?: boolean }) {
  const logs = useJobLogs('wb-1', 'job-1', expanded, running);
  return <div><span data-testid="lines">{logs.logs?.lines.join(',')}</span><span data-testid="asleep">{String(logs.logs?.asleep)}</span><button onClick={logs.wakeAndLoad}>Wake and load logs</button></div>;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(api.workbenches.backgroundJobLogs).mockResolvedValue(response(false, ['first']));
});
afterEach(() => { cleanup(); jest.useRealTimers(); jest.clearAllMocks(); });

it('loads once, then polls every three seconds only while running and expanded', async () => {
  const { rerender } = render(<Probe />);
  await act(async () => { await Promise.resolve(); });
  expect(api.workbenches.backgroundJobLogs).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('lines')).toHaveTextContent('first');
  await act(async () => { jest.advanceTimersByTime(3000); await Promise.resolve(); });
  expect(api.workbenches.backgroundJobLogs).toHaveBeenCalledTimes(2);
  rerender(<Probe expanded={false} />);
  await act(async () => { jest.advanceTimersByTime(6000); await Promise.resolve(); });
  expect(api.workbenches.backgroundJobLogs).toHaveBeenCalledTimes(2);
  rerender(<Probe running={false} />);
  await act(async () => { await Promise.resolve(); });
  expect(api.workbenches.backgroundJobLogs).toHaveBeenCalledTimes(3);
  await act(async () => { jest.advanceTimersByTime(6000); await Promise.resolve(); });
  expect(api.workbenches.backgroundJobLogs).toHaveBeenCalledTimes(3);
});

it('requests live logs after the sleeping answer', async () => {
  jest.mocked(api.workbenches.backgroundJobLogs).mockResolvedValueOnce(response(true)).mockResolvedValue(response(false, ['awake']));
  render(<Probe />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByTestId('asleep')).toHaveTextContent('true');
  fireEvent.click(screen.getByRole('button', { name: 'Wake and load logs' }));
  await act(async () => { await Promise.resolve(); });
  expect(api.workbenches.backgroundJobLogs).toHaveBeenLastCalledWith('wb-1', 'job-1', { tail: 200, live: true });
  expect(screen.getByTestId('lines')).toHaveTextContent('awake');
});
