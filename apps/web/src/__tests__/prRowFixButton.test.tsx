import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { PRRow } from '../lib/api';
import { toast } from '../stores/toast';
import { trackEvent } from '../lib/analytics';
import { PRTable } from '../components/panels/github/prTableShared';

/**
 * The PR row's fix control, after it stopped being a silent 14px icon.
 *
 * Two things are under test, and they are the same change seen from both
 * ends. It carries a WORD, because the click data showed people using every
 * labelled control around it and never this one. And when it cannot run it
 * REFUSES OUT LOUD — a `disabled` attribute fires no click, so "nobody wants
 * to delegate from here" and "we refuse nearly every PR they try" were the
 * same absence in the funnel.
 *
 * Duplicated in apps/desktop on purpose: the renderer is a deliberate fork.
 */

vi.mock('../lib/api', () => ({ api: {} }));
vi.mock('../hooks/useSkills', () => ({ useSkills: vi.fn() }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: () => ({ currentWorkspaceId: 'ws1' }),
}));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

/** `fixable: false` is a clean, approved, green PR — nothing to point an agent at. */
function row(fixable: boolean): PRRow {
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
      mergeStateStatus: fixable ? 'UNSTABLE' : 'CLEAN',
      reviewDecision: fixable ? null : 'APPROVED',
      blockingReason: fixable ? 'checks_failed' : 'mergeable',
      checks: fixable
        ? { total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 }
        : { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
  };
}

function renderRow(fixable: boolean) {
  const onCreatePostHogTask = vi.fn(async () => true);
  render(
    <PRTable
      rows={[row(fixable)]}
      variant="mine"
      viewerLogin="octocat"
      selectedId={null}
      onSelect={vi.fn()}
      onOpenTask={vi.fn()}
      onStopTask={vi.fn()}
      onMerge={vi.fn()}
      onSetMergeQueue={vi.fn()}
      onCreatePostHogTask={onCreatePostHogTask}
      taskStatusById={new Map()}
    />
  );
  return { onCreatePostHogTask };
}

const fixButton = () =>
  document.querySelector('[data-attr="pr-row-fix-with-posthog"]') as HTMLButtonElement;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PR row fix button — the label', () => {
  it.each([true, false])('reads "Fix" whether or not it can run (fixable: %s)', (fixable) => {
    renderRow(fixable);
    expect(fixButton().textContent).toContain('Fix');
  });

  it('is findable by its accessible name, not only by a data attribute', () => {
    renderRow(true);
    expect(screen.getByText('Fix')).toBeTruthy();
  });
});

describe('PR row fix button — refusing out loud', () => {
  it('stays clickable when there is nothing to fix', () => {
    renderRow(false);
    // aria-disabled, NOT disabled. A disabled button fires no click, and the
    // click is the only evidence that somebody wanted to delegate this PR.
    expect(fixButton().disabled).toBe(false);
    expect(fixButton().getAttribute('aria-disabled')).toBe('true');
  });

  it('records the refusal and explains it, instead of dispatching', async () => {
    const { onCreatePostHogTask } = renderRow(false);
    fireEvent.click(fixButton());
    await waitFor(() =>
      expect(trackEvent).toHaveBeenCalledWith('pr_fix_blocked', {
        source: 'pr_row',
        reason: 'no_fixable_issues',
        repo: 'acme/app',
        pr_number: 7,
        blocking_reason: 'mergeable',
      })
    );
    expect(toast.info).toHaveBeenCalledWith(
      'Nothing to hand to an agent',
      expect.stringContaining('Nothing to fix')
    );
    expect(onCreatePostHogTask).not.toHaveBeenCalled();
  });
});

describe('PR row fix button — dispatching', () => {
  it('starts the run and records no refusal when the PR is fixable', async () => {
    const { onCreatePostHogTask } = renderRow(true);
    expect(fixButton().getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(fixButton());
    await waitFor(() =>
      expect(onCreatePostHogTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'pr1' }),
        undefined,
        undefined
      )
    );
    expect(trackEvent).not.toHaveBeenCalledWith('pr_fix_blocked', expect.anything());
    expect(toast.info).not.toHaveBeenCalled();
  });
});

/**
 * The purple REVIEW badge. On the Reviews tab being a requested reviewer is
 * the entry condition, so it rendered on every row and separated nothing —
 * noise wearing the colour of information. It is still a fact worth stating
 * on any other list, where the row might not be there for that reason.
 */
describe('the REVIEW badge', () => {
  function renderVariant(variant: 'mine' | 'review') {
    const r = row(true);
    render(
      <PRTable
        rows={[{ ...r, reviewRequested: true }]}
        variant={variant}
        viewerLogin="octocat"
        selectedId={null}
        onSelect={vi.fn()}
        onOpenTask={vi.fn()}
        onStopTask={vi.fn()}
        onMerge={vi.fn()}
        onSetMergeQueue={vi.fn()}
        onCreatePostHogTask={vi.fn(async () => true)}
        taskStatusById={new Map()}
      />
    );
  }

  it('is hidden on the Reviews tab, where every row would carry it', () => {
    renderVariant('review');
    expect(screen.queryByText('Review')).toBeNull();
  });

  it('still shows on My PRs, where it says something about the row', () => {
    renderVariant('mine');
    expect(screen.getByText('Review')).toBeTruthy();
  });

  it('is absent when the viewer was never asked to review', () => {
    render(
      <PRTable
        rows={[row(true)]}
        variant="mine"
        viewerLogin="octocat"
        selectedId={null}
        onSelect={vi.fn()}
        onOpenTask={vi.fn()}
        onStopTask={vi.fn()}
        onMerge={vi.fn()}
        onSetMergeQueue={vi.fn()}
        onCreatePostHogTask={vi.fn(async () => true)}
        taskStatusById={new Map()}
      />
    );
    expect(screen.queryByText('Review')).toBeNull();
  });
});
