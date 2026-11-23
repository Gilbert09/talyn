import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { TaskStatus } from '@talyn/shared';
import type { PRRow } from '../lib/api';
import { PRTable } from '../components/panels/github/prTableShared';

/**
 * The linked-task chip for a run paused for CI (`waiting_ci`). It reads as
 * running work, with its own words, and the row offers no second run.
 *
 * Duplicated in apps/desktop on purpose: the renderer is a deliberate fork.
 */

vi.mock('../lib/api', () => ({ api: {} }));
vi.mock('../hooks/useSkills', () => ({ useSkills: vi.fn() }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: { currentWorkspaceId: string; tasks: unknown[] }) => unknown) =>
    selector({ currentWorkspaceId: 'ws1', tasks: [] }),
}));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../lib/openExternal', () => ({ openExternal: vi.fn(() => Promise.resolve()), isOpenInBrowserClick: () => false }));
const fn = vi.fn;

function row(over: Partial<PRRow> = {}): PRRow {
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
      blockingReason: 'checks_failed',
      ciStatus: 'running',
      checks: { total: 3, passed: 1, failed: 2, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
    ...over,
  } as PRRow;
}


function renderRow(status: TaskStatus) {
  render(
    <PRTable
      rows={[row({ taskId: 'task1' })]}
      variant="mine"
      viewerLogin="octocat"
      selectedId={null}
      onSelect={fn()}
      onOpenTask={fn()}
      onStopTask={fn()}
      onMerge={fn()}
      onSetMergeQueue={fn()}
      onCreatePostHogTask={fn()}
      taskStatusById={new Map([['task1', status]])}
    />,
  );
}

afterEach(() => cleanup());

describe('PR row — a run paused for CI', () => {
  it('says Waiting for CI, not Working', () => {
    renderRow('waiting_ci');
    const chip = screen.getByText('Waiting for CI').closest('button')!;
    expect(chip.getAttribute('title')).toContain('paused until CI finishes');
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
  });

  it.each<[TaskStatus, string]>([
    ['in_progress', 'Working'],
    ['queued', 'Working'],
  ])('still says %s for a running run', (status, label) => {
    renderRow(status);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText('Waiting for CI')).not.toBeInTheDocument();
  });

  it('offers Stop instead of a second run', () => {
    renderRow('waiting_ci');
    expect(document.querySelector('[data-attr="pr-row-stop-task"]')).not.toBeNull();
  });
});
