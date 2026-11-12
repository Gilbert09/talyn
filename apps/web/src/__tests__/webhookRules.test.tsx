import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import {
  validateWorkflow,
  type InboundDeliverySummary,
  type WorkflowInput,
  type WorkflowWithStats,
} from '@talyn/shared';
import { api } from '../lib/api';
import { useBillingStore } from '../stores/billing';
import { useWorkspaceStore } from '../stores/workspace';
import { IntegrationsView } from '../pages/IntegrationsView';
import { WorkflowsPanel } from '../components/panels/workflows/WorkflowsPanel';
import { WebhookDeliveriesList } from '../components/panels/workflows/WebhookDeliveriesList';
import { webhookPathProblem } from '../components/panels/workflows/webhookFields';

const STATS = { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null };

const RULE: WorkflowWithStats = {
  id: 'wf1',
  workspaceId: 'ws1',
  integration: 'webhook',
  name: 'From the tracker',
  enabled: true,
  events: ['webhook_received'],
  conditions: {},
  actions: [{ type: 'start_task', repositoryId: 'repo1', prompt: 'Fix it' }],
  maxRunsPerPrPerHour: 5,
  createdAt: '2026-11-12T00:00:00Z',
  updatedAt: '2026-11-12T00:00:00Z',
  stats: STATS,
} as never;

const REVEAL = { connectionId: 'c1', url: 'https://api.talyn.dev/api/v1/webhooks/in/c1/tok_secret', signingSecret: 'whsec_123' };

function delivery(i: number, over: Partial<InboundDeliverySummary> = {}): InboundDeliverySummary {
  return {
    id: `d${i}`,
    connectionId: 'c1',
    deliveryId: `sender-${i}`,
    eventType: `event-${i}`,
    receivedAt: new Date(Date.UTC(2026, 10, 12, 0, 0, 100 - i)).toISOString(),
    processedAt: null,
    attempts: 1,
    outcome: 'handled',
    error: null,
    replayOf: null,
    payloadBytes: 512,
    ...over,
  };
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    repositories: [{ id: 'repo1', fullName: 'acme/app' }],
    features: { workflows: true, webhookRules: true },
  } as never);
  useBillingStore.setState({ status: null } as never);
  vi.spyOn(useBillingStore.getState(), 'refresh').mockResolvedValue(undefined);
  vi.spyOn(api.workflows, 'list').mockResolvedValue([]);
  vi.spyOn(api.workflows, 'suggestions').mockResolvedValue({ repos: [], branches: [], labels: [], people: [], teams: [] } as never);
  vi.spyOn(api.workflows, 'runs').mockResolvedValue([]);
  vi.spyOn(api.ws, 'on').mockReturnValue(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Webhooks in the integrations catalog', () => {
  it.each([
    ['offered with the flag on', { workflows: true, webhookRules: true }, true],
    ['hidden with the flag off', { workflows: true, webhookRules: false }, false],
    ['hidden when workflows are off', { workflows: false, webhookRules: true }, false],
  ])('%s', (_label, features, shown) => {
    useWorkspaceStore.setState({ features } as never);
    render(<IntegrationsView kind={null} />);
    const card = document.querySelector('[data-attr="integration-card-webhook"]');
    expect(Boolean(card)).toBe(shown);
    if (card) {
      expect(within(card as HTMLElement).getByText('Webhooks')).toBeTruthy();
      expect(within(card as HTMLElement).getByText('Built in')).toBeTruthy();
    }
  });

  it('opens the webhook automations with no Connection tab', async () => {
    render(<IntegrationsView kind="webhook" />);
    expect(await screen.findByText('Webhook automations')).toBeTruthy();
    await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'webhook'));
    expect(screen.queryByRole('tab', { name: 'Connection' })).toBeNull();
  });
});

describe('webhookPathProblem', () => {
  it.each([
    ['', false],
    ['action', false],
    ['issue.labels[0].name', false],
    ['issue.labels.0.name', false],
    ['a..b', true],
    ['issue labels', true],
    ['issue.[x]', true],
  ])('%j has a problem: %s', (path, bad) => {
    expect(webhookPathProblem(path) !== null).toBe(bad);
  });
});

async function openEditor() {
  render(<WorkflowsPanel integration="webhook" />);
  await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'webhook'));
  fireEvent.click(screen.getByText('New automation'));
  await screen.findByLabelText('Name');
}

describe('Webhook rule editor', () => {
  it('shows the fixed trigger without a way to remove or add one', async () => {
    await openEditor();
    expect(screen.getByText('Webhook received')).toBeTruthy();
    expect(screen.queryByLabelText('Remove Webhook received')).toBeNull();
    expect(screen.queryByText('Add trigger')).toBeNull();
  });

  it('adds, edits and removes payload tests', async () => {
    await openEditor();
    expect(screen.getByText('No tests. Every request to the URL starts this automation.')).toBeTruthy();

    fireEvent.click(screen.getByText('Add test'));
    fireEvent.click(screen.getByText('Add test'));
    expect(document.querySelectorAll('[data-attr="webhook-payload-row"]').length).toBe(2);

    fireEvent.change(screen.getByLabelText('Path 1'), { target: { value: 'a..b' } });
    expect(screen.getByRole('alert').textContent).toContain('This is not a path');
    fireEvent.change(screen.getByLabelText('Path 1'), { target: { value: 'issue.labels[0].name' } });
    expect(screen.queryByRole('alert')).toBeNull();

    expect(screen.getByLabelText('Value 1')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Test 1'), { target: { value: 'exists' } });
    expect(screen.queryByLabelText('Value 1')).toBeNull();
    fireEvent.change(screen.getByLabelText('Test 1'), { target: { value: 'contains' } });
    expect(screen.getByLabelText('Value 1')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Remove test 2'));
    expect(document.querySelectorAll('[data-attr="webhook-payload-row"]').length).toBe(1);
    fireEvent.click(screen.getByLabelText('Remove test 1'));
    expect(screen.getByText('No tests. Every request to the URL starts this automation.')).toBeTruthy();
  });

  it.each(['Start a task', 'Start a session'])('requires a repository for "%s"', async (label) => {
    await openEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rule' } });
    fireEvent.click(screen.getByText('Add action'));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));
    const repo = screen.getByLabelText('Repository') as HTMLSelectElement;
    expect(within(repo).queryByText('Let Talyn choose')).toBeNull();
    expect(screen.getByText(/Talyn adds the request body below your prompt as untrusted text/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Fix it' } });
    const create = vi.spyOn(api.workflows, 'create');
    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);
    expect(await screen.findAllByText(/choose the repository/)).not.toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a valid rule and shows the URL once', async () => {
    const create = vi.spyOn(api.workflows, 'create').mockImplementation(async (_ws, input) => ({
      ...RULE, ...input, webhook: REVEAL,
    } as never));
    await openEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'From the tracker' } });
    fireEvent.click(screen.getByText('Add test'));
    fireEvent.change(screen.getByLabelText('Path 1'), { target: { value: 'action' } });
    fireEvent.change(screen.getByLabelText('Value 1'), { target: { value: 'opened' } });
    fireEvent.click(screen.getByText('Add action'));
    fireEvent.click(screen.getByRole('button', { name: /Start a task/ }));
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'repo1' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Fix the bug' } });
    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);

    await waitFor(() => expect(create).toHaveBeenCalled());
    const [workspaceId, input] = create.mock.calls[0]!;
    expect(workspaceId).toBe('ws1');
    const normalized = validateWorkflow(input as WorkflowInput);
    expect(normalized.integration).toBe('webhook');
    expect(normalized.conditions).toEqual({ payloadMatches: [{ path: 'action', op: 'equals', value: 'opened' }] });
    expect(normalized.actions).toEqual([{ type: 'start_task', repositoryId: 'repo1', prompt: 'Fix the bug' }]);

    const dialog = await screen.findByRole('dialog', { name: 'Copy the webhook URL' });
    expect(within(dialog).getByTestId('webhook-url').textContent).toBe(REVEAL.url);
    expect(within(dialog).getByTestId('webhook-signing-secret').textContent).toBe(REVEAL.signingSecret);
    expect(within(dialog).getByText(/Talyn shows it only once/)).toBeTruthy();
    expect(within(dialog).getByText(new RegExp(`curl -X POST "${REVEAL.url}"`))).toBeTruthy();

    // The list row never holds the secret.
    expect(screen.getAllByText('From the tracker').length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getByText('Done'));
    expect(screen.queryByRole('dialog', { name: 'Copy the webhook URL' })).toBeNull();
    expect(screen.queryByText(REVEAL.signingSecret)).toBeNull();
  });
});

async function openRule() {
  vi.mocked(api.workflows.list).mockResolvedValue([RULE]);
  vi.spyOn(api.workflows, 'webhook').mockResolvedValue({
    connectionId: 'c1', ruleId: 'wf1', urlPrefix: 'https://api.talyn.dev/api/v1/webhooks/in/c1/',
    createdAt: '2026-11-12T00:00:00Z', rotatedAt: null, lastDeliveryAt: null,
  });
  render(<WorkflowsPanel integration="webhook" />);
  fireEvent.click(await screen.findByTitle('Show history'));
  await screen.findByTestId('webhook-url-prefix');
}

describe('A saved webhook rule', () => {
  it('shows the URL without its token', async () => {
    await openRule();
    expect(screen.getByTestId('webhook-url-prefix').textContent).toBe('https://api.talyn.dev/api/v1/webhooks/in/c1/…');
  });

  it('rotates the URL after a confirm and shows the new one once', async () => {
    const rotate = vi.spyOn(api.workflows, 'rotateWebhook').mockResolvedValue({ ...REVEAL, url: 'https://x/new', signingSecret: 'whsec_new' });
    await openRule();
    fireEvent.click(document.querySelector('[data-attr="webhook-rotate"]')!);
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/The old URL stops working at once/)).toBeTruthy();
    expect(rotate).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Rotate URL' }));

    await waitFor(() => expect(rotate).toHaveBeenCalledWith('wf1'));
    const dialog = await screen.findByRole('dialog', { name: 'Copy the webhook URL' });
    expect(within(dialog).getByTestId('webhook-url').textContent).toBe('https://x/new');
    expect(within(dialog).getByTestId('webhook-signing-secret').textContent).toBe('whsec_new');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not rotate when the confirm is cancelled', async () => {
    const rotate = vi.spyOn(api.workflows, 'rotateWebhook');
    await openRule();
    fireEvent.click(document.querySelector('[data-attr="webhook-rotate"]')!);
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('Cancel'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(rotate).not.toHaveBeenCalled();
  });

  it('switches to the requests it received', async () => {
    const deliveries = vi.spyOn(api.workflows, 'deliveries').mockResolvedValue([delivery(1)]);
    await openRule();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Requests' }));
    await waitFor(() => expect(deliveries).toHaveBeenCalledWith('wf1', { limit: 25, cursor: null }));
    expect(await screen.findByText('event-1')).toBeTruthy();
  });
});

describe('Webhook deliveries list', () => {
  it.each<[InboundDeliverySummary['outcome'], string]>([
    ['handled', 'Handled'],
    ['ignored', 'No rule matched'],
    ['failed', 'Failed'],
    [null, 'Waiting'],
  ])('shows outcome %s as "%s"', async (outcome, label) => {
    vi.spyOn(api.workflows, 'deliveries').mockResolvedValue([delivery(1, { outcome })]);
    render(<WebhookDeliveriesList ruleId="wf1" />);
    expect(await screen.findByText(label)).toBeTruthy();
  });

  it('renders attempts, size, errors and the replay marker', async () => {
    vi.spyOn(api.workflows, 'deliveries').mockResolvedValue([
      delivery(1, { attempts: 3, payloadBytes: 2048, error: 'No repository access', outcome: 'failed', replayOf: 'd0' }),
      delivery(2),
    ]);
    render(<WebhookDeliveriesList ruleId="wf1" />);
    expect(await screen.findByText(/3 attempts · 2.0 KB/)).toBeTruthy();
    expect(screen.getByText(/1 attempt · 512 B/)).toBeTruthy();
    expect(screen.getByText('No repository access')).toBeTruthy();
    expect(screen.getAllByText('Replay', { selector: 'div' })).toHaveLength(1);
  });

  it('loads more with the last receivedAt as the cursor', async () => {
    const page = Array.from({ length: 25 }, (_, i) => delivery(i));
    const deliveries = vi.spyOn(api.workflows, 'deliveries')
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([delivery(99)]);
    render(<WebhookDeliveriesList ruleId="wf1" />);
    fireEvent.click(await screen.findByText('Load more'));
    await waitFor(() => expect(deliveries).toHaveBeenLastCalledWith('wf1', { limit: 25, cursor: page[24]!.receivedAt }));
    expect(await screen.findByText('event-99')).toBeTruthy();
    expect(screen.getByText('event-0')).toBeTruthy();
    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('replays a request and reloads the list', async () => {
    const deliveries = vi.spyOn(api.workflows, 'deliveries')
      .mockResolvedValueOnce([delivery(1)])
      .mockResolvedValueOnce([delivery(2, { replayOf: 'd1' }), delivery(1)]);
    const replay = vi.spyOn(api.workflows, 'replayDelivery').mockResolvedValue(delivery(2, { replayOf: 'd1' }));
    render(<WebhookDeliveriesList ruleId="wf1" />);
    fireEvent.click(await screen.findByLabelText('Replay request d1'));
    await waitFor(() => expect(replay).toHaveBeenCalledWith('wf1', 'd1'));
    await waitFor(() => expect(deliveries).toHaveBeenCalledTimes(2));
    expect(deliveries).toHaveBeenLastCalledWith('wf1', { limit: 25, cursor: null });
    expect(await screen.findByText('event-2')).toBeTruthy();
  });

  it('opens a request to show its body and headers', async () => {
    vi.spyOn(api.workflows, 'deliveries').mockResolvedValue([delivery(1)]);
    const detail = vi.spyOn(api.workflows, 'delivery').mockResolvedValue({
      ...delivery(1),
      payload: { action: 'opened', issue: { id: 7 } },
      headers: { 'content-type': 'application/json', 'x-talyn-event': 'issue' },
    });
    render(<WebhookDeliveriesList ruleId="wf1" />);
    const row = await screen.findByRole('button', { name: /Request event-1/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    await waitFor(() => expect(detail).toHaveBeenCalledWith('wf1', 'd1'));
    const body = await screen.findByTestId('webhook-delivery-payload');
    expect(JSON.parse(body.textContent!)).toEqual({ action: 'opened', issue: { id: 7 } });
    expect(screen.getByText('x-talyn-event:')).toBeTruthy();
    expect(screen.getByText('issue')).toBeTruthy();
    fireEvent.click(row);
    expect(screen.queryByTestId('webhook-delivery-payload')).toBeNull();
  });

  it('says so when there are no requests', async () => {
    vi.spyOn(api.workflows, 'deliveries').mockResolvedValue([]);
    render(<WebhookDeliveriesList ruleId="wf1" />);
    expect(await screen.findByText(/No requests yet/)).toBeTruthy();
  });
});
