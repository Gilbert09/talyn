import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { PRRow } from '../lib/api';
import { PRTable } from '../components/panels/github/prTableShared';
import { toast } from '../stores/toast';

/**
 * The PR row's merge button is a two-step: click arms it, the second click
 * merges. The arm has to be SPENT by the attempt, however the attempt ends.
 *
 * It used to be cleared only in the failure branch. A merge that lands removes
 * the row, so nobody saw the leftover arm — but when an external merge queue
 * owns the base branch the backend SUBMITS the PR instead of merging it, the PR
 * stays open, and the row survives with `canMerge` still true. The spent confirm
 * then rendered as a live "Confirm" on a PR that had just been submitted, which
 * reads as "that did not work, press it again". Pressing it again is the
 * expensive half: the backend finds the provider already holding the PR, falls
 * through to a direct merge the gate refuses, and answers 400 on a healthy PR.
 *
 * Duplicated from apps/desktop on purpose: the renderer is a deliberate fork.
 */

vi.mock('../lib/api', () => ({ api: {} }));
vi.mock('../hooks/useSkills', () => ({ useSkills: vi.fn() }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: () => ({ currentWorkspaceId: 'ws1' }),
}));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

function row(): PRRow {
  return {
    id: 'pr1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskId: null,
    owner: 'acme',
    repo: 'app',
    number: 7,
    state: 'open',
    reviewRequested: false,
    authored: true,
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
      author: 'octocat',
      draft: false,
      headBranch: 'h',
      baseBranch: 'main',
      headSha: 'abc',
      updatedAt: '',
      url: 'https://github.com/acme/app/pull/7',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      // What makes the merge affordance appear at all.
      blockingReason: 'mergeable',
      checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
  } as PRRow;
}

function renderRow(onMerge: (r: PRRow) => Promise<void>) {
  render(
    <PRTable
      rows={[row()]}
      variant="mine"
      viewerLogin="octocat"
      selectedId={null}
      onSelect={vi.fn()}
      onOpenTask={vi.fn()}
      onStopTask={vi.fn()}
      onMerge={onMerge}
      onSetMergeQueue={vi.fn()}
      onCreatePostHogTask={vi.fn()}
      taskStatusById={new Map()}
    />,
  );
}

const mergeButton = () => document.querySelector('[data-attr="pr-row-merge"]');
const confirmButton = () => document.querySelector('[data-attr="pr-row-merge-confirm"]');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PR row merge confirm', () => {
  it('arms on the first click', () => {
    renderRow(vi.fn(async () => {}));

    expect(confirmButton()).not.toBeInTheDocument();
    fireEvent.click(mergeButton()!);
    expect(confirmButton()).toBeInTheDocument();
  });

  it('disarms once a submit-to-queue attempt finishes and the row survives', async () => {
    // The external-merge-queue path: `onMerge` resolves, and deliberately does
    // NOT remove the row — the PR stays open until that queue lands it.
    renderRow(vi.fn(async () => {}));

    fireEvent.click(mergeButton()!);
    fireEvent.click(confirmButton()!);

    // The button that invited the second, expensive click must be gone.
    await waitFor(() => expect(confirmButton()).not.toBeInTheDocument());
    expect(mergeButton()).toBeInTheDocument();
  });

  it('calls the merge handler exactly once per confirm', async () => {
    const onMerge = vi.fn(async () => {});
    renderRow(onMerge);

    fireEvent.click(mergeButton()!);
    fireEvent.click(confirmButton()!);

    await waitFor(() => expect(onMerge).toHaveBeenCalledTimes(1));
    // Re-arming is a deliberate act, so the only way to call it again is two
    // more clicks — never one.
    expect(confirmButton()).not.toBeInTheDocument();
  });

  it('disarms on failure too, and says why', async () => {
    renderRow(vi.fn(async () => {
      throw new Error('At least 1 approving review is required');
    }));

    fireEvent.click(mergeButton()!);
    fireEvent.click(confirmButton()!);

    await waitFor(() => expect(confirmButton()).not.toBeInTheDocument());
    // On the row the reason is a toast and a hover title — GitHub's own wording
    // is the useful part, so it must survive to at least one of them.
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('acme/app#7'),
      expect.stringContaining('approving review is required'),
    );
    expect(document.querySelector('[title*="approving review is required"]')).toBeInTheDocument();
  });
});
