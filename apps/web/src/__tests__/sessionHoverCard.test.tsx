import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SpaceSessionRow, Workbench, WorkbenchChat } from '@talyn/shared';

vi.mock('../lib/api', () => ({ api: { workbenches: {} } }));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { SidebarWorkbenchList } from '../components/layout/SidebarWorkbenchList';
import { SpaceSessionHoverCard } from '../components/workbench/SessionHoverCard';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { useWorkbenchStore } from '../stores/workbenches';
import { installNavigation, useNavigationStore } from '../stores/navigation';
import { usePullRequestStore } from '../stores/pullRequests';
import { useSessionBackgroundStore } from '../stores/sessionBackground';

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    title: 'Add signal sources for incident tables',
    branch: `tom/${id}`,
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    sandboxState: 'suspended',
    status: 'ready',
    pullRequestId: null,
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

function prRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pr1',
    number: 134522,
    state: 'open',
    mergedAt: null,
    summary: {
      title: 'feat: add signal sources for incident tables',
      author: 'octo',
      draft: false,
      url: 'https://github.com/acme/app/pull/134522',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'REVIEW_REQUIRED',
      blockingReason: 'checks_failed',
      ciStatus: 'failing_required',
      checks: { total: 14, passed: 10, failed: 2, inProgress: 1, skipped: 1 },
      additions: 120,
      deletions: 30,
      changedFiles: 8,
      ...over,
    },
  };
}

function store() {
  return useWorkbenchStore.getState();
}

function show() {
  render(<SidebarWorkbenchList workbenches={Object.values(store().workbenches)} />);
}

function row() {
  return document.querySelector('[data-attr="sidebar-workbench-row"]') as HTMLElement;
}

function card() {
  return document.querySelector('[data-attr="session-hover-card"]');
}

/** Radix opens a zero-delay tooltip on a zero-length timer: wait one tick. */
async function hover(element: HTMLElement) {
  await act(async () => {
    fireEvent.pointerMove(element, { pointerType: 'mouse' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeAll(() => {
  installNavigation();
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom has no DOMRect.fromRect, which the Radix context menu uses to place itself.
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
  useWorkbenchStore.setState({ unread: {}, unseen: {}, chats: {} });
  store().setWorkspace('ws1');
  store().setWorkbenches('ws1', [wb('incidents', { pullRequestId: 'pr1', uncommittedStats: { added: 4, removed: 1, files: 2 } })]);
  useWorkbenchStore.setState({ listLoaded: true, selectedWorkbenchId: null });
  usePullRequestStore.setState({ rows: [prRow()] as never });
  useSessionBackgroundStore.setState({ byWorkbench: {} });
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => cleanup());

describe('session hover card', () => {
  it('has no native title, so only the card shows', async () => {
    show();
    expect(row()).not.toHaveAttribute('title');
    expect(card()).toBeNull();
  });

  it('opens on the first hover with the session and pull request at a glance', async () => {
    store().upsertChat({
      id: 'c1',
      workbenchId: 'incidents',
      status: 'idle',
      agent: 'claude',
      model: 'claude-opus-5-5',
      createdAt: '2026-10-13T00:00:00Z',
      updatedAt: '2026-10-13T00:00:00Z',
    } as WorkbenchChat);
    show();
    await hover(row());
    const glance = card();
    expect(glance).not.toBeNull();
    const text = glance!.textContent ?? '';
    expect(text).toContain('Add signal sources for incident tables');
    expect(text).toContain('#134522 open, checks are failing');
    expect(text).toContain('acme/app');
    expect(text).toContain('tom/incidents');
    expect(text).toContain('→ main');
    expect(text).toContain('feat: add signal sources for incident tables');
    expect(text).toContain('Checks: 10 passed, 2 failed, 1 running, 1 skipped');
    expect(text).toContain('+120 −30 in 8 files');
    expect(text).toContain('by @octo');
    expect(text).toContain('Needs approval');
    expect(text).toContain('Uncommitted');
    expect(text).toContain('+4 −1 in 2 files');
    expect(text).toContain('Claude · Opus 5.5');
    expect(text).toContain('Asleep, wakes when you send a message');
    expect(text).toMatch(/⌥|Alt\+1/);
  });

  it('gives assistive tech a plain label', async () => {
    show();
    await hover(row());
    expect(screen.getByRole('tooltip')).toHaveTextContent('Add signal sources for incident tables. #134522 open, checks are failing.');
  });

  it('closes when the pointer goes down on the row', async () => {
    show();
    await hover(row());
    expect(card()).not.toBeNull();
    act(() => {
      fireEvent.pointerDown(row());
    });
    expect(card()).toBeNull();
  });

  it('opens when the row gets keyboard focus', async () => {
    show();
    await act(async () => {
      row().focus();
    });
    expect(card()).not.toBeNull();
  });

  it('stays closed when the row menu opens the archive dialog and gives focus back to the row', async () => {
    show();
    act(() => {
      fireEvent.contextMenu(row());
    });
    act(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Archive/ }));
    });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Archive Add signal sources for incident tables?');
    await act(async () => {
      row().focus();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await hover(row());
    expect(card()).toBeNull();
  });

  it('closes when a dialog opens over it', async () => {
    show();
    await hover(row());
    expect(card()).not.toBeNull();
    await act(async () => {
      render(<ConfirmDialog open title="Archive?" confirmLabel="Archive" onConfirm={() => {}} onCancel={() => {}} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(card()).toBeNull();
  });

  it('falls back to the workbench summary when the PR row is not loaded', async () => {
    usePullRequestStore.setState({ rows: [] as never });
    store().setWorkbenches('ws1', [
      wb('incidents', {
        pullRequestId: 'pr1',
        pr: { number: 77, url: 'https://github.com/acme/app/pull/77', state: 'merged', mergeable: 'unknown', ciStatus: 'none' },
      }),
    ]);
    show();
    await hover(row());
    const text = card()!.textContent ?? '';
    expect(text).toContain('#77');
    expect(text).toContain('Merged pull request');
    expect(text).not.toContain('Checks:');
  });

  it('shows a running background job', async () => {
    useSessionBackgroundStore.setState({
      byWorkbench: {
        incidents: {
          workbenchId: 'incidents',
          jobs: [{ id: 'j1', status: 'running', name: 'npm test' }],
          wakeups: [],
        },
      } as never,
    });
    show();
    await hover(row());
    expect(card()!.textContent).toContain('Running: npm test');
  });
});

describe('space session hover card', () => {
  const spaceRow = {
    id: 's1',
    spaceId: 'sp1',
    workspaceId: 'ws1',
    kind: 'session',
    threadId: null,
    name: 'lisbon',
    title: 'Fix the flaky test',
    status: 'ready',
    sandboxState: 'running',
    running: false,
    repoFullName: 'acme/api',
    branch: 'ana/flaky',
    baseBranch: 'main',
    agent: 'codex',
    model: null,
    pullRequest: { number: 9, state: 'open', url: 'https://github.com/acme/api/pull/9' },
    creator: { userId: 'u2', githubLogin: 'ana', avatarUrl: null },
    lastActivityAt: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
  } as SpaceSessionRow;

  it('shows who started it, the agent and the pull request', async () => {
    render(
      <SpaceSessionHoverCard row={spaceRow} state={{ kind: 'pr_waiting', label: '#9 open, waiting on checks or review' }}>
        <button type="button">row</button>
      </SpaceSessionHoverCard>
    );
    await hover(screen.getByText('row'));
    const text = card()!.textContent ?? '';
    expect(text).toContain('Fix the flaky test');
    expect(text).toContain('acme/api');
    expect(text).toContain('ana/flaky');
    expect(text).toContain('@ana');
    expect(text).toContain('Codex');
    expect(text).toContain('#9');
    expect(text).toContain('Awake');
  });
});
