import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MergeQueueReviewWaitEvent, Task } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import { PRTable } from '../renderer/components/panels/github/prTableShared';
import { QueuePanel } from '../renderer/components/panels/QueuePanel';
import { MergeQueueSection } from '../renderer/components/widgets/PRDetailSheet';
import { taskDisplayStatus } from '../renderer/lib/taskDisplayStatus';
import { notifyMergeQueueReviewWait } from '../renderer/lib/mergeQueueReviewWait';
import { toast } from '../renderer/stores/toast';
import { openExternal } from '../renderer/lib/openExternal';

const resubmit = jest.fn<Promise<null>, [string]>();
let linkedTask: Task | undefined;
jest.mock('../renderer/lib/api', () => ({ api: { ws: { on: () => () => {} }, pullRequests: { mergeQueueTimeline: () => Promise.resolve({ events: [] }), resubmitMergeQueue: (...args: unknown[]) => resubmit(args[0] as string) } } }));
jest.mock('../renderer/hooks/useSkills', () => ({ useSkills: jest.fn() }));
jest.mock('../renderer/hooks/useApi', () => ({
  useTaskActions: () => ({ retryTask: jest.fn(), deleteTask: jest.fn(), startTask: jest.fn(), cancelTask: jest.fn() }),
  loadMoreTasks: jest.fn(),
}));
jest.mock('../renderer/components/panels/github/useGitHubActions', () => ({ useGitHubActions: () => ({}) }));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector?: (state: Record<string, unknown>) => unknown) => {
    const state = { currentWorkspaceId: 'ws1', tasks: linkedTask ? [linkedTask] : [],
      selectedTaskId: linkedTask?.id ?? null, selectTask: () => {},
      environments: [], repositories: [], tasksHasMore: false, tasksLoadingMore: false,
      tasksHistoryTotal: linkedTask ? 1 : 0 };
    return selector ? selector(state) : state;
  },
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../renderer/lib/openExternal', () => ({
  openExternal: jest.fn(() => Promise.resolve()),
  isOpenInBrowserClick: () => false,
}));

function row(status: NonNullable<PRRow['mergeQueue']>['status'], external = false): PRRow {
  return {
    id: 'pr1', workspaceId: 'ws1', repositoryId: 'repo1', taskId: linkedTask?.id ?? null,
    owner: 'acme', repo: 'app', number: 7, state: 'open', reviewRequested: false,
    authored: true, watching: false, mergedAt: null, lastPolledAt: '',
    autoKeepMergeable: false, mergeQueued: true, mergeMethod: 'squash',
    mergeQueue: { status, position: 2, reason: 'GitHub could not prepare the test branch.',
      blockedCode: external ? 'external_queue_rejected' : 'no_progress',
      ...(external ? { external: { state: 'cancelled' } } : {}) } as PRRow['mergeQueue'],
    createdAt: '', updatedAt: '',
    summary: {
      title: 'A PR', author: 'octocat', draft: false, headBranch: 'h', baseBranch: 'main',
      headSha: 'abc', updatedAt: '', url: 'https://github.com/acme/app/pull/7',
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: null,
      blockingReason: 'mergeable', checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
  } as PRRow;
}

function renderRow(status: NonNullable<PRRow['mergeQueue']>['status'], external = false) {
  render(<PRTable rows={[row(status, external)]} variant="queue" viewerLogin="octocat"
    selectedId={null} onSelect={jest.fn()} onOpenTask={jest.fn()} onStopTask={jest.fn()}
    onMerge={jest.fn()} onSetMergeQueue={jest.fn()} onCreatePostHogTask={jest.fn()}
    taskStatusById={new Map(linkedTask ? [[linkedTask.id, linkedTask.status]] : [])} />);
}

const ended = '2026-11-02T12:00:00.000Z';
const resolved = { at: '2026-11-02T12:05:00.000Z', by: 'merge_queue', note: 'Moved on.' };
function task(metadata: Task['metadata']): Task {
  return { id: 'task1', workspaceId: 'ws1', type: 'code_writing', status: 'needs_human',
    priority: 'medium', title: 'Fix PR', description: '', createdAt: ended, updatedAt: ended,
    completedAt: ended, metadata };
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  linkedTask = undefined;
});

describe('merge queue UI follow-ups', () => {
  it('shows a resolved needs-human task as done in the task list and PR badge', () => {
    linkedTask = task({ needsHumanResolved: resolved });
    expect(taskDisplayStatus(linkedTask)).toBe('completed');
    renderRow('queued');
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
  });

  it('shows the resolved line in task detail without the needs-you banner', () => {
    linkedTask = task({ needsHumanResolved: resolved });
    render(<QueuePanel />);
    expect(screen.getByText('Resolved: the merge queue moved on.')).toHaveClass('text-muted-foreground');
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
  });

  it('keeps a newer needs-human run open', () => {
    const newerRun = task({ needsHumanResolved: { ...resolved, at: '2026-11-02T11:00:00.000Z' } });
    expect(taskDisplayStatus(newerRun)).toBe('needs_human');
  });

  it.each([['blocked', true], ['blocked_manual', true], ['blocked', false], ['awaiting_review', true]] as const)(
    'shows re-submit only for a parked external entry (%s, external %s)', (status, external) => {
      renderRow(status, external);
      expect(Boolean(screen.queryByRole('button', { name: 'Re-submit to Trunk' }))).toBe(
        external && status !== 'awaiting_review'
      );
    }
  );

  it('shows re-submit in the PR detail only for a parked external entry', async () => {
    const { rerender } = render(<MergeQueueSection row={row('blocked', true)} />);
    expect(screen.getByRole('button', { name: 'Re-submit to Trunk' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Requeue' })).not.toBeInTheDocument();
    await screen.findByText('No queue activity recorded yet.');
    await act(async () => {
      rerender(<MergeQueueSection row={row('awaiting_review', true)} />);
    });
    expect(screen.queryByRole('button', { name: 'Re-submit to Trunk' })).not.toBeInTheDocument();
  });

  it('shows success after re-submitting', async () => {
    resubmit.mockResolvedValue(null);
    renderRow('blocked', true);
    fireEvent.click(screen.getByRole('button', { name: 'Re-submit to Trunk' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Re-submitted to Trunk'));
    expect(resubmit).toHaveBeenCalledWith('pr1');
  });

  it.each([
    ['not_queued', 'This pull request is not in the merge queue.'],
    ['not_parked', 'The merge queue is still working on this pull request.'],
    ['no_external_queue', 'This pull request has not been through an external merge queue.'],
  ])('shows the server message for %s', async (code, message) => {
    resubmit.mockRejectedValue(Object.assign(new Error(message), { status: 409, code }));
    renderRow('blocked', true);
    fireEvent.click(screen.getByRole('button', { name: 'Re-submit to Trunk' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message, undefined));
  });

  it('shows a required review as a neutral wait', () => {
    renderRow('awaiting_review');
    const wait = screen.getByText('Waiting for a required review');
    expect(wait.closest('span')).toHaveClass('text-muted-foreground');
  });

  it('opens the PR from the OS reminder', () => {
    const focus = jest.spyOn(window, 'focus').mockImplementation(() => {});
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
    let notice: { onclick: (() => void) | null; body: string } | null = null;
    class FakeNotification {
      static permission = 'granted';
      body: string;
      constructor(_title: string, options: { body: string }) {
        this.body = options.body;
      }
      set onclick(handler: (() => void) | null) {
        notice = { body: this.body, onclick: handler };
      }
    }
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FakeNotification });
    try {
      const event = { number: 7, url: 'https://github.com/acme/app/pull/7' } as MergeQueueReviewWaitEvent;
      notifyMergeQueueReviewWait(event, true);
      const shown = notice as { onclick: (() => void) | null; body: string } | null;
      expect(shown?.body).toBe('#7 is still waiting for a review');
      shown?.onclick?.();
      expect(openExternal).toHaveBeenCalledWith(event.url);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'Notification', descriptor);
      else Reflect.deleteProperty(globalThis, 'Notification');
      focus.mockRestore();
    }
  });

  it('shows a neutral reminder that opens the PR', () => {
    const event = { number: 7, url: 'https://github.com/acme/app/pull/7' } as MergeQueueReviewWaitEvent;
    notifyMergeQueueReviewWait(event, true);
    expect(toast.info).toHaveBeenCalledWith('#7 is still waiting for a review', undefined, expect.objectContaining({ label: 'Open PR' }));
    const action = (toast.info as jest.Mock).mock.calls[0][2] as { onClick: () => void } | undefined;
    action?.onClick();
    expect(openExternal).toHaveBeenCalledWith(event.url);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
