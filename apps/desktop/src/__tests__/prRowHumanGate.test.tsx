import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { PRHumanGate, PRRow } from '../renderer/lib/api';
import { PRTable, isNeedsAttention } from '../renderer/components/panels/github/prTableShared';
import { openExternal } from '../renderer/lib/openExternal';

/**
 * The "Needs human" chip. It reads the PR's own checks, so it shows on every
 * open PR whose Visual Review is waiting for a person — not only on one the
 * merge queue, auto-keep or a linked task happens to be watching. It was asked
 * for several times; every earlier "Needs you" hung off one of those three.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

jest.mock('../renderer/lib/api', () => ({ api: {} }));
jest.mock('../renderer/hooks/useSkills', () => ({ useSkills: jest.fn() }));
let taskReason: string | undefined;
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: { currentWorkspaceId: string; tasks: unknown[] }) => unknown) =>
    selector({
      currentWorkspaceId: 'ws1',
      tasks: [{ id: 'task1', result: { needsHuman: { reason: taskReason } } }],
    }),
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../renderer/lib/openExternal', () => ({
  openExternal: jest.fn(() => Promise.resolve()),
  isOpenInBrowserClick: () => false,
}));

const VR: PRHumanGate = {
  id: 'posthog_visual_review',
  label: 'Visual review',
  name: 'PostHog Visual Review / storybook',
  url: 'https://us.posthog.com/visual_review/runs/1',
};

function row(over: Partial<PRRow> = {}, humanGates?: PRHumanGate[]): PRRow {
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
    mergeQueue: null,
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
      mergeStateStatus: 'BLOCKED',
      reviewDecision: null,
      blockingReason: humanGates?.length ? 'needs_human' : 'mergeable',
      ciStatus: humanGates?.length ? 'needs_human' : 'passing',
      humanGates,
      checks: { total: 3, passed: 1, failed: 2, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
    ...over,
  } as PRRow;
}

function renderRows(
  rows: PRRow[],
  variant: 'mine' | 'queue' = 'mine',
  taskStatusById = new Map<string, 'needs_human'>(),
) {
  render(
    <PRTable
      rows={rows}
      variant={variant}
      viewerLogin="octocat"
      selectedId={null}
      onSelect={jest.fn()}
      onOpenTask={jest.fn()}
      onStopTask={jest.fn()}
      onMerge={jest.fn()}
      onSetMergeQueue={jest.fn()}
      onCreatePostHogTask={jest.fn()}
      taskStatusById={taskStatusById}
    />,
  );
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  taskReason = undefined;
});

describe('PR row — Needs human chip', () => {
  it('shows on a PR nobody is queueing or watching', () => {
    renderRows([row({}, [VR])]);

    const chip = screen.getByText('Needs human', { selector: 'button' });
    expect(chip).toBeInTheDocument();
    expect(chip.getAttribute('title')).toContain('PostHog Visual Review / storybook');
  });

  it('combines task and PR reasons in one person badge', () => {
    taskReason = 'Please approve the deployment.';
    renderRows([row({ taskId: 'task1' }, [VR])], 'mine', new Map([['task1', 'needs_human']]));

    const chip = screen.getByText('Needs you', { selector: 'button' });
    expect(screen.getAllByText('Needs you')).toHaveLength(1);
    expect(chip.querySelector('svg.lucide-user-round-check')).toBeInTheDocument();
    expect(chip.getAttribute('title')).toContain('The agent stopped: Please approve the deployment.');
    expect(chip.getAttribute('title')).toContain('Needs a person: Visual review');
    expect(chip.getAttribute('title')).toContain('\n');
  });

  it('shows the task badge and its reason when only the task needs a person', () => {
    taskReason = 'Please approve the deployment.';
    renderRows([row({ taskId: 'task1' })], 'mine', new Map([['task1', 'needs_human']]));

    const chip = screen.getByText('Needs you', { selector: 'button' });
    expect(screen.getAllByText('Needs you')).toHaveLength(1);
    expect(chip.getAttribute('title')).toContain('The agent stopped: Please approve the deployment.');
  });

  it('combines a task stop with the watcher reason', () => {
    taskReason = 'Please approve the deployment.';
    renderRows(
      [row({ taskId: 'task1', autoKeepMergeable: true, autoMergeState: { needsHuman: { reason: 'Review required.' } } } as Partial<PRRow>)],
      'mine',
      new Map([['task1', 'needs_human']]),
    );

    const chip = screen.getByText('Needs you');
    expect(screen.getAllByText('Needs you')).toHaveLength(1);
    expect(chip.closest('span')?.getAttribute('title')).toContain('The agent stopped: Please approve the deployment.\nThe run stopped and needs you: Review required.');
  });

  it.each(['mine', 'queue'] as const)('combines a task stop with the merge queue reason on %s', (variant) => {
    taskReason = 'Please approve the deployment.';
    renderRows(
      [row({
        taskId: 'task1',
        mergeQueued: true,
        mergeQueue: {
          status: 'blocked',
          position: 2,
          blockedCode: 'agent_needs_human',
          reason: 'Review required.',
        } as PRRow['mergeQueue'],
      })],
      variant,
      new Map([['task1', 'needs_human']]),
    );

    const chip = screen.getByText('Needs you');
    expect(screen.getAllByText('Needs you')).toHaveLength(1);
    expect(chip.closest('span')?.getAttribute('title')).toContain('The agent stopped: Please approve the deployment.\n');
    expect(chip.closest('span')?.getAttribute('title')).toContain('Review required.');
    if (variant === 'mine') expect(screen.getByText('Queued #2')).toBeInTheDocument();
  });

  it.each([
    ['no gates', undefined],
    ['an empty list', []],
  ])('does not show with %s', (_label, gates) => {
    renderRows([row({}, gates)]);

    expect(screen.queryByText('Needs human', { selector: 'button' })).not.toBeInTheDocument();
  });

  it('does not show on a PR that is no longer open', () => {
    renderRows([row({ state: 'merged' }, [VR])]);

    expect(screen.queryByText('Needs human', { selector: 'button' })).not.toBeInTheDocument();
  });

  it('opens the run a person has to approve', () => {
    renderRows([row({}, [VR])]);

    fireEvent.click(screen.getByText('Needs human', { selector: 'button' }));
    expect(openExternal).toHaveBeenCalledWith(VR.url);
  });

  it('is the one chip when the queue parked on the same gate', () => {
    renderRows([
      row(
        {
          mergeQueued: true,
          mergeQueue: {
            status: 'blocked',
            position: 2,
            blockedCode: 'awaiting_human_check',
          } as PRRow['mergeQueue'],
        },
        [VR],
      ),
    ]);

    expect(screen.getByText('Needs human', { selector: 'button' })).toBeInTheDocument();
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
    expect(screen.getByText('Queued #2')).toBeInTheDocument();
  });
});

describe('Merge Queue page — Queue column', () => {
  it.each([
    ['awaiting_human_check', 'Needs you'],
    ['agent_needs_human', 'Needs you'],
    ['no_progress', 'Blocked'],
  ])('reads %s as "%s"', (blockedCode, label) => {
    renderRows(
      [
        row({
          mergeQueued: true,
          mergeQueue: {
            status: 'blocked',
            position: 1,
            blockedCode,
            reason: 'Waiting on a human to review 2 visual-review snapshot(s).',
          } as PRRow['mergeQueue'],
        }),
      ],
      'queue',
    );

    const cell = screen.getByText(label);
    const title = cell.closest('span')?.getAttribute('title') ?? '';
    if (label === 'Needs you') {
      // A push re-runs CI and raises the same gate — it does not self-heal.
      expect(title).not.toContain('Self-heals on a new push');
    } else {
      expect(title).toContain('Self-heals on a new push');
    }
  });
});

describe('isNeedsAttention', () => {
  it('counts a PR only a person can unblock', () => {
    expect(isNeedsAttention(row({}, [VR]))).toBe(true);
  });
});
