import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import {
  validateWorkflow,
  type PostHogInboxDryRun,
  type PostHogInboxStatus,
  type WorkflowInput,
} from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { useBillingStore } from '../renderer/stores/billing';
import { useNavigationStore } from '../renderer/stores/navigation';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { IntegrationsView } from '../renderer/pages/IntegrationsView';
import { WorkflowsPanel } from '../renderer/components/panels/workflows/WorkflowsPanel';

const STATS = { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null };

function inboxStatus(over: Partial<PostHogInboxStatus> = {}): PostHogInboxStatus {
  return {
    access: 'ok',
    reason: null,
    authMethod: 'oauth',
    projectId: '42',
    host: 'https://us.posthog.com',
    lastPolledAt: null,
    lastError: null,
    ...over,
  };
}

const DRY_RUN: PostHogInboxDryRun = {
  matches: [
    {
      id: 'r1',
      title: 'Checkout crashes on submit',
      url: 'https://us.posthog.com/project/42/inbox/r1',
      priority: 'P0',
      repository: 'acme/app',
      signalCount: 7,
      updatedAt: '2026-11-14T00:00:00Z',
      matched: true,
      reason: null,
    },
  ],
  skipped: [
    {
      id: 'r2',
      title: 'Slow dashboard',
      url: 'https://us.posthog.com/project/42/inbox/r2',
      priority: 'P3',
      repository: 'acme/app',
      signalCount: 1,
      updatedAt: '2026-11-13T00:00:00Z',
      matched: false,
      reason: 'priority is not P0',
    },
  ],
  scanned: 12,
  truncated: true,
};

const navigate = jest.fn();

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

beforeEach(() => {
  navigate.mockReset();
  useNavigationStore.setState({ navigate } as never);
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', name: 'Acme', integrations: { github: { login: 'me' } } }],
    githubStatus: { connected: true },
    repositories: [{ id: 'repo1', fullName: 'acme/app' }],
    cloudProviders: [{ type: 'posthog_code', connected: true }],
    features: { workflows: true, posthogInboxRules: true, mcpServers: true },
  } as never);
  useBillingStore.setState({ status: null, refresh: jest.fn() } as never);
    jest.spyOn(api.workflows, 'list').mockResolvedValue([]);
  jest.spyOn(api.workflows, 'suggestions').mockResolvedValue({ repos: ['acme/app'], branches: [], labels: [], people: [], teams: [], partial: false } as never);
  jest.spyOn(api.workflows, 'runs').mockResolvedValue([]);
  jest.spyOn(api.workflows, 'posthogInboxStatus').mockResolvedValue(inboxStatus());
  jest.spyOn(api.workflows, 'posthogInboxDryRun').mockResolvedValue(DRY_RUN);
  jest.spyOn(api.ws, 'on').mockReturnValue(() => {});
  jest.spyOn(api.mcpServers, 'list').mockResolvedValue([]);
  jest.spyOn(api.slack, 'getStatus').mockResolvedValue({ installations: [], links: [] });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

async function openEditor() {
  render(<WorkflowsPanel integration="posthog_inbox" />);
  await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'posthog_inbox'));
  fireEvent.click(screen.getByText('New automation'));
  await screen.findByLabelText('Name');
}

function addCondition(label: string) {
  fireEvent.click(screen.getByText('Add condition'));
  const option = screen.getAllByRole('button', { name: new RegExp(label) }).find((b) => b.closest('.absolute'));
  fireEvent.click(option!);
}

function fillNameAndPrompt() {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fix urgent reports' } });
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Fix the report' } });
}

describe('PostHog Inbox in the catalog', () => {
  it.each([
    ['flag on', { workflows: true, posthogInboxRules: true }, true],
    ['flag off', { workflows: true, posthogInboxRules: false }, false],
    ['workflows off', { workflows: false, posthogInboxRules: true }, false],
  ])('%s', (_label, features, visible) => {
    useWorkspaceStore.setState({ features } as never);
    render(<IntegrationsView kind={null} />);
    const card = document.querySelector('[data-attr="integration-card-posthog_inbox"]');
    expect(Boolean(card)).toBe(visible);
    if (card) expect(within(card as HTMLElement).getByText('Connected')).toBeTruthy();
  });

  it('opens PostHog Inbox automations with the PostHog connection note', async () => {
    render(<IntegrationsView kind="posthog_inbox" />);
    expect(await screen.findByText(/Start a session when a PostHog self-driving report is ready for work/)).toBeTruthy();
    await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'posthog_inbox'));
    expect(screen.getByText(/Uses your PostHog connection/)).toBeTruthy();
    fireEvent.click(screen.getByText('Open PostHog Code'));
    expect(navigate).toHaveBeenCalledWith({ view: 'integrations', kind: 'posthog' });
  });

  it('sends the Connection tab to the PostHog Code page', async () => {
    render(<IntegrationsView kind="posthog_inbox" />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Connection' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Connection' }));
    expect(await screen.findByText(/use your PostHog connection/)).toBeTruthy();
  });
});

describe('PostHog Inbox rule editor', () => {
  it('starts a session on the report\'s repository, with no repository picker', async () => {
    await openEditor();
    expect(screen.getByText('Start a session')).toBeTruthy();
    expect(screen.getByText('Report ready for work')).toBeTruthy();
    expect(screen.queryByLabelText('Repository')).toBeNull();
    expect(screen.getByText(/The session works on the report's own repository/)).toBeTruthy();
    expect(screen.queryByLabelText('Remove Report ready for work')).toBeNull();
  });

  it('allows one start action only', async () => {
    await openEditor();
    fireEvent.click(screen.getByText('Add action'));
    const option = screen.getAllByRole('button', { name: /Start a session/ }).find((b) => b.closest('.absolute'));
    expect((option as HTMLButtonElement).disabled).toBe(true);
  });

  it('edits every condition and saves them', async () => {
    const create = jest.spyOn(api.workflows, 'create').mockImplementation(async (_ws, input) => ({
      id: 'wf1', workspaceId: 'ws1', createdAt: '', updatedAt: '', stats: STATS, ...input,
    } as never));
    await openEditor();
    fillNameAndPrompt();

    addCondition('Repository');
    const repoInput = screen.getByPlaceholderText('owner/repo');
    fireEvent.change(repoInput, { target: { value: 'acme/app' } });
    fireEvent.keyDown(repoInput, { key: 'Enter' });

    addCondition('Priority');
    fireEvent.click(screen.getByRole('button', { name: 'P0' }));
    fireEvent.click(screen.getByRole('button', { name: 'P1' }));

    addCondition('Actionability');
    fireEvent.click(screen.getByRole('button', { name: 'Needs a person' }));

    addCondition('Source product');
    const product = screen.getByPlaceholderText('error_tracking');
    fireEvent.change(product, { target: { value: 'error_tracking' } });
    fireEvent.keyDown(product, { key: 'Enter' });

    addCondition('Scout');
    const [include, exclude] = screen.getAllByPlaceholderText('Scout skill name');
    fireEvent.change(include!, { target: { value: 'errors' } });
    fireEvent.keyDown(include!, { key: 'Enter' });
    fireEvent.change(exclude!, { target: { value: 'noise' } });
    fireEvent.keyDown(exclude!, { key: 'Enter' });

    addCondition('Suggested reviewer');
    const reviewer = screen.getByPlaceholderText('GitHub login');
    fireEvent.change(reviewer, { target: { value: 'alice' } });
    fireEvent.keyDown(reviewer, { key: 'Enter' });

    addCondition('Title contains');
    addCondition('Summary contains');
    const [title, summary] = within(document.querySelector('[data-attr="posthog-inbox-conditions"]') as HTMLElement)
      .getAllByRole('textbox')
      .filter((el) => !(el as HTMLInputElement).placeholder);
    fireEvent.change(title!, { target: { value: 'crash' } });
    fireEvent.change(summary!, { target: { value: 'checkout' } });

    addCondition('At least this many signals');
    fireEvent.change(screen.getByLabelText('At least this many signals'), { target: { value: '3' } });

    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);
    await waitFor(() => expect(create).toHaveBeenCalled());
    const [workspaceId, input] = create.mock.calls[0]! as [string, WorkflowInput];
    expect(workspaceId).toBe('ws1');
    const normalized = validateWorkflow(input);
    expect(normalized.integration).toBe('posthog_inbox');
    expect(normalized.events).toEqual(['report_ready']);
    expect(normalized.conditions).toEqual({
      repositories: ['acme/app'],
      priorities: ['P0', 'P1'],
      actionability: ['immediately_actionable', 'requires_human_input'],
      sourceProducts: ['error_tracking'],
      scouts: { include: ['errors'], exclude: ['noise'] },
      suggestedReviewers: ['alice'],
      titleContains: 'crash',
      summaryContains: 'checkout',
      minSignalCount: 3,
    });
    expect(normalized.actions).toEqual([{ type: 'start_session', repositoryId: null, prompt: 'Fix the report' }]);
    expect(normalized.maxRunsPerDay).toBe(10);
  });

  it('edits the daily cap under Advanced', async () => {
    const create = jest.spyOn(api.workflows, 'create').mockImplementation(async (_ws, input) => ({
      id: 'wf1', workspaceId: 'ws1', createdAt: '', updatedAt: '', stats: STATS, ...input,
    } as never));
    await openEditor();
    fillNameAndPrompt();
    fireEvent.click(screen.getByText('Advanced'));
    expect(screen.getByText('Runs per report per hour')).toBeTruthy();
    const cap = screen.getByLabelText('Runs per day') as HTMLInputElement;
    expect(cap.value).toBe('10');
    fireEvent.change(cap, { target: { value: '25' } });
    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(validateWorkflow((create.mock.calls[0] as [string, WorkflowInput])[1]).maxRunsPerDay).toBe(25);
  });

  it.each([
    ['reconnect', { access: 'reconnect', reason: 'The grant has no inbox:read.' }, /Reconnect PostHog to let Talyn read your Inbox/, 'Reconnect PostHog'],
    ['not_connected', { access: 'not_connected', projectId: null, authMethod: null }, /Connect PostHog first/, 'Connect PostHog'],
  ] as const)('shows the %s notice with a link to PostHog Code', async (_access, over, text, button) => {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(inboxStatus(over));
    await openEditor();
    expect(await screen.findByText(text)).toBeTruthy();
    if (over.access === 'reconnect') expect(screen.getByText('The grant has no inbox:read.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(navigate).toHaveBeenCalledWith({ view: 'integrations', kind: 'posthog' });
  });

  it('shows the last poll error when the connection works', async () => {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(
      inboxStatus({ lastPolledAt: '2026-11-14T10:00:00Z', lastError: 'PostHog answered 500' })
    );
    await openEditor();
    expect(await screen.findByText(/Talyn reads the Inbox of PostHog project 42/)).toBeTruthy();
    expect(screen.getByText(/PostHog answered 500/)).toBeTruthy();
    expect(screen.queryByText(/Reconnect PostHog/)).toBeNull();
  });

  it('previews matches without starting anything', async () => {
    await openEditor();
    fillNameAndPrompt();
    expect(screen.getByText(/The preview starts nothing/)).toBeTruthy();
    fireEvent.click(document.querySelector('[data-attr="posthog-inbox-preview-run"]')!);

    await waitFor(() => expect(api.workflows.posthogInboxDryRun).toHaveBeenCalled());
    const [workspaceId, input] = jest.mocked(api.workflows.posthogInboxDryRun).mock.calls[0]!;
    expect(workspaceId).toBe('ws1');
    expect(input.integration).toBe('posthog_inbox');
    expect(input.name).toBe('Fix urgent reports');

    const link = (await screen.findByText('Checkout crashes on submit')).closest('a')!;
    expect(link.getAttribute('href')).toBe('https://us.posthog.com/project/42/inbox/r1');
    const matches = document.querySelector('[data-attr="posthog-inbox-preview-matches"]') as HTMLElement;
    expect(within(matches).getByText(/P0 · acme\/app · 7 signals/)).toBeTruthy();
    expect(screen.getByText(/Talyn read 12 reports\. 1 of them matches\./)).toBeTruthy();
    expect(screen.getByText(/PostHog has more reports than the preview reads/)).toBeTruthy();
    const skipped = document.querySelector('[data-attr="posthog-inbox-preview-skipped"]') as HTMLElement;
    expect(within(skipped).getByText('1 skipped report')).toBeTruthy();
    expect(within(skipped).getByText(/priority is not P0/)).toBeTruthy();
  });

  it('previews before the rule has a name or a prompt', async () => {
    await openEditor();
    fireEvent.click(document.querySelector('[data-attr="posthog-inbox-preview-run"]')!);
    await waitFor(() => expect(api.workflows.posthogInboxDryRun).toHaveBeenCalled());
    expect(screen.queryByText(/Fix this first/)).toBeNull();
  });

  it('clears the preview when a condition changes', async () => {
    await openEditor();
    fillNameAndPrompt();
    fireEvent.click(document.querySelector('[data-attr="posthog-inbox-preview-run"]')!);
    expect(await screen.findByText('Checkout crashes on submit')).toBeTruthy();
    addCondition('Priority');
    await waitFor(() => expect(screen.queryByText('Checkout crashes on submit')).toBeNull());
  });
});
