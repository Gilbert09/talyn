import React from 'react';
import { emptyLoopInput, type LoopRun } from '@talyn/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { LoopsPanel } from '../renderer/components/panels/loops/LoopsPanel';
import { toast } from '../renderer/stores/toast';

const mockLoopHook = { loops: [] as unknown[], error: null, create: jest.fn(), update: jest.fn(), remove: jest.fn(), setEnabled: jest.fn(), runNow: jest.fn(), liveRuns: {}, agents: [] };
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/stores/toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('../renderer/stores/billing', () => ({ useBillingStore: { getState: () => ({ status: null, refresh: jest.fn() }) }, maybeHandleBillingLimit: () => false }));
jest.mock('../renderer/components/panels/loops/useLoops', () => ({ useLoops: () => mockLoopHook }));
jest.mock('../renderer/components/panels/workflows/FeedbackButton', () => ({ FeedbackButton: () => null }));
jest.mock('../renderer/components/panels/loops/LoopRunsList', () => ({ LoopRunsList: () => <div data-testid="run-history" /> }));

const loop = {
  ...emptyLoopInput('UTC'), id: 'loop-1', name: 'Daily sweep', enabled: true,
  repoFullName: 'org/repo', nextRunAt: null, disabledReason: null,
  stats: { runsTotal: 0, runs7d: 0, failures7d: 0, lastRunAt: null, lastStatus: null },
};

function run(over: Partial<LoopRun>): LoopRun {
  return {
    id: 'run-1', loopId: 'loop-1', workspaceId: 'ws-1', scheduledFor: '2026-11-17T10:00:00Z', trigger: 'manual',
    repositoryId: 'repo-1', repoFullName: 'org/repo', provider: 'selfhosted', model: 'claude-opus-5-5', target: 'session',
    taskId: null, sessionId: null, status: 'queued', failureCode: null, error: null, retryAfter: null,
    createdAt: '2026-11-17T10:00:00Z', settledAt: null, ...over,
  } as LoopRun;
}

afterEach(() => { mockLoopHook.loops = []; cleanup(); jest.clearAllMocks(); });

describe('loop run now feedback', () => {
  it('shows that the run is starting while the request is in flight', async () => {
    let resolve: (r: LoopRun) => void = () => {};
    mockLoopHook.runNow.mockReturnValue(new Promise<LoopRun>((r) => { resolve = r; }));
    mockLoopHook.loops = [loop];
    render(<LoopsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    const busy = await screen.findByRole('button', { name: 'Starting a run' });
    expect(busy).toBeDisabled();
    expect(screen.getByText(/Starting a run/, { selector: 'p' })).toBeTruthy();
    expect(screen.getByTestId('run-history')).toBeTruthy();

    // A second click while it is starting must not ask for a second run.
    fireEvent.click(busy);
    expect(mockLoopHook.runNow).toHaveBeenCalledTimes(1);

    await act(async () => { resolve(run({ status: 'running', sessionId: 'session-1' })); });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run now' })).not.toBeDisabled());
    expect(screen.queryByText(/Starting a run/, { selector: 'p' })).toBeNull();
  });

  it.each([
    { name: 'a started session', result: run({ status: 'running', target: 'session', sessionId: 's-1' }), kind: 'success', title: 'Started Daily sweep', action: 'Open session' },
    { name: 'a queued task', result: run({ status: 'queued', target: 'task', taskId: 't-1' }), kind: 'success', title: 'Started Daily sweep', action: 'Open task' },
    { name: 'a failed dispatch', result: run({ status: 'failed', error: 'boom' }), kind: 'error', title: 'The run did not start', action: undefined },
    { name: 'a run waiting for a slot', result: run({ status: 'waiting_slot', failureCode: 'task_limit_reached' }), kind: 'info', title: 'The run is waiting to start', action: undefined },
    { name: 'a skipped run', result: run({ status: 'skipped', failureCode: 'overlap' }), kind: 'info', title: 'The run was skipped', action: undefined },
    { name: 'no run in the response', result: null, kind: 'info', title: 'Run requested', action: undefined },
  ])('tells the outcome for $name', async ({ result, kind, title, action }) => {
    mockLoopHook.runNow.mockResolvedValue(result);
    mockLoopHook.loops = [loop];
    render(<LoopsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    const fn = toast[kind as 'success' | 'error' | 'info'] as unknown as jest.Mock;
    await waitFor(() => expect(fn).toHaveBeenCalled());
    expect(fn.mock.calls[0][0]).toBe(title);
    expect((fn.mock.calls[0][2] as { label: string } | undefined)?.label).toBe(action);
  });

  it('shows the error when the request fails', async () => {
    mockLoopHook.runNow.mockRejectedValue(new Error('Automation not found'));
    mockLoopHook.loops = [loop];
    render(<LoopsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not run that', 'Automation not found'));
    expect(screen.getByRole('button', { name: 'Run now' })).not.toBeDisabled();
  });
});
