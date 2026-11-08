/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Workbench, WorkbenchBackground, WorkbenchBackgroundJob, WorkbenchChat, WorkbenchWakeup } from '@talyn/shared';
import { SidebarWorkbenchList } from '../renderer/components/layout/SidebarWorkbenchList';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { installNavigation, useNavigationStore } from '../renderer/stores/navigation';
import { usePullRequestStore } from '../renderer/stores/pullRequests';
import { useSessionBackgroundStore } from '../renderer/stores/sessionBackground';

jest.mock('../renderer/lib/api', () => ({ api: { workbenches: {} } }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

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

function background(
  jobs: WorkbenchBackgroundJob['status'][],
  wakeups: WorkbenchWakeup['status'][] = []
): WorkbenchBackground {
  return {
    workbenchId: 'lisbon',
    jobs: jobs.map((status, i) => ({ id: `j${i}`, status }) as WorkbenchBackgroundJob),
    wakeups: wakeups.map((status, i) => ({ id: `w${i}`, status }) as WorkbenchWakeup),
  } as WorkbenchBackground;
}

const STATE_JOB = '[data-attr="session-state-background-job"]';
const STATE_WAKEUP = '[data-attr="session-state-wakeup"]';

function show() {
  const store = useWorkbenchStore.getState();
  render(<SidebarWorkbenchList workbenches={Object.values(store.workbenches)} />);
}

/** The small timer at the end of the row, with its own title. */
function trailingMark(title: string) {
  return document.querySelector(`span[title="${title}"]`);
}

beforeAll(() => {
  installNavigation();
});

beforeEach(() => {
  useWorkbenchStore.setState({ unread: {}, unseen: {}, chats: {} });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', [wb('lisbon', { diffStat: { files: 2, added: 234, removed: 69 } })]);
  useWorkbenchStore.setState({ listLoaded: true, selectedWorkbenchId: null });
  usePullRequestStore.setState({
    rows: [{ id: 'pr1', number: 4, state: 'open', summary: { draft: false, url: 'https://github.com/acme/app/pull/4', ciStatus: 'running' } }] as never,
  });
  useSessionBackgroundStore.setState({ byWorkbench: {} });
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => cleanup());

describe('sidebar row: background work', () => {
  it('shows the unshipped mark when nothing runs in the background', () => {
    show();
    expect(screen.getByLabelText('Changes with no pull request yet')).toBeInTheDocument();
    expect(document.querySelector(STATE_JOB)).toBeNull();
    expect(document.querySelector(STATE_WAKEUP)).toBeNull();
  });

  it.each([
    ['a running job', background(['running']), STATE_JOB, 'Background job running'],
    ['a running job and a wake-up', background(['running'], ['scheduled']), STATE_JOB, 'Background job running'],
    ['a scheduled wake-up', background([], ['scheduled']), STATE_WAKEUP, 'Wake-up scheduled'],
  ])('shows %s as the state icon, with no second timer', (_name, payload, selector, label) => {
    act(() => useSessionBackgroundStore.getState().applyBackground(payload));
    show();
    expect(document.querySelector(selector)).toHaveAttribute('aria-label', label);
    expect(screen.queryByLabelText('Changes with no pull request yet')).toBeNull();
    expect(trailingMark(label)).toBeNull();
  });

  it('shows no background state for ended jobs and wake-ups', () => {
    act(() => useSessionBackgroundStore.getState().applyBackground(background(['exited', 'lost'], ['fired', 'cancelled'])));
    show();
    expect(screen.getByLabelText('Changes with no pull request yet')).toBeInTheDocument();
    expect(document.querySelector(STATE_JOB)).toBeNull();
  });

  it('keeps the blue dot for a question and the trailing timer for the job', () => {
    useWorkbenchStore.getState().upsertChat(chat('awaiting_input'));
    act(() => useSessionBackgroundStore.getState().applyBackground(background(['running'])));
    show();
    expect(screen.getByLabelText('Waiting for your answer')).toBeInTheDocument();
    expect(document.querySelector(STATE_JOB)).toBeNull();
    expect(trailingMark('Background job running')).not.toBeNull();
  });

  it('keeps the PR icon and the trailing timer for a wake-up on an open PR', () => {
    useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', { pullRequestId: 'pr1' }));
    act(() => useSessionBackgroundStore.getState().applyBackground(background([], ['scheduled'])));
    show();
    expect(screen.getByLabelText('#4 open, waiting on checks or review')).toBeInTheDocument();
    expect(document.querySelector(STATE_WAKEUP)).toBeNull();
    expect(trailingMark('Wake-up scheduled')).not.toBeNull();
  });

  it('shows a running job in place of the open PR icon', () => {
    useWorkbenchStore.getState().upsertWorkbench(wb('lisbon', { pullRequestId: 'pr1' }));
    act(() => useSessionBackgroundStore.getState().applyBackground(background(['running'])));
    show();
    expect(document.querySelector(STATE_JOB)).not.toBeNull();
    expect(screen.queryByLabelText('#4 open, waiting on checks or review')).toBeNull();
  });
});
