import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import type { PRRow } from '../renderer/lib/api';
import { PRTable } from '../renderer/components/panels/github/prTableShared';

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
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

jest.mock('../renderer/lib/api', () => ({ api: {} }));
jest.mock('../renderer/hooks/useSkills', () => ({ useSkills: jest.fn() }));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: () => ({ currentWorkspaceId: 'ws1' }),
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
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
      onSelect={jest.fn()}
      onOpenTask={jest.fn()}
      onStopTask={jest.fn()}
      onMerge={jest.fn()}
      onSetMergeQueue={jest.fn()}
      onCreatePostHogTask={jest.fn()}
      taskStatusById={new Map()}
    />,
  );
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
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

// Tom, 2026-11-03: a PR whose session was ready and idle showed "Needs you"
// with "The session ... is working on this pull request". A session at work
// (its own turn, or the fix the queue sent it) is a wait with nothing for the
// reader to do, so it gets a neutral badge and never "Needs you".
describe('PR row merge-queue chip for a session', () => {
  function renderQueue(
    mergeQueue: Record<string, unknown>,
    variant: 'mine' | 'queue' = 'mine',
  ) {
    const r = row(mergeQueue as unknown as PRRow['mergeQueue']);
    (r as { session?: unknown }).session = { id: 'wb1', name: 'paris', status: 'ready' };
    render(
      <PRTable
        rows={[r]}
        variant={variant}
        viewerLogin="octocat"
        selectedId={null}
        onSelect={jest.fn()}
        onOpenTask={jest.fn()}
        onStopTask={jest.fn()}
        onMerge={jest.fn()}
        onSetMergeQueue={jest.fn()}
        onCreatePostHogTask={jest.fn()}
        taskStatusById={new Map()}
      />,
    );
  }

  it('says "Session working", not "Needs you", while the session works the PR', () => {
    renderQueue({
      status: 'blocked',
      position: 3,
      blockedCode: 'session_active',
      reason: 'The session "paris" is working on this pull request now. The merge queue waits for its turn to end.',
    });

    const chip = screen.getByText('Session working');
    expect(chip.closest('span')?.getAttribute('title')).toBe(
      'The session "paris" is working on this pull request now. The merge queue waits for its turn to end.',
    );
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
    expect(screen.queryByText('Blocked')).not.toBeInTheDocument();
    expect(screen.getByText('Queued #3')).toBeInTheDocument();
  });

  it('says "Session fixing" when the queue sent the fix into the session', () => {
    renderQueue({ status: 'fixing', position: 2, fixKind: 'session' });

    const chip = screen.getByText('Session fixing');
    expect(chip.closest('span')?.getAttribute('title')).toBe(
      'The merge queue asked the session "paris" to fix this pull request. It waits for the session\'s turn to end.',
    );
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
  });

  it.each([
    ['an ordinary fix run', { status: 'fixing', position: 1, fixKind: 'blockers' }],
    ['a needs-human stop', { status: 'blocked', position: 1, blockedCode: 'agent_needs_human' }],
    ['a waiting entry', { status: 'queued', position: 1 }],
  ])('shows no session chip for %s', (_label, mq) => {
    renderQueue(mq);

    expect(screen.queryByText('Session working')).not.toBeInTheDocument();
    expect(screen.queryByText('Session fixing')).not.toBeInTheDocument();
  });

  it('labels the queue column "Session working" for a session park', () => {
    renderQueue({ status: 'blocked', position: 1, blockedCode: 'session_active', reason: 'r.' }, 'queue');

    expect(screen.getByText('Session working')).toBeInTheDocument();
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
  });

  it('labels the queue column "Session fixing" with the fix budget', () => {
    renderQueue(
      { status: 'fixing', position: 1, fixKind: 'session', budgets: { fixRuns: [1, 3], checkReruns: [0, 3], resigns: [0, 3] } },
      'queue',
    );

    expect(screen.getByText(/Session fixing \(2\/3\)/)).toBeInTheDocument();
    expect(screen.queryByText(/^Fixing/)).not.toBeInTheDocument();
  });
});
