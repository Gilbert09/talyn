import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';

vi.mock('../lib/api', () => ({ api: { workbenches: {} } }));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { SidebarWorkbenchList } from '../components/layout/SidebarWorkbenchList';
import { useWorkbenchStore } from '../stores/workbenches';
import { installNavigation, useNavigationStore } from '../stores/navigation';
import { usePullRequestStore } from '../stores/pullRequests';

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    branch: `branch-${id}`,
    baseBranch: 'main',
    runtime: 'sandbox',
    sandboxState: 'running',
    status: 'ready',
    pullRequestId: null,
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

const chat = (status: WorkbenchChat['status']) =>
  ({ id: 'c1', workbenchId: 'lisbon', status, createdAt: '2026-10-13T00:00:00Z' }) as WorkbenchChat;

const PR_ICON = '[data-attr="sidebar-workbench-pr-opened"]';

function store() {
  return useWorkbenchStore.getState();
}

function openPr() {
  store().upsertWorkbench(wb('lisbon', { pullRequestId: 'pr1' }));
}

/** A turn that ends while nobody looks at the session. */
function finishTurn() {
  store().upsertChat(chat('running'));
  store().upsertChat(chat('idle'));
}

function show() {
  render(<SidebarWorkbenchList workbenches={Object.values(store().workbenches)} />);
}

function dot() {
  return screen.queryByLabelText('New reply');
}

function prIcon() {
  return document.querySelector(PR_ICON);
}

beforeAll(() => {
  installNavigation();
});

beforeEach(() => {
  useWorkbenchStore.setState({ unread: {}, unseen: {}, chats: {} });
  store().setWorkspace('ws1');
  store().setWorkbenches('ws1', [wb('lisbon')]);
  useWorkbenchStore.setState({ listLoaded: true, selectedWorkbenchId: null });
  usePullRequestStore.setState({
    rows: [{ id: 'pr1', number: 4, state: 'open', summary: { draft: false, url: 'https://github.com/acme/app/pull/4' } }] as never,
  });
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => cleanup());

describe('sidebar row: a new pull request', () => {
  it('shows the PR icon and no dot when a new PR is the only update', () => {
    finishTurn();
    openPr();
    show();
    expect(prIcon()).not.toBeNull();
    expect(screen.getByLabelText('Pull request opened: #4')).toBeInTheDocument();
    expect(dot()).toBeNull();
  });

  it('shows the same when the PR link arrives before the turn ends', () => {
    store().upsertChat(chat('running'));
    openPr();
    store().upsertChat(chat('idle'));
    show();
    expect(prIcon()).not.toBeNull();
    expect(dot()).toBeNull();
  });

  it('keeps the blue dot when another turn also finished', () => {
    finishTurn();
    openPr();
    finishTurn();
    show();
    expect(dot()).not.toBeNull();
    expect(prIcon()).toBeNull();
  });

  it('keeps the blue dot when the agent needs an answer', () => {
    store().upsertChat(chat('running'));
    openPr();
    store().upsertChat(chat('awaiting_input'));
    show();
    expect(screen.getByLabelText('Waiting for your answer')).toBeInTheDocument();
    expect(prIcon()).toBeNull();
  });

  it('keeps the blue dot for a finished turn with no new PR', () => {
    finishTurn();
    show();
    expect(dot()).not.toBeNull();
    expect(prIcon()).toBeNull();
  });

  it('shows neither mark when nothing is unseen', () => {
    show();
    expect(dot()).toBeNull();
    expect(prIcon()).toBeNull();
  });

  it('shows the plain blue dot for a turn on a PR that was already there', () => {
    store().setWorkbenches('ws1', [wb('lisbon', { pullRequestId: 'pr1' })]);
    finishTurn();
    openPr();
    show();
    expect(dot()).not.toBeNull();
    expect(prIcon()).toBeNull();
  });

  it('clears the PR icon once the session is opened', () => {
    finishTurn();
    openPr();
    const { rerender } = render(<SidebarWorkbenchList workbenches={Object.values(store().workbenches)} />);
    expect(prIcon()).not.toBeNull();
    act(() => store().selectChat('lisbon', 'c1'));
    rerender(<SidebarWorkbenchList workbenches={Object.values(store().workbenches)} />);
    expect(prIcon()).toBeNull();
    expect(dot()).toBeNull();
  });
});
