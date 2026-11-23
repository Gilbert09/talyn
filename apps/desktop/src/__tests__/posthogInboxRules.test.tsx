import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import {
  POSTHOG_INBOX_DEFAULT_PROMPT,
  validateWorkflow,
  type PostHogClaimSummary,
  type PostHogInboxDryRun,
  type PostHogInboxStatus,
  type WorkflowInput,
  type WorkflowRun,
} from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { useBillingStore } from '../renderer/stores/billing';
import { useNavigationStore } from '../renderer/stores/navigation';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useIntegrationSectionFocus } from '../renderer/lib/automationFocus';
import { IntegrationsView } from '../renderer/pages/IntegrationsView';
import { WorkflowsPanel } from '../renderer/components/panels/workflows/WorkflowsPanel';
import { WorkflowRunsList } from '../renderer/components/panels/workflows/WorkflowRunsList';
import { PostHogInboxConnectionSection } from '../renderer/components/panels/workflows/posthogInboxFields';

const STATS = { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, sessionsStarted: 0, lastRunAt: null, lastStatus: null };

function inboxStatus(over: Partial<PostHogInboxStatus> = {}): PostHogInboxStatus {
  return {
    access: 'ok',
    reason: null,
    authMethod: 'oauth',
    projectId: '42',
    host: 'https://us.posthog.com',
    connection: 'posthog_inbox',
    missingScopes: [],
    oauthAvailable: true,
    lastPolledAt: null,
    lastError: null,
    lastPushAt: null,
    pushConfigured: false,
    pushManaged: false,
    pushSetupMissingScopes: [],
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
const openWindow = jest.fn();


beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

beforeEach(() => {
  navigate.mockReset();
  openWindow.mockReset();
  window.open = openWindow as never;
  useIntegrationSectionFocus.setState({ target: null });
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
  jest.spyOn(api.workflows, 'posthogInboxWebhook').mockResolvedValue(null);
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
  ])('%s', async (_label, features, visible) => {
    useWorkspaceStore.setState({ features } as never);
    render(<IntegrationsView kind={null} />);
    const card = document.querySelector('[data-attr="integration-card-posthog_inbox"]');
    expect(Boolean(card)).toBe(visible);
    if (card) expect(await within(card as HTMLElement).findByText('Connected')).toBeTruthy();
    else expect(api.workflows.posthogInboxStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['ok', { access: 'ok' }, 'Connected'],
    ['unknown', { access: 'unknown', authMethod: 'personal_api_key' }, 'Connected'],
    ['reconnect', { access: 'reconnect' }, 'Not connected'],
    ['not_connected', { access: 'not_connected', connection: null, projectId: null }, 'Not connected'],
    ['PostHog Code fallback', { access: 'ok', connection: 'posthog_code' }, 'Connected'],
  ] as const)('reads its own state, not the PostHog Code state: %s', async (_label, over, badge) => {
    // PostHog Code says the opposite, so a mirror of it would fail.
    useWorkspaceStore.setState({
      cloudProviders: [{ type: 'posthog_code', connected: badge !== 'Connected' }],
    } as never);
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(inboxStatus(over as Partial<PostHogInboxStatus>));
    render(<IntegrationsView kind={null} />);
    const card = document.querySelector('[data-attr="integration-card-posthog_inbox"]') as HTMLElement;
    expect(await within(card).findByText(badge)).toBeTruthy();
    expect(api.workflows.posthogInboxStatus).toHaveBeenCalledWith('ws1');
  });

  it('shows no badge while the status cannot be read', async () => {
    jest.mocked(api.workflows.posthogInboxStatus).mockRejectedValue(new Error('down'));
    render(<IntegrationsView kind={null} />);
    await waitFor(() => expect(api.workflows.posthogInboxStatus).toHaveBeenCalled());
    const card = document.querySelector('[data-attr="integration-card-posthog_inbox"]') as HTMLElement;
    await new Promise((r) => setTimeout(r, 0));
    expect(within(card).queryByText('Connected')).toBeNull();
    expect(within(card).queryByText('Not connected')).toBeNull();
  });

  it('opens PostHog Inbox automations with a link to its own connection', async () => {
    render(<IntegrationsView kind="posthog_inbox" />);
    expect(await screen.findByText(/Start a session when a PostHog self-driving report is ready for work/)).toBeTruthy();
    await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'posthog_inbox'));
    expect(screen.getByText(/read the Inbox through your PostHog connection/)).toBeTruthy();
    expect(screen.queryByText('Open PostHog Code')).toBeNull();
    fireEvent.click(screen.getByText('Manage the connection'));
    expect(navigate).toHaveBeenCalledWith({ view: 'integrations', kind: 'posthog_inbox' });
    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'posthog' }));
    expect(await screen.findByText('Talyn reads your Inbox with your PostHog account.')).toBeTruthy();
    expect(document.querySelector('[data-attr="posthog-inbox-connection-section"]')).toBeTruthy();
  });

  it('has a Reports tab that shows the reports an automation matches', async () => {
    jest.mocked(api.workflows.list).mockResolvedValue([
      {
        id: 'wf1', workspaceId: 'ws1', integration: 'posthog_inbox', name: 'Fix urgent reports', enabled: true,
        events: ['report_ready'], conditions: {}, actions: [{ type: 'start_session', prompt: 'Fix it' }],
        stats: { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, sessionsStarted: 0, lastRunAt: null, lastStatus: null },
      } as never,
    ]);
    const backlog = jest.spyOn(api.workflows, 'posthogInboxBacklog').mockResolvedValue({
      rows: [], scanned: 0, nextOffset: null, total: 0, days: 7, workflowId: 'wf1',
      runnable: true, notRunnableReason: null, dailyCap: 10, runsToday: 0,
    });
    jest.spyOn(api.workflows, 'posthogInboxBacklogCount').mockResolvedValue({
      days: 7, matched: 0, scanned: 0, total: 0, complete: true,
      byState: { not_run: 0, running: 0, already_run: 0, claimed_elsewhere: 0, already_addressed: 0, repository_not_connected: 0, held_back: 0 },
    });
    render(<IntegrationsView kind="posthog_inbox" />);
    const tab = await screen.findByRole('tab', { name: 'Reports' });
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
    expect(await screen.findByText('0 reports match in the last 7 days.')).toBeTruthy();
    expect(backlog).toHaveBeenCalledWith('ws1', expect.objectContaining({ workflowId: 'wf1', offset: 0 }));
  });

  it('shows its own connection card on the Connection tab', async () => {
    render(<IntegrationsView kind="posthog_inbox" />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Connection' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Connection' }));
    expect(await screen.findByText('Talyn reads your Inbox with your PostHog account.')).toBeTruthy();
    expect(screen.queryByText(/PostHog Code page/)).toBeNull();
    expect(screen.queryByText('Open PostHog Code')).toBeNull();
  });

  it('asks for a PostHog connection before it shows the automations', async () => {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(
      inboxStatus({ access: 'not_connected', connection: null, projectId: null, authMethod: null })
    );
    render(<IntegrationsView kind="posthog_inbox" />);
    expect(await screen.findByText('Connect PostHog first')).toBeTruthy();
    expect(screen.queryByText('New automation')).toBeNull();
    expect(screen.queryByText('Manage the connection')).toBeNull();
    expect(api.workflows.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Connect PostHog' }));
    expect(navigate).toHaveBeenCalledWith({ view: 'integrations', kind: 'posthog_inbox' });
    expect(await screen.findByRole('button', { name: 'Connect with PostHog' })).toBeTruthy();
    expect(useIntegrationSectionFocus.getState().target).toBeNull();
  });

  it('shows nothing of the automations while it checks the connection', async () => {
    jest.mocked(api.workflows.posthogInboxStatus).mockReturnValue(new Promise(() => {}));
    render(<IntegrationsView kind="posthog_inbox" />);
    expect(await screen.findByText('Checking the PostHog connection...')).toBeTruthy();
    expect(screen.queryByText('New automation')).toBeNull();
    expect(api.workflows.list).not.toHaveBeenCalled();
  });

  it('shows the automations with a reconnect line when the connection needs a reconnect', async () => {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(inboxStatus({ access: 'reconnect', reason: 'Old grant.' }));
    render(<IntegrationsView kind="posthog_inbox" />);
    await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'posthog_inbox'));
    expect(screen.getByText(/Until you do, these automations do not run/)).toBeTruthy();
    expect(screen.queryByText('Connect PostHog first')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect PostHog' }));
    expect(navigate).toHaveBeenCalledWith({ view: 'integrations', kind: 'posthog_inbox' });
    expect(await screen.findByText('Talyn reads your Inbox with your PostHog account.')).toBeTruthy();
  });

  it.each([
    ['ok', inboxStatus()],
    ['unknown', inboxStatus({ access: 'unknown' })],
  ])('shows the automations when the connection is %s', async (_access, status) => {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(status);
    render(<IntegrationsView kind="posthog_inbox" />);
    await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'posthog_inbox'));
    expect(screen.getByText('Manage the connection')).toBeTruthy();
    expect(screen.queryByText('Connect PostHog first')).toBeNull();
  });

  it('shows the automations when the connection status cannot be read', async () => {
    jest.mocked(api.workflows.posthogInboxStatus).mockRejectedValue(new Error('down'));
    render(<IntegrationsView kind="posthog_inbox" />);
    await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'posthog_inbox'));
    expect(screen.queryByText('Connect PostHog first')).toBeNull();
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

  it('starts the prompt with the template', async () => {
    await openEditor();
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe(POSTHOG_INBOX_DEFAULT_PROMPT);
    expect(screen.queryByRole('button', { name: 'Use the template' })).toBeNull();
  });

  it('puts the template back into an empty prompt', async () => {
    await openEditor();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use the template' }));
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe(POSTHOG_INBOX_DEFAULT_PROMPT);
  });

  it.each(['{{report.title}}', '{{report.url}}', '{{report.summary}}', '{{report.id}}', '{{repo}}'])(
    'inserts %s at the cursor',
    async (placeholder) => {
      await openEditor();
      const prompt = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
      fireEvent.change(prompt, { target: { value: 'Fix  now' } });
      prompt.setSelectionRange(4, 4);
      fireEvent.click(screen.getByRole('button', { name: placeholder }));
      expect(prompt.value).toBe(`Fix ${placeholder} now`);
    }
  );

  it('replaces the selected text with a field', async () => {
    await openEditor();
    const prompt = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: 'Fix TITLE now' } });
    prompt.setSelectionRange(4, 9);
    fireEvent.click(screen.getByRole('button', { name: '{{report.title}}' }));
    expect(prompt.value).toBe('Fix {{report.title}} now');
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
    ['reconnect', { access: 'reconnect', reason: 'The grant has no inbox:read.' }, /Reconnect PostHog to let Talyn read and claim your Inbox reports/, 'Reconnect PostHog'],
    ['not_connected', { access: 'not_connected', projectId: null, authMethod: null }, /Connect PostHog first/, 'Connect PostHog'],
  ] as const)('shows the %s notice with a link to the Inbox connection', async (_access, over, text, button) => {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(inboxStatus(over));
    await openEditor();
    expect(await screen.findByText(text)).toBeTruthy();
    if (over.access === 'reconnect') expect(screen.getByText('The grant has no inbox:read.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: button }));
    expect(navigate).toHaveBeenCalledWith({ view: 'integrations', kind: 'posthog_inbox' });
    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'posthog' }));
    expect(useIntegrationSectionFocus.getState().target).toEqual({ kind: 'posthog_inbox', section: 'connection' });
  });

  it.each([
    ['some scopes', ['inbox:write', 'task:write'], 'Missing permissions: inbox:write, task:write.'],
    ['one scope', ['task:write'], 'Missing permissions: task:write.'],
    ['no scopes', [], null],
  ])('lists the missing scopes in the reconnect notice: %s', async (_label, missingScopes, text) => {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(
      inboxStatus({ access: 'reconnect', reason: 'Old grant.', missingScopes })
    );
    await openEditor();
    expect(await screen.findByText('Old grant.')).toBeTruthy();
    if (text) expect(screen.getByText(text)).toBeTruthy();
    else expect(document.querySelector('[data-attr="posthog-inbox-missing-scopes"]')).toBeNull();
  });

  it('tells the editor when the rules use the PostHog Code connection', async () => {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(inboxStatus({ connection: 'posthog_code' }));
    await openEditor();
    expect(await screen.findByText(/It uses the older PostHog Code connection/)).toBeTruthy();
    fireEvent.click(screen.getByText('Connect PostHog for the Inbox'));
    expect(navigate).toHaveBeenCalledWith({ view: 'integrations', kind: 'posthog_inbox' });
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

  it('adds a typed reviewer that was not entered when the field loses focus', async () => {
    await openEditor();
    addCondition('Suggested reviewer');
    const reviewer = screen.getByPlaceholderText('GitHub login');
    fireEvent.change(reviewer, { target: { value: 'Gilbert09' } });
    fireEvent.blur(reviewer);
    expect(screen.getByLabelText('Remove Gilbert09')).toBeTruthy();

    fireEvent.click(document.querySelector('[data-attr="posthog-inbox-preview-run"]')!);
    await waitFor(() => expect(api.workflows.posthogInboxDryRun).toHaveBeenCalled());
    const [, input] = jest.mocked(api.workflows.posthogInboxDryRun).mock.calls[0]!;
    expect(input.conditions?.suggestedReviewers).toEqual(['Gilbert09']);
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

describe('PostHog Inbox run history', () => {
  const run = (over: Partial<WorkflowRun> = {}) =>
    ({
      id: 'run-1', workflowId: 'wf1', workspaceId: 'ws1', integration: 'posthog_inbox', subjectLabel: 'Checkout crashes',
      repositoryId: 'repo1', repoFullName: '', prNumber: 0, prTitle: '', prUrl: '', prAuthor: '', pullRequestId: null,
      taskId: null, workbenchId: null, event: 'report_ready', status: 'succeeded',
      actions: [{ type: 'start_session', ok: true, detail: 'started a session' }],
      error: null, retryAfter: null, attempts: 1, createdAt: new Date().toISOString(), ...over,
    }) as WorkflowRun;
  const claim = (over: Partial<PostHogClaimSummary>): PostHogClaimSummary => ({
    state: 'claimed', prUrl: null, reason: null, pending: false, error: null, updatedAt: null, ...over,
  });

  it.each([
    ['claimed', claim({}), 'Claimed the report in PostHog.', null],
    ['PR attached', claim({ state: 'pr_attached', prUrl: 'https://github.com/acme/app/pull/7' }), 'Attached the pull request to the claim in PostHog.', 'acme/app/pull/7'],
    ['merged', claim({ state: 'merged', prUrl: 'https://github.com/acme/app/pull/7' }), 'The pull request merged. PostHog resolves the report.', 'acme/app/pull/7'],
    ['released', claim({ state: 'released', reason: 'the session was archived without a pull request' }), 'Released the claim in PostHog: the session was archived without a pull request.', null],
    ['lost', claim({ state: 'lost', reason: 'somebody else took the report over' }), 'PostHog ended the claim: somebody else took the report over.', null],
    ['an update owed', claim({ pending: true, error: '503: down' }), 'Claimed the report in PostHog. PostHog did not take the last update (503: down). Talyn tries again.', null],
  ])('shows the claim when it is %s', async (_name, posthogClaim, text, link) => {
    jest.spyOn(api.workflows, 'runs').mockResolvedValue([run({ posthogClaim })]);
    render(<WorkflowRunsList workflowId="wf1" liveRuns={undefined} />);
    expect(await screen.findByText('Checkout crashes')).toBeTruthy();
    const line = document.querySelector('[data-testid="posthog-claim"]') as HTMLElement;
    expect(line.textContent).toContain(text);
    const anchor = line.querySelector('a');
    expect(anchor?.textContent ?? null).toBe(link);
    if (anchor) expect(anchor.getAttribute('href')).toBe(posthogClaim.prUrl);
  });

  it('shows no claim line on a run without a claim, and says why a lost race was skipped', async () => {
    jest.spyOn(api.workflows, 'runs').mockResolvedValue([
      run({
        status: 'skipped',
        actions: [{ type: 'start_session', ok: false, code: 'report_claimed_elsewhere', error: 'Another person or agent claimed this report in PostHog first, so Talyn started no session.' }],
      }),
    ]);
    render(<WorkflowRunsList workflowId="wf1" liveRuns={undefined} />);
    expect(await screen.findByText(/claimed this report in PostHog first/)).toBeTruthy();
    expect(document.querySelector('[data-testid="posthog-claim"]')).toBeNull();
  });

  it('says a parked claim waits for PostHog, not GitHub', async () => {
    jest.spyOn(api.workflows, 'runs').mockResolvedValue([
      run({
        status: 'pending_retry',
        retryAfter: new Date(Date.now() + 10 * 60_000).toISOString(),
        actions: [{ type: 'start_session', ok: false, code: 'posthog_unavailable', error: 'PostHog did not take the claim (503). Talyn tries again later.' }],
      }),
    ]);
    render(<WorkflowRunsList workflowId="wf1" liveRuns={undefined} />);
    expect(await screen.findByText(/PostHog did not take the claim on the report\./)).toBeTruthy();
    expect(screen.queryByText(/GitHub is rate-limiting/)).toBeNull();
  });
});

describe('PostHog Inbox connection card', () => {
  const NOT_CONNECTED: Partial<PostHogInboxStatus> = {
    access: 'not_connected',
    connection: null,
    authMethod: null,
    projectId: null,
    host: null,
  };

  async function renderCard(over: Partial<PostHogInboxStatus> = {}) {
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(inboxStatus(over));
    render(<PostHogInboxConnectionSection />);
    await waitFor(() => expect(screen.queryByText('Checking the PostHog connection...')).toBeNull());
    return document.querySelector('[data-attr="posthog-inbox-connection-section"]') as HTMLElement;
  }

  function button(name: string | RegExp) {
    return screen.getByRole('button', { name });
  }

  it.each([
    [
      'not connected, OAuth available',
      NOT_CONNECTED,
      'Not connected',
      ['Connect with PostHog', 'Use a personal API key instead'],
      ['Disconnect', 'Save and verify', 'Connect PostHog for the Inbox', 'Reconnect'],
    ],
    [
      'not connected, no OAuth',
      { ...NOT_CONNECTED, oauthAvailable: false },
      'Not connected',
      ['Save and verify'],
      ['Connect with PostHog', 'Connect with PostHog instead', 'Cancel', 'Disconnect'],
    ],
    [
      'connected with Inbox OAuth',
      {},
      'Connected',
      ['Reconnect', 'Disconnect'],
      ['Connect with PostHog', 'Connect PostHog for the Inbox', 'Save and verify'],
    ],
    [
      'connected with an Inbox key, OAuth available',
      { authMethod: 'personal_api_key' },
      'Connected',
      ['Switch to PostHog sign-in', 'Disconnect'],
      ['Reconnect', 'Edit'],
    ],
    [
      'connected with an Inbox key, no OAuth',
      { authMethod: 'personal_api_key', oauthAvailable: false },
      'Connected',
      ['Edit', 'Disconnect'],
      ['Reconnect', 'Switch to PostHog sign-in'],
    ],
    [
      'unknown Inbox key',
      { access: 'unknown', authMethod: 'personal_api_key' },
      'Connected',
      ['Disconnect'],
      ['Reconnect'],
    ],
    [
      'connected through PostHog Code',
      { connection: 'posthog_code' },
      'Connected',
      ['Connect PostHog for the Inbox'],
      ['Disconnect', 'Reconnect'],
    ],
    [
      'reconnect on the Inbox connection',
      { access: 'reconnect', reason: 'PostHog revoked the grant.' },
      'Reconnect needed',
      ['Reconnect', 'Disconnect'],
      ['Connect PostHog for the Inbox'],
    ],
    [
      'reconnect on the PostHog Code connection',
      { access: 'reconnect', connection: 'posthog_code', reason: 'The grant has no inbox:read.' },
      'Reconnect needed',
      ['Reconnect', 'Connect PostHog for the Inbox'],
      ['Disconnect'],
    ],
  ] as const)('%s', async (_label, over, badge, shown, hidden) => {
    const card = await renderCard(over as Partial<PostHogInboxStatus>);
    expect(within(card).getByText(badge)).toBeTruthy();
    for (const name of shown) expect(within(card).getByRole('button', { name })).toBeTruthy();
    for (const name of hidden) expect(within(card).queryByRole('button', { name })).toBeNull();
    expect(screen.queryByText('Open PostHog Code')).toBeNull();
  });

  it.each([
    ['Inbox OAuth', {}, 'Talyn reads your Inbox with your PostHog account.'],
    ['Inbox key', { authMethod: 'personal_api_key' }, 'Talyn reads your Inbox with a personal API key.'],
    ['PostHog Code', { connection: 'posthog_code' }, /use your older PostHog Code connection/],
    ['unknown key', { access: 'unknown', authMethod: 'personal_api_key' }, 'Talyn has not used this API key on your Inbox yet.'],
  ] as const)('shows the project and host when connected: %s', async (_label, over, text) => {
    const card = await renderCard({ projectId: '77', host: 'https://eu.posthog.com', ...over } as Partial<PostHogInboxStatus>);
    const details = within(card).getByText('Project').closest('dl') as HTMLElement;
    expect(within(details).getByText('77')).toBeTruthy();
    expect(within(details).getByText('https://eu.posthog.com')).toBeTruthy();
    expect(within(details).getByText('Not checked yet')).toBeTruthy();
    expect(within(card).getByText(text)).toBeTruthy();
  });

  it('shows the last check time and error', async () => {
    const card = await renderCard({ lastPolledAt: '2026-11-14T10:00:00Z', lastError: 'PostHog answered 500' });
    expect(within(card).queryByText('Not checked yet')).toBeNull();
    expect(within(card).getByText(/The last check failed\. PostHog answered 500/)).toBeTruthy();
  });

  it.each([
    ['two scopes', ['inbox:write', 'task:write'], 'Missing permissions: inbox:write, task:write.'],
    ['all scopes', ['inbox:read', 'inbox:write', 'task:write'], 'Missing permissions: inbox:read, inbox:write, task:write.'],
    ['no scopes', [], null],
  ])('lists the missing scopes: %s', async (_label, missingScopes, text) => {
    const card = await renderCard({ access: 'reconnect', reason: 'Old grant.', missingScopes });
    expect(within(card).getByText('Old grant.')).toBeTruthy();
    if (text) expect(within(card).getByText(text)).toBeTruthy();
    else expect(card.querySelector('[data-attr="posthog-inbox-missing-scopes"]')).toBeNull();
  });

  it('shows a default reason when the reconnect has none', async () => {
    const card = await renderCard({ access: 'reconnect', reason: null });
    expect(within(card).getByText('The PostHog connection does not have the Inbox permissions.')).toBeTruthy();
  });

  it.each([
    ['a host', ' https://eu.posthog.com ', 'https://eu.posthog.com'],
    ['the default host', null, 'https://us.posthog.com'],
    ['a blank host', '   ', undefined],
  ])('starts the Inbox OAuth from Connect with %s', async (_label, typed, host) => {
    const start = jest.spyOn(api.posthogInbox, 'startOAuth').mockResolvedValue({ authorizeUrl: 'https://us.posthog.com/oauth/authorize?x=1' });
    await renderCard(NOT_CONNECTED);
    if (typed !== null) fireEvent.change(screen.getByLabelText('PostHog host'), { target: { value: typed } });
    fireEvent.click(button('Connect with PostHog'));
    await waitFor(() => expect(start).toHaveBeenCalledWith('ws1', { host, projectId: undefined }));
    await waitFor(() => expect(openWindow).toHaveBeenCalledWith('https://us.posthog.com/oauth/authorize?x=1', '_blank', 'noopener,noreferrer'));
  });

  it.each([
    ['the reconnect notice', { access: 'reconnect', missingScopes: ['task:write'] }, 'Reconnect'],
    ['a working Inbox grant', {}, 'Reconnect'],
    ['an Inbox key', { authMethod: 'personal_api_key' }, 'Switch to PostHog sign-in'],
    ['the PostHog Code fallback', { connection: 'posthog_code' }, 'Connect PostHog for the Inbox'],
    ['a PostHog Code reconnect', { access: 'reconnect', connection: 'posthog_code' }, 'Reconnect'],
  ] as const)('starts the Inbox OAuth with the project from %s', async (_label, over, name) => {
    const start = jest.spyOn(api.posthogInbox, 'startOAuth').mockResolvedValue({ authorizeUrl: 'https://us.posthog.com/oauth/again' });
    await renderCard(over as Partial<PostHogInboxStatus>);
    fireEvent.click(button(name));
    await waitFor(() => expect(start).toHaveBeenCalledWith('ws1', { host: 'https://us.posthog.com', projectId: '42' }));
    await waitFor(() => expect(openWindow).toHaveBeenCalledWith('https://us.posthog.com/oauth/again', '_blank', 'noopener,noreferrer'));
  });

  it.each([
    ['a reconnect', { access: 'reconnect', authMethod: 'personal_api_key', oauthAvailable: false }, 'Reconnect'],
    ['the PostHog Code fallback', { connection: 'posthog_code', oauthAvailable: false }, 'Connect PostHog for the Inbox'],
    ['an edit', { authMethod: 'personal_api_key', oauthAvailable: false }, 'Edit'],
  ] as const)('opens the key form for %s when OAuth is not available', async (_label, over, name) => {
    const start = jest.spyOn(api.posthogInbox, 'startOAuth');
    await renderCard(over as Partial<PostHogInboxStatus>);
    fireEvent.click(button(name));
    expect(await screen.findByRole('button', { name: 'Save and verify' })).toBeTruthy();
    expect((screen.getByLabelText('Project id') as HTMLInputElement).value).toBe('42');
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ['a generic failure', new Error('PostHog is down'), 'PostHog is down', false],
    ['no message', {}, 'Could not start the PostHog sign-in.', false],
    [
      'OAuth not set up',
      Object.assign(new Error('nope'), { code: 'posthog_inbox_oauth_unavailable' }),
      'PostHog sign-in is not set up here. Use a personal API key.',
      true,
    ],
  ])('shows an OAuth start error: %s', async (_label, err, text, keyForm) => {
    jest.spyOn(api.posthogInbox, 'startOAuth').mockRejectedValue(err);
    await renderCard(NOT_CONNECTED);
    fireEvent.click(button('Connect with PostHog'));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(Boolean(screen.queryByRole('button', { name: 'Save and verify' }))).toBe(keyForm);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('saves a personal API key with trimmed values and shows the new status', async () => {
    const save = jest.spyOn(api.posthogInbox, 'saveConfig').mockResolvedValue(
      inboxStatus({ access: 'unknown', authMethod: 'personal_api_key', projectId: '7', host: 'https://eu.posthog.com', oauthAvailable: false })
    );
    await renderCard({ ...NOT_CONNECTED, oauthAvailable: false });
    fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: '  phx_secret  ' } });
    fireEvent.change(screen.getByLabelText('Project id'), { target: { value: ' 7 ' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: ' https://eu.posthog.com ' } });
    fireEvent.click(button('Save and verify'));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('ws1', { apiKey: 'phx_secret', projectId: '7', host: 'https://eu.posthog.com' })
    );
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText('Talyn has not used this API key on your Inbox yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save and verify' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  });

  it('sends no host when the host is blank', async () => {
    const save = jest.spyOn(api.posthogInbox, 'saveConfig').mockResolvedValue(inboxStatus({ authMethod: 'personal_api_key' }));
    await renderCard({ ...NOT_CONNECTED, oauthAvailable: false });
    fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'phx_k' } });
    fireEvent.change(screen.getByLabelText('Project id'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: '  ' } });
    fireEvent.click(button('Save and verify'));
    await waitFor(() => expect(save).toHaveBeenCalledWith('ws1', { apiKey: 'phx_k', projectId: '9', host: undefined }));
  });

  it.each([
    ['no key', '', '7', true],
    ['a blank key', '   ', '7', true],
    ['no project', 'phx_k', '', true],
    ['a blank project', 'phx_k', '  ', true],
    ['both', 'phx_k', '7', false],
  ])('enables Save and verify only with a key and a project: %s', async (_label, key, project, disabled) => {
    await renderCard({ ...NOT_CONNECTED, oauthAvailable: false });
    fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: key } });
    fireEvent.change(screen.getByLabelText('Project id'), { target: { value: project } });
    expect((button('Save and verify') as HTMLButtonElement).disabled).toBe(disabled);
  });

  it('shows a save error and keeps the form', async () => {
    jest.spyOn(api.posthogInbox, 'saveConfig').mockRejectedValue(new Error('PostHog rejected the key'));
    await renderCard({ ...NOT_CONNECTED, oauthAvailable: false });
    fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'phx_bad' } });
    fireEvent.change(screen.getByLabelText('Project id'), { target: { value: '7' } });
    fireEvent.click(button('Save and verify'));
    expect(await screen.findByText('PostHog rejected the key')).toBeTruthy();
    expect(button('Save and verify')).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
  });

  it('opens the key form from the OAuth view and closes it again', async () => {
    const start = jest.spyOn(api.posthogInbox, 'startOAuth').mockResolvedValue({ authorizeUrl: 'https://us.posthog.com/oauth' });
    await renderCard(NOT_CONNECTED);
    fireEvent.click(button('Use a personal API key instead'));
    expect(button('Save and verify')).toBeTruthy();
    expect(button('Connect with PostHog instead')).toBeTruthy();
    fireEvent.click(button('Cancel'));
    expect(screen.queryByRole('button', { name: 'Save and verify' })).toBeNull();
    fireEvent.click(button('Use a personal API key instead'));
    fireEvent.click(button('Connect with PostHog instead'));
    await waitFor(() => expect(start).toHaveBeenCalledWith('ws1', { host: 'https://us.posthog.com', projectId: undefined }));
  });

  it.each([
    ['an OAuth grant', {}],
    ['a personal API key', { authMethod: 'personal_api_key' }],
    ['a reconnect', { access: 'reconnect' }],
  ] as const)('disconnects the Inbox connection: %s', async (_label, over) => {
    const disconnect = jest.spyOn(api.posthogInbox, 'disconnect').mockResolvedValue(inboxStatus(NOT_CONNECTED));
    await renderCard(over as Partial<PostHogInboxStatus>);
    fireEvent.click(button('Disconnect'));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('ws1'));
    expect(await screen.findByText('Not connected')).toBeTruthy();
    expect(button('Connect with PostHog')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('shows the PostHog Code fallback after a disconnect', async () => {
    jest.spyOn(api.posthogInbox, 'disconnect').mockResolvedValue(inboxStatus({ connection: 'posthog_code' }));
    await renderCard();
    fireEvent.click(button('Disconnect'));
    expect(await screen.findByRole('button', { name: 'Connect PostHog for the Inbox' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('shows a disconnect error', async () => {
    jest.spyOn(api.posthogInbox, 'disconnect').mockRejectedValue(new Error('Database is down'));
    await renderCard();
    fireEvent.click(button('Disconnect'));
    expect(await screen.findByText('Database is down')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('never offers a disconnect of the PostHog Code connection', async () => {
    const disconnect = jest.spyOn(api.posthogInbox, 'disconnect');
    const card = await renderCard({ connection: 'posthog_code' });
    expect(within(card).queryByRole('button', { name: /Disconnect/ })).toBeNull();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('shows a status read error', async () => {
    jest.mocked(api.workflows.posthogInboxStatus).mockRejectedValue(new Error('Backend is down'));
    render(<PostHogInboxConnectionSection />);
    expect(await screen.findByText(/Could not check the PostHog connection\. Backend is down/)).toBeTruthy();
  });

  it('reads the status again when the window gets focus', async () => {
    await renderCard(NOT_CONNECTED);
    expect(api.workflows.posthogInboxStatus).toHaveBeenCalledTimes(1);
    jest.mocked(api.workflows.posthogInboxStatus).mockResolvedValue(inboxStatus());
    fireEvent.focus(window);
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(api.workflows.posthogInboxStatus).toHaveBeenCalledTimes(2);
  });

  it('never sends the user to the PostHog Code page', async () => {
    jest.spyOn(api.posthogInbox, 'startOAuth').mockResolvedValue({ authorizeUrl: 'https://us.posthog.com/oauth' });
    await renderCard({ connection: 'posthog_code', access: 'reconnect' });
    for (const b of screen.getAllByRole('button')) fireEvent.click(b);
    await waitFor(() => expect(api.posthogInbox.startOAuth).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByText(/PostHog Code page/)).toBeNull();
  });
});
