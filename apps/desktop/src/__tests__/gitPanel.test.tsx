/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChanges, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { GIT_PANEL_MAX_WIDTH, GIT_PANEL_MIN_WIDTH, readLayout } from '../renderer/lib/workbenchLayout';
import { VIEWED_STORAGE_PREFIX, loadViewed } from '../renderer/lib/viewedFiles';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { GitPanel } from '../renderer/components/workbench/GitPanel';
import { WorkbenchChecks } from '../renderer/components/workbench/WorkbenchChecks';
import { ChangesTab } from '../renderer/components/workbench/ChangesTab';

const getPr = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: { pullRequests: { get: (...a: unknown[]) => getPr(...a) } },
}));
jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/stores/toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('../renderer/components/widgets/PRDetailSheet', () => ({
  PRDetailSheet: () => null,
  ReviewsTab: () => <div>reviews</div>,
}));
jest.mock('../renderer/components/workbench/FilesTab', () => ({
  FilesTab: ({ visible }: { visible: boolean }) => <div data-testid="files-tab" data-visible={String(visible)} />,
}));
jest.mock('../renderer/components/workbench/terminal/TerminalPanel', () => ({
  TerminalPanel: () => <div data-testid="terminal-dock" />,
}));

const WB: Workbench = {
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
  sandboxId: 'sb1',
  sandboxState: 'running',
  status: 'ready',
  pullRequestId: 'pr1',
  settings: {},
  diffStat: { added: 4, removed: 1, files: 2 },
  archivedAt: null,
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
};

const chat = { id: 'c1', workbenchId: 'wb1', status: 'idle' } as WorkbenchChat;

const PR = {
  id: 'pr1',
  number: 42,
  state: 'open',
  summary: { title: 'Add a thing', url: 'https://github.com/acme/app/pull/42', draft: false, checks: { total: 3 } },
} as unknown as PRRow;

function changes(files: Array<[string, number]>): WorkbenchChanges {
  return {
    base: 'b',
    headSha: 'h',
    files: files.map(([path, added]) => ({ path, status: 'modified', added, removed: 0, binary: false })),
  };
}

function makeOps(over: Partial<WorkbenchOps> = {}): WorkbenchOps {
  return {
    runtime: 'sandbox',
    unavailable: null,
    changes: jest.fn(async () => changes([['a.ts', 1], ['b.ts', 2]])),
    diff: jest.fn(async (path?: string) => `patch of ${path}`),
    ...over,
  } as unknown as WorkbenchOps;
}

beforeEach(() => {
  window.localStorage.clear();
  useWorkbenchStore.setState({
    sideTab: 'files',
    rightPanelWidth: 340,
    rightPanelOpen: true,
    drafts: {},
    chats: {},
  });
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('GitPanel', () => {
  it('labels its tabs All files, Changes, Checks', () => {
    render(<GitPanel workbench={WB} chat={chat} ops={makeOps()} pr={null} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['All files', 'Changes2', 'Checks']);
  });

  it('a tab click is remembered across restarts', () => {
    render(<GitPanel workbench={WB} chat={chat} ops={makeOps()} pr={null} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Checks' }));
    expect(useWorkbenchStore.getState().sideTab).toBe('checks');
    expect(readLayout().gitPanelTab).toBe('checks');
    expect(screen.getByRole('tab', { name: 'Checks' })).toHaveAttribute('aria-selected', 'true');
    // A visited tab stays mounted, hidden, so its state survives.
    expect(screen.getByTestId('files-tab')).toHaveAttribute('data-visible', 'false');
  });

  it.each([
    ['wider by dragging left', 1000, 900, 440],
    ['narrower by dragging right', 1000, 1050, 290],
    ['never under the minimum', 1000, 1400, GIT_PANEL_MIN_WIDTH],
    ['never over the maximum', 1000, 0, GIT_PANEL_MAX_WIDTH],
  ])('resizes %s, and remembers the width', (_name, from, to, expected) => {
    render(<GitPanel workbench={WB} chat={chat} ops={makeOps()} pr={null} />);
    const handle = screen.getByRole('separator', { name: 'Resize the right panel' });
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: from }));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: to }));
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(useWorkbenchStore.getState().rightPanelWidth).toBe(expected);
    expect(readLayout().gitPanelWidth).toBe(expected);
    expect(screen.getByTestId('git-panel')).toHaveStyle({ width: `${expected}px` });
  });

  it('the keyboard resizes the panel too', () => {
    render(<GitPanel workbench={WB} chat={chat} ops={makeOps()} pr={null} />);
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize the right panel' }), { key: 'ArrowLeft' });
    expect(useWorkbenchStore.getState().rightPanelWidth).toBe(356);
  });

  it('docks the terminal under the tabs', () => {
    render(<GitPanel workbench={WB} chat={chat} ops={makeOps()} pr={null} />);
    expect(screen.getByTestId('terminal-dock')).toBeInTheDocument();
  });
});

describe('Checks tab', () => {
  const fresh = {
    checkContexts: [
      { name: 'unit', state: 'success', required: true, url: 'https://ci/unit' },
      { name: 'docs', state: 'failure', required: false, url: 'https://ci/docs' },
      { name: 'lint', state: 'failure', required: true, url: 'https://ci/lint' },
      { name: 'e2e', state: 'in_progress', required: null, url: null },
    ],
  };

  it('shows the PR pill and the checks failing first, required before optional', async () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    render(<WorkbenchChecks workbench={WB} chat={chat} pr={PR} visible turnsEnded={0} />);
    await waitFor(() => expect(screen.getAllByTestId('check-line')).toHaveLength(4));
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByTitle('Open on GitHub')).toHaveAttribute('href', 'https://github.com/acme/app/pull/42');
    expect(screen.getAllByTestId('check-line').map((l) => l.textContent)).toEqual([
      'lintrequired',
      'docsoptional',
      'e2e',
      'unitrequired',
    ]);
    expect(screen.getByTestId('checks-tally')).toHaveTextContent('2 failing (1 required) · 1 running · 1 passed');
  });

  it('"Add to chat" puts one line with the link into the open chat draft', async () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    useWorkbenchStore.setState({ drafts: { c1: 'Please fix' } });
    render(<WorkbenchChecks workbench={WB} chat={chat} pr={PR} visible turnsEnded={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add lint to chat' }));
    expect(useWorkbenchStore.getState().drafts.c1).toBe(
      'Please fix\n\nThe CI check `lint` (required) is failing on #42: https://ci/lint'
    );
  });

  it('with no chat yet, the line goes to the workbench draft', async () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    render(<WorkbenchChecks workbench={WB} chat={null} pr={PR} visible turnsEnded={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add docs to chat' }));
    expect(useWorkbenchStore.getState().drafts['wb:wb1']).toBe(
      'The CI check `docs` (optional) is failing on #42: https://ci/docs'
    );
  });

  it('re-reads every 30 s while visible and after a turn ends, never while hidden', async () => {
    jest.useFakeTimers();
    try {
      getPr.mockResolvedValue({ row: PR, fresh });
      const { rerender } = render(<WorkbenchChecks workbench={WB} chat={chat} pr={PR} visible turnsEnded={0} />);
      await act(async () => {});
      expect(getPr).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(getPr).toHaveBeenCalledTimes(2);
      rerender(<WorkbenchChecks workbench={WB} chat={chat} pr={PR} visible turnsEnded={1} />);
      await act(async () => {});
      expect(getPr).toHaveBeenCalledTimes(3);
      rerender(<WorkbenchChecks workbench={WB} chat={chat} pr={PR} visible={false} turnsEnded={1} />);
      await act(async () => {
        jest.advanceTimersByTime(90_000);
      });
      expect(getPr).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('without a PR it says how to get one, and reads nothing', () => {
    render(<WorkbenchChecks workbench={WB} chat={chat} pr={null} visible turnsEnded={0} />);
    expect(screen.getByText(/once this branch has a pull request/)).toBeInTheDocument();
    expect(getPr).not.toHaveBeenCalled();
  });
});

describe('Changes tab: Viewed', () => {
  function renderChanges(ops: WorkbenchOps, turnsEnded = 0) {
    return render(
      <ChangesTab
        workbench={WB}
        chat={chat}
        ops={ops}
        visible
        turnsEnded={turnsEnded}
        comments={[]}
        setComments={() => {}}
      />
    );
  }

  it('a Viewed mark is stored per workbench and path, and survives a remount', async () => {
    const ops = makeOps();
    const { unmount } = renderChanges(ops);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Viewed a.ts' }));
    await waitFor(() => expect(loadViewed('wb1')['a.ts']).toBeDefined());
    expect(window.localStorage.getItem(`${VIEWED_STORAGE_PREFIX}wb1`)).toContain('a.ts');
    unmount();
    renderChanges(ops);
    expect(await screen.findByRole('checkbox', { name: 'Viewed a.ts' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Viewed b.ts' })).not.toBeChecked();
    expect(screen.getByTestId('viewed-count')).toHaveTextContent('1/2 viewed');
  });

  it('a file whose line counts change becomes unviewed on the next refresh', async () => {
    let list = changes([['a.ts', 1], ['b.ts', 2]]);
    const ops = makeOps({ changes: jest.fn(async () => list) as unknown as WorkbenchOps['changes'] });
    const { rerender } = renderChanges(ops);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Viewed a.ts' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Viewed a.ts' })).toBeChecked());
    list = changes([['a.ts', 5], ['b.ts', 2]]);
    rerender(
      <ChangesTab workbench={WB} chat={chat} ops={ops} visible turnsEnded={1} comments={[]} setComments={() => {}} />
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Viewed a.ts' })).not.toBeChecked());
    expect(loadViewed('wb1')).toEqual({});
  });

  it('a file whose patch changes with the same counts becomes unviewed after a turn', async () => {
    let patch = 'first version';
    const ops = makeOps({ diff: jest.fn(async () => patch) as unknown as WorkbenchOps['diff'] });
    const { rerender } = renderChanges(ops);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Viewed a.ts' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Viewed a.ts' })).toBeChecked());
    patch = 'second version';
    rerender(
      <ChangesTab workbench={WB} chat={chat} ops={ops} visible turnsEnded={1} comments={[]} setComments={() => {}} />
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Viewed a.ts' })).not.toBeChecked());
  });

  it('"N comments ready to send" puts them in the composer as one message', async () => {
    const setComments = jest.fn();
    render(
      <ChangesTab
        workbench={WB}
        chat={chat}
        ops={makeOps()}
        visible
        turnsEnded={0}
        comments={[
          { id: 'x', path: 'src/a.ts', side: 'additions', startLine: 3, endLine: 3, text: 'Rename this' },
          { id: 'y', path: 'src/a.ts', side: 'additions', startLine: 9, endLine: 10, text: 'Add a test' },
        ]}
        setComments={setComments}
      />
    );
    await screen.findByRole('checkbox', { name: 'Viewed a.ts' });
    expect(screen.getByTestId('comment-bar')).toHaveTextContent('2 comments ready to send');
    fireEvent.click(screen.getByRole('button', { name: /Add to chat/ }));
    const draft = useWorkbenchStore.getState().drafts.c1;
    expect(draft).toContain('I left 2 comments on the diff');
    expect(draft).toContain('Rename this');
    expect(draft).toContain('Add a test');
    expect(setComments).toHaveBeenCalledWith([]);
  });
});
