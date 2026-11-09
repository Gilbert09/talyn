import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, waitFor, cleanup, screen } from '@testing-library/react';
import type { PRRow } from '../lib/api';
import { PRTable } from '../components/panels/github/prTableShared';
import { toast } from '../stores/toast';

/**
 * The PR row's copy button copies the plain PR URL on a click. A right-click
 * opens a menu that can also copy the PR as a Markdown link.
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

const URL = 'https://github.com/acme/app/pull/7';

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
      title: 'Fix the thing',
      author: 'octocat',
      draft: false,
      headBranch: 'h',
      baseBranch: 'main',
      headSha: 'abc',
      updatedAt: '',
      url: URL,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      blockingReason: 'mergeable',
      checks: { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 },
    } as PRRow['summary'],
  } as PRRow;
}

function renderRow(onSelect = vi.fn()) {
  render(
    <PRTable
      rows={[row()]}
      variant="mine"
      viewerLogin="octocat"
      selectedId={null}
      onSelect={onSelect}
      onOpenTask={vi.fn()}
      onStopTask={vi.fn()}
      onMerge={vi.fn()}
      onSetMergeQueue={vi.fn()}
      onCreatePostHogTask={vi.fn()}
      taskStatusById={new Map()}
    />,
  );
  return onSelect;
}

const copyButton = () => document.querySelector('[data-attr="pr-row-copy-link"]')!;
let writeText: ReturnType<typeof vi.fn>;

// jsdom has no DOMRect.fromRect, which the Radix context menu uses to place itself.
beforeAll(() => {
  (globalThis as { DOMRect: unknown }).DOMRect = class {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    static fromRect(rect: { x?: number; y?: number; width?: number; height?: number } = {}) {
      return new (globalThis.DOMRect as new (...args: (number | undefined)[]) => DOMRect)(rect.x, rect.y, rect.width, rect.height);
    }
    get left() { return this.x; }
    get top() { return this.y; }
    get right() { return this.x + this.width; }
    get bottom() { return this.y + this.height; }
  };
});

beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PR row copy button', () => {
  it('copies the plain URL on click, without selecting the row', async () => {
    const onSelect = renderRow();

    fireEvent.click(copyButton());

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    ['Copy link', URL],
    ['Copy as Markdown link', `[Fix the thing](${URL})`],
  ])('right-click menu item "%s" copies %s', async (label, expected) => {
    const onSelect = renderRow();

    fireEvent.contextMenu(copyButton());
    fireEvent.click(await screen.findByText(label));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows an error toast when the clipboard write fails', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    renderRow();

    fireEvent.click(copyButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy to clipboard'));
  });
});
