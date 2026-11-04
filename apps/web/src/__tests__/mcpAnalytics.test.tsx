import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMcpServers } from '../components/panels/mcpServers/useMcpServers';
import { trackEvent, captureAnalyticsException } from '../lib/analytics';

const { mockList, mockTest } = vi.hoisted(() => ({ mockList: vi.fn(), mockTest: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { mcpServers: { list: mockList, test: mockTest } } }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../stores/workspace', () => ({ useWorkspaceStore: (pick: (state: { currentWorkspaceId: string }) => unknown) => pick({ currentWorkspaceId: 'ws1' }) }));
vi.mock('../hooks/useOnReconnect', () => ({ useOnReconnect: () => undefined }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('records a failed MCP probe with a status code', async () => {
  mockList.mockResolvedValue([]);
  mockTest.mockResolvedValue({ ok: false, at: '', status: 401 });
  const { result } = renderHook(() => useMcpServers());
  await act(async () => { await result.current.test('srv1'); });
  expect(trackEvent).toHaveBeenCalledWith('mcp_server_test_result', { ok: false, error_code: 401, failure_reason: 'auth' });
});

it('captures a failed MCP probe request', async () => {
  mockList.mockResolvedValue([]);
  mockTest.mockRejectedValue(new Error('connection failed'));
  const { result } = renderHook(() => useMcpServers());
  await act(async () => { await expect(result.current.test('srv1')).rejects.toThrow('connection failed'); });
  expect(trackEvent).toHaveBeenCalledWith('mcp_server_test_result', { ok: false, error_code: 'request_failed', failure_reason: 'request_failed' });
  expect(captureAnalyticsException).toHaveBeenCalledWith(expect.any(Error), { flow: 'mcp_server_test' });
});
