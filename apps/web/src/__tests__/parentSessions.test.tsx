import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { ParentSessions } from '../components/workbench/ParentSessions';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';
import { useNavigationStore } from '../stores/navigation';

const mockList = vi.fn();
vi.mock('../lib/api', () => ({ api: { workbenches: {
  threadSessions: (...args: unknown[]) => mockList(...args), get: async () => ({ id: 'parent', name: 'Parent work' }),
} } }));
vi.mock('../components/workbench/WorkPanel', () => ({
  SessionRow: ({ session }: { session: Workbench }) => <li>{session.name}: {session.status}</li>,
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('parent sessions', () => {
  it.each([false, true])('gates the parent chip and child list with flag %s', async (enabled) => {
    const child = { id: 'child', parentId: 'current', name: 'Child work', status: 'ready', createdAt: '2026-11-19' } as Workbench;
    mockList.mockResolvedValue([child]);
    const navigate = vi.fn();
    useNavigationStore.setState({ navigate });
    useWorkbenchStore.setState({ workbenches: { child } });
    useWorkspaceStore.setState({ features: { sessionSubagents: enabled } as never });
    render(<ParentSessions workbench={{ id: 'current', parentId: 'parent' } as Workbench} />);
    if (!enabled) {
      expect(screen.queryByText(/Started by/)).toBeNull();
      expect(screen.queryByText(/session/)).toBeNull();
      expect(mockList).not.toHaveBeenCalled();
      return;
    }
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('current'));
    expect(screen.queryByText('Child work: ready')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show the 1 session this session started' }));
    expect(await screen.findByText('Sessions started (1)')).toBeInTheDocument();
    expect(screen.getByText('Child work: ready')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Open the parent session Parent work' }));
    expect(navigate).toHaveBeenCalledWith({ view: 'workbench', id: 'parent' });
  });
});
