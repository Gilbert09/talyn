import { act, renderHook } from '@testing-library/react';
import type { PRRow } from '../renderer/lib/api';

/**
 * `usePullRequestSync` buffers `pull_request:updated` echoes and applies them
 * in one store write per window. The backend sends one message per queued PR
 * on every enqueue or merge, so a write per message re-rendered the app once
 * per PR in the queue.
 */

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Handler>();
const list = jest.fn();

jest.mock('../renderer/lib/api', () => ({
  api: {
    ws: {
      on: (event: string, handler: Handler) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    },
    pullRequests: { list: (...a: unknown[]) => list(...a) },
    posthog: { getStatus: () => Promise.resolve({ connected: false }) },
    repositories: { forcePoll: jest.fn() },
  },
}));
jest.mock('../renderer/hooks/useOnReconnect', () => ({ useOnReconnect: jest.fn() }));

import { usePullRequestSync, PR_UPDATE_FLUSH_MS } from '../renderer/hooks/usePullRequestSync';
import { usePullRequestStore } from '../renderer/stores/pullRequests';
import { useWorkspaceStore } from '../renderer/stores/workspace';

function makeRow(id: string): PRRow {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'acme',
    repo: 'app',
    number: 1,
    state: 'open',
    reviewRequested: false,
    authored: true,
    watching: false,
    mergedAt: null,
    lastPolledAt: '2026-06-05T00:00:00Z',
    summary: { title: `PR ${id}` } as PRRow['summary'],
    autoKeepMergeable: false,
    autoMergeState: null,
    mergeQueued: false,
    mergeMethod: 'squash',
    mergeQueue: null,
    createdAt: '2026-06-05T00:00:00Z',
    updatedAt: '2026-06-05T00:00:00Z',
  };
}

const held = [makeRow('p1'), makeRow('p2')];

function emit(payload: Record<string, unknown>) {
  handlers.get('pull_request:updated')!({ taskId: null, state: 'open', ...payload });
}

describe('usePullRequestSync — batched pull_request:updated', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    handlers.clear();
    list.mockReset();
    // The initial fetch returns the rows the echoes then patch.
    list.mockResolvedValue(held);
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1', justOnboarded: false });
    usePullRequestStore.setState({ rows: [] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function mount() {
    const hook = renderHook(() => usePullRequestSync());
    await act(async () => {
      await Promise.resolve();
    });
    list.mockClear();
    return hook;
  }

  it('holds echoes until the window ends, then writes once', async () => {
    const { unmount } = await mount();
    const listener = jest.fn();
    const unsubscribe = usePullRequestStore.subscribe(listener);

    act(() => {
      emit({ id: 'p1', mergeQueued: true, mergeQueue: { status: 'queued', position: 1 } });
      emit({ id: 'p2', mergeQueued: true, mergeQueue: { status: 'queued', position: 2 } });
      emit({ id: 'p1', mergeQueue: { status: 'merging', position: 1 } });
    });
    expect(listener).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(PR_UPDATE_FLUSH_MS);
    });
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
    const [p1, p2] = usePullRequestStore.getState().rows;
    // The second echo for p1 landed on top of the first, not instead of it.
    expect(p1.mergeQueued).toBe(true);
    expect(p1.mergeQueue).toEqual({ status: 'merging', position: 1 });
    expect(p2.mergeQueue).toEqual({ status: 'queued', position: 2 });
    // No summary on these echoes: the held one stays.
    expect(p1.summary).toBe(held[0].summary);
    unmount();
  });

  it('refetches once per window, however many unknown open PRs it held', async () => {
    const { unmount } = await mount();
    act(() => {
      emit({ id: 'new1' });
      emit({ id: 'new2' });
      emit({ id: 'new3' });
      jest.advanceTimersByTime(PR_UPDATE_FLUSH_MS);
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ workspaceId: 'ws1', state: 'open' });
    unmount();
  });

  it('drops a pending batch on unmount instead of applying it later', async () => {
    const { unmount } = await mount();
    const before = usePullRequestStore.getState().rows;
    act(() => {
      emit({ id: 'p1', mergeQueued: true });
    });
    unmount();
    act(() => {
      jest.advanceTimersByTime(PR_UPDATE_FLUSH_MS * 2);
    });
    expect(usePullRequestStore.getState().rows).toBe(before);
  });
});
