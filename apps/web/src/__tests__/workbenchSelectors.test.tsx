import { cleanup } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
/**
 * @jest-environment jsdom
 */
import { renderHook } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { useWorkbenchOps } from '../components/workbench/workbenchSelectors';

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

afterEach(cleanup);
