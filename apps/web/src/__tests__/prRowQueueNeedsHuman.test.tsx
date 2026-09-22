import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PRRow } from '../lib/api';
import { PRTable } from '../components/panels/github/prTableShared';

/**
 * The merge-queue chip on a PR row, when the queue is parked.
 *
 * "Blocked" was one amber chip for every cause, because the row read
 * `mergeQueue.status` and threw `blockedCode` away — the field has been on the
 * wire for as long as the queue has recorded causes, and NOTHING in either
 * front end read it. So a PR parked because twelve visual-review snapshots need
 * a human was reported as one the queue had given up on after three failed
 * attempts: the opposite of the truth, on the two states where no attempt was
 * spent and where clearing the gate resumes the queue by itself.
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

function row(mergeQueue: PRRow['mergeQueue']): PRRow {
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
    mergeQueued: true,
    mergeQueue,
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
      mergeStateStatus: 'UNSTABLE',
      reviewDecision: null,
      blockingReason: 'checks_failed',
      checks: { total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
  } as PRRow;
}

function renderBlocked(blockedCode: string | null, reason?: string) {
  render(
    <PRTable
      rows={[
        row({
          status: 'blocked',
          position: 3,
          blockedCode,
          reason,
        } as PRRow['mergeQueue']),
      ]}
      variant="mine"
      viewerLogin="octocat"
      selectedId={null}
      onSelect={vi.fn()}
      onOpenTask={vi.fn()}
      onStopTask={vi.fn()}
      onMerge={vi.fn()}
      onSetMergeQueue={vi.fn()}
      onCreatePostHogTask={vi.fn()}
      taskStatusById={new Map()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PR row merge-queue chip', () => {
  it.each(['awaiting_human_check', 'agent_needs_human'])(
    'says the queue needs you, not that it gave up, for %s',
    (code) => {
      renderBlocked(code);

      expect(screen.getByText('Needs you')).toBeInTheDocument();
      expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
    },
  );

  it('still reports a genuine give-up as blocked', () => {
    renderBlocked('no_progress');

    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
  });

  it('reads an absent code as an ordinary block', () => {
    // Entries parked before the queue recorded causes, and anything a newer
    // backend invents. The safe direction: never promise it self-heals.
    renderBlocked(null);

    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
  });

  it('keeps the queue-position chip alongside either face', () => {
    // The membership badge is a separate fact from the activity badge and has
    // to survive the split — losing it would drop "where in the queue am I".
    renderBlocked('awaiting_human_check');

    expect(screen.getByText('Queued #3')).toBeInTheDocument();
  });

  it('explains the wait with the queue’s own reason, and promises no retry', () => {
    renderBlocked(
      'awaiting_human_check',
      'Waiting on a human to review 12 visual-review snapshot(s).',
    );

    const title = screen.getByText('Needs you').closest('span')?.getAttribute('title') ?? '';
    expect(title).toContain('12 visual-review snapshot(s)');
    expect(title).toContain('waiting on you');
    // The sentence that was wrong: nothing was attempted and nothing was spent.
    expect(title).not.toContain('gave up');
    expect(title).not.toContain('3 attempts');
  });
});
