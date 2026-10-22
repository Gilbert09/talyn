import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { WorkbenchHeader } from '../renderer/components/workbench/WorkbenchHeader';
import { requestWorkbenchAction, type WorkbenchAction } from '../renderer/lib/workbenchActions';
import { toast } from '../renderer/stores/toast';

const merge = jest.fn();
const archive = jest.fn();
const createChat = jest.fn();
const unlinkPullRequest = jest.fn();
const openPullRequests = jest.fn().mockResolvedValue([]);
jest.mock('../renderer/lib/api', () => ({
  api: {
    pullRequests: { merge: (...a: unknown[]) => merge(...a) },
    workbenches: {
      archive: (...a: unknown[]) => archive(...a),
      unlinkPullRequest: (...a: unknown[]) => unlinkPullRequest(...a),
      openPullRequests: (...a: unknown[]) => openPullRequests(...a),
      createChat: (...a: unknown[]) => createChat(...a),
    },
  },
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
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

function ops(): WorkbenchOps & { runAction: jest.Mock; send: jest.Mock } {
  return {
    runtime: 'sandbox',
    unavailable: null,
    canRemoveQueued: false,
    canAttach: false,
    runAction: jest.fn(async () => {}),
    send: jest.fn(async () => ({ queued: false })),
  } as unknown as WorkbenchOps & { runAction: jest.Mock; send: jest.Mock };
}

const chat = { id: 'c1' } as WorkbenchChat;
const CREATE_PR = { text: 'Create a pull request', intent: 'create_pr', planMode: false };

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('WorkbenchHeader action cycle', () => {
  it.each([
    ['sandbox', false, true],
    ['sandbox', true, false],
    ['local', false, false],
  ] as const)('shows the network hint for %s with access %s: %s', (runtime, internetAccess, shown) => {
    render(<WorkbenchHeader workbench={{ ...WB, runtime, settings: { internetAccess } }} pr={null} chat={chat} ops={ops()} />);
    expect(Boolean(screen.queryByText('No internet'))).toBe(shown);
  });

  // nextWorkbenchAction → the primary button's label, its shortcut and what a click does.
  it.each<[string, PRRow | null, Partial<Workbench>, string, string | null, 'prompt' | 'confirm' | 'send', string]>([
    ['no PR, with changes', null, {}, 'Create PR', 'Ctrl+Shift+P', 'send', 'create_pr'],
    ['conflicting PR', prRow({ mergeable: 'CONFLICTING', ciStatus: 'failing_required' }), {}, 'Resolve conflicts', null, 'prompt', 'resolve_conflicts'],
    ['failing required checks', prRow({ ciStatus: 'failing_required' }), {}, 'Fix checks', 'Ctrl+Shift+X', 'prompt', 'fix_checks'],
    ['green PR', prRow({}), {}, 'Merge', 'Ctrl+Shift+M', 'confirm', 'merge'],
    ['failing optional checks read as green', prRow({ ciStatus: 'failing_optional' }), {}, 'Merge', 'Ctrl+Shift+M', 'confirm', 'merge'],
    ['merged PR', prRow({}, 'merged'), {}, 'Archive session', 'Ctrl+Shift+A', 'confirm', 'archive'],
    ['closed PR', prRow({}, 'closed'), {}, 'Archive', 'Ctrl+Shift+A', 'confirm', 'archive'],
  ])('%s', async (_name, pr, over, label, keys, kind, action) => {
    const o = ops();
    render(<WorkbenchHeader workbench={{ ...WB, pullRequestId: pr ? 'pr1' : null, ...over }} pr={pr} chat={chat} ops={o} />);
    const button = screen.getByTestId('workbench-primary-action');
    expect(button).toHaveTextContent(label);
    if (keys) expect(button).toHaveTextContent(keys);
    else expect(button.textContent).toBe(label);
    fireEvent.click(button);
    if (kind === 'prompt') {
      await waitFor(() => expect(o.runAction).toHaveBeenCalledWith(action, chat));
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
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not create the pull request', 'The session is not ready.'));
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
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['MergeCtrl+Shift+M', 'ArchiveCtrl+Shift+A', 'Unlink pull request', 'Copy branch name']);
  });

  it('the menu lists every action that applies, in cycle order', () => {
    render(
      <WorkbenchHeader
        workbench={WB}
        pr={prRow({ mergeable: 'CONFLICTING', ciStatus: 'failing_required' })}
        chat={chat}
        ops={ops()}
      />
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Resolve conflicts',
      'Fix checksCtrl+Shift+X',
      'ArchiveCtrl+Shift+A',
      'Unlink pull request',
      'Copy branch name',
    ]);
  });

  it('opens the link dialog when the session has no PR', async () => {
    render(<WorkbenchHeader workbench={{ ...WB, pullRequestId: null }} pr={null} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Link pull request…' }));
    expect(await screen.findByRole('combobox', { name: 'Search pull requests' })).toBeInTheDocument();
    await waitFor(() => expect(openPullRequests).toHaveBeenCalledWith(WB.id, { state: 'open' }));
  });

  it('unlinks a PR from the menu', async () => {
    unlinkPullRequest.mockResolvedValue({ ...WB, pullRequestId: null });
    render(<WorkbenchHeader workbench={WB} pr={prRow({})} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
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

  it('an archived workbench shows no actions', () => {
    render(<WorkbenchHeader workbench={{ ...WB, status: 'archived', archivedAt: '2026-10-13T01:00:00Z' }} pr={null} chat={chat} ops={ops()} />);
    expect(screen.queryByTestId('workbench-primary-action')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('prompt actions wait while the workbench is unavailable', () => {
    const o = { ...ops(), unavailable: 'The sandbox is starting.' } as ReturnType<typeof ops>;
    render(<WorkbenchHeader workbench={{ ...WB, pullRequestId: null }} pr={null} chat={chat} ops={o} />);
    expect(screen.getByTestId('workbench-primary-action')).toBeDisabled();
  });

  it('Merge confirms in a dialog, then merges through the PR merge API', async () => {
    merge.mockResolvedValue({ merged: true, message: 'ok' });
    render(<WorkbenchHeader workbench={WB} pr={prRow({})} chat={chat} ops={ops()} />);
    fireEvent.click(screen.getByTestId('workbench-primary-action'));
    expect(merge).not.toHaveBeenCalled();
    expect(screen.getByText('Merge #42?')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Merge' }).pop()!);
    await waitFor(() => expect(merge).toHaveBeenCalledWith('pr1'));
  });

  it('Archive on a merged PR confirms in a dialog before archiving', async () => {
    archive.mockResolvedValue({ ...WB, status: 'archived', archivedAt: '2026-10-13T01:00:00Z' });
    render(<WorkbenchHeader workbench={WB} pr={prRow({}, 'merged')} chat={chat} ops={ops()} />);
    fireEvent.click(screen.getByTestId('workbench-primary-action'));
    expect(archive).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' }).pop()!);
    await waitFor(() => expect(archive).toHaveBeenCalledWith('wb1'));
  });

  it('shows the merged status and purple PR pill', () => {
    const row = { ...prRow({}, 'merged'), mergedAt: new Date(Date.now() - 3_600_000).toISOString() };
    render(<WorkbenchHeader workbench={WB} pr={row} chat={chat} ops={ops()} />);
    expect(screen.getByText('Merged')).toHaveClass('bg-merged/15', 'text-merged');
    expect(screen.getByText('PR #42 merged into main')).toBeInTheDocument();
    expect(screen.getByText('· 1h ago')).toBeInTheDocument();
    expect(screen.getByText('#42')).toHaveClass('bg-merged/15', 'text-merged');
    expect(screen.getByTestId('workbench-primary-action')).toHaveTextContent('Archive session');
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
