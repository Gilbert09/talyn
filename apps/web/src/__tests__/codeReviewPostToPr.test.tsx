import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react';
import type { CodeReviewFinding, CodeReviewPublic } from '@talyn/shared';
import {
  FindingsTab,
  postToPrState,
} from '../components/widgets/codeReview/FindingsTab';
import { api } from '../lib/api';
import { toast } from '../stores/toast';

/**
 * "Post to PR" writes on GitHub under the user's own name, and Talyn cannot
 * take it back. So the button must say how many comments it will write, must
 * never count a finding that is on the pull request already, and must do
 * nothing until the confirmation is accepted.
 *
 * Duplicated from apps/desktop on purpose: the renderer is a deliberate fork.
 */

vi.mock('../lib/api', () => ({
  api: {
    pullRequests: {
      codeReview: vi.fn(),
      postCodeReviewFindings: vi.fn(),
      codeReviewFinding: vi.fn(),
    },
  },
}));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ workspaces: [], currentWorkspaceId: 'ws1' }),
}));
vi.mock('../stores/billing', () => ({ maybeHandleBillingLimit: vi.fn(() => false) }));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../lib/markdown', () => ({
  Markdown: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock('@pierre/diffs/react', () => ({ PatchDiff: () => null }));

const mocked = api.pullRequests as unknown as {
  codeReview: Mock;
  postCodeReviewFindings: Mock;
};

function review(over: Partial<CodeReviewPublic> = {}): CodeReviewPublic {
  return {
    id: 'rev-1',
    preset: 'standard',
    phase: 'ready',
    phasePlan: [],
    runsDone: 4,
    runsTotal: 4,
    lensesRun: [],
    chunkTotal: 1,
    headSha: 'a'.repeat(40),
    headShaShort: 'aaaaaaa',
    reviewedHeadSha: 'a'.repeat(40),
    staleForHead: false,
    counts: { blocker: 0, major: 3, minor: 0, nit: 0 },
    openCount: 3,
    dismissedCount: 0,
    funnel: { raised: 0, kept: 0, rejected: 0 },
    failureReason: null,
    deferredSince: null,
    fixTaskId: null,
    lastFix: null,
    startedAt: null,
    finishedAt: null,
    ...over,
  } as CodeReviewPublic;
}

function finding(id: string, over: Partial<CodeReviewFinding> = {}): CodeReviewFinding {
  return {
    id,
    // Not a blocker: a blocker opens itself and fetches its detail.
    severity: 'major',
    category: '',
    lenses: ['correctness'],
    filePath: 'src/a.ts',
    lineStart: 10,
    lineEnd: 10,
    anchorVerified: true,
    title: `Finding ${id}`,
    confidence: 80,
    verdict: 'confirmed',
    disposition: 'open',
    carriedOver: false,
    seenCount: 1,
    postedAt: null,
    ...over,
  };
}

function serve(findings: CodeReviewFinding[], over: Partial<CodeReviewPublic> = {}) {
  mocked.codeReview.mockResolvedValue({
    review: review(over),
    findings,
    defaultPreset: 'standard',
    pullRequest: { owner: 'acme', repo: 'app', number: 7 },
  });
}

const postButton = () =>
  document.querySelector('[data-attr="code-review-post"]') as HTMLButtonElement | null;

async function renderTab() {
  render(<FindingsTab pullRequestId="pr1" />);
  await waitFor(() => expect(screen.getByText('Finding f-1')).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('postToPrState', () => {
  const shown = [
    { id: 'a', postedAt: null },
    { id: 'b', postedAt: '2026-10-07T10:00:00.000Z' },
    { id: 'c', postedAt: null },
  ];

  it.each<[string, { running?: boolean; shown?: typeof shown; ticked?: string[] }, string, string[], boolean]>([
    ['nothing ticked posts everything not posted yet', {}, 'Post to PR', ['a', 'c'], false],
    ['one ticked', { ticked: ['a'] }, 'Post 1 to PR', ['a'], false],
    ['two ticked', { ticked: ['a', 'c'] }, 'Post 2 to PR', ['a', 'c'], false],
    ['a posted one among the ticks is not counted', { ticked: ['a', 'b'] }, 'Post 1 to PR', ['a'], false],
    ['only a posted one ticked', { ticked: ['b'] }, 'Post to PR', [], true],
    ['a tick for a finding that is not shown is ignored', { ticked: ['gone'] }, 'Post to PR', ['a', 'c'], false],
    ['everything posted', { shown: [shown[1]!] }, 'Post to PR', [], true],
    ['no findings', { shown: [] }, 'Post to PR', [], true],
    ['a review that is running', { running: true }, 'Post to PR', ['a', 'c'], true],
    ['a review that is running, with ticks', { running: true, ticked: ['a'] }, 'Post 1 to PR', ['a'], true],
  ])('%s', (_label, input, label, ids, disabled) => {
    const state = postToPrState({
      running: input.running ?? false,
      shown: input.shown ?? shown,
      ticked: new Set(input.ticked ?? []),
    });
    expect(state.label).toBe(label);
    expect(state.ids).toEqual(ids);
    expect(state.disabledReason !== null).toBe(disabled);
  });

  it('gives a different reason for each way it is disabled', () => {
    const reasons = [
      postToPrState({ running: true, shown, ticked: new Set() }).disabledReason,
      postToPrState({ running: false, shown: [shown[1]!], ticked: new Set() }).disabledReason,
      postToPrState({ running: false, shown, ticked: new Set(['b']) }).disabledReason,
    ];
    expect(new Set(reasons).size).toBe(3);
    expect(reasons.every((r) => typeof r === 'string' && r.length > 0)).toBe(true);
  });
});

describe('FindingsTab: Post to PR', () => {
  it('shows the button with no count when nothing is ticked', async () => {
    serve([finding('f-1'), finding('f-2')]);
    await renderTab();
    expect(postButton()).toHaveTextContent(/^Post to PR$/);
    expect(postButton()).toBeEnabled();
  });

  it('shows the count of ticked findings', async () => {
    serve([finding('f-1'), finding('f-2'), finding('f-3')]);
    await renderTab();
    fireEvent.click(screen.getByLabelText('Select "Finding f-1" to fix'));
    fireEvent.click(screen.getByLabelText('Select "Finding f-3" to fix'));
    expect(postButton()).toHaveTextContent(/^Post 2 to PR$/);
  });

  it('is disabled, with the reason, when every finding is on the pull request', async () => {
    serve([finding('f-1', { postedAt: '2026-10-07T10:00:00.000Z' })]);
    await renderTab();
    expect(postButton()).toBeDisabled();
    expect(postButton()).toHaveAttribute(
      'title',
      'Every finding shown is already on the pull request.'
    );
  });

  it('is disabled, with the reason, while the review is running', async () => {
    serve([finding('f-1')], { phase: 'validating' });
    await renderTab();
    expect(postButton()).toBeDisabled();
    expect(postButton()).toHaveAttribute('title', 'Wait for the review to finish before you post.');
  });

  it('is absent when the list shows no finding', async () => {
    serve([]);
    render(<FindingsTab pullRequestId="pr1" />);
    await waitFor(() => expect(mocked.codeReview).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Nothing to flag.')).toBeInTheDocument());
    expect(postButton()).toBeNull();
  });

  it('marks a finding that is on the pull request, and only that one', async () => {
    serve([finding('f-1', { postedAt: '2026-10-07T10:00:00.000Z' }), finding('f-2')]);
    await renderTab();
    const markers = document.querySelectorAll('[data-attr="code-review-finding-posted"]');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toHaveTextContent('Posted to PR');
    expect(markers[0]!.closest('button')).toHaveTextContent('Finding f-1');
  });

  it('asks first, and posts nothing when the answer is no', async () => {
    serve([finding('f-1'), finding('f-2')]);
    await renderTab();
    fireEvent.click(postButton()!);

    expect(screen.getByText('Post findings to the pull request?')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This writes 2 findings on acme/app#7 as a review comment from your GitHub account. You cannot undo it from Talyn.'
      )
    ).toBeInTheDocument();
    expect(mocked.postCodeReviewFindings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Post findings to the pull request?')).toBeNull();
    expect(mocked.postCodeReviewFindings).not.toHaveBeenCalled();
  });

  it('posts exactly the ticked findings after the confirmation', async () => {
    serve([finding('f-1'), finding('f-2'), finding('f-3')]);
    mocked.postCodeReviewFindings.mockResolvedValue({
      review: review(),
      posted: 1,
      inline: 1,
      inSummary: 0,
      reviewUrl: null,
    });
    await renderTab();
    fireEvent.click(screen.getByLabelText('Select "Finding f-2" to fix'));
    fireEvent.click(postButton()!);
    expect(
      screen.getByText(/This writes 1 finding on acme\/app#7 as a review comment/)
    ).toBeInTheDocument();

    // The page shows the updated findings after the post.
    serve([finding('f-1'), finding('f-2', { postedAt: '2026-10-07T10:00:00.000Z' }), finding('f-3')]);
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Post to PR')!
    );

    await waitFor(() =>
      expect(mocked.postCodeReviewFindings).toHaveBeenCalledWith('pr1', ['f-2'])
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Posted 1 finding to the pull request')
    );
    await waitFor(() =>
      expect(document.querySelectorAll('[data-attr="code-review-finding-posted"]')).toHaveLength(1)
    );
    expect(screen.queryByText('Post findings to the pull request?')).toBeNull();
    // The ticks are spent, so the button is back to "everything that is left".
    expect(postButton()).toHaveTextContent(/^Post to PR$/);
  });

  it('posts every finding shown that is not posted yet when nothing is ticked', async () => {
    serve([finding('f-1'), finding('f-2', { postedAt: '2026-10-07T10:00:00.000Z' }), finding('f-3')]);
    mocked.postCodeReviewFindings.mockResolvedValue({
      review: review(),
      posted: 2,
      inline: 2,
      inSummary: 0,
      reviewUrl: null,
    });
    await renderTab();
    fireEvent.click(postButton()!);
    fireEvent.click(
      Array.from(screen.getByRole('alertdialog').querySelectorAll('button')).find(
        (b) => b.textContent === 'Post to PR'
      )!
    );
    await waitFor(() =>
      expect(mocked.postCodeReviewFindings).toHaveBeenCalledWith('pr1', ['f-1', 'f-3'])
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Posted 2 findings to the pull request')
    );
  });

  it('shows the error from GitHub and closes the confirmation', async () => {
    serve([finding('f-1')]);
    mocked.postCodeReviewFindings.mockRejectedValue(new Error('Resource not accessible'));
    await renderTab();
    fireEvent.click(postButton()!);
    fireEvent.click(
      Array.from(screen.getByRole('alertdialog').querySelectorAll('button')).find(
        (b) => b.textContent === 'Post to PR'
      )!
    );
    await waitFor(() => expect(screen.getByText('Resource not accessible')).toBeInTheDocument());
    expect(screen.queryByText('Post findings to the pull request?')).toBeNull();
    expect(toast.success).not.toHaveBeenCalled();
    expect(postButton()).toBeEnabled();
  });
});
