import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Workbench, WorkbenchChanges, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../lib/api';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { GIT_PANEL_MAX_WIDTH, GIT_PANEL_MIN_WIDTH, readLayout } from '../lib/workbenchLayout';
import { useWorkbenchStore } from '../stores/workbenches';
import { GitPanel } from '../components/workbench/GitPanel';
import { PullRequestTab } from '../components/workbench/PullRequestTab';
import { toast } from '../stores/toast';
import { usePullRequestStore } from '../stores/pullRequests';
import { ChangesTab } from '../components/workbench/ChangesTab';

vi.mock('@pierre/diffs/react', () => ({
  PatchDiff: () => <div data-testid="patch-diff" />,
}));

const getPr = vi.fn();
const startCodeReview = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    pullRequests: {
      get: (...a: unknown[]) => getPr(...a),
      startCodeReview: (...a: unknown[]) => startCodeReview(...a),
    },
  },
}));
vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
const billingLimit = vi.fn((..._a: unknown[]) => false);
vi.mock('../stores/billing', () => ({
  maybeHandleBillingLimit: (...a: unknown[]) => billingLimit(...a),
}));
let features: Record<string, boolean> = { codeReview: true };
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (sel: (s: { features: Record<string, boolean> }) => unknown) => sel({ features }),
}));
const setMergeQueue = vi.fn(async () => {});
vi.mock('../components/panels/github/useGitHubActions', () => ({
  useGitHubActions: () => ({ setMergeQueue }),
}));
const autoKeep = {
  posthogConnected: true,
  toggling: false,
  toggle: vi.fn(async () => {}),
};
vi.mock('../components/widgets/PRDetailSheet', () => ({
  PRDetailSheet: ({ pullRequestId, initialTab }: { pullRequestId: string | null; initialTab?: string }) =>
    pullRequestId ? <div data-testid="pr-sheet" data-tab={initialTab} /> : null,
  ReviewsTab: () => <div>reviews</div>,
  MergeQueueSection: () => <div data-testid="merge-queue-section" />,
  usePrAutoKeep: () => autoKeep,
}));
vi.mock('../components/workbench/FilesTab', () => ({
  FilesTab: ({ visible }: { visible: boolean }) => <div data-testid="files-tab" data-visible={String(visible)} />,
}));
vi.mock('../components/workbench/terminal/TerminalPanel', () => ({
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
  workspaceId: 'ws1',
  owner: 'acme',
  repo: 'app',
  number: 42,
  state: 'open',
  mergeQueued: false,
  autoKeepMergeable: false,
  mergedAt: null,
  summary: {
    title: 'Add a thing',
    url: 'https://github.com/acme/app/pull/42',
    draft: false,
    baseBranch: 'main',
    blockingReason: 'checks_failed',
    reviewDecision: null,
    ciStatus: 'failing_required',
    checks: { total: 3, passed: 1, failed: 1, inProgress: 1, skipped: 0 },
  },
} as unknown as PRRow;

function prWith(over: Partial<PRRow>, summary: Partial<PRRow['summary']> = {}): PRRow {
  return { ...PR, ...over, summary: { ...PR.summary, ...summary } } as PRRow;
}

function changes(files: Array<[string, number]>): WorkbenchChanges {
  return {
    base: 'b',
    headSha: 'h',
    files: files.map(([path, added]) => ({
      path,
      status: 'modified',
      added,
      removed: 0,
      binary: false,
    })),
  };
}

function makeOps(over: Partial<WorkbenchOps> = {}): WorkbenchOps {
  return {
    runtime: 'sandbox',
    unavailable: null,
    changes: vi.fn(async () =>
      changes([
        ['a.ts', 1],
        ['b.ts', 2],
      ]),
    ),
    diff: vi.fn(async (path?: string) => `patch of ${path}`),
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
  vi.clearAllMocks();
});

describe('GitPanel', () => {
  it('labels its tabs All files, Changes, Pull request', () => {
    render(<GitPanel workbench={WB} chat={chat} ops={makeOps()} pr={null} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['All files', 'Changes2', 'Pull request']);
  });

  it('a tab click is remembered across restarts', () => {
    render(<GitPanel workbench={WB} chat={chat} ops={makeOps()} pr={null} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Pull request' }));
    expect(useWorkbenchStore.getState().sideTab).toBe('pr');
    expect(readLayout().gitPanelTab).toBe('pr');
    expect(screen.getByRole('tab', { name: 'Pull request' })).toHaveAttribute('aria-selected', 'true');
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
    const handle = screen.getByRole('separator', {
      name: 'Resize the right panel',
    });
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: from }));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: to }));
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(useWorkbenchStore.getState().rightPanelWidth).toBe(expected);
    expect(readLayout().gitPanelWidth).toBe(expected);
    expect(screen.getByTestId('git-panel')).toHaveStyle({
      width: `${expected}px`,
    });
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

describe('Pull request tab', () => {
  const fresh = {
    checkContexts: [
      {
        name: 'unit',
        state: 'success',
        required: true,
        url: 'https://ci/unit',
      },
      {
        name: 'docs',
        state: 'failure',
        required: false,
        url: 'https://ci/docs',
      },
      {
        name: 'lint',
        state: 'failure',
        required: true,
        url: 'https://ci/lint',
      },
      { name: 'e2e', state: 'in_progress', required: null, url: null },
    ],
  };

  beforeEach(() => {
    features = { codeReview: true };
    autoKeep.posthogConnected = true;
    usePullRequestStore.setState({ rows: [] });
  });

  it('shows the status, the blocking reason and the checks failing first, required before optional', async () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    render(<PullRequestTab workbench={WB} chat={chat} pr={PR} visible turnsEnded={0} />);
    await waitFor(() => expect(screen.getAllByTestId('check-line')).toHaveLength(4));
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Add a thing')).toBeInTheDocument();
    expect(screen.getByTestId('pr-blocking-reason')).toHaveTextContent('Required CI checks failing');
    expect(screen.getByTitle('Open on GitHub')).toHaveAttribute('href', 'https://github.com/acme/app/pull/42');
    expect(screen.getAllByTestId('check-line').map((l) => l.textContent)).toEqual([
      'lintrequired',
      'docsoptional',
      'e2e',
      'unitrequired',
    ]);
    expect(screen.getByTestId('checks-tally')).toHaveTextContent('2 failing (1 required) · 1 running · 1 passed');
    expect(screen.getByText('reviews')).toBeInTheDocument();
  });

  it('"Add to chat" puts one line with the link into the open chat draft', async () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    useWorkbenchStore.setState({ drafts: { c1: 'Please fix' } });
    render(<PullRequestTab workbench={WB} chat={chat} pr={PR} visible turnsEnded={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add lint to chat' }));
    expect(useWorkbenchStore.getState().drafts.c1).toBe(
      'Please fix\n\nThe CI check `lint` (required) is failing on #42: https://ci/lint',
    );
  });

  it('with no chat yet, the line goes to the workbench draft', async () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    render(<PullRequestTab workbench={WB} chat={null} pr={PR} visible turnsEnded={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add docs to chat' }));
    expect(useWorkbenchStore.getState().drafts['wb:wb1']).toBe(
      'The CI check `docs` (optional) is failing on #42: https://ci/docs',
    );
  });

  it('reads when opened, after a turn ends and on Refresh, never on a timer or while hidden', async () => {
    vi.useFakeTimers();
    try {
      getPr.mockResolvedValue({ row: PR, fresh });
      const { rerender } = render(<PullRequestTab workbench={WB} chat={chat} pr={PR} visible={false} turnsEnded={0} />);
      await act(async () => {});
      expect(getPr).not.toHaveBeenCalled();
      rerender(<PullRequestTab workbench={WB} chat={chat} pr={PR} visible turnsEnded={0} />);
      await act(async () => {});
      expect(getPr).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(5 * 60_000);
      });
      expect(getPr).toHaveBeenCalledTimes(1);
      rerender(<PullRequestTab workbench={WB} chat={chat} pr={PR} visible turnsEnded={1} />);
      await act(async () => {});
      expect(getPr).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await act(async () => {});
      expect(getPr).toHaveBeenCalledTimes(3);
      rerender(<PullRequestTab workbench={WB} chat={chat} pr={PR} visible={false} turnsEnded={2} />);
      await act(async () => {});
      expect(getPr).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a check event offers a refresh instead of reading at once', async () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    const first = prWith({}, { checksAt: 100 });
    const { rerender } = render(<PullRequestTab workbench={WB} chat={chat} pr={first} visible turnsEnded={0} />);
    await waitFor(() => expect(getPr).toHaveBeenCalledTimes(1));
    await screen.findAllByTestId('check-line');
    expect(screen.queryByText('The checks changed. Refresh')).not.toBeInTheDocument();
    rerender(<PullRequestTab workbench={WB} chat={chat} pr={prWith({}, { checksAt: 200 })} visible turnsEnded={0} />);
    expect(getPr).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('The checks changed. Refresh'));
    await waitFor(() => expect(getPr).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('The checks changed. Refresh')).not.toBeInTheDocument());
  });

  it('without a PR it says how to get one, and reads nothing', () => {
    render(<PullRequestTab workbench={{ ...WB, pullRequestId: null }} chat={chat} pr={null} visible turnsEnded={0} />);
    expect(screen.getByText(/once this branch has a pull request/)).toBeInTheDocument();
    expect(getPr).not.toHaveBeenCalled();
  });

  it('while a merged PR loads, it shows the summary the session carries', () => {
    render(
      <PullRequestTab
        workbench={{
          ...WB,
          pr: {
            number: 42,
            url: 'https://github.com/acme/app/pull/42',
            state: 'merged',
            mergeable: 'unknown',
            ciStatus: 'none',
          },
        }}
        chat={chat}
        pr={null}
        visible
        turnsEnded={0}
      />,
    );
    expect(screen.getByText('#42')).toHaveClass('text-merged');
    expect(screen.getByText('Loading the pull request…')).toBeInTheDocument();
    expect(getPr).not.toHaveBeenCalled();
  });

  it.each([
    ['merged', 'Merged into main'],
    ['closed', 'Closed without merging'],
  ] as const)('a %s PR says so, and offers only Details and GitHub', async (state, line) => {
    getPr.mockResolvedValue({ row: PR, fresh: { checkContexts: [] } });
    render(
      <PullRequestTab workbench={WB} chat={chat} pr={prWith({ state, mergeQueued: true })} visible turnsEnded={0} />,
    );
    expect(screen.getByText(line)).toBeInTheDocument();
    expect(screen.queryByTestId('pr-blocking-reason')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /merge queue|Queued/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Auto-keep/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Review/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('merge-queue-section')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Details/ })).toBeInTheDocument();
    expect(screen.getByTitle('Open on GitHub')).toBeInTheDocument();
    await screen.findByText(/No checks have run yet|not available right now/);
  });

  it.each([
    [false, 'Add to merge queue', true],
    [true, 'Queued', false],
  ])('the merge queue button (queued %s) reads "%s" and toggles to %s', (queued, label, next) => {
    getPr.mockResolvedValue({ row: PR, fresh });
    const row = prWith({ mergeQueued: queued });
    render(<PullRequestTab workbench={WB} chat={chat} pr={row} visible turnsEnded={0} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(setMergeQueue).toHaveBeenCalledWith(row, next);
    expect(Boolean(screen.queryByTestId('merge-queue-section'))).toBe(queued);
  });

  it.each([
    [{ status: 'blocked', blockedCode: 'agent_needs_human' }, 'Queue needs you'],
    [{ status: 'merging' }, 'Merging…'],
    [{ status: 'queued', position: 3 }, 'Queued #3'],
  ])('a queued PR says where it is: %o', (mergeQueue, label) => {
    getPr.mockResolvedValue({ row: PR, fresh });
    render(
      <PullRequestTab
        workbench={WB}
        chat={chat}
        pr={prWith({
          mergeQueued: true,
          mergeQueue: mergeQueue as PRRow['mergeQueue'],
        })}
        visible
        turnsEnded={0}
      />,
    );
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
  });

  it.each([
    [true, false, 'Auto-keep', true],
    [true, true, 'Auto-keeping', false],
  ])('auto-keep (connected %s, on %s) reads "%s" and toggles to %s', (connected, on, label, next) => {
    getPr.mockResolvedValue({ row: PR, fresh });
    autoKeep.posthogConnected = connected;
    render(<PullRequestTab workbench={WB} chat={chat} pr={prWith({ autoKeepMergeable: on })} visible turnsEnded={0} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(autoKeep.toggle).toHaveBeenCalledWith(next);
  });

  it('hides auto-keep without a connected provider', () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    autoKeep.posthogConnected = false;
    render(<PullRequestTab workbench={WB} chat={chat} pr={PR} visible turnsEnded={0} />);
    expect(screen.queryByRole('button', { name: /Auto-keep/ })).not.toBeInTheDocument();
  });

  it('Review starts a code review and stores it on the row', async () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    usePullRequestStore.setState({ rows: [PR] });
    const review = { phase: 'reviewing', openCount: 0 };
    startCodeReview.mockResolvedValue(review);
    render(<PullRequestTab workbench={WB} chat={chat} pr={PR} visible turnsEnded={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(startCodeReview).toHaveBeenCalledWith('pr1'));
    await waitFor(() => expect(usePullRequestStore.getState().rows[0].codeReview).toBe(review));
  });

  it('a plan limit on Review goes to the billing handler, not a toast', async () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    const err = new Error('limit');
    startCodeReview.mockRejectedValue(err);
    billingLimit.mockReturnValueOnce(true);
    render(<PullRequestTab workbench={WB} chat={chat} pr={PR} visible turnsEnded={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(billingLimit).toHaveBeenCalledWith(err, 'code_review_start'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  // Code review has no feature flag since 2026-10-26, so the only case left is a review in progress.
  it('offers no Review while one runs', () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    const running = prWith({
      codeReview: {
        phase: 'reviewing',
        phasePlan: ['reviewing'],
        openCount: 0,
      } as unknown as PRRow['codeReview'],
    });
    const { unmount } = render(<PullRequestTab workbench={WB} chat={chat} pr={running} visible turnsEnded={0} />);
    expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
    unmount();
  });

  it('a finished review with no findings says so and opens the findings', () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    const done = prWith({
      codeReview: {
        phase: 'ready',
        phasePlan: [],
        openCount: 0,
      } as unknown as PRRow['codeReview'],
    });
    render(<PullRequestTab workbench={WB} chat={chat} pr={done} visible turnsEnded={0} />);
    fireEvent.click(screen.getByText('No open findings'));
    expect(screen.getByTestId('pr-sheet')).toHaveAttribute('data-tab', 'findings');
  });

  it('Details and the title open the full view on its overview', () => {
    getPr.mockResolvedValue({ row: PR, fresh });
    render(<PullRequestTab workbench={WB} chat={chat} pr={PR} visible turnsEnded={0} />);
    expect(screen.queryByTestId('pr-sheet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByTestId('pr-sheet')).toHaveAttribute('data-tab', 'overview');
  });
});

describe('Changes tab', () => {
  it('shows separate counts and passes the scope for a file in both groups', async () => {
    const data = changes([['both.ts', 5]]);
    data.uncommitted = [{ ...data.files[0], added: 2, removed: 1 }];
    data.committed = [{ ...data.files[0], added: 7, removed: 3 }];
    const ops = makeOps({ changes: vi.fn(async () => data) });
    render(<ChangesTab workbench={WB} chat={chat} ops={ops} visible turnsEnded={0} comments={[]} setComments={() => {}} />);
    const uncommitted = await screen.findByRole('region', { name: 'Uncommitted' });
    const committed = screen.getByRole('region', { name: 'Committed on this branch' });
    const header = within(uncommitted).getByRole('button', { name: /Uncommitted/ });
    expect(header).toHaveTextContent('1 file');
    expect(header).toHaveTextContent('+2');
    expect(header).toHaveTextContent('−1');
    const committedHeader = within(committed).getByRole('button', { name: /Committed on this branch/ });
    expect(committedHeader).toHaveTextContent('1 file');
    expect(committedHeader).toHaveTextContent('+7');
    expect(committedHeader).toHaveTextContent('−3');
    fireEvent.click(within(uncommitted).getByRole('button', { name: /both.ts/ }));
    await waitFor(() => expect(ops.diff).toHaveBeenLastCalledWith('both.ts', 'uncommitted'));
    fireEvent.click(within(committed).getByRole('button', { name: /both.ts/ }));
    await waitFor(() => expect(ops.diff).toHaveBeenLastCalledWith('both.ts', 'committed'));
    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(within(uncommitted).queryByText('both.ts')).not.toBeInTheDocument();
    expect(within(committed).getByText('both.ts')).toBeInTheDocument();
    fireEvent.click(header);
    expect(within(uncommitted).getByText('both.ts')).toBeInTheDocument();
  });

  it.each(['uncommitted', 'committed', 'both'] as const)('shows empty states for %s', async (empty) => {
    const data = changes([['a.ts', 1]]);
    data.uncommitted = empty === 'committed' ? data.files : [];
    data.committed = empty === 'uncommitted' ? data.files : [];
    const ops = makeOps({ changes: vi.fn(async () => data) });
    render(<ChangesTab workbench={WB} chat={chat} ops={ops} visible turnsEnded={0} comments={[]} setComments={() => {}} />);
    await screen.findByRole('region', { name: 'Uncommitted' });
    if (empty !== 'committed') expect(screen.getByText('No uncommitted changes.')).toBeInTheDocument();
    if (empty !== 'uncommitted') expect(screen.getByText('No committed changes.')).toBeInTheDocument();
  });

  it('does not refresh a merged branch while the notice is shown', () => {
    vi.useFakeTimers();
    try {
      const ops = makeOps();
      render(
        <ChangesTab
          workbench={{
            ...WB,
            pr: {
              number: 42,
              url: 'https://github.com/acme/app/pull/42',
              state: 'merged',
              mergeable: 'unknown',
              ciStatus: 'none',
            },
          }}
          chat={chat}
          ops={ops}
          visible
          turnsEnded={0}
          comments={[]}
          setComments={vi.fn()}
        />,
      );
      act(() => vi.advanceTimersByTime(30_000));
      expect(ops.changes).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a merged notice and loads the branch diff only after a click', async () => {
    const ops = makeOps();
    render(
      <ChangesTab
        workbench={{
          ...WB,
          pr: {
            number: 42,
            url: 'https://github.com/acme/app/pull/42',
            state: 'merged',
            mergeable: 'unknown',
            ciStatus: 'none',
          },
        }}
        chat={chat}
        ops={ops}
        visible
        turnsEnded={0}
        comments={[]}
        setComments={vi.fn()}
      />,
    );
    expect(screen.getByText('PR #42 merged. Its changes are in main.')).toBeInTheDocument();
    expect(ops.changes).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /a\.ts/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the branch diff anyway' }));
    expect(await screen.findByRole('button', { name: /a\.ts/ })).toBeInTheDocument();
    expect(ops.changes).toHaveBeenCalledTimes(1);
  });

  it('a second click on a file row collapses its diff', async () => {
    const ops = makeOps();
    render(
      <ChangesTab workbench={WB} chat={chat} ops={ops} visible turnsEnded={0} comments={[]} setComments={vi.fn()} />,
    );
    const row = await screen.findByRole('button', { name: /a\.ts/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    await waitFor(() => expect(row).toHaveAttribute('aria-expanded', 'true'));
    await waitFor(() => expect(ops.diff).toHaveBeenCalled());
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: /b\.ts/ }));
    expect(screen.getByRole('button', { name: /b\.ts/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('"N comments ready to send" sends them to the agent as one message', async () => {
    const setComments = vi.fn();
    const send = vi.fn(async () => ({ queued: false }));
    render(
      <ChangesTab
        workbench={WB}
        chat={chat}
        ops={makeOps({ send } as Partial<WorkbenchOps>)}
        visible
        turnsEnded={0}
        comments={[
          {
            id: 'x',
            path: 'src/a.ts',
            side: 'additions',
            startLine: 3,
            endLine: 3,
            text: 'Rename this',
          },
          {
            id: 'y',
            path: 'src/a.ts',
            side: 'additions',
            startLine: 9,
            endLine: 10,
            text: 'Add a test',
          },
        ]}
        setComments={setComments}
      />,
    );
    await screen.findByText('a.ts');
    expect(screen.getByTestId('comment-bar')).toHaveTextContent('2 comments ready to send');
    fireEvent.click(screen.getByRole('button', { name: /Send to agent/ }));
    await waitFor(() => expect(setComments).toHaveBeenCalledWith([]));
    expect(send).toHaveBeenCalledTimes(1);
    const [target, input] = send.mock.calls[0] as unknown as [WorkbenchChat, { text: string }];
    expect(target.id).toBe(chat.id);
    expect(input.text).toContain('I left 2 comments on the diff');
    expect(input.text).toContain('Rename this');
    expect(input.text).toContain('Add a test');
    expect(useWorkbenchStore.getState().drafts.c1).toBeUndefined();
  });

  it('keeps the comments when the send fails', async () => {
    const setComments = vi.fn();
    const send = vi.fn(async () => {
      throw new Error('Down');
    });
    render(
      <ChangesTab
        workbench={WB}
        chat={chat}
        ops={makeOps({ send } as Partial<WorkbenchOps>)}
        visible
        turnsEnded={0}
        comments={[
          {
            id: 'x',
            path: 'src/a.ts',
            side: 'additions',
            startLine: 3,
            endLine: 3,
            text: 'Rename this',
          },
        ]}
        setComments={setComments}
      />,
    );
    await screen.findByText('a.ts');
    fireEvent.click(screen.getByRole('button', { name: /Send to agent/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(setComments).not.toHaveBeenCalled();
  });
});
