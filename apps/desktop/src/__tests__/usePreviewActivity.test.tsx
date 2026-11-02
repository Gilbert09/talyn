/** @jest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import type { RepositoryPreviewResponse, Workbench } from '@talyn/shared';
import { usePreviewActivity } from '../renderer/hooks/usePreviewActivity';
import { useCoderPreviewStatusStore } from '../renderer/stores/coderPreviewStatus';
import { usePreviewStatusStore } from '../renderer/stores/previewStatus';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

jest.mock('../renderer/lib/coderPreview', () => ({ refreshCoderPreview: jest.fn().mockResolvedValue(null) }));

const workbench = { id: 'activity', runtime: 'sandbox' } as Workbench;
const sandbox = { target: 'sandbox', ports: [{ port: 3000 }] } as RepositoryPreviewResponse;
const coder = { ...sandbox, target: 'coder', ports: [], coder: { workspace: 'devbox-tom-eu' } } as RepositoryPreviewResponse;

beforeEach(() => {
  usePreviewStatusStore.setState({ ports: {}, runStarting: {} });
  useCoderPreviewStatusStore.setState({ sessions: {} });
  useWorkbenchStore.setState({ scriptOutput: {} });
});
afterEach(cleanup);

it.each([
  ['starting', 'starting', 'Starting preview :3000'],
  ['live', 'running', 'Running on preview :3000'],
] as const)('maps a %s sandbox port', (portState, status, label) => {
  usePreviewStatusStore.getState().set(workbench.id, 3000, portState);
  const { result } = renderHook(() => usePreviewActivity(workbench, sandbox));
  expect(result.current).toMatchObject({ status, label });
});

it('shows the run script while its start request is pending', () => {
  usePreviewStatusStore.getState().setRunStarting(workbench.id, true);
  const { result } = renderHook(() => usePreviewActivity(workbench, sandbox));
  expect(result.current).toMatchObject({ status: 'starting', label: 'Starting preview :3000' });
});

it.each([
  [true, null, 'running', 'Run script is running'],
  [false, 2, 'failed', 'Run script exited with code 2'],
  [false, null, 'idle', 'Preview is idle'],
] as const)('maps run script state %s and exit %s', (running, exitCode, status, label) => {
  useWorkbenchStore.setState({ scriptOutput: { activity: { run: { chunks: [], total: 0, running, exitCode } } } });
  const { result } = renderHook(() => usePreviewActivity(workbench, null));
  expect(result.current).toMatchObject({ status, label });
});

it.each([
  ['workspace', 'Starting devbox-tom-eu'],
  ['worktree', 'Preparing worktree'],
  ['sync', 'Syncing'],
  ['run', 'Starting app'],
] as const)('maps Coder step %s outside the panel', (step, label) => {
  useCoderPreviewStatusStore.getState().update(workbench.id, { busy: true, step });
  const { result } = renderHook(() => usePreviewActivity(workbench, coder));
  expect(result.current).toMatchObject({ status: 'starting', label });
});

it('maps running, failed, and idle Coder states', () => {
  const { result } = renderHook(() => usePreviewActivity(workbench, coder));
  expect(result.current.status).toBe('idle');
  act(() => useCoderPreviewStatusStore.getState().update(workbench.id, { state: { active: true, running: true } as never }));
  expect(result.current).toMatchObject({ status: 'running', label: 'Running in Coder' });
  act(() => useCoderPreviewStatusStore.getState().update(workbench.id, { state: { active: false, running: false, problem: { message: 'Sign in to Coder' } } as never }));
  expect(result.current).toMatchObject({ status: 'failed', label: 'Sign in to Coder' });
});
