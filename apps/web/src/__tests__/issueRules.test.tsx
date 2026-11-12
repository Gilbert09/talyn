import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import React from 'react';
import {
  validateWorkflow,
  type LinearConnection,
  type LinearStatus,
  type McpServerDefinition,
  type WorkflowInput,
  type WorkflowRun,
} from '@talyn/shared';
import { api } from '../lib/api';
import { useBillingStore } from '../stores/billing';
import { useWorkspaceStore } from '../stores/workspace';
import { IntegrationsView } from '../pages/IntegrationsView';
import { LinearSettings } from '../components/panels/LinearSettings';
import { WorkflowsPanel } from '../components/panels/workflows/WorkflowsPanel';
import { WorkflowRunsList } from '../components/panels/workflows/WorkflowRunsList';
import { issueAssigneeKinds } from '../components/panels/workflows/issueFields';
import { OpenTask } from '../routes/OpenTask';

const STATS = { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null };
const assign = vi.fn();

function connection(over: Partial<LinearConnection> = {}): LinearConnection {
  return {
    id: 'lc1',
    workspaceId: 'ws1',
    organizationId: 'org1',
    organizationName: 'Acme Linear',
    urlKey: 'acme',
    scopes: ['read', 'write'],
    canAssign: true,
    reauthRequiredAt: null,
    reauthReason: null,
    createdAt: '2026-11-12T00:00:00Z',
    ...over,
  };
}

function linearStatus(over: Partial<LinearStatus> = {}): LinearStatus {
  return { configured: true, connections: [connection()], ...over };
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign, search: '', pathname: '/integrations/linear' },
  });
  assign.mockReset();
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', name: 'Acme', integrations: { github: { login: 'me' } } }],
    githubStatus: { connected: true },
    repositories: [{ id: 'repo1', fullName: 'acme/app' }],
    features: { workflows: true, issueRules: true, mcpServers: true },
  } as never);
  useBillingStore.setState({ status: null } as never);
  vi.spyOn(useBillingStore.getState(), 'refresh').mockResolvedValue(undefined);
  vi.spyOn(api.workflows, 'list').mockResolvedValue([]);
  vi.spyOn(api.workflows, 'suggestions').mockResolvedValue({ repos: ['acme/app'], branches: [], labels: [], people: [], teams: [], partial: false } as never);
  vi.spyOn(api.workflows, 'runs').mockResolvedValue([]);
  vi.spyOn(api.ws, 'on').mockReturnValue(() => {});
  vi.spyOn(api.linear, 'getStatus').mockResolvedValue(linearStatus());
  vi.spyOn(api.linear, 'options').mockResolvedValue({
    teams: [{ id: 't1', key: 'ENG', name: 'Engineering' }],
    labels: [{ id: 'l1', name: 'agent', teamId: null }],
    states: [{ id: 's1', name: 'Todo', type: 'unstarted', position: 1, teamId: 't1' }],
    projects: [],
    partial: false,
  });
  vi.spyOn(api.mcpServers, 'list').mockResolvedValue([]);
  vi.spyOn(api.slack, 'getStatus').mockResolvedValue({ installations: [], links: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Issue integrations in the catalog', () => {
  it.each([
    ['flag off', { workflows: true, issueRules: false }, true, { linear: false, github_issues: false }],
    ['flag on, GitHub connected', { workflows: true, issueRules: true }, true, { linear: true, github_issues: true }],
    ['flag on, GitHub not connected', { workflows: true, issueRules: true }, false, { linear: true, github_issues: false }],
    ['workflows off', { workflows: false, issueRules: true }, true, { linear: false, github_issues: false }],
  ])('%s', (_label, features, githubConnected, shown) => {
    useWorkspaceStore.setState({
      features,
      githubStatus: { connected: githubConnected },
      workspaces: [{ id: 'ws1', name: 'Acme', integrations: githubConnected ? { github: {} } : {} }],
    } as never);
    render(<IntegrationsView kind={null} />);
    for (const [kind, visible] of Object.entries(shown)) {
      expect(Boolean(document.querySelector(`[data-attr="integration-card-${kind}"]`))).toBe(visible);
    }
  });

  it('opens GitHub Issues automations with the GitHub connection note', async () => {
    render(<IntegrationsView kind="github_issues" />);
    expect(await screen.findByText('GitHub Issues automations')).toBeTruthy();
    await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'github_issues'));
    expect(screen.getByText(/Uses your GitHub connection/)).toBeTruthy();
    expect(screen.queryByText('Connect GitHub')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Connection' })).toBeNull();
  });

  it('links to GitHub when GitHub is not connected', async () => {
    useWorkspaceStore.setState({ githubStatus: { connected: false }, workspaces: [{ id: 'ws1', name: 'Acme', integrations: {} }] } as never);
    render(<IntegrationsView kind="github_issues" />);
    expect(await screen.findByText('Connect GitHub')).toBeTruthy();
  });

  it('opens Linear with Automations and Connection tabs', async () => {
    render(<IntegrationsView kind="linear" />);
    expect(await screen.findByText('Linear automations')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Connection' })).toBeTruthy();
  });
});

describe('Linear connection', () => {
  it('connects through Linear in this tab', async () => {
    const connect = vi.spyOn(api.linear, 'connect').mockResolvedValue({ authorizeUrl: 'https://linear.app/oauth/authorize?x=1' });
    vi.mocked(api.linear.getStatus).mockResolvedValue(linearStatus({ connections: [] }));
    render(<LinearSettings />);
    expect(await screen.findByText('No Linear workspace is connected yet.')).toBeTruthy();
    fireEvent.click(screen.getByText('Connect Linear'));
    await waitFor(() => expect(connect).toHaveBeenCalledWith({ workspaceId: 'ws1' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://linear.app/oauth/authorize?x=1'));
  });

  it('disables Connect when this deployment has no Linear app', async () => {
    vi.mocked(api.linear.getStatus).mockResolvedValue({ configured: false, connections: [] });
    render(<LinearSettings />);
    const button = (await screen.findByText('Connect Linear')).closest('button')!;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('Linear is not set up on this deployment.')).toBeTruthy();
  });

  it('shows the connection with a link to the organization', async () => {
    render(<LinearSettings />);
    expect(await screen.findByText('Acme Linear')).toBeTruthy();
    expect(screen.getByText('linear.app/acme').closest('a')!.getAttribute('href')).toBe('https://linear.app/acme');
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.getByText('Connect another Linear workspace')).toBeTruthy();
  });

  it('disconnects after a confirm', async () => {
    const disconnect = vi.spyOn(api.linear, 'disconnect').mockResolvedValue(undefined);
    render(<LinearSettings />);
    fireEvent.click(await screen.findByText('Disconnect'));
    const dialog = await screen.findByRole('alertdialog');
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('ws1', 'lc1'));
    await waitFor(() => expect(api.linear.getStatus).toHaveBeenCalledTimes(2));
  });

  it('shows Reconnect and the reason when Linear needs a new sign-in', async () => {
    const connect = vi.spyOn(api.linear, 'connect').mockResolvedValue({ authorizeUrl: 'https://linear.app/again' });
    vi.mocked(api.linear.getStatus).mockResolvedValue(
      linearStatus({ connections: [connection({ reauthRequiredAt: '2026-11-12T01:00:00Z', reauthReason: 'Linear revoked the grant.' })] })
    );
    render(<LinearSettings />);
    expect(await screen.findByText('Needs reconnect')).toBeTruthy();
    expect(screen.getByText(/Linear revoked the grant\./)).toBeTruthy();
    fireEvent.click(screen.getByText('Reconnect'));
    await waitFor(() => expect(connect).toHaveBeenCalled());
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://linear.app/again'));
  });

  it.each([
    ['connected', 'Linear connected.'],
    ['error', 'Linear said no'],
  ])('shows the result of the sign-in: %s', async (result, text) => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, assign, search: `?linear=${result}&message=Linear%20said%20no`, pathname: '/integrations/linear' },
    });
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    render(<LinearSettings />);
    expect((await screen.findByRole('status')).textContent).toBe(text);
    expect(replace).toHaveBeenCalled();
  });
});

describe('Linear MCP server offer', () => {
  const linearServer = { id: 'm1', name: 'linear', catalogHandle: 'linear', url: 'https://mcp.linear.app/mcp' } as McpServerDefinition;

  it('is hidden when MCP servers are off', async () => {
    useWorkspaceStore.setState({ features: { workflows: true, issueRules: true, mcpServers: false } } as never);
    render(<LinearSettings />);
    await screen.findByText('Acme Linear');
    expect(screen.queryByText('Also connect as an MCP server')).toBeNull();
  });

  it('says so when a Linear MCP server exists', async () => {
    vi.mocked(api.mcpServers.list).mockResolvedValue([linearServer]);
    render(<LinearSettings />);
    expect(await screen.findByText('A Linear MCP server is already set up.')).toBeTruthy();
    expect(screen.getByText('Open MCP servers')).toBeTruthy();
    expect(screen.queryByText('Also connect as an MCP server')).toBeNull();
  });

  it('creates the catalog server and starts its own sign-in', async () => {
    const popup = { closed: false, opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as never);
    const create = vi.spyOn(api.mcpServers, 'create').mockResolvedValue(linearServer);
    const startSignIn = vi.spyOn(api.mcpServers, 'startSignIn').mockResolvedValue({
      flowId: 'f1', authorizeUrl: 'https://mcp.linear.app/authorize', expiresAt: '2026-11-12T01:00:00Z', scopes: [],
    });
    render(<LinearSettings />);
    expect(await screen.findByText(/uses its own sign-in, separate/)).toBeTruthy();
    const button = await screen.findByText('Also connect as an MCP server');
    await waitFor(() => expect(button.closest('button')!.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toBe('ws1');
    expect(create.mock.calls[0]![1]).toMatchObject({ catalogHandle: 'linear', url: 'https://mcp.linear.app/mcp' });
    await waitFor(() => expect(startSignIn).toHaveBeenCalledWith('m1'));
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith('https://mcp.linear.app/authorize'));
  });
});

describe('issueAssigneeKinds', () => {
  it.each([
    ['linear', true, ['talyn', 'unassigned', 'people']],
    ['linear', false, ['unassigned', 'people']],
    ['github_issues', true, ['me', 'unassigned', 'people']],
    ['github_issues', false, ['me', 'unassigned', 'people']],
  ] as const)('%s with canAssign %s', (integration, canAssign, kinds) => {
    expect(issueAssigneeKinds(integration, canAssign)).toEqual(kinds);
  });
});

async function openEditor(integration: 'linear' | 'github_issues') {
  render(<WorkflowsPanel integration={integration} />);
  await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', integration));
  fireEvent.click(screen.getByText('New automation'));
  await screen.findByLabelText('Name');
}

function savedInput(create: { mock: { calls: unknown[][] } }): WorkflowInput {
  const [workspaceId, input] = create.mock.calls[0]! as [string, WorkflowInput];
  expect(workspaceId).toBe('ws1');
  return input;
}

describe('Issue rule editor', () => {
  it('starts a new rule with a session and both write-backs on', async () => {
    await openEditor('linear');
    expect(screen.getByText('Start a session')).toBeTruthy();
    const boxes = within(document.querySelector('[data-attr="issue-write-back"]') as HTMLElement).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true]);
    expect(screen.getByText('Comment on the issue when work starts')).toBeTruthy();
    expect(screen.getByText('Move the issue to done when the fix merges')).toBeTruthy();
    expect(screen.getByText(/Talyn always comments on the issue with the pull request link/)).toBeTruthy();
  });

  it('allows one start action only', async () => {
    await openEditor('linear');
    fireEvent.click(screen.getByText('Add action'));
    for (const label of ['Start a session', 'Start a task']) {
      const option = screen.getAllByRole('button', { name: new RegExp(label) }).find((b) => b.closest('.absolute'));
      expect((option as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByRole('button', { name: /Comment on the issue/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('saves a Linear rule with its connection and the write-backs off', async () => {
    const create = vi.spyOn(api.workflows, 'create').mockImplementation(async (_ws, input) => ({
      id: 'wf1', workspaceId: 'ws1', createdAt: '', updatedAt: '', stats: STATS, ...input,
    } as never));
    await openEditor('linear');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Agent issues' } });
    fireEvent.change(await screen.findByLabelText('Linear workspace'), { target: { value: 'lc1' } });
    await waitFor(() => expect(api.linear.options).toHaveBeenCalledWith('ws1', 'lc1'));
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'repo1' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Fix it' } });
    for (const box of within(document.querySelector('[data-attr="issue-write-back"]') as HTMLElement).getAllByRole('checkbox')) {
      fireEvent.click(box);
    }
    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);

    await waitFor(() => expect(create).toHaveBeenCalled());
    const normalized = validateWorkflow(savedInput(create));
    expect(normalized.integration).toBe('linear');
    expect(normalized.conditions).toEqual({ connectionId: 'lc1' });
    expect(normalized.actions).toEqual([
      { type: 'start_session', repositoryId: 'repo1', prompt: 'Fix it', issueStartComment: false, issueDoneOnMerge: false },
    ]);
  });

  it('refuses a Linear rule with no connection', async () => {
    const create = vi.spyOn(api.workflows, 'create');
    await openEditor('linear');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Agent issues' } });
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'repo1' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Fix it' } });
    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);
    expect(await screen.findAllByText(/needs a Linear workspace/)).not.toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('hides Talyn as an assignee when the connection cannot assign', async () => {
    vi.mocked(api.linear.getStatus).mockResolvedValue(linearStatus({ connections: [connection({ canAssign: false })] }));
    await openEditor('linear');
    fireEvent.change(await screen.findByLabelText('Linear workspace'), { target: { value: 'lc1' } });
    fireEvent.click(screen.getByText('Add condition'));
    fireEvent.click(screen.getByRole('button', { name: /Assigned to/ }));
    const group = screen.getByRole('group', { name: 'Assigned to' });
    expect(within(group).queryByText('Talyn')).toBeNull();
    expect(within(group).queryByText('Me')).toBeNull();
    expect(within(group).getByText('Nobody')).toBeTruthy();
  });

  it('saves a GitHub Issues task on the issue\'s own repository', async () => {
    const create = vi.spyOn(api.workflows, 'create').mockImplementation(async (_ws, input) => ({
      id: 'wf2', workspaceId: 'ws1', createdAt: '', updatedAt: '', stats: STATS, ...input,
    } as never));
    await openEditor('github_issues');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fix bugs' } });
    fireEvent.click(screen.getByLabelText('Remove Start a session'));
    fireEvent.click(screen.getByText('Add action'));
    fireEvent.click(screen.getByRole('button', { name: /Start a task/ }));
    const repo = screen.getByLabelText('Repository') as HTMLSelectElement;
    expect(repo.value).toBe('');
    expect(within(repo).getByText('The issue\'s repository')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Fix the bug' } });
    expect(screen.getByText('Move the issue to closed when the fix merges')).toBeTruthy();
    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);

    await waitFor(() => expect(create).toHaveBeenCalled());
    const normalized = validateWorkflow(savedInput(create));
    expect(normalized.integration).toBe('github_issues');
    expect(normalized.actions).toEqual([{ type: 'start_task', repositoryId: null, prompt: 'Fix the bug' }]);
  });

  it('offers done, closed and open for a GitHub status action', async () => {
    await openEditor('github_issues');
    fireEvent.click(screen.getByText('Add action'));
    fireEvent.click(screen.getByRole('button', { name: /Change the issue status/ }));
    const status = screen.getByLabelText('Status') as HTMLSelectElement;
    expect([...status.options].map((o) => o.value)).toEqual(['done', 'closed', 'open']);
  });
});

describe('Issue run history', () => {
  it.each([
    ['issue_created', 'Issue created'],
    ['issue_pr_merged', 'Pull request merged'],
  ] as const)('shows %s on the issue identifier', async (event, label) => {
    const run = {
      id: 'r1', workflowId: 'wf1', workspaceId: 'ws1', integration: 'linear', subjectLabel: 'ENG-12',
      repositoryId: null, repoFullName: '', prNumber: 0, prTitle: '', prUrl: '', prAuthor: '', pullRequestId: null,
      taskId: null, event, status: 'succeeded', actions: [], error: null, retryAfter: null, attempts: 1,
      createdAt: new Date().toISOString(),
    } as WorkflowRun;
    vi.mocked(api.workflows.runs).mockResolvedValue([run]);
    render(<WorkflowRunsList workflowId="wf1" liveRuns={undefined} />);
    expect(await screen.findByText('ENG-12')).toBeTruthy();
    expect(screen.getByText(label)).toBeTruthy();
  });
});

describe('OpenTask', () => {
  function Location() {
    return <output>{useLocation().pathname}</output>;
  }

  it('selects the task and opens the task list', async () => {
    useWorkspaceStore.setState({ selectedTaskId: null } as never);
    render(
      <MemoryRouter initialEntries={['/open/task/task-1']}>
        <Routes>
          <Route path="/open/task/:id" element={<OpenTask />} />
          <Route path="/queue" element={<Location />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('/queue')).toBeTruthy();
    expect(useWorkspaceStore.getState().selectedTaskId).toBe('task-1');
  });
});
