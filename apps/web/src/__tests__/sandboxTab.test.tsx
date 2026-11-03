import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat, WorkbenchSandboxStatus } from '@talyn/shared';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { readLayout } from '../lib/workbenchLayout';
import { useWorkbenchStore } from '../stores/workbenches';
import { GitPanel } from '../components/workbench/GitPanel';
import { SandboxStatusChip } from '../components/workbench/SandboxStatusPanel';
import { buildAppShortcuts } from '../components/layout/appShortcuts';

vi.mock('@pierre/diffs/react', () => ({ PatchDiff: () => <div data-testid="patch-diff" /> }));
const sandboxStatus = vi.fn();
const wake = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    workbenches: {
      sandboxStatus: (...a: unknown[]) => sandboxStatus(...a),
      wake: (...a: unknown[]) => wake(...a),
    },
    pullRequests: {},
  },
}));
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../stores/billing', () => ({ maybeHandleBillingLimit: () => false }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: { features: Record<string, boolean> }) => unknown) => sel({ features: {} }),
}));
vi.mock('../components/panels/github/useGitHubActions', () => ({ useGitHubActions: () => ({ setMergeQueue: vi.fn() }) }));
vi.mock('../components/widgets/PRDetailSheet', () => ({
  PRDetailSheet: () => null,
  ReviewsTab: () => null,
  MergeQueueSection: () => null,
  usePrAutoKeep: () => ({ posthogConnected: true, toggling: false, toggle: vi.fn() }),
}));
vi.mock('../components/workbench/FilesTab', () => ({ FilesTab: () => <div data-testid="files-tab" /> }));
vi.mock('../components/workbench/ChangesTab', () => ({ ChangesTab: () => <div data-testid="changes-tab" /> }));
vi.mock('../components/workbench/terminal/TerminalPanel', () => ({ TerminalPanel: () => <div data-testid="terminal-dock" /> }));

const WB = {
  id: 'wb1',
  runtime: 'sandbox',
  status: 'ready',
  sandboxState: 'running',
  diffStat: null,
  archivedAt: null,
  updatedAt: '2026-11-03T10:00:00Z',
} as unknown as Workbench;
const LOCAL = { ...WB, runtime: 'local' } as Workbench;
const chat = { id: 'c1', workbenchId: 'wb1', status: 'idle' } as WorkbenchChat;

function status(over: Partial<WorkbenchSandboxStatus> = {}): WorkbenchSandboxStatus {
  return {
    workbenchId: 'wb1',
    checkedAt: new Date().toISOString(),
    state: 'running',
    headline: 'The agent is working.',
    detail: null,
    sleepsAt: null,
    since: null,
    replacementStarting: false,
    fleet: { known: true, status: 'running', phase: null, error: null },
    host: 'hetzner-64',
    size: null,
    activity: [],
    work: null,
    problem: null,
    actions: [],
    ...over,
  };
}

const ops = { runtime: 'sandbox', unavailable: null } as unknown as WorkbenchOps;
const renderPanel = (wb: Workbench = WB) => render(<GitPanel workbench={wb} chat={chat} ops={ops} pr={null} />);

beforeEach(() => {
  window.localStorage.clear();
  useWorkbenchStore.setState({ sideTab: 'files', rightPanelWidth: 340, rightPanelOpen: true, drafts: {}, chats: {} });
  sandboxStatus.mockResolvedValue(status());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Sandbox tab', () => {
  it('sits after Pull request for a sandbox session', () => {
    renderPanel();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['All files', 'Changes', 'Pull request', 'Sandbox']);
  });

  it('is absent for a local session, and a stored Sandbox tab falls back to Changes', () => {
    useWorkbenchStore.setState({ sideTab: 'sandbox' });
    renderPanel(LOCAL);
    expect(screen.queryByRole('tab', { name: 'Sandbox' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true');
    expect(sandboxStatus).not.toHaveBeenCalled();
  });

  it('renders the full status as a page and remembers the tab', async () => {
    sandboxStatus.mockResolvedValue(
      status({
        host: 'hetzner-64',
        activity: [{ kind: 'turn', text: 'The agent is working', since: null }],
        problem: { text: 'The box was lost on its host.', at: null },
        work: {
          savedAt: null, savedBytes: null, checkedAt: null, unpushedCommits: null, uncommitted: null, committed: null,
          branchPushed: null, failures: 0, lastFailureAt: null, lastFailure: null,
          warning: 'The work is not saved.', warningLevel: 'warn',
        },
      })
    );
    renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: /Sandbox/ }));
    expect(readLayout().gitPanelTab).toBe('sandbox');
    expect(await screen.findByTestId('sandbox-headline')).toHaveTextContent('The agent is working.');
    expect(screen.getByTestId('sandbox-tab')).toBeInTheDocument();
    expect(screen.getByText('hetzner-64')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-activity')).toBeInTheDocument();
    expect(screen.getByTestId('sandbox-work-warning')).toHaveTextContent('The work is not saved.');
    expect(screen.getByTestId('sandbox-problem')).toBeInTheDocument();
  });

  it.each<[string, Partial<WorkbenchSandboxStatus>, 'warn' | 'danger' | null]>([
    ['healthy', {}, null],
    ['an amber work warning', { work: { warning: 'Old', warningLevel: 'warn' } as WorkbenchSandboxStatus['work'] }, 'warn'],
    ['a red work warning', { work: { warning: 'At risk', warningLevel: 'danger' } as WorkbenchSandboxStatus['work'] }, 'danger'],
    ['a lost box', { state: 'lost' }, 'warn'],
    ['a failed box', { state: 'failed' }, 'danger'],
  ])('the tab label dot for %s', async (_name, over, level) => {
    sandboxStatus.mockResolvedValue(status(over));
    renderPanel();
    await waitFor(() => expect(sandboxStatus).toHaveBeenCalled());
    if (level) expect(await screen.findByTestId('sandbox-tab-dot')).toHaveAttribute('data-level', level);
    else {
      await act(async () => {});
      expect(screen.queryByTestId('sandbox-tab-dot')).not.toBeInTheDocument();
    }
  });

  it('runs an action from the tab', async () => {
    wake.mockResolvedValue({ status: 'resuming' });
    sandboxStatus.mockResolvedValue(status({ state: 'asleep', actions: [{ kind: 'wake', label: 'Wake', confirm: null }] }));
    useWorkbenchStore.setState({ sideTab: 'sandbox' });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Wake' }));
    await waitFor(() => expect(wake).toHaveBeenCalledWith('wb1'));
    await waitFor(() => expect(sandboxStatus.mock.calls.length).toBeGreaterThan(1));
  });

  it('polls every 10 s while the tab is visible, and not while it is hidden', async () => {
    vi.useFakeTimers();
    useWorkbenchStore.setState({ sideTab: 'sandbox' });
    renderPanel();
    await act(async () => {});
    const afterOpen = sandboxStatus.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(sandboxStatus.mock.calls.length).toBe(afterOpen + 1);
    act(() => useWorkbenchStore.setState({ sideTab: 'changes' }));
    await act(async () => {});
    const hidden = sandboxStatus.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(sandboxStatus.mock.calls.length).toBe(hidden);
  });

  it('the chip opens the tab', async () => {
    useWorkbenchStore.setState({ sideTab: 'files', rightPanelOpen: false });
    render(<SandboxStatusChip workbench={WB} chat={chat} />);
    fireEvent.click(screen.getByRole('button', { name: /Sandbox|Idle|Running/ }));
    expect(useWorkbenchStore.getState().sideTab).toBe('sandbox');
    expect(useWorkbenchStore.getState().rightPanelOpen).toBe(true);
  });

  it('the command palette entry opens the tab for a sandbox session only', () => {
    const entry = buildAppShortcuts().find((s) => s.id === 'workbench.sandbox')!;
    expect(entry.label).toBe('Show Sandbox Status');
    expect(entry.group).toBe('Session');
    expect(entry.hidden).toBeFalsy();
  });
});
