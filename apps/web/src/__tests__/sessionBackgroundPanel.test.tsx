import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkbenchBackgroundJob, WorkbenchWakeup } from '@talyn/shared';

vi.mock('../lib/api', () => ({ api: { workbenches: { keepBackgroundJobAwake: vi.fn(), stopBackgroundJob: vi.fn(), cancelWakeup: vi.fn(), backgroundJobLogs: vi.fn() } } }));
vi.mock('../stores/toast', () => ({ toast: { error: vi.fn() } }));

import { api } from '../lib/api';
import { useSessionBackgroundStore } from '../stores/sessionBackground';
import { BackgroundTab } from '../components/workbench/BackgroundTab';

const job: WorkbenchBackgroundJob = {
  id: 'job-1', workbenchId: 'wb-1', chatId: 'chat-1', name: 'Build', command: 'npm run build', cwd: '/work',
  status: 'running', exitCode: null, detail: null, startedAt: '2026-11-08T09:00:00Z', endedAt: null,
  keepAwakeUntil: '2026-11-08T11:00:00Z', notifyOnExit: true, lastCheckedAt: null,
};
const wakeup: WorkbenchWakeup = {
  id: 'wake-1', workbenchId: 'wb-1', chatId: 'chat-1', wakeAt: '2026-11-08T11:00:00Z', reason: 'Check the build',
  status: 'scheduled', failureDetail: null, createdBy: 'agent', sourceJobId: null, ci: null,
  createdAt: '2026-11-08T09:00:00Z', firedAt: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T10:00:00Z'));
  vi.mocked(api.workbenches.keepBackgroundJobAwake).mockResolvedValue(job);
  vi.mocked(api.workbenches.stopBackgroundJob).mockResolvedValue(job);
  vi.mocked(api.workbenches.cancelWakeup).mockResolvedValue(wakeup);
  useSessionBackgroundStore.getState().applyBackground({ workbenchId: 'wb-1', jobs: [job], wakeups: [wakeup] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it('shows job controls and scheduled wake-ups', () => {
  render(<BackgroundTab workbenchId="wb-1" />);
  expect(screen.getByText('Build')).toBeInTheDocument();
  expect(screen.getByTitle('npm run build')).toBeInTheDocument();
  expect(screen.getByText('Keeps the box awake until 11:00')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Let it sleep' }));
  expect(api.workbenches.keepBackgroundJobAwake).toHaveBeenCalledWith('wb-1', 'job-1', 0);
  fireEvent.click(screen.getByRole('button', { name: 'Extend 1h' }));
  expect(api.workbenches.keepBackgroundJobAwake).toHaveBeenCalledWith('wb-1', 'job-1', 3600);
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(api.workbenches.stopBackgroundJob).toHaveBeenCalledWith('wb-1', 'job-1');
  expect(screen.getByText('Set by the agent')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(api.workbenches.cancelWakeup).toHaveBeenCalledWith('wb-1', 'wake-1');
});

it('shows empty states', () => {
  useSessionBackgroundStore.getState().applyBackground({ workbenchId: 'wb-1', jobs: [], wakeups: [] });
  render(<BackgroundTab workbenchId="wb-1" />);
  expect(screen.getByText('No background jobs yet.')).toBeInTheDocument();
  expect(screen.getByText('No wake-ups yet.')).toBeInTheDocument();
});
