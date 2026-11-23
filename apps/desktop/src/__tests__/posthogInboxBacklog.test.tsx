/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import {
  MAX_POSTHOG_INBOX_RUN_REPORTS,
  POSTHOG_INBOX_ACTIONABILITY_LABELS,
  POSTHOG_INBOX_BACKLOG_STATE_LABELS,
  type PostHogInboxBacklogCount,
  type PostHogInboxBacklogPage,
  type PostHogInboxBacklogRow,
  type PostHogInboxBacklogState,
  type PostHogInboxRunResponse,
  type WorkflowRun,
  type WorkflowWithStats,
} from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { useNavigationStore } from '../renderer/stores/navigation';
import { useBillingStore } from '../renderer/stores/billing';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { PostHogInboxBacklog } from '../renderer/components/panels/workflows/posthogInboxBacklog';
import { WorkflowsPanel } from '../renderer/components/panels/workflows/WorkflowsPanel';
import { WorkflowRunsList } from '../renderer/components/panels/workflows/WorkflowRunsList';
import { PostHogInboxReports } from '../renderer/components/panels/workflows/posthogInboxReports';

const STATS = { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, sessionsStarted: 0, lastRunAt: null, lastStatus: null };

function row(id: string, over: Partial<PostHogInboxBacklogRow> = {}): PostHogInboxBacklogRow {
  return {
    id,
    title: `Report ${id} title`,
    url: `https://us.posthog.com/project/42/inbox/${id}`,
    priority: 'P1',
    actionability: 'immediately_actionable',
    repository: 'acme/app',
    sourceProducts: ['error_tracking'],
    signalCount: 3,
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    state: 'not_run',
    selectable: true,
    runId: null,
    workbenchId: null,
    pullRequestId: null,
    prUrl: null,
    ...over,
  };
}

function page(over: Partial<PostHogInboxBacklogPage> = {}): PostHogInboxBacklogPage {
  return {
    rows: [row('r1')],
    scanned: 25,
    nextOffset: null,
    total: 40,
    days: 7,
    workflowId: 'wf1',
    runnable: true,
    notRunnableReason: null,
    dailyCap: 10,
    runsToday: 3,
    ...over,
  };
}

function countOf(over: Partial<PostHogInboxBacklogCount> = {}): PostHogInboxBacklogCount {
  return {
    days: 7,
    matched: 12,
    byState: {
      not_run: 9, running: 1, already_run: 2, claimed_elsewhere: 0, already_addressed: 0, repository_not_connected: 0, held_back: 0,
    },
    scanned: 40,
    total: 40,
    complete: true,
    ...over,
  };
}

const ALL_STATES = Object.keys(POSTHOG_INBOX_BACKLOG_STATE_LABELS) as PostHogInboxBacklogState[];

function rule(over: Partial<WorkflowWithStats> = {}): WorkflowWithStats {
  return {
    id: 'wf1',
    workspaceId: 'ws1',
    integration: 'posthog_inbox',
    name: 'Fix urgent reports',
    enabled: true,
    events: ['report_ready'],
    conditions: {},
    actions: [{ type: 'start_session', prompt: 'Fix it' }],
    maxRunsPerPrPerHour: 5,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    stats: STATS,
    ...over,
  } as WorkflowWithStats;
}

function rowElement(id: string): HTMLElement {
  return document.querySelector(`[data-report-id="${id}"]`) as HTMLElement;
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

beforeEach(() => {
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', name: 'Acme', integrations: { github: { login: 'me' } } }],
    githubStatus: { connected: true },
    repositories: [{ id: 'repo1', fullName: 'acme/app' }],
    features: { workflows: true, posthogInboxRules: true, mcpServers: true },
  } as never);
  useBillingStore.setState({ status: null } as never);
  jest.spyOn(api.workflows, 'posthogInboxBacklog').mockResolvedValue(page());
  jest.spyOn(api.workflows, 'posthogInboxBacklogCount').mockResolvedValue(countOf());
  jest.spyOn(api.workflows, 'runPostHogInboxReports').mockResolvedValue({
    results: [], requested: 0, started: 0, dailyCap: 10, summary: '0 of 0 started.',
  });
  jest.spyOn(api.workflows, 'list').mockResolvedValue([]);
  jest.spyOn(api.workflows, 'runs').mockResolvedValue([]);
  jest.spyOn(api.workflows, 'suggestions').mockResolvedValue({ repos: [], branches: [], labels: [], people: [], teams: [], partial: false } as never);
  jest.spyOn(api.workflows, 'posthogInboxStatus').mockResolvedValue({
    access: 'ok', reason: null, authMethod: 'oauth', projectId: '42', host: 'https://us.posthog.com',
    connection: 'posthog_inbox', missingScopes: [], oauthAvailable: true, lastPolledAt: null, lastError: null,
    lastPushAt: null, pushConfigured: false, pushManaged: false, pushSetupMissingScopes: [],
  });
  jest.spyOn(api.ws, 'on').mockReturnValue(() => {});
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

async function showBacklog() {
  fireEvent.click(screen.getByRole('button', { name: 'Show backlog' }));
  await waitFor(() => expect(document.querySelector('[data-attr="posthog-inbox-backlog-count"]')).toBeTruthy());
}

describe('PostHogInboxBacklog', () => {
  it('loads only on demand in the editor, with the editor conditions', async () => {
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} conditions={{ priorities: ['P0'] }} />);
    expect(api.workflows.posthogInboxBacklog).not.toHaveBeenCalled();
    await showBacklog();
    expect(api.workflows.posthogInboxBacklog).toHaveBeenCalledWith('ws1', {
      workflowId: 'wf1', conditions: { priorities: ['P0'] }, days: 7, offset: 0,
    });
    expect(screen.getByText('Showing 1 report. Talyn read 25 reports from PostHog for this list.')).toBeTruthy();
    expect(api.workflows.posthogInboxBacklogCount).toHaveBeenCalledWith('ws1', {
      workflowId: 'wf1', conditions: { priorities: ['P0'] }, days: 7,
    });
    expect(await screen.findByText('12 reports match in the last 7 days: 9 not run, 1 running / PR open, 2 already run.')).toBeTruthy();
  });

  it('says it is counting, and says when the count fails', async () => {
    let fail: (err: Error) => void = () => {};
    jest.mocked(api.workflows.posthogInboxBacklogCount).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { fail = reject; })
    );
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    expect(await screen.findByText('Counting the matching reports...')).toBeTruthy();
    fail(new Error('PostHog is down'));
    expect(await screen.findByText('Talyn could not count the matching reports.')).toBeTruthy();
    expect(screen.getByText('Report r1 title')).toBeTruthy();
  });

  it('shows a count that stopped before the end as not complete', async () => {
    jest.mocked(api.workflows.posthogInboxBacklogCount).mockResolvedValue(
      countOf({ days: 'all', matched: 3, scanned: 1000, complete: false, byState: { ...countOf().byState, not_run: 3, running: 0, already_run: 0 } })
    );
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(page({ days: 'all' }));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    expect(
      await screen.findByText('3+ reports match in all time: 3 not run. Talyn read the newest 1000 reports only.')
    ).toBeTruthy();
  });

  it('drops a count for an older range', async () => {
    let resolveOld: (value: PostHogInboxBacklogCount) => void = () => {};
    jest.mocked(api.workflows.posthogInboxBacklogCount)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(countOf({ days: 30, matched: 1, byState: { ...countOf().byState, not_run: 1, running: 0, already_run: 0 } }));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    await screen.findByText('Report r1 title');
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    expect(await screen.findByText('1 report matches in the last 30 days: 1 not run.')).toBeTruthy();
    resolveOld(countOf());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/12 reports match/)).toBeNull();
  });

  it('loads at once with autoLoad and the saved rule', async () => {
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    await waitFor(() =>
      expect(api.workflows.posthogInboxBacklog).toHaveBeenCalledWith('ws1', {
        workflowId: 'wf1', conditions: undefined, days: 7, offset: 0,
      })
    );
    expect(await screen.findByText('Report r1 title')).toBeTruthy();
  });

  it('asks for an unsaved rule with no workflow id', async () => {
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(
      page({ workflowId: null, runnable: false, notRunnableReason: 'Save this automation first.' })
    );
    render(<PostHogInboxBacklog workflow={null} conditions={{}} />);
    await showBacklog();
    expect(api.workflows.posthogInboxBacklog).toHaveBeenCalledWith('ws1', expect.objectContaining({ workflowId: null }));
    expect(screen.getByText('Save this automation first.')).toBeTruthy();
  });

  it.each(ALL_STATES)('shows the %s badge, with a checkbox only on a selectable row', async (state) => {
    const selectable = state === 'not_run';
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(
      page({ rows: [row('r1', { state, selectable }), row('r2')] })
    );
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    await screen.findByText('Report r1 title');
    const el = rowElement('r1');
    expect(within(el).getByText(POSTHOG_INBOX_BACKLOG_STATE_LABELS[state])).toBeTruthy();
    expect(Boolean(within(el).queryByRole('checkbox'))).toBe(selectable);
    expect(within(rowElement('r2')).getByRole('checkbox')).toBeTruthy();
  });

  it('shows the report details and a link to PostHog', async () => {
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    const link = (await screen.findByText('Report r1 title')).closest('a')!;
    expect(link.getAttribute('href')).toBe('https://us.posthog.com/project/42/inbox/r1');
    expect(link.getAttribute('target')).toBe('_blank');
    const text = rowElement('r1').textContent ?? '';
    expect(text).toContain('P1');
    expect(text).toContain(POSTHOG_INBOX_ACTIONABILITY_LABELS.immediately_actionable);
    expect(text).toContain('acme/app');
    expect(text).toContain('error_tracking');
    expect(text).toContain('created 3d ago');
    expect(text).toContain('updated 2h ago');
  });

  it('links a running row to its session and its pull request', async () => {
    const navigate = jest.fn();
    useNavigationStore.setState({ navigate } as never);
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(
      page({
        rows: [row('r1', {
          state: 'running', selectable: false, workbenchId: 'wb1', runId: 'run1',
          prUrl: 'https://github.com/acme/app/pull/7',
        })],
      })
    );
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    fireEvent.click(await screen.findByText('Open the session'));
    expect(navigate).toHaveBeenCalledWith({ view: 'workbench', id: 'wb1' });
    expect(screen.getByText('Open the pull request').closest('a')!.getAttribute('href')).toBe('https://github.com/acme/app/pull/7');
  });

  it('hides the checkboxes and the run button when the rule cannot run', async () => {
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(
      page({ runnable: false, notRunnableReason: 'Save your changes first.', rows: [row('r1'), row('r2')] })
    );
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    expect(await screen.findByText('Save your changes first.')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Run selected' })).toBeNull();
  });

  it.each([
    [30, '30 days'],
    [90, '90 days'],
    ['all', 'All time'],
  ] as const)('reads again from offset 0 when the range changes to %s', async (days, label) => {
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(page({ nextOffset: 25 }));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    await screen.findByText('Report r1 title');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(api.workflows.posthogInboxBacklog).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(api.workflows.posthogInboxBacklog).toHaveBeenCalledTimes(3));
    expect(jest.mocked(api.workflows.posthogInboxBacklog).mock.calls[2]![1]).toEqual(
      expect.objectContaining({ days, offset: 0 })
    );
    // Load more does not count again; a new range does.
    expect(api.workflows.posthogInboxBacklogCount).toHaveBeenCalledTimes(2);
    expect(jest.mocked(api.workflows.posthogInboxBacklogCount).mock.calls[1]![1]).toEqual(expect.objectContaining({ days }));
    expect(screen.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('true');
  });

  it('appends the next page with Load more', async () => {
    jest.mocked(api.workflows.posthogInboxBacklog)
      .mockResolvedValueOnce(page({ rows: [row('r1')], scanned: 25, nextOffset: 25 }))
      .mockResolvedValueOnce(page({ rows: [row('r2')], scanned: 10, nextOffset: null }));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    await screen.findByText('Report r1 title');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Report r2 title')).toBeTruthy();
    expect(screen.getByText('Report r1 title')).toBeTruthy();
    expect(jest.mocked(api.workflows.posthogInboxBacklog).mock.calls[1]![1]).toEqual(
      expect.objectContaining({ offset: 25, days: 7 })
    );
    expect(screen.getByText('Showing 2 reports. Talyn read 35 reports from PostHog for this list.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('drops an answer for older conditions', async () => {
    let resolveOld: (value: PostHogInboxBacklogPage) => void = () => {};
    jest.mocked(api.workflows.posthogInboxBacklog)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(page({ rows: [row('new')] }));
    const { rerender } = render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} conditions={{ priorities: ['P0'] }} autoLoad />);
    rerender(<PostHogInboxBacklog workflow={{ id: 'wf1' }} conditions={{ priorities: ['P1'] }} autoLoad />);
    expect(await screen.findByText('Report new title')).toBeTruthy();
    resolveOld(page({ rows: [row('old')] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Report old title')).toBeNull();
  });

  it('resets the backlog when the conditions change', async () => {
    const { rerender } = render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} conditions={{ priorities: ['P0'] }} />);
    await showBacklog();
    expect(screen.getByText('Report r1 title')).toBeTruthy();
    rerender(<PostHogInboxBacklog workflow={{ id: 'wf1' }} conditions={{ priorities: ['P1'] }} />);
    expect(screen.queryByText('Report r1 title')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show backlog' })).toBeTruthy();
  });

  it('shows an empty state', async () => {
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(page({ rows: [], scanned: 25 }));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    expect(await screen.findByText('No reports match in this time range.')).toBeTruthy();
  });

  it('shows the server error message', async () => {
    jest.mocked(api.workflows.posthogInboxBacklog).mockRejectedValue(new Error('PostHog refused the Inbox read (403).'));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    expect(await screen.findByText('PostHog refused the Inbox read (403).')).toBeTruthy();
  });

  it.each([
    ['one at a time', false],
    ['with select all', true],
  ])('caps the selection at the run limit, %s', async (_label, all) => {
    const rows = Array.from({ length: MAX_POSTHOG_INBOX_RUN_REPORTS + 3 }, (_, i) => row(`r${i}`));
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(page({ rows }));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    await screen.findByText('Report r0 title');
    if (all) {
      fireEvent.click(screen.getByLabelText('Select all reports that can run'));
    } else {
      for (const r of rows) fireEvent.click(within(rowElement(r.id)).getByRole('checkbox'));
    }
    expect(screen.getByText(`${MAX_POSTHOG_INBOX_RUN_REPORTS} selected`)).toBeTruthy();
    expect(screen.getByText(`You can run ${MAX_POSTHOG_INBOX_RUN_REPORTS} reports at one time.`)).toBeTruthy();
    const last = within(rowElement(`r${MAX_POSTHOG_INBOX_RUN_REPORTS + 2}`)).getByRole('checkbox') as HTMLInputElement;
    expect(last.checked).toBe(false);
    expect(last.disabled).toBe(true);
  });

  it('clears the selection with select all', async () => {
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(page({ rows: [row('r1'), row('r2')] }));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    await screen.findByText('Report r1 title');
    const all = screen.getByLabelText('Select all reports that can run');
    fireEvent.click(all);
    expect(screen.getByText('2 selected')).toBeTruthy();
    fireEvent.click(all);
    expect(screen.getByText('0 selected')).toBeTruthy();
  });

  it.each([
    ['room left', { dailyCap: 10, runsToday: 3 }, 2, 'The daily cap is 10. 3 runs counted in the last 24 hours, so 7 more can start today.', false],
    ['too few left', { dailyCap: 4, runsToday: 3 }, 2, 'The daily cap is 4. 3 runs counted in the last 24 hours, so 1 more can start today.', true],
    ['no cap', { dailyCap: null, runsToday: 0 }, 1, 'This automation has no daily cap.', false],
  ])('confirms the run with the daily cap: %s', async (_label, over, count, capText, overCap) => {
    const rows = [row('r1'), row('r2'), row('r3')];
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(page({ rows, ...over }));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    await screen.findByText('Report r1 title');
    for (const r of rows.slice(0, count)) fireEvent.click(within(rowElement(r.id)).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Run selected' }));
    const dialog = screen.getByRole('alertdialog');
    const sessions = `${count} session${count === 1 ? '' : 's'}`;
    expect(within(dialog).getByText(`Start ${sessions}?`)).toBeTruthy();
    expect(within(dialog).getByText('Talyn starts one session for each selected report. Each session opens a pull request.')).toBeTruthy();
    const cap = dialog.querySelector('[data-attr="posthog-inbox-backlog-confirm-cap"]')!.textContent ?? '';
    expect(cap).toContain(capText);
    expect(cap.includes('Talyn does not start the reports after the cap.')).toBe(overCap);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.workflows.runPostHogInboxReports).not.toHaveBeenCalled();
  });

  it('runs the selected reports, shows the summary and reads the backlog again', async () => {
    const response: PostHogInboxRunResponse = {
      results: [
        { reportId: 'r1', outcome: 'started', message: 'Started a session.', runId: 'run1', workbenchId: 'wb1' },
        { reportId: 'r3', outcome: 'daily_cap', message: 'The daily cap is reached.', runId: null, workbenchId: null },
      ],
      requested: 2,
      started: 1,
      dailyCap: 10,
      summary: '1 of 2 started; the daily cap of 10 is reached.',
    };
    jest.mocked(api.workflows.runPostHogInboxReports).mockResolvedValue(response);
    jest.mocked(api.workflows.posthogInboxBacklog).mockResolvedValue(page({ rows: [row('r1'), row('r2'), row('r3')], nextOffset: 25 }));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    await screen.findByText('Report r1 title');
    fireEvent.click(within(rowElement('r1')).getByRole('checkbox'));
    fireEvent.click(within(rowElement('r3')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Run selected' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Start 2 sessions' }));
    expect(await screen.findByText('1 of 2 started; the daily cap of 10 is reached.')).toBeTruthy();
    expect(api.workflows.runPostHogInboxReports).toHaveBeenCalledWith('wf1', ['r1', 'r3']);
    const result = document.querySelector('[data-attr="posthog-inbox-backlog-run-result"]') as HTMLElement;
    expect(result.textContent).toContain('Report r3 title: The daily cap is reached.');
    expect(result.textContent).not.toContain('Started a session.');
    await waitFor(() => expect(api.workflows.posthogInboxBacklog).toHaveBeenCalledTimes(2));
    expect(jest.mocked(api.workflows.posthogInboxBacklog).mock.calls[1]![1]).toEqual(expect.objectContaining({ offset: 0 }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('0 selected')).toBeTruthy();
  });

  it('shows the error when the run fails', async () => {
    jest.mocked(api.workflows.runPostHogInboxReports).mockRejectedValue(new Error('This automation is off.'));
    render(<PostHogInboxBacklog workflow={{ id: 'wf1' }} autoLoad />);
    await screen.findByText('Report r1 title');
    fireEvent.click(within(rowElement('r1')).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Run selected' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Start 1 session' }));
    expect(await screen.findByText('This automation is off.')).toBeTruthy();
  });
});

describe('PostHog Inbox rules list', () => {
  it.each([
    ['posthog_inbox', true],
    ['github', false],
  ] as const)('shows the Backlog tab for a %s rule: %s', async (integration, shown) => {
    jest.mocked(api.workflows.list).mockResolvedValue([rule({ integration })]);
    render(<WorkflowsPanel integration={integration} />);
    fireEvent.click(await screen.findByTitle('Show history'));
    await waitFor(() => expect(api.workflows.runs).toHaveBeenCalled());
    expect(Boolean(screen.queryByRole('tab', { name: 'Backlog' }))).toBe(shown);
    if (!shown) return;
    const tab = screen.getByRole('tab', { name: 'Backlog' });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(await screen.findByText('Report r1 title')).toBeTruthy();
    expect(api.workflows.posthogInboxBacklog).toHaveBeenCalledWith('ws1', {
      workflowId: 'wf1', conditions: undefined, days: 7, offset: 0,
    });
  });
});

describe('WorkflowRunsList manual runs', () => {
  const run = (over: Partial<WorkflowRun>): WorkflowRun =>
    ({
      id: 'run1', workflowId: 'wf1', workspaceId: 'ws1', integration: 'posthog_inbox',
      subjectLabel: 'Checkout crashes', repositoryId: null, repoFullName: '', prNumber: 0, prTitle: '',
      prUrl: '', prAuthor: '', pullRequestId: null, taskId: null, event: 'report_ready',
      status: 'succeeded', actions: [], error: null, retryAfter: null, attempts: 1,
      createdAt: new Date().toISOString(), ...over,
    }) as WorkflowRun;

  it.each([
    ['a named person', { trigger: 'manual', triggeredBy: 'octocat' }, 'Started by octocat'],
    ['no name', { trigger: 'manual', triggeredBy: null }, 'Started by hand'],
    ['an event', { trigger: 'event' }, null],
    ['an older server', {}, null],
  ] as const)('labels a run started by %s', async (_label, over, text) => {
    jest.mocked(api.workflows.runs).mockResolvedValue([run(over as Partial<WorkflowRun>)]);
    render(<WorkflowRunsList workflowId="wf1" liveRuns={undefined} />);
    await screen.findByText('Checkout crashes');
    const label = document.querySelector('[data-testid="workflow-run-trigger"]');
    expect(label?.textContent ?? null).toBe(text);
  });
});

describe('PostHogInboxReports', () => {
  it('shows the backlog of the first automation, and of the one the person picks', async () => {
    jest.mocked(api.workflows.list).mockResolvedValue([
      rule({ id: 'wf1', name: 'Fix urgent reports' }),
      rule({ id: 'wf2', name: 'Fix crashes', enabled: false }),
    ]);
    render(<PostHogInboxReports />);
    expect(await screen.findByText('Report r1 title')).toBeTruthy();
    expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'posthog_inbox');
    expect(api.workflows.posthogInboxBacklog).toHaveBeenLastCalledWith('ws1', expect.objectContaining({ workflowId: 'wf1', days: 7, offset: 0 }));
    const select = screen.getByLabelText('Automation', { selector: 'select' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Fix urgent reports', 'Fix crashes (off)']);
    fireEvent.change(select, { target: { value: 'wf2' } });
    await waitFor(() =>
      expect(api.workflows.posthogInboxBacklog).toHaveBeenLastCalledWith('ws1', expect.objectContaining({ workflowId: 'wf2', offset: 0 }))
    );
    expect(api.workflows.posthogInboxBacklogCount).toHaveBeenLastCalledWith('ws1', expect.objectContaining({ workflowId: 'wf2' }));
  });

  it('asks for an automation first when there is none', async () => {
    jest.mocked(api.workflows.list).mockResolvedValue([]);
    render(<PostHogInboxReports />);
    expect(await screen.findByText(/Make a PostHog Inbox automation on the Automations tab first/)).toBeTruthy();
    expect(api.workflows.posthogInboxBacklog).not.toHaveBeenCalled();
  });

  it('shows the error when the automations do not load', async () => {
    jest.mocked(api.workflows.list).mockRejectedValue(new Error('Server down'));
    render(<PostHogInboxReports />);
    expect(await screen.findByText('Server down')).toBeTruthy();
  });
});
