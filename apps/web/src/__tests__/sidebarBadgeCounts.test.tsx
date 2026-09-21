import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { LoopWithStats } from '@talyn/shared';
import { useLoops } from '../components/panels/loops/useLoops';

/**
 * The sidebar's Loops badge.
 *
 * `useSystemStatus` seeds the count once per workspace with an indexed
 * `count(*)`. That is right for a cold boot and stale from the first edit
 * afterwards, because nothing re-seeded it: creating a second loop left the
 * badge reading 1 until the app restarted. The list this panel already holds
 * is the fresher truth, so it writes the count through.
 *
 * Duplicated in apps/desktop on purpose: the renderer is a deliberate fork.
 */

type Store = {
  currentWorkspaceId: string | null;
  workspaces: unknown[];
  cloudProviders: unknown[];
  setEnabledLoopCount: (n: number | null) => void;
};
// On globalThis: both runners hoist their `mock` calls above every import, so
// a plain const is still in its dead zone when a factory first runs.
const seen = (): number[] =>
  ((globalThis as unknown as { __talynLoopCounts?: number[] }).__talynLoopCounts ??= []);

let listed: LoopWithStats[] = [];

vi.mock('../lib/api', () => ({
  api: {
    loops: {
      list: vi.fn(async () => listed),
      create: vi.fn(async () => loop('l2', true)),
      update: vi.fn(async (id: string, input: { enabled: boolean }) => loop(id, input.enabled)),
    },
    ws: { on: vi.fn(() => () => {}) },
  },
}));
vi.mock('../hooks/useOnReconnect', () => ({ useOnReconnect: vi.fn() }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: Store) => unknown) =>
    sel({
      currentWorkspaceId: 'ws1',
      workspaces: [],
      cloudProviders: [],
      setEnabledLoopCount: (n: number | null) => {
        if (n !== null) seen().push(n);
      },
    }),
}));

function loop(id: string, enabled: boolean): LoopWithStats {
  return {
    id,
    workspaceId: 'ws1',
    name: id,
    enabled,
    prompt: 'do the thing',
    repositoryId: 'r1',
  } as unknown as LoopWithStats;
}

const latest = () => seen()[seen().length - 1];

beforeEach(() => {
  seen().length = 0;
  listed = [loop('l1', true)];
});
afterEach(() => vi.clearAllMocks());

describe('the Loops sidebar badge', () => {
  it('counts the enabled loops once the list lands', async () => {
    renderHook(() => useLoops());
    await waitFor(() => expect(latest()).toBe(1));
  });

  it('moves the moment a second loop is created', async () => {
    const { result } = renderHook(() => useLoops());
    await waitFor(() => expect(latest()).toBe(1));
    await act(async () => {
      await result.current.create({ name: 'l2' } as never);
    });
    // The reported bug: this stayed at 1 until a restart.
    await waitFor(() => expect(latest()).toBe(2));
  });

  it('counts only the enabled ones, so a paused loop does not inflate it', async () => {
    listed = [loop('l1', true), loop('l2', false), loop('l3', true)];
    renderHook(() => useLoops());
    await waitFor(() => expect(latest()).toBe(2));
  });

  it('follows a loop being switched off, without waiting on a re-list', async () => {
    listed = [loop('l1', true), loop('l2', true)];
    const { result } = renderHook(() => useLoops());
    await waitFor(() => expect(latest()).toBe(2));
    await act(async () => {
      await result.current.setEnabled(loop('l2', true), false);
    });
    await waitFor(() => expect(latest()).toBe(1));
  });

  // `null` is still loading. Writing 0 there would blank a badge that is about
  // to come back, which reads as "you have no loops" rather than "one moment".
  it('never reports a count while the list is still loading', async () => {
    renderHook(() => useLoops());
    await waitFor(() => expect(seen().length).toBeGreaterThan(0));
    expect(seen()).not.toContain(0);
  });

  it('reports zero once the list genuinely comes back empty', async () => {
    listed = [];
    renderHook(() => useLoops());
    await waitFor(() => expect(latest()).toBe(0));
  });
});
