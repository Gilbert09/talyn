import { cleanup } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import type { Features, SpacesTeam, Workbench } from '@talyn/shared';
import { useWorkbenchOps, useWorkspaceWorkbenches } from '../components/workbench/workbenchSelectors';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';
import { useSpacesStore } from '../stores/spaces';

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));

const base = {
  id: 'wb1',
  workspaceId: 'ws1',
  repositoryId: 'r1',
  repoFullName: 'acme/app',
  name: 'lisbon',
  branch: 'lisbon',
  baseBranch: 'main',
  runtime: 'sandbox',
  agent: 'claude',
  deviceId: null,
  localPath: null,
  sandboxId: null,
  sandboxState: 'running',
  status: 'ready',
  pullRequestId: null,
  settings: {} as Workbench['settings'],
  diffStat: null,
  archivedAt: null,
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
} as unknown as Workbench;

describe('useWorkbenchOps', () => {
  it('keeps the same ops when only object identities change', () => {
    const { result, rerender } = renderHook(({ w }) => useWorkbenchOps(w), {
      initialProps: { w: base },
    });
    const first = result.current;
    rerender({
      w: { ...base, settings: {} as Workbench['settings'], updatedAt: 'later' },
    });
    expect(result.current).toBe(first);
  });

  it('rebuilds when the status changes', () => {
    const { result, rerender } = renderHook(({ w }) => useWorkbenchOps(w), {
      initialProps: { w: base },
    });
    rerender({ w: { ...base, status: 'error', error: 'boom' } as Workbench });
    expect(result.current.unavailable).toBe('boom');
  });
});

describe('useWorkspaceWorkbenches', () => {
  const personal = { ...base, id: 'personal', spaceId: null } as Workbench;
  const inSpace = { ...base, id: 'in-space', spaceId: 's1' } as Workbench;
  const archivedInSpace = { ...base, id: 'archived-in-space', spaceId: 's1', archivedAt: '2026-11-01T00:00:00Z' } as Workbench;
  const goneSpace = { ...base, id: 'gone-space', spaceId: 's-gone' } as Workbench;
  const extra = { ...base, id: 'extra', workspaceId: 'ws-ana', spaceId: 's1' } as Workbench;
  const teams = [{ id: 't1', name: 'T', role: 'member', homeWorkspaceId: 'ws1', createdAt: '', spaces: [{ id: 's1', teamId: 't1' }] }] as unknown as SpacesTeam[];

  function setup(spaces: boolean, teamList: SpacesTeam[] | null) {
    useWorkbenchStore.setState({
      workspaceId: 'ws1',
      workbenches: Object.fromEntries([personal, inSpace, archivedInSpace, goneSpace, extra].map((w) => [w.id, w])),
      extraWorkbenchIds: { extra: true },
    });
    useWorkspaceStore.setState({ features: { spaces } as Features });
    useSpacesStore.setState({ teams: teamList });
  }

  const ids = (list: Workbench[]) => list.map((w) => w.id).sort();

  it('leaves sessions of my spaces out of the Personal lists', () => {
    setup(true, teams);
    const { result } = renderHook(() => useWorkspaceWorkbenches());
    expect(ids(result.current)).toEqual(['gone-space', 'personal']);
  });

  it('keeps space sessions for History', () => {
    setup(true, teams);
    const { result } = renderHook(() => useWorkspaceWorkbenches({ withSpaceSessions: true }));
    expect(ids(result.current)).toEqual(['archived-in-space', 'gone-space', 'in-space', 'personal']);
  });

  it('keeps every session when Spaces is off', () => {
    setup(false, null);
    const { result } = renderHook(() => useWorkspaceWorkbenches());
    expect(ids(result.current)).toEqual(['archived-in-space', 'gone-space', 'in-space', 'personal']);
  });

  it('shows a space session again once my teams load without its space', () => {
    setup(true, null);
    const { result } = renderHook(() => useWorkspaceWorkbenches());
    expect(ids(result.current)).toEqual(['personal']);
    act(() => useSpacesStore.setState({ teams: [] }));
    expect(ids(result.current)).toEqual(['archived-in-space', 'gone-space', 'in-space', 'personal']);
  });
});

afterEach(cleanup);
