import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workbench } from '@talyn/shared';
import { ApiNetworkError } from '@talyn/client';
import { api as sharedApi, configureApiClient } from '../../../../packages/client/src/index';

const { api, navigate } = vi.hoisted(() => ({
  api: { workbenches: { create: vi.fn(), createChat: vi.fn(), sendMessage: vi.fn(), runScript: vi.fn() } },
  navigate: vi.fn(),
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../lib/api', () => ({ api }));
vi.mock('../stores/navigation', () => ({ useNavigationStore: { getState: () => ({ navigate }) } }));
vi.mock('../stores/billing', () => ({ maybeHandleBillingLimit: vi.fn(() => false) }));
vi.mock('../stores/toast', () => ({ toast: { error: vi.fn() } }));

import { captureAnalyticsException, trackEvent } from '../lib/analytics';
import { reportApiError } from '../lib/apiErrorAnalytics';
import { captureWorkbenchFailure } from '../lib/workbenchAnalytics';
import { useCreateWorkbench, type NewWorkbenchSpec } from '../components/workbench/new/useCreateWorkbench';
import { useWorkbenchStore } from '../stores/workbenches';
import { sandboxOps } from '../lib/workbenchOps';

const spec: NewWorkbenchSpec = {
  workspaceId: 'ws1', repositoryId: 'repo1', repoFullName: 'private/repo',
  agent: 'claude', model: 'model1', effort: 'medium', planMode: true,
  internetAccess: false, prompt: 'private prompt',
};
const workbench = {
  id: 'wb1', workspaceId: 'ws1', repositoryId: 'repo1', kind: 'session', runtime: 'sandbox',
  settings: { sandboxSize: 'small' }, pullRequestId: null,
} as unknown as Workbench;

beforeEach(() => {
  vi.clearAllMocks();
  useWorkbenchStore.setState({ selectedWorkbenchId: null, terminalOpen: false, prDetailId: null, workbenches: {} });
});

describe('API error reporting', () => {
  it('calls the shared failure hook once after session recovery', async () => {
    const response = (status: number) => ({
      status,
      text: async () => JSON.stringify({ success: false, error: 'hidden detail', code: 'backend_down' }),
    }) as Response;
    const fetchMock = vi.fn().mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(503));
    vi.stubGlobal('fetch', fetchMock);
    configureApiClient({
      baseUrl: 'https://example.test', clientVersion: 'test',
      getAccessToken: async () => 'token', recoverSession: async () => true,
      onRequestError: reportApiError,
    });
    try {
      await expect(sharedApi.workbenches.retry('private-id')).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(captureAnalyticsException).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('calls the shared failure hook once after a GET transport retry', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    const onRequestError = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    configureApiClient({
      baseUrl: 'https://example.test', clientVersion: 'test',
      getAccessToken: async () => null, recoverSession: async () => false,
      onRequestError,
    });
    try {
      const failed = expect(sharedApi.workbenches.get('private-id')).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1_000);
      await failed;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(onRequestError).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('reports 5xx and network failures once per route and minute without identifiers', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const failure = { error: new Error('secret'), method: 'POST', path: '/workbenches/chats/private-id/messages?token=secret', status: 503, code: 'backend_down' };
    reportApiError(failure);
    reportApiError({ ...failure, path: '/workbenches/chats/other-id/messages?token=other' });
    expect(captureAnalyticsException).toHaveBeenCalledTimes(1);
    expect(captureAnalyticsException).toHaveBeenCalledWith(expect.any(Error), {
      route: 'POST /workbenches/chats/:id/messages', status: 503, error_code: 'backend_down',
    });
    expect((vi.mocked(captureAnalyticsException).mock.calls[0][0] as Error).stack).toBeUndefined();
    expect(JSON.stringify(vi.mocked(captureAnalyticsException).mock.calls)).not.toMatch(/private|secret/);
    vi.spyOn(Date, 'now').mockReturnValue(160_001);
    reportApiError(failure);
    expect(captureAnalyticsException).toHaveBeenCalledTimes(2);
    reportApiError({ error: new ApiNetworkError('GET', '/workbenches/another-id', new Error('offline')), method: 'GET', path: '/workbenches/another-id' });
    expect(captureAnalyticsException).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });

  it.each([400, 401, 402, 403, 404, 409, 412, 422, 429])('ignores expected HTTP %i', (status) => {
    reportApiError({ error: new Error('expected'), method: 'GET', path: '/workbenches/private-id', status });
    captureWorkbenchFailure('send_message', { status, code: 'expected' }, 'wb1');
    expect(captureAnalyticsException).not.toHaveBeenCalled();
  });
});

it('tracks a created session and its first queued message', async () => {
  api.workbenches.create.mockResolvedValue(workbench);
  const { result } = renderHook(() => useCreateWorkbench());
  await act(async () => { await result.current.create(spec); });
  expect(trackEvent).toHaveBeenCalledWith('session_created', {
    kind: 'session', runtime: 'sandbox', repository_id: 'repo1', size: 'small',
  });
  expect(trackEvent).toHaveBeenCalledWith('session_message_sent', {
    queued: true, plan_mode: true, model_id: 'model1', attachments_count: 0,
  });
  expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain('private prompt');
});

it('captures a failed session creation', async () => {
  api.workbenches.create.mockRejectedValue(new Error('private path'));
  const { result } = renderHook(() => useCreateWorkbench());
  await act(async () => { await result.current.create(spec); });
  expect(captureAnalyticsException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ operation: 'create_session' }));
  expect((vi.mocked(captureAnalyticsException).mock.calls[0][0] as Error).message).toBe('Workbench operation failed: create_session');
  expect(JSON.stringify(vi.mocked(captureAnalyticsException).mock.calls)).not.toContain('private path');
});

it('tracks terminal and pull request overlay openings', () => {
  useWorkbenchStore.setState({ selectedWorkbenchId: 'wb1' });
  useWorkbenchStore.getState().setTerminalOpen(true);
  useWorkbenchStore.getState().setTerminalOpen(true);
  useWorkbenchStore.getState().openPrDetail('pr1');
  expect(trackEvent).toHaveBeenCalledWith('session_terminal_opened', { workbench_id: 'wb1' });
  expect(trackEvent).toHaveBeenCalledWith('session_pr_overlay_opened', { workbench_id: 'wb1' });
  expect(vi.mocked(trackEvent).mock.calls.filter(([name]) => name === 'session_terminal_opened')).toHaveLength(1);
});

it('tracks a started setup script', async () => {
  api.workbenches.runScript.mockResolvedValue(undefined);
  await sandboxOps(workbench).runScript('setup');
  expect(trackEvent).toHaveBeenCalledWith('session_script_run', { workbench_id: 'wb1', script_kind: 'setup' });
});
