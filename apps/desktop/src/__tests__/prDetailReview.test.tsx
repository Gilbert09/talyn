import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { api, type PRRow } from '../renderer/lib/api';
import { trackEvent } from '../renderer/lib/analytics';
import { toast } from '../renderer/stores/toast';
import { usePullRequestStore } from '../renderer/stores/pullRequests';
import { PRDetailSheet } from '../renderer/components/widgets/PRDetailSheet';

/**
 * Approve and Request changes on the PR detail sheet. Offered only to a
 * requested reviewer on an open PR they did not write, the same rule as the
 * mobile app and the backend route.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/lib/prSummaryCache', () => ({ prime: jest.fn() }));
jest.mock('../renderer/hooks/useOnReconnect', () => ({ useOnReconnect: jest.fn() }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../renderer/components/panels/github/useGitHubActions', () => ({
  useGitHubActions: () => ({ createPostHogTask: jest.fn(async () => true), providerReady: true }),
}));
jest.mock('../renderer/stores/pullRequests', () => {
  const patchRow = jest.fn();
  const hook = (sel: (s: unknown) => unknown) => sel({ rows: [] });
  hook.getState = () => ({ patchRow });
  return { usePullRequestStore: hook };
});
jest.mock('../renderer/stores/workspace', () => {
  const getState = () => ({ tasks: [], openConnectAgent: jest.fn() });
  const hook = (sel: (s: unknown) => unknown) => sel(getState());
  hook.getState = getState;
  return { useWorkspaceStore: hook };
});
jest.mock('../renderer/lib/api', () => ({
  api: {
    pullRequests: {
      description: jest.fn(() => new Promise(() => {})),
      get: jest.fn(() => new Promise(() => {})),
      files: jest.fn(() => new Promise(() => {})),
      focus: jest.fn(async () => {}),
      submitReview: jest.fn(),
    },
    posthog: { getStatus: jest.fn(async () => ({ connected: false })) },
    ws: { on: jest.fn(() => () => {}) },
  },
}));

const submitReview = api.pullRequests.submitReview as unknown as jest.Mock;

function row(opts: { reviewRequested?: boolean; authored?: boolean; state?: string } = {}): PRRow {
  return {
    id: 'pr1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'acme',
    repo: 'app',
    number: 7,
    state: (opts.state ?? 'open') as PRRow['state'],
    reviewRequested: opts.reviewRequested ?? true,
    authored: opts.authored ?? false,
    watching: false,
    mergedAt: null,
    lastPolledAt: '',
    autoKeepMergeable: false,
    mergeQueued: false,
    mergeMethod: 'squash',
    createdAt: '',
    updatedAt: '',
    summary: {
      title: 'a PR',
      author: 'someone',
      draft: false,
      headBranch: 'h',
      baseBranch: 'main',
      headSha: 'abc',
      updatedAt: '',
      url: 'https://github.com/acme/app/pull/7',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      blockingReason: 'blocked',
      checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
  };
}

function open(seedRow: PRRow) {
  render(<PRDetailSheet pullRequestId="pr1" onClose={jest.fn()} seedRow={seedRow} />);
}

const approveButton = () => screen.queryByRole('button', { name: 'Approve' });
const requestButton = () => screen.queryByRole('button', { name: 'Request changes' });
const dialog = () => screen.getByRole('dialog');
const inDialog = (name: string) =>
  Array.from(dialog().querySelectorAll('button')).find((b) => b.textContent === name)!;
const comment = () => dialog().querySelector('textarea')!;

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('who sees the review buttons', () => {
  it('shows both on an open PR that asked for your review', () => {
    open(row());
    expect(approveButton()).toBeTruthy();
    expect(requestButton()).toBeTruthy();
  });

  it.each([
    ['your own PR', { authored: true }],
    ['a PR that did not ask for your review', { reviewRequested: false }],
    ['a merged PR', { state: 'merged' }],
    ['a closed PR', { state: 'closed' }],
    ['your own PR that also lists you as a reviewer', { authored: true, reviewRequested: true }],
  ])('hides them on %s', (_label, opts) => {
    open(row(opts));
    expect(approveButton()).toBeNull();
    expect(requestButton()).toBeNull();
  });
});

describe('Approve', () => {
  it('submits with no comment when none is typed', async () => {
    const next = { ...row(), summary: { ...row().summary, reviewDecision: 'APPROVED' } } as PRRow;
    submitReview.mockResolvedValue({ review: { id: 1, state: 'APPROVED', url: '' }, row: next });
    open(row());
    fireEvent.click(approveButton()!);
    expect(dialog().textContent).toContain('Approve acme/app#7');
    expect(inDialog('Approve').disabled).toBe(false);
    fireEvent.click(inDialog('Approve'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(submitReview).toHaveBeenCalledWith('pr1', { event: 'approve' });
    expect(trackEvent).toHaveBeenCalledWith('pr_review_submitted', {
      event: 'approve',
      has_comment: false,
    });
    expect(toast.success).toHaveBeenCalledWith('Approved', 'acme/app#7');
    expect(usePullRequestStore.getState().patchRow).toHaveBeenCalledWith('pr1', next);
  });

  it('sends a trimmed comment when one is typed', async () => {
    submitReview.mockResolvedValue({ review: { id: 1, state: 'APPROVED', url: '' }, row: null });
    open(row());
    fireEvent.click(approveButton()!);
    fireEvent.change(comment(), { target: { value: '  Looks good  ' } });
    fireEvent.click(inDialog('Approve'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(submitReview).toHaveBeenCalledWith('pr1', { event: 'approve', body: 'Looks good' });
    expect(trackEvent).toHaveBeenCalledWith('pr_review_submitted', {
      event: 'approve',
      has_comment: true,
    });
  });

  it('sends with Cmd+Enter from the comment box', async () => {
    submitReview.mockResolvedValue({ review: { id: 1, state: 'APPROVED', url: '' }, row: null });
    open(row());
    fireEvent.click(approveButton()!);
    fireEvent.keyDown(comment(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(submitReview).toHaveBeenCalledWith('pr1', { event: 'approve' }));
  });

  it('closes on Escape without sending', () => {
    open(row());
    fireEvent.click(approveButton()!);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(submitReview).not.toHaveBeenCalled();
  });
});

describe('Request changes', () => {
  it('keeps submit disabled until a comment is typed, then submits', async () => {
    submitReview.mockResolvedValue({
      review: { id: 2, state: 'CHANGES_REQUESTED', url: '' },
      row: null,
    });
    open(row());
    fireEvent.click(requestButton()!);
    expect(dialog().textContent).toContain('Request changes on acme/app#7');
    expect(inDialog('Request changes').disabled).toBe(true);

    fireEvent.change(comment(), { target: { value: '   ' } });
    expect(inDialog('Request changes').disabled).toBe(true);
    fireEvent.keyDown(comment(), { key: 'Enter', ctrlKey: true });
    expect(submitReview).not.toHaveBeenCalled();

    fireEvent.change(comment(), { target: { value: 'Please add a test' } });
    expect(inDialog('Request changes').disabled).toBe(false);
    fireEvent.click(inDialog('Request changes'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(submitReview).toHaveBeenCalledWith('pr1', {
      event: 'request_changes',
      body: 'Please add a test',
    });
    expect(trackEvent).toHaveBeenCalledWith('pr_review_submitted', {
      event: 'request_changes',
      has_comment: true,
    });
    expect(toast.success).toHaveBeenCalledWith('Changes requested', 'acme/app#7');
  });
});

describe('a failed review', () => {
  it.each([
    ['approve', 'Approve', 'GitHub does not let you approve or request changes on your own pull request.'],
    ['request_changes', 'Request changes', 'GitHub is rate limiting Talyn. The review was not sent. Try again in a few minutes.'],
  ])('shows the server message and keeps the comment (%s)', async (_event, label, message) => {
    submitReview.mockRejectedValue(new Error(message));
    open(row());
    fireEvent.click(label === 'Approve' ? approveButton()! : requestButton()!);
    fireEvent.change(comment(), { target: { value: 'My comment' } });
    fireEvent.click(inDialog(label));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message));
    expect(dialog()).toBeTruthy();
    expect(comment().value).toBe('My comment');
    expect(inDialog(label).disabled).toBe(false);
    expect(trackEvent).not.toHaveBeenCalledWith('pr_review_submitted', expect.anything());
    expect(toast.success).not.toHaveBeenCalled();
  });
});
