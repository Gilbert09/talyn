/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { ApiNetworkError } from '@talyn/client';
import { captureAnalyticsException, trackEvent } from '../renderer/lib/analytics';
import { reportApiError } from '../renderer/lib/apiErrorAnalytics';
import { captureWorkbenchFailure } from '../renderer/lib/workbenchAnalytics';
import { useCreateWorkbench, type NewWorkbenchSpec } from '../renderer/components/workbench/new/useCreateWorkbench';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { api } from '../renderer/lib/api';
import { sandboxOps } from '../renderer/lib/workbenchOps';

jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/lib/api', () => ({ api: { workbenches: { create: jest.fn(), createChat: jest.fn(), sendMessage: jest.fn(), runScript: jest.fn() } } }));
jest.mock('../renderer/lib/localWorkbench', () => ({ createLocalWorkbench: jest.fn() }));
jest.mock('../renderer/stores/navigation', () => ({ useNavigationStore: { getState: () => ({ navigate: jest.fn() }) } }));
jest.mock('../renderer/stores/billing', () => ({ maybeHandleBillingLimit: jest.fn(() => false) }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn() } }));

const spec: NewWorkbenchSpec = {
  workspaceId: 'ws1', repositoryId: 'repo1', repoFullName: 'private/repo', runtime: 'sandbox',
  agent: 'claude', model: 'model1', effort: 'medium', planMode: true, internetAccess: false,
  prompt: 'private prompt',
};
const workbench = {
  id: 'wb1', workspaceId: 'ws1', repositoryId: 'repo1', kind: 'session', runtime: 'sandbox',
  settings: { sandboxSize: 'small' }, pullRequestId: null,
} as unknown as Workbench;

beforeEach(() => {
  jest.clearAllMocks();
  useWorkbenchStore.setState({ selectedWorkbenchId: null, terminalOpen: false, prDetailId: null, workbenches: {} });
});

it('reports 5xx and network failures once per route and minute without identifiers', () => {
  jest.spyOn(Date, 'now').mockReturnValue(100_000);
  const failure = { error: new Error('secret'), method: 'POST', path: '/workbenches/chats/private-id/messages?token=secret', status: 503, code: 'backend_down' };
  reportApiError(failure);
  reportApiError({ ...failure, path: '/workbenches/chats/other-id/messages?token=other' });
  expect(captureAnalyticsException).toHaveBeenCalledTimes(1);
  expect(captureAnalyticsException).toHaveBeenCalledWith(expect.any(Error), {
    route: 'POST /workbenches/chats/:id/messages', status: 503, error_code: 'backend_down',
  });
  expect((jest.mocked(captureAnalyticsException).mock.calls[0][0] as Error).stack).toBeUndefined();
  expect(JSON.stringify(jest.mocked(captureAnalyticsException).mock.calls)).not.toMatch(/private|secret/);
  jest.spyOn(Date, 'now').mockReturnValue(160_001);
  reportApiError(failure);
  expect(captureAnalyticsException).toHaveBeenCalledTimes(2);
  reportApiError({ error: new ApiNetworkError('GET', '/workbenches/another-id', new Error('offline')), method: 'GET', path: '/workbenches/another-id' });
  expect(captureAnalyticsException).toHaveBeenCalledTimes(3);
  jest.restoreAllMocks();
});

it.each([400, 401, 402, 403, 404, 409, 412, 422, 429])('ignores expected HTTP %i', (status) => {
  reportApiError({ error: new Error('expected'), method: 'GET', path: '/workbenches/private-id', status });
  captureWorkbenchFailure('send_message', { status, code: 'expected' }, 'wb1');
  expect(captureAnalyticsException).not.toHaveBeenCalled();
});

it('tracks a created session and its first queued message', async () => {
  jest.mocked(api.workbenches.create).mockResolvedValue(workbench);
  const { result } = renderHook(() => useCreateWorkbench());
  await act(async () => { await result.current.create(spec); });
  expect(trackEvent).toHaveBeenCalledWith('session_created', {
    kind: 'session', runtime: 'sandbox', repository_id: 'repo1', size: 'small',
  });
  expect(trackEvent).toHaveBeenCalledWith('session_message_sent', {
    queued: true, plan_mode: true, model_id: 'model1', attachments_count: 0,
  });
  expect(JSON.stringify(jest.mocked(trackEvent).mock.calls)).not.toContain('private prompt');
});

it('captures a failed session creation', async () => {
  jest.mocked(api.workbenches.create).mockRejectedValue(new Error('private path'));
  const { result } = renderHook(() => useCreateWorkbench());
  await act(async () => { await result.current.create(spec); });
  expect(captureAnalyticsException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ operation: 'create_session' }));
  expect((jest.mocked(captureAnalyticsException).mock.calls[0][0] as Error).message).toBe('Workbench operation failed: create_session');
  expect(JSON.stringify(jest.mocked(captureAnalyticsException).mock.calls)).not.toContain('private path');
});

it('tracks terminal and pull request overlay openings', () => {
  useWorkbenchStore.setState({ selectedWorkbenchId: 'wb1' });
  useWorkbenchStore.getState().setTerminalOpen(true);
  useWorkbenchStore.getState().setTerminalOpen(true);
  useWorkbenchStore.getState().openPrDetail('pr1');
  expect(trackEvent).toHaveBeenCalledWith('session_terminal_opened', { workbench_id: 'wb1' });
  expect(trackEvent).toHaveBeenCalledWith('session_pr_overlay_opened', { workbench_id: 'wb1' });
  expect(jest.mocked(trackEvent).mock.calls.filter(([name]) => name === 'session_terminal_opened')).toHaveLength(1);
});

it('tracks a started setup script', async () => {
  jest.mocked(api.workbenches.runScript).mockResolvedValue(undefined);
  await sandboxOps(workbench).runScript('setup');
  expect(trackEvent).toHaveBeenCalledWith('session_script_run', { workbench_id: 'wb1', script_kind: 'setup' });
});
