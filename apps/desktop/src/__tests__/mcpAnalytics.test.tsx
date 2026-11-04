import { act, cleanup, renderHook } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useMcpServers } from '../renderer/components/panels/mcpServers/useMcpServers';
import { trackEvent, captureAnalyticsException } from '../renderer/lib/analytics';

const mockList = jest.fn();
const mockTest = jest.fn();
jest.mock('../renderer/lib/api', () => ({ api: { mcpServers: { list: (...args: unknown[]) => mockList(...args), test: (...args: unknown[]) => mockTest(...args) } } }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/stores/workspace', () => ({ useWorkspaceStore: (pick: (state: { currentWorkspaceId: string }) => unknown) => pick({ currentWorkspaceId: 'ws1' }) }));
jest.mock('../renderer/hooks/useOnReconnect', () => ({ useOnReconnect: () => undefined }));

afterEach(() => { cleanup(); jest.clearAllMocks(); });

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
