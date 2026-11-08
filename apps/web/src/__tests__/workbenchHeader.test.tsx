import { vi, describe, it, expect, beforeAll, afterEach, type Mock } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../lib/api';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { WorkbenchHeader } from '../components/workbench/WorkbenchHeader';
import { requestWorkbenchAction, type WorkbenchAction } from '../lib/workbenchActions';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';
import { usePullRequestStore } from '../stores/pullRequests';
import { captureAnalyticsException, trackEvent } from '../lib/analytics';

const merge = vi.fn();
const setMergeQueue = vi.fn();
const archive = vi.fn();
const restore = vi.fn();
const createChat = vi.fn();
const unlinkPullRequest = vi.fn();
const openPullRequests = vi.fn().mockResolvedValue([]);
const update = vi.fn();
const restart = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    pullRequests: {
      merge: (...a: unknown[]) => merge(...a),
      setMergeQueue: (...a: unknown[]) => setMergeQueue(...a),
    },
    workbenches: {
      archive: (...a: unknown[]) => archive(...a),
      restore: (...a: unknown[]) => restore(...a),
      unlinkPullRequest: (...a: unknown[]) => unlinkPullRequest(...a),
      openPullRequests: (...a: unknown[]) => openPullRequests(...a),
      createChat: (...a: unknown[]) => createChat(...a),
      update: (...a: unknown[]) => update(...a),
      restart: (...a: unknown[]) => restart(...a),
    },
  },
}));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));

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
  diffStat: { added: 4, removed: 1, files: 1 },
  archivedAt: null,
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
};

function prRow(summary: Partial<PRRow['summary']>, state: PRRow['state'] = 'open'): PRRow {
  return {
    id: 'pr1',
    number: 42,
    state,
    summary: {
      title: 'Add a thing',
      url: 'https://github.com/acme/app/pull/42',
      baseBranch: 'main',
      headBranch: 'lisbon',
      draft: false,
      mergeable: 'MERGEABLE',
      ciStatus: 'passing',
      ...summary,
    },
  } as PRRow;
}

function ops(): WorkbenchOps & { runAction: Mock; send: Mock } {
  return {
    runtime: 'sandbox',
    unavailable: null,
    canRemoveQueued: false,
    canAttach: false,
    runAction: vi.fn(async () => {}),
    send: vi.fn(async () => ({ queued: false })),
  } as unknown as WorkbenchOps & { runAction: Mock; send: Mock };
}

const chat = { id: 'c1' } as WorkbenchChat;
const CREATE_PR = {
  text: 'Create a pull request',
  intent: 'create_pr',
  planMode: false,
};

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  usePullRequestStore.setState({ rows: [] });
  useWorkbenchStore.setState({ extraWorkbenchIds: {} });
  vi.clearAllMocks();
});

describe('WorkbenchHeader layout', () => {
  it('renames from the menu and saves on blur', async () => {
    update.mockResolvedValue({ ...WB, title: 'New title' });
    render(<WorkbenchHeader workbench={WB} pr={null} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename session' }));
    const input = await screen.findByRole('textbox', { name: 'Session title' });
    fireEvent.change(input, { target: { value: '  New title  ' } });
    fireEvent.blur(input);
    await waitFor(() => expect(update).toHaveBeenCalledWith('wb1', { title: 'New title' }));
    expect(useWorkbenchStore.getState().workbenches.wb1.title).toBe('New title');
    expect(trackEvent).toHaveBeenCalledWith('session_renamed', { workbench_id: 'wb1' });
  });

  it('opens the title input on double-click and cancels with Escape', () => {
    render(<WorkbenchHeader workbench={WB} pr={null} chat={chat} ops={ops()} />);
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'lisbon' }));
    const input = screen.getByRole('textbox', { name: 'Session title' });
    fireEvent.change(input, { target: { value: 'Other title' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'lisbon' })).toBeInTheDocument();
  });

  it('puts actions and panel toggles above branch details and chips', () => {
    const { container } = render(<WorkbenchHeader workbench={WB} pr={prRow({ blockingReason: 'checks_failed', ciStatus: 'failing_required' })} chat={chat} ops={ops()} />);
    const titleRow = container.querySelector('[data-attr="workbench-header-title-row"]');
    const metaRow = container.querySelector('[data-attr="workbench-header-meta-row"]');
    expect(titleRow).toContainElement(screen.getByRole('heading', { name: 'lisbon' }));
    expect(titleRow).toContainElement(screen.getByTestId('workbench-primary-action'));
    expect(titleRow).toContainElement(container.querySelector('[data-attr="workbench-open-pr"]'));
    expect(metaRow).toContainElement(screen.getByRole('button', { name: 'Copy the branch name' }));
    expect(titleRow).toContainElement(screen.getByRole('button', { name: 'Toggle the terminal' }));
    expect(titleRow).toContainElement(screen.getByRole('button', { name: 'Toggle the right panel' }));
    expect(metaRow).toHaveTextContent('lisbon');
    expect(metaRow).toHaveTextContent('main');
    expect(metaRow).toContainElement(screen.getByTitle(/Required CI checks failing/));
    const chips = container.querySelector('[data-attr="workbench-header-chips"]');
    expect(chips).toContainElement(screen.getByTitle('Sandbox status'));
    expect(chips).toHaveClass('overflow-x-auto');
  });
});

describe('WorkbenchHeader action cycle', () => {
  it.each([
    ['sandbox', false, true],
    ['sandbox', true, false],
  ] as const)('shows the network hint for %s with access %s: %s', (runtime, internetAccess, shown) => {
    render(
      <WorkbenchHeader
        workbench={{ ...WB, runtime, settings: { internetAccess } }}
        pr={null}
        chat={chat}
        ops={ops()}
      />,
    );
    expect(Boolean(screen.queryByText('No internet'))).toBe(shown);
  });

  // nextWorkbenchAction → the primary button's label, its shortcut and what a click does.
  it.each<[string, PRRow | null, Partial<Workbench>, string, string | null, 'prompt' | 'confirm' | 'send', string]>([
    ['no PR, with changes', null, {}, 'Create PR', 'Ctrl+Alt+P', 'send', 'create_pr'],
    [
      'conflicting PR',
      prRow({ mergeable: 'CONFLICTING', ciStatus: 'failing_required' }),
      {},
      'Resolve conflicts',
      null,
      'prompt',
      'resolve_conflicts',
    ],
    [
      'failing required checks',
      prRow({ ciStatus: 'failing_required' }),
      {},
      'Fix checks',
      'Ctrl+Alt+X',
      'prompt',
      'fix_checks',
    ],
    ['green PR', prRow({}), {}, 'Merge', 'Ctrl+Alt+M', 'confirm', 'merge'],
    [
      'failing optional checks read as green',
      prRow({ ciStatus: 'failing_optional' }),
      {},
      'Merge',
      'Ctrl+Alt+M',
      'confirm',
      'merge',
    ],
    ['merged PR', prRow({}, 'merged'), {}, 'Archive session', 'Ctrl+Alt+A', 'confirm', 'archive'],
    ['closed PR', prRow({}, 'closed'), {}, 'Archive', 'Ctrl+Alt+A', 'confirm', 'archive'],
  ])('%s', async (_name, pr, over, label, keys, kind, action) => {
    const o = ops();
    render(
      <WorkbenchHeader workbench={{ ...WB, pullRequestId: pr ? 'pr1' : null, ...over }} pr={pr} chat={chat} ops={o} />,
    );
    const button = screen.getByTestId('workbench-primary-action');
    expect(button).toHaveTextContent(label);
    if (keys) expect(button).toHaveTextContent(keys);
    else expect(button.textContent).toBe(label);
    fireEvent.click(button);
    if (kind === 'prompt') {
      await waitFor(() => expect(o.runAction).toHaveBeenCalledWith(action, chat));
      await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('session_fix_sent', { workbench_id: 'wb1', action }));
    } else if (kind === 'send') {
      // Create PR is a short message with its own intent, sent straight away.
      await waitFor(() => expect(o.send).toHaveBeenCalledWith(chat, CREATE_PR));
      expect(o.runAction).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    } else {
      expect(o.runAction).not.toHaveBeenCalled();
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    }
  });

  it('captures a failed fix without sending its error text', async () => {
    const o = ops();
    o.runAction.mockRejectedValue(new Error('private path'));
    render(<WorkbenchHeader workbench={WB} pr={prRow({ ciStatus: 'failing_required' })} chat={chat} ops={o} />);
    fireEvent.click(screen.getByTestId('workbench-primary-action'));
    await waitFor(() => expect(captureAnalyticsException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ operation: 'send_fix' })));
    expect((vi.mocked(captureAnalyticsException).mock.calls[0][0] as Error).message).not.toContain('private path');
  });

  describe('Create PR', () => {
    const noPr = { ...WB, pullRequestId: null };

    it('opens a chat first when there is none, then sends to it', async () => {
      const fresh = { id: 'c2', workbenchId: 'wb1' } as WorkbenchChat;
      createChat.mockResolvedValue(fresh);
      const o = ops();
      render(<WorkbenchHeader workbench={noPr} pr={null} chat={null} ops={o} />);
      fireEvent.click(screen.getByTestId('workbench-primary-action'));
      await waitFor(() => expect(o.send).toHaveBeenCalledWith(fresh, CREATE_PR));
      expect(createChat).toHaveBeenCalledWith('wb1', {});
    });

    it.each<[string, Partial<Workbench>, string]>([
      ['behind a running turn', {}, 'It runs when the current turn ends.'],
      ['while the sandbox starts', { status: 'provisioning' }, 'It runs when the sandbox is ready.'],
    ])('says it is queued %s', async (_name, over, detail) => {
      const o = ops();
      o.send.mockResolvedValue({ queued: true });
      render(<WorkbenchHeader workbench={{ ...noPr, ...over }} pr={null} chat={chat} ops={o} />);
      act(() => requestWorkbenchAction('wb1', 'create_pr'));
      await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Queued', detail));
    });

    it('says why the message could not be sent', async () => {
      const o = ops();
      o.send.mockRejectedValue(new Error('The session is not ready.'));
      render(<WorkbenchHeader workbench={noPr} pr={null} chat={chat} ops={o} />);
      fireEvent.click(screen.getByTestId('workbench-primary-action'));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('Could not create the pull request', 'The session is not ready.'),
      );
    });

    it('sends nothing when no chat could be opened', async () => {
      createChat.mockRejectedValue(new Error('offline'));
      const o = ops();
      render(<WorkbenchHeader workbench={noPr} pr={null} chat={null} ops={o} />);
      fireEvent.click(screen.getByTestId('workbench-primary-action'));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not open a new chat', 'offline'));
      expect(o.send).not.toHaveBeenCalled();
    });
  });

  it('shows no primary while checks are still running, but the menu still offers what applies', () => {
    render(<WorkbenchHeader workbench={WB} pr={prRow({ ciStatus: 'running' })} chat={chat} ops={ops()} />);
    expect(screen.queryByTestId('workbench-primary-action')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), {
      key: 'Enter',
    });
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Rename session', 'Add to merge queue', 'MergeCtrl+Alt+M', 'ArchiveCtrl+Alt+A', 'Sandbox', 'Restart sandbox', 'Unlink pull request', 'Copy branch name', 'Continue as thread']);
  });

  it('restarts the sandbox from the Actions menu after a confirmation', async () => {
    restart.mockResolvedValue({ outcome: 'restarting', continued: false });
    render(<WorkbenchHeader workbench={WB} pr={null} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restart sandbox' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent("current MCP servers");
    expect(restart).not.toHaveBeenCalled();
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Restart')!);
    await waitFor(() => expect(restart).toHaveBeenCalledWith(WB.id));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith('Restarting the sandbox', expect.stringContaining('MCP servers')));
  });

  it.each([
    ['a session that is still starting', { status: 'provisioning' }],
    ['a session with no box', { sandboxId: null }],
    ['a local session', { runtime: 'local' }],
  ])('offers no restart for %s', (_name, patch) => {
    render(<WorkbenchHeader workbench={{ ...WB, ...patch } as Workbench} pr={null} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    expect(screen.queryByRole('menuitem', { name: 'Restart sandbox' })).not.toBeInTheDocument();
  });

  it('has a Sandbox entry in the Actions menu that opens the Sandbox tab', () => {
    useWorkbenchStore.setState({ sideTab: 'files', rightPanelOpen: false });
    render(<WorkbenchHeader workbench={WB} pr={null} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sandbox' }));
    expect(useWorkbenchStore.getState().sideTab).toBe('sandbox');
    expect(useWorkbenchStore.getState().rightPanelOpen).toBe(true);
  });

  it('the menu lists every action that applies, in cycle order', () => {
    render(
      <WorkbenchHeader
        workbench={WB}
        pr={prRow({ mergeable: 'CONFLICTING', ciStatus: 'failing_required' })}
        chat={chat}
        ops={ops()}
      />,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), {
      key: 'Enter',
    });
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Rename session',
      'Add to merge queue',
      'Resolve conflicts',
      'Fix checksCtrl+Alt+X',
      'ArchiveCtrl+Alt+A',
      'Sandbox',
      'Restart sandbox',
      'Unlink pull request',
      'Copy branch name',
      'Continue as thread',
    ]);
  });

  it('opens the link dialog when the session has no PR', async () => {
    render(<WorkbenchHeader workbench={{ ...WB, pullRequestId: null }} pr={null} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), {
      key: 'Enter',
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Link pull request…' }));
    expect(await screen.findByRole('combobox', { name: 'Search pull requests' })).toBeInTheDocument();
    await waitFor(() => expect(openPullRequests).toHaveBeenCalledWith(WB.id, { state: 'open' }));
  });

  it('unlinks a PR from the menu', async () => {
    unlinkPullRequest.mockResolvedValue({ ...WB, pullRequestId: null });
    render(<WorkbenchHeader workbench={WB} pr={prRow({})} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), {
      key: 'Enter',
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unlink pull request' }));
    await waitFor(() => expect(unlinkPullRequest).toHaveBeenCalledWith(WB.id));
  });

  it.each<[string, PRRow['state'], boolean]>([
    ['open', 'open', true],
    ['merged', 'merged', false],
    ['closed', 'closed', false],
  ])('the PR button shows for an %s PR: %p', (_name, state, shown) => {
    const row = prRow({ url: 'https://github.com/acme/app/pull/7' }, state);
    render(<WorkbenchHeader workbench={WB} pr={row} chat={chat} ops={ops()} />);
    const button = screen.queryByRole('button', { name: `PR #${row.number}` });
    if (shown) expect(button).toBeInTheDocument();
    else expect(button).toBeNull();
  });

  it('offers Restore on an archived session and waits for a click', async () => {
    const archived = { ...WB, status: 'archived' as const, archivedAt: '2026-10-13T01:00:00Z' };
    restore.mockResolvedValue(WB);
    render(<WorkbenchHeader workbench={archived} pr={null} chat={chat} ops={ops()} />);
    expect(restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith('wb1'));
    expect(useWorkbenchStore.getState().workbenches.wb1?.status).toBe('ready');
  });

  it('an archived workbench shows no actions', () => {
    render(
      <WorkbenchHeader
        workbench={{
          ...WB,
          status: 'archived',
          archivedAt: '2026-10-13T01:00:00Z',
        }}
        pr={null}
        chat={chat}
        ops={ops()}
      />,
    );
    expect(screen.queryByTestId('workbench-primary-action')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('prompt actions wait while the workbench is unavailable', () => {
    const o = {
      ...ops(),
      unavailable: 'The sandbox is starting.',
    } as ReturnType<typeof ops>;
    render(<WorkbenchHeader workbench={{ ...WB, pullRequestId: null }} pr={null} chat={chat} ops={o} />);
    expect(screen.getByTestId('workbench-primary-action')).toBeDisabled();
  });

  it('Merge confirms in a dialog, then merges through the PR merge API', async () => {
    merge.mockResolvedValue({ merged: true, message: 'ok' });
    render(<WorkbenchHeader workbench={WB} pr={prRow({})} chat={chat} ops={ops()} />);
    fireEvent.click(screen.getByTestId('workbench-primary-action'));
    expect(merge).not.toHaveBeenCalled();
    expect(screen.getByText('Merge #42?')).toBeInTheDocument();
    const confirmButton = screen.getAllByRole('button', { name: 'Merge' }).pop()!;
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    expect(confirmButton).toHaveFocus();
    fireEvent.keyDown(confirmButton, { key: 'ArrowLeft' });
    expect(cancelButton).toHaveFocus();
    fireEvent.keyDown(cancelButton, { key: 'ArrowDown' });
    expect(confirmButton).toHaveFocus();
    fireEvent.keyDown(confirmButton, { key: 'ArrowUp' });
    expect(cancelButton).toHaveFocus();
    fireEvent.keyDown(cancelButton, { key: 'ArrowRight' });
    expect(confirmButton).toHaveFocus();
    fireEvent.keyDown(confirmButton, { key: 'Enter' });
    await waitFor(() => expect(merge).toHaveBeenCalledWith('pr1'));
  });

  it('Archive on a merged PR confirms in a dialog before archiving', async () => {
    archive.mockResolvedValue({
      ...WB,
      status: 'archived',
      archivedAt: '2026-10-13T01:00:00Z',
    });
    render(<WorkbenchHeader workbench={WB} pr={prRow({}, 'merged')} chat={chat} ops={ops()} />);
    fireEvent.click(screen.getByTestId('workbench-primary-action'));
    expect(archive).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' }).pop()!);
    await waitFor(() => expect(archive).toHaveBeenCalledWith('wb1'));
  });

  it('shows the merged status and purple PR pill', () => {
    const row = {
      ...prRow({}, 'merged'),
      mergedAt: new Date(Date.now() - 3_600_000).toISOString(),
    };
    render(<WorkbenchHeader workbench={WB} pr={row} chat={chat} ops={ops()} />);
    expect(screen.getByText('Merged')).toHaveClass('bg-merged/15', 'text-merged');
    expect(screen.getByText('PR #42 merged into main')).toBeInTheDocument();
    expect(screen.getByText('· 1h ago')).toBeInTheDocument();
    expect(screen.getByText('#42')).toHaveClass('bg-merged/15', 'text-merged');
    expect(screen.getByTestId('workbench-primary-action')).toHaveTextContent('Archive session');
  });

  it('an open PR shows its status pill, which opens the Pull request tab', () => {
    useWorkbenchStore.setState({ sideTab: 'files', rightPanelOpen: false });
    render(
      <WorkbenchHeader
        workbench={WB}
        pr={prRow({
          blockingReason: 'checks_failed',
          ciStatus: 'failing_required',
          checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 },
        })}
        chat={chat}
        ops={ops()}
      />,
    );
    expect(screen.queryByText('#42')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/Required CI checks failing/));
    expect(useWorkbenchStore.getState()).toMatchObject({
      sideTab: 'pr',
      rightPanelOpen: true,
    });
  });

  it.each(['merged', 'closed'] as const)('a %s PR keeps its number pill, which opens the Pull request tab', (state) => {
    useWorkbenchStore.setState({ sideTab: 'files', rightPanelOpen: false });
    render(<WorkbenchHeader workbench={WB} pr={prRow({}, state)} chat={chat} ops={ops()} />);
    fireEvent.click(screen.getByText('#42'));
    expect(useWorkbenchStore.getState()).toMatchObject({
      sideTab: 'pr',
      rightPanelOpen: true,
    });
  });

  it('shows why a closed PR ended', () => {
    render(<WorkbenchHeader workbench={WB} pr={prRow({}, 'closed')} chat={chat} ops={ops()} />);
    expect(screen.getByText('PR #42 was closed without merging')).toBeInTheDocument();
  });

  describe('requests from shortcuts and the palette', () => {
    it.each<[string, PRRow | null, WorkbenchAction, 'prompt' | 'confirm' | 'send']>([
      ['create_pr with no PR', null, 'create_pr', 'send'],
      ['fix_checks on failing checks', prRow({ ciStatus: 'failing_required' }), 'fix_checks', 'prompt'],
      ['merge on a green PR', prRow({}), 'merge', 'confirm'],
      ['archive at any time', prRow({}), 'archive', 'confirm'],
    ])('%s runs through the header', async (_name, pr, action, kind) => {
      const o = ops();
      render(<WorkbenchHeader workbench={{ ...WB, pullRequestId: pr ? 'pr1' : null }} pr={pr} chat={chat} ops={o} />);
      act(() => requestWorkbenchAction('wb1', action));
      if (kind === 'prompt') await waitFor(() => expect(o.runAction).toHaveBeenCalledWith(action, chat));
      else if (kind === 'send') await waitFor(() => expect(o.send).toHaveBeenCalledWith(chat, CREATE_PR));
      else expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });

    it('an action that does not apply is refused with a note, not run', () => {
      const o = ops();
      render(<WorkbenchHeader workbench={WB} pr={prRow({})} chat={chat} ops={o} />);
      act(() => requestWorkbenchAction('wb1', 'fix_checks'));
      expect(o.runAction).not.toHaveBeenCalled();
      expect(toast.info).toHaveBeenCalledWith('Fix checks does not apply to this session now');
    });

    it("ignores another workbench's request", () => {
      const o = ops();
      render(<WorkbenchHeader workbench={{ ...WB, pullRequestId: null }} pr={null} chat={chat} ops={o} />);
      act(() => requestWorkbenchAction('other', 'create_pr'));
      expect(o.runAction).not.toHaveBeenCalled();
      expect(o.send).not.toHaveBeenCalled();
    });
  });
});


describe('WorkbenchHeader merge queue', () => {
  it.each([
    [false, 'button'],
    [true, 'button'],
    [false, 'menuitem'],
    [true, 'menuitem'],
  ] as const)('toggles queue membership %s from the %s', async (queued, role) => {
    setMergeQueue.mockResolvedValue({});
    const row = { ...prRow({ ciStatus: 'running' }), mergeQueued: queued };
    usePullRequestStore.setState({ rows: [row] });
    const { container } = render(<WorkbenchHeader workbench={WB} pr={row} chat={chat} ops={ops()} />);
    const label = queued ? 'Remove from merge queue' : 'Add to merge queue';
    expect(container.querySelector('[data-attr="workbench-header-title-row"]'))
      .toContainElement(screen.getByRole('button', { name: label }));
    if (role === 'menuitem') {
      fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    }
    fireEvent.click(screen.getByRole(role, { name: label }));
    await waitFor(() => expect(setMergeQueue).toHaveBeenCalledWith('pr1', !queued));
    expect(usePullRequestStore.getState().rows[0].mergeQueued).toBe(!queued);
  });

  it('blocks repeated queue requests until the request finishes', async () => {
    let finish!: () => void;
    setMergeQueue.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    render(<WorkbenchHeader workbench={WB} pr={prRow({})} chat={chat} ops={ops()} />);
    const button = screen.getByRole('button', { name: 'Add to merge queue' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeDisabled();
    fireEvent.click(button);
    expect(setMergeQueue).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(button).toBeEnabled();
  });

  it('shows queue updates and restores membership after an API failure', async () => {
    setMergeQueue.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Queue unavailable'));
    usePullRequestStore.setState({ rows: [{ ...prRow({}), owner: 'acme', repo: 'app', mergeQueued: false }] });
    function Header() {
      const row = usePullRequestStore((s) => s.rows[0]);
      return <WorkbenchHeader workbench={WB} pr={row} chat={chat} ops={ops()} />;
    }
    render(<Header />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to merge queue' }));
    const remove = await screen.findByRole('button', { name: 'Remove from merge queue' });
    await waitFor(() => expect(remove).toBeEnabled());
    expect(remove).toHaveTextContent('Queued');
    fireEvent.click(remove);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't dequeue acme/app#42", 'Queue unavailable'));
    expect(screen.getByRole('button', { name: 'Remove from merge queue' })).toBeEnabled();
    expect(usePullRequestStore.getState().rows[0].mergeQueued).toBe(true);
  });

  it.each(['none', 'merged', 'closed', 'archived', 'thread', 'viewer'] as const)(
    'hides queue actions for %s', (kind) => {
      const workbench = kind === 'archived' ? { ...WB, status: 'archived' as const }
        : kind === 'thread' ? { ...WB, kind: 'thread' as const } : WB;
      if (kind === 'viewer') useWorkbenchStore.setState({ extraWorkbenchIds: { [WB.id]: true } });
      const row = kind === 'none' ? null : prRow({}, kind === 'merged' || kind === 'closed' ? kind : 'open');
      render(<WorkbenchHeader workbench={workbench} pr={row} chat={chat} ops={ops()} />);
      expect(screen.queryByRole('button', { name: /merge queue/ })).not.toBeInTheDocument();
      const menu = screen.queryByRole('button', { name: 'More actions' });
      if (menu) {
        fireEvent.keyDown(menu, { key: 'Enter' });
        expect(screen.queryByRole('menuitem', { name: /merge queue/ })).not.toBeInTheDocument();
      }
    }
  );
});

describe('WorkbenchHeader last message', () => {
  afterEach(() => useWorkbenchStore.setState({ chatEvents: {} }));

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const held = (chatId: string, ...times: Array<string | undefined>) => ({
    events: times.map((createdAt, i) => ({ chatId, seq: i + 1, turn: 1, event: { seq: i + 1, type: 'assistant' }, ...(createdAt ? { createdAt } : {}) })),
  });

  it('shows the newest event time across the session chats', () => {
    const newest = minutesAgo(3);
    useWorkbenchStore.setState({
      chatEvents: { c1: held('c1', minutesAgo(20), minutesAgo(8)), c2: held('c2', newest, undefined) } as never,
    });
    const workbench = { ...WB, chats: [{ id: 'c1' }, { id: 'c2' }] } as typeof WB;
    const { container } = render(<WorkbenchHeader workbench={workbench} pr={null} chat={chat} ops={ops()} />);
    const label = screen.getByText('Last message 3 minutes ago');
    expect(label).toHaveAttribute('datetime', newest);
    expect(container.querySelector('[data-attr="workbench-header-meta-row"]')).toContainElement(label);
  });

  it('shows nothing when no held event has a time', () => {
    useWorkbenchStore.setState({ chatEvents: { c1: held('c1', undefined) } as never });
    render(<WorkbenchHeader workbench={WB} pr={null} chat={chat} ops={ops()} />);
    expect(screen.queryByText(/^Last message/)).not.toBeInTheDocument();
  });
});
