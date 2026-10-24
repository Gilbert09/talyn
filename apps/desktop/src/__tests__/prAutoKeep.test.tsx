/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PRRow } from '../renderer/lib/api';
import { usePrAutoKeep } from '../renderer/components/widgets/PRDetailSheet';

const getStatus = jest.fn();
const setAutoKeepMergeable = jest.fn();
const patchRow = jest.fn();
const toastError = jest.fn();

jest.mock('../renderer/lib/api', () => ({
  api: {
    posthog: { getStatus: (...a: unknown[]) => getStatus(...a) },
    pullRequests: { setAutoKeepMergeable: (...a: unknown[]) => setAutoKeepMergeable(...a) },
    ws: { on: jest.fn(() => () => {}) },
  },
}));
jest.mock('../renderer/lib/prSummaryCache', () => ({ prime: jest.fn() }));
jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: (...a: unknown[]) => toastError(...a), info: jest.fn() },
}));
jest.mock('../renderer/stores/pullRequests', () => ({
  usePullRequestStore: Object.assign((sel: (s: unknown) => unknown) => sel({ rows: [] }), {
    getState: () => ({ patchRow: (...a: unknown[]) => patchRow(...a) }),
  }),
}));
jest.mock('../renderer/components/panels/github/useGitHubActions', () => ({ useGitHubActions: () => ({}) }));

const ROW = { id: 'pr1', workspaceId: 'ws1' } as Pick<PRRow, 'id' | 'workspaceId'>;

afterEach(() => jest.clearAllMocks());

describe('usePrAutoKeep', () => {
  it.each([
    ['connected', { connected: true }, true],
    ['not connected', { connected: false }, false],
  ])('offers the toggle only when PostHog Code is %s', async (_name, status, expected) => {
    getStatus.mockResolvedValue(status);
    const { result } = renderHook(() => usePrAutoKeep(ROW));
    await waitFor(() => expect(getStatus).toHaveBeenCalledWith('ws1'));
    await waitFor(() => expect(result.current.posthogConnected).toBe(expected));
  });

  it('a failed status read reads as not connected', async () => {
    getStatus.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => usePrAutoKeep(ROW));
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(result.current.posthogConnected).toBe(false);
  });

  it('asks nothing and does nothing without a row', async () => {
    const { result } = renderHook(() => usePrAutoKeep(null));
    await act(async () => {
      await result.current.toggle(true);
    });
    expect(getStatus).not.toHaveBeenCalled();
    expect(setAutoKeepMergeable).not.toHaveBeenCalled();
  });

  it.each([
    [true, { autoKeepMergeable: true, autoMergeState: { attempts: 0, paused: false } }],
    [false, { autoKeepMergeable: false, autoMergeState: null }],
  ])('turning it %s patches the store row at once, then calls the API', async (enabled, patch) => {
    getStatus.mockResolvedValue({ connected: true });
    setAutoKeepMergeable.mockResolvedValue(undefined);
    const { result } = renderHook(() => usePrAutoKeep(ROW));
    await act(async () => {
      await result.current.toggle(enabled);
    });
    expect(patchRow).toHaveBeenCalledTimes(1);
    expect(patchRow).toHaveBeenCalledWith('pr1', patch);
    expect(setAutoKeepMergeable).toHaveBeenCalledWith('pr1', enabled);
    expect(result.current.toggling).toBe(false);
  });

  it('rolls back and toasts when the API refuses', async () => {
    getStatus.mockResolvedValue({ connected: true });
    setAutoKeepMergeable.mockRejectedValue(new Error('Nope'));
    const { result } = renderHook(() => usePrAutoKeep(ROW));
    await act(async () => {
      await result.current.toggle(true);
    });
    expect(patchRow).toHaveBeenLastCalledWith('pr1', { autoKeepMergeable: false });
    expect(toastError).toHaveBeenCalledWith('Could not change auto-keep', 'Nope');
  });

  it('a caller with its own row copy gets the patches and the error instead', async () => {
    getStatus.mockResolvedValue({ connected: true });
    setAutoKeepMergeable.mockRejectedValue('weird');
    const onPatch = jest.fn();
    const onError = jest.fn();
    const { result } = renderHook(() => usePrAutoKeep(ROW, { onPatch, onError }));
    await act(async () => {
      await result.current.toggle(true);
    });
    expect(onPatch.mock.calls).toEqual([
      ['pr1', { autoKeepMergeable: true, autoMergeState: { attempts: 0, paused: false } }],
      ['pr1', { autoKeepMergeable: false }],
    ]);
    expect(onError).toHaveBeenCalledWith('Could not update auto-keep-mergeable');
    expect(patchRow).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
