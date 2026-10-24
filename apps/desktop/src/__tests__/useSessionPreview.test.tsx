import { act, renderHook, waitFor } from '@testing-library/react';
import { workbenchesOffered, type Features, type Workbench } from '@talyn/shared';
import { useSessionPreview } from '../renderer/hooks/useSessionPreview';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { toast } from '../renderer/stores/toast';
import { archiveWorkbench } from '../renderer/components/workbench/archiveWorkbench';

const get = jest.fn();
const getToken = jest.fn();
const start = jest.fn();
const stop = jest.fn();
const open = jest.fn();
const archive = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { repositories: { preview: { get: (...args: unknown[]) => get(...args) } }, workbenches: { archive: (...args: unknown[]) => archive(...args) } },
  API_BASE_URL: 'https://api.example.com',
  getAccessToken: () => getToken(),
}));
jest.mock('../renderer/lib/workbenchBridge', () => ({
  getWorkbenchBridge: () => ({ preview: { start: (...args: unknown[]) => start(...args), stop: (...args: unknown[]) => stop(...args) } }),
}));
jest.mock('../renderer/lib/openExternal', () => ({ openExternal: (...args: unknown[]) => open(...args) }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn() } }));

const wb = { id: 'wb1', repositoryId: 'repo1', runtime: 'sandbox', status: 'ready' } as Workbench;
const ops = { runScript: jest.fn(), unavailable: null } as unknown as WorkbenchOps;

beforeEach(() => {
  jest.clearAllMocks();
  get.mockReset().mockResolvedValue({ target: 'sandbox', ports: [{ port: 5173, label: 'App' }] });
  getToken.mockReset().mockResolvedValue('current-token');
  start.mockReset().mockResolvedValue({ localPort: 5174, url: 'http://localhost:5174' });
  stop.mockReset().mockResolvedValue(undefined);
  open.mockReset().mockResolvedValue(undefined);
  (ops.runScript as jest.Mock).mockReset().mockResolvedValue(undefined);
  useWorkspaceStore.setState({ features: { workbenches: true } as Features });
  useWorkbenchStore.setState({ scriptOutput: {}, workbenches: {} });
});

it.each([undefined, null, {}, { workbenches: false }])('hides previews without an enabled flag: %j', (features) => {
  expect(workbenchesOffered(features)).toBe(false);
  useWorkspaceStore.setState({ features: features as Features | null });
  const { result } = renderHook(() => useSessionPreview(wb));
  expect(result.current.ports).toEqual([]);
  expect(get).not.toHaveBeenCalled();
});

it.each([
  { runtime: 'local' },
  { status: 'archived' },
  { archivedAt: '2026-10-24T00:00:00Z' },
])('does not load previews for an ineligible session: %j', (overrides) => {
  const { result } = renderHook(() => useSessionPreview({ ...wb, ...overrides } as Workbench));
  expect(result.current.ports).toEqual([]);
  expect(get).not.toHaveBeenCalled();
});

it.each(['coder', 'off'])('hides the %s target', async (target) => {
  get.mockResolvedValue({ target, ports: [{ port: 8010 }] });
  const { result } = renderHook(() => useSessionPreview(wb));
  await act(async () => {});
  expect(get).toHaveBeenCalledWith('repo1');
  expect(result.current.ports).toEqual([]);
});

it.each(['sandbox', null])('uses TALYN_PORT when target %s has no ports', async (target) => {
  get.mockResolvedValue({ target, ports: [] });
  const { result } = renderHook(() => useSessionPreview(wb));
  await waitFor(() => expect(result.current.ports).toEqual([{ port: 3000 }]));
});

it('starts the run script before the tunnel, then opens the selected local port', async () => {
  const order: string[] = [];
  (ops.runScript as jest.Mock).mockImplementation(async () => { order.push('run'); });
  start.mockImplementation(async () => { order.push('start'); return { url: 'http://localhost:5174' }; });
  open.mockImplementation(async () => { order.push('open'); });
  const { result } = renderHook(() => useSessionPreview(wb));
  await waitFor(() => expect(result.current.ports).toHaveLength(1));
  await act(() => result.current.openPreview(5173, ops));
  expect(order).toEqual(['run', 'start', 'open']);
  expect(ops.runScript).toHaveBeenCalledWith('run');
  expect(start).toHaveBeenCalledWith({ workbenchId: 'wb1', port: 5173, token: 'current-token', apiBaseUrl: 'https://api.example.com' });
  expect(open).toHaveBeenCalledWith('http://localhost:5174');
});

it('keeps an active run script running', async () => {
  useWorkbenchStore.getState().markScriptStarted('wb1', 'run');
  const { result } = renderHook(() => useSessionPreview(wb));
  await waitFor(() => expect(result.current.ports).toHaveLength(1));
  await act(() => result.current.openPreview(5173, ops));
  expect(ops.runScript).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalledTimes(1);
});

it('reports a run failure without opening a forward', async () => {
  (ops.runScript as jest.Mock).mockRejectedValue(new Error('Run failed'));
  const { result } = renderHook(() => useSessionPreview(wb));
  await waitFor(() => expect(result.current.ports).toHaveLength(1));
  await act(() => result.current.openPreview(5173, ops));
  expect(toast.error).toHaveBeenCalledWith('Could not open the preview', 'Run failed');
  expect(start).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(result.current.busy).toBe(false);
});

it('does not run or open without an access token', async () => {
  getToken.mockResolvedValue(null);
  const { result } = renderHook(() => useSessionPreview(wb));
  await waitFor(() => expect(result.current.ports).toHaveLength(1));
  await act(() => result.current.openPreview(5173, ops));
  expect(ops.runScript).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith('Could not open the preview', 'Sign in to open the preview.');
});

it('hides ports as soon as the flag turns off', async () => {
  const { result } = renderHook(() => useSessionPreview(wb));
  await waitFor(() => expect(result.current.ports).toHaveLength(1));
  act(() => useWorkspaceStore.setState({ features: { workbenches: false } as Features }));
  expect(result.current.ports).toEqual([]);
});

it('ignores a late config response from the previous repository', async () => {
  let finish: (value: unknown) => void = () => {};
  get.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  get.mockResolvedValueOnce({ target: 'sandbox', ports: [{ port: 4000 }] });
  const { result, rerender } = renderHook(({ workbench }) => useSessionPreview(workbench), { initialProps: { workbench: wb } });
  rerender({ workbench: { ...wb, id: 'wb2', repositoryId: 'repo2' } });
  await waitFor(() => expect(result.current.ports).toEqual([{ port: 4000 }]));
  await act(async () => { finish({ target: 'sandbox', ports: [{ port: 5000 }] }); });
  expect(result.current.ports).toEqual([{ port: 4000 }]);
});

it('reports a config error without guessing preview ports', async () => {
  get.mockRejectedValue(new Error('Offline'));
  const { result } = renderHook(() => useSessionPreview(wb));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load the preview config'));
  expect(result.current.ports).toEqual([]);
});

it('stops all forwards for an archived session', async () => {
  archive.mockResolvedValue({ ...wb, status: 'archived' });
  expect(await archiveWorkbench(wb.id, false)).toBe(true);
  expect(stop).toHaveBeenCalledWith(wb.id);
});


it('uses a token refreshed while the run script starts', async () => {
  getToken.mockResolvedValueOnce('old-token').mockResolvedValueOnce('new-token');
  const { result } = renderHook(() => useSessionPreview(wb));
  await waitFor(() => expect(result.current.ports).toHaveLength(1));
  await act(() => result.current.openPreview(5173, ops));
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ token: 'new-token' }));
});

it('does not open a forward if the session is archived while the script starts', async () => {
  (ops.runScript as jest.Mock).mockImplementation(async () => {
    useWorkbenchStore.setState({ workbenches: { [wb.id]: { ...wb, status: 'archived' } } });
  });
  const { result } = renderHook(() => useSessionPreview(wb));
  await waitFor(() => expect(result.current.ports).toHaveLength(1));
  await act(() => result.current.openPreview(5173, ops));
  expect(start).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
