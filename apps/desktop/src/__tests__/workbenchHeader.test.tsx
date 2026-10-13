import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { WorkbenchHeader } from '../renderer/components/workbench/WorkbenchHeader';

const merge = jest.fn();
const archive = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: {
    pullRequests: { merge: (...a: unknown[]) => merge(...a) },
    workbenches: { archive: (...a: unknown[]) => archive(...a) },
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

function ops(): WorkbenchOps & { runAction: jest.Mock } {
  return {
    runtime: 'sandbox',
    unavailable: null,
    canRemoveQueued: false,
    canAttach: false,
    runAction: jest.fn(async () => {}),
  } as unknown as WorkbenchOps & { runAction: jest.Mock };
}

const chat = { id: 'c1' } as WorkbenchChat;

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('WorkbenchHeader next action', () => {
  it.each([
    ['Create PR', null, 'create_pr'],
    ['Fix checks', prRow({ ciStatus: 'failing_required' }), 'fix_checks'],
    ['Resolve conflicts', prRow({ mergeable: 'CONFLICTING' }), 'resolve_conflicts'],
  ] as const)('"%s" sends its prompt through the ops', async (label, pr, action) => {
    const o = ops();
    render(<WorkbenchHeader workbench={{ ...WB, pullRequestId: pr ? 'pr1' : null }} pr={pr} chat={chat} ops={o} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));
    await waitFor(() => expect(o.runAction).toHaveBeenCalledWith(action, chat));
  });

  it('shows no action while checks are still running', () => {
    render(<WorkbenchHeader workbench={WB} pr={prRow({ ciStatus: 'running' })} chat={chat} ops={ops()} />);
    for (const label of ['Create PR', 'Fix checks', 'Merge', 'Archive', 'Resolve conflicts']) {
      expect(screen.queryByRole('button', { name: new RegExp(`^${label}$`) })).not.toBeInTheDocument();
    }
  });

  it('Merge asks inline first, then merges through the PR merge API', async () => {
    merge.mockResolvedValue({ merged: true, message: 'ok' });
    render(<WorkbenchHeader workbench={WB} pr={prRow({})} chat={chat} ops={ops()} />);
    fireEvent.click(screen.getByRole('button', { name: /Merge/ }));
    expect(merge).not.toHaveBeenCalled();
    expect(screen.getByText(/Merge #42 into/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(merge).toHaveBeenCalledWith('pr1'));
  });

  it('Archive on a merged PR confirms in a dialog before archiving', async () => {
    archive.mockResolvedValue({ ...WB, status: 'archived', archivedAt: '2026-10-13T01:00:00Z' });
    render(<WorkbenchHeader workbench={WB} pr={prRow({}, 'merged')} chat={chat} ops={ops()} />);
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }));
    expect(archive).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' }).pop()!);
    await waitFor(() => expect(archive).toHaveBeenCalledWith('wb1'));
  });
});
