import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { usePreviewActivity } from '../hooks/usePreviewActivity';
import { usePreviewStatusStore } from '../stores/previewStatus';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';

const { previewGet } = vi.hoisted(() => ({ previewGet: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { repositories: { preview: { get: previewGet } } } }));

const workbench = { id: 'activity', repositoryId: 'repo', runtime: 'sandbox', status: 'ready' } as Workbench;

beforeEach(() => {
  previewGet.mockReset().mockResolvedValue({ target: 'sandbox', ports: [{ port: 3000 }] });
  useWorkspaceStore.getState().setFeatures({ workbenches: true, previewLinks: true } as never);
  usePreviewStatusStore.setState({ ports: {}, runStarting: {} });
  useWorkbenchStore.setState({ scriptOutput: {} });
});
afterEach(cleanup);

it.each([
  ['starting', 'starting', 'Starting preview :3000'],
  ['live', 'running', 'Running on preview :3000'],
] as const)('maps a %s hosted port', async (portState, status, label) => {
  const { result } = renderHook(() => usePreviewActivity(workbench));
  await waitFor(() => expect(result.current.ports).toHaveLength(1));
  act(() => usePreviewStatusStore.getState().set(workbench.id, 3000, portState));
  expect(result.current).toMatchObject({ status, label });
});

it('shows the run script while its start request is pending', () => {
  usePreviewStatusStore.getState().setRunStarting(workbench.id, true);
  const { result } = renderHook(() => usePreviewActivity(workbench));
  expect(result.current).toMatchObject({ status: 'starting', label: 'Starting run script' });
});

it.each([
  [true, null, 'running'],
  [false, 3, 'failed'],
  [false, null, 'idle'],
] as const)('maps run state %s and exit %s', (running, exitCode, status) => {
  useWorkbenchStore.setState({ scriptOutput: { activity: { run: { chunks: [], total: 0, running, exitCode } } } });
  const { result } = renderHook(() => usePreviewActivity(workbench));
  expect(result.current.status).toBe(status);
});
