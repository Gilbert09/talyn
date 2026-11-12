import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { validateWorkflow, type InboundDeliverySummary, type WorkflowInput } from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { useBillingStore } from '../renderer/stores/billing';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { IntegrationsView } from '../renderer/pages/IntegrationsView';
import { WorkflowsPanel } from '../renderer/components/panels/workflows/WorkflowsPanel';
import { WebhookDeliveriesList } from '../renderer/components/panels/workflows/WebhookDeliveriesList';
import { withoutEmptyPayloadTests } from '../renderer/components/panels/workflows/webhookFields';

const stats = { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null };

const webhookRule = {
  id: 'wf1',
  workspaceId: 'ws1',
  integration: 'webhook',
  name: 'Deploy hook',
  enabled: true,
  events: ['webhook_received'],
  conditions: {},
  actions: [{ type: 'start_task', repositoryId: 'repo1', prompt: 'Fix it' }],
  maxRunsPerPrPerHour: 5,
  stats,
};

const reveal = {
  connectionId: 'c1',
  url: 'https://api.talyn.dev/api/v1/webhooks/in/c1/tok_secret',
  signingSecret: 'whsec_123',
};

function delivery(i: number, over: Partial<InboundDeliverySummary> = {}): InboundDeliverySummary {
  return {
    id: `d${i}`,
    connectionId: 'c1',
    deliveryId: `del-${i}`,
    eventType: `event-${i}`,
    receivedAt: new Date(Date.UTC(2026, 10, 12, 12, 0, 0) - i * 60_000).toISOString(),
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
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

beforeEach(() => {
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    repositories: [{ id: 'repo1', fullName: 'acme/app' }],
    features: { workflows: true, webhookRules: true },
  } as never);
  useBillingStore.setState({ status: null, refresh: jest.fn() } as never);
  jest.spyOn(api.workflows, 'list').mockResolvedValue([]);
  jest.spyOn(api.workflows, 'suggestions').mockResolvedValue({ repos: [], branches: [], labels: [], people: [], teams: [] } as never);
  jest.spyOn(api.ws, 'on').mockReturnValue(() => {});
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

describe('Webhooks catalog card', () => {
  it.each([
    ['shown with both flags', { workflows: true, webhookRules: true }, true],
    ['hidden without webhookRules', { workflows: true, webhookRules: false }, false],
    ['hidden without workflows', { workflows: false, webhookRules: true }, false],
  ])('%s', (_label, features, shown) => {
    useWorkspaceStore.setState({ features } as never);
    render(<IntegrationsView kind={null} />);
    const card = document.querySelector('[data-attr="integration-card-webhook"]');
    if (shown) {
      expect(card).not.toBeNull();
      expect(within(card as HTMLElement).getByText('Webhooks')).toBeInTheDocument();
      expect(within(card as HTMLElement).getByText('Built in')).toBeInTheDocument();
    } else {
      expect(card).toBeNull();
    }
  });
});

describe('Webhooks integration page', () => {
  it('shows the automations panel for webhook rules', async () => {
    render(<IntegrationsView kind="webhook" />);
    await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'webhook'));
    expect(screen.getByText(/Each automation gets its own URL/)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Connection' })).toBeNull();
  });

  it('draws nothing when the flag is off', () => {
    useWorkspaceStore.setState({ features: { workflows: true, webhookRules: false } } as never);
    render(<IntegrationsView kind="webhook" />);
    expect(api.workflows.list).not.toHaveBeenCalled();
  });
});

async function openWebhookEditor() {
  render(<WorkflowsPanel integration="webhook" />);
  await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'webhook'));
  fireEvent.click(screen.getByText('New automation'));
  await screen.findByLabelText('Name');
}

async function addAction(label: string) {
  fireEvent.click(screen.getByText('Add action'));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));
}

describe('Webhook rule editor', () => {
  it('has a fixed trigger', async () => {
    await openWebhookEditor();
    expect(screen.getByText('Webhook received')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Webhook received' })).toBeNull();
  });

  it('adds, edits and removes payload tests', async () => {
    await openWebhookEditor();
    expect(screen.getByText('No tests. Every request to the URL starts the automation.')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Add test'));
    fireEvent.click(screen.getByText('Add test'));
    expect(screen.getByLabelText('Path 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Path 2')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Path 1'), { target: { value: 'action' } });
    expect(screen.getByLabelText('Value 1')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Test 1'), { target: { value: 'exists' } });
    expect(screen.queryByLabelText('Value 1')).toBeNull();
    fireEvent.change(screen.getByLabelText('Test 1'), { target: { value: 'contains' } });
    expect(screen.getByLabelText('Value 1')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Remove test 1' }));
    expect(screen.queryByLabelText('Path 2')).toBeNull();
    expect(screen.getByLabelText('Path 1')).toHaveValue('');
  });

  it.each([
    ['a..b', true],
    ['issue labels', true],
    ['issue.labels[0].name', false],
    ['issue.labels.0.name', false],
    ['', false],
  ])('path %p shows a problem: %p', async (path, problem) => {
    await openWebhookEditor();
    fireEvent.click(screen.getByText('Add test'));
    fireEvent.change(screen.getByLabelText('Path 1'), { target: { value: path } });
    if (problem) expect(screen.getByRole('alert')).toHaveTextContent('This is not a valid path');
    else expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks for a repository on a start action', async () => {
    await openWebhookEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Deploy hook' } });
    await addAction('Start a session');
    expect(screen.queryByText('Let Talyn choose')).toBeNull();
    expect(screen.getByText('Pick a repository')).toBeInTheDocument();
    expect(screen.getByText(/quotes the request body below the prompt as untrusted text/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Go' } });
    const create = jest.spyOn(api.workflows, 'create');
    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);
    expect((await screen.findAllByText(/choose the repository the session works on/)).length).toBeGreaterThan(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a rule and shows the URL and secret once', async () => {
    const create = jest.spyOn(api.workflows, 'create').mockImplementation(async (_ws, input) => ({
      ...webhookRule,
      ...input,
      webhook: reveal,
    }) as never);
    await openWebhookEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Deploy hook' } });
    fireEvent.click(screen.getByText('Add test'));
    fireEvent.change(screen.getByLabelText('Path 1'), { target: { value: 'action' } });
    fireEvent.change(screen.getByLabelText('Value 1'), { target: { value: 'opened' } });
    fireEvent.click(screen.getByText('Add test'));
    await addAction('Start a task');
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'repo1' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Fix {{payload.issue.title}}' } });
    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);

    await waitFor(() => expect(create).toHaveBeenCalled());
    const input = create.mock.calls[0]![1] as WorkflowInput;
    expect(input.integration).toBe('webhook');
    // The empty second test is dropped, not sent.
    expect(input.conditions?.payloadMatches).toEqual([{ path: 'action', op: 'equals', value: 'opened' }]);
    expect(validateWorkflow(input).actions).toEqual([
      { type: 'start_task', repositoryId: 'repo1', prompt: 'Fix {{payload.issue.title}}' },
    ]);

    const dialog = await screen.findByRole('dialog', { name: 'Copy your webhook URL' });
    expect(within(dialog).getByTestId('webhook-url')).toHaveTextContent(reveal.url);
    expect(within(dialog).getByTestId('webhook-signing-secret')).toHaveTextContent(reveal.signingSecret);
    expect(within(dialog).getByTestId('webhook-curl')).toHaveTextContent(`curl -X POST "${reveal.url}"`);
    expect(dialog).toHaveTextContent('Copy the URL now. Talyn shows it only once. Anyone with the URL can start this automation.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'Copy your webhook URL' })).toBeNull();
    // The secret is not kept anywhere on the page after the dialog closes.
    expect(document.body).not.toHaveTextContent(reveal.signingSecret);
    expect(screen.getByText('Deploy hook')).toBeInTheDocument();
  });

  it('shows no reveal for a create answer without a webhook', async () => {
    jest.spyOn(api.workflows, 'create').mockImplementation(async (_ws, input) => ({ ...webhookRule, ...input }) as never);
    await openWebhookEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Deploy hook' } });
    await addAction('Start a task');
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'repo1' } });
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Go' } });
    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);
    await screen.findByText('Deploy hook');
    expect(screen.queryByRole('dialog', { name: 'Copy your webhook URL' })).toBeNull();
  });
});

describe('withoutEmptyPayloadTests', () => {
  const base: WorkflowInput = { integration: 'webhook', name: 'x', events: ['webhook_received'], actions: [] };
  it.each<[string, WorkflowInput['conditions'], WorkflowInput['conditions']]>([
    ['no conditions', undefined, undefined],
    ['all empty rows', { payloadMatches: [{ path: ' ', op: 'equals', value: '' }] }, {}],
    [
      'keeps a row with a value only, so the save names the missing path',
      { payloadMatches: [{ path: '', op: 'equals', value: 'x' }] },
      { payloadMatches: [{ path: '', op: 'equals', value: 'x' }] },
    ],
    [
      'drops empty rows among filled ones',
      { payloadMatches: [{ path: 'a', op: 'exists' }, { path: '', op: 'contains', value: '' }] },
      { payloadMatches: [{ path: 'a', op: 'exists' }] },
    ],
  ])('%s', (_label, conditions, expected) => {
    expect(withoutEmptyPayloadTests({ ...base, conditions }).conditions).toEqual(expected);
  });
});

describe('Webhook URL section', () => {
  beforeEach(() => {
    jest.mocked(api.workflows.list).mockResolvedValue([webhookRule] as never);
    jest.spyOn(api.workflows, 'runs').mockResolvedValue([]);
    jest.spyOn(api.workflows, 'deliveries').mockResolvedValue([]);
    jest.spyOn(api.workflows, 'webhook').mockResolvedValue({
      connectionId: 'c1',
      ruleId: 'wf1',
      urlPrefix: 'https://api.talyn.dev/api/v1/webhooks/in/c1/',
      createdAt: '2026-11-01T10:00:00Z',
      rotatedAt: null,
      lastDeliveryAt: null,
    });
  });

  async function expandRule() {
    render(<WorkflowsPanel integration="webhook" />);
    await screen.findByText('Deploy hook');
    fireEvent.click(document.querySelector('[data-attr="workflow-toggle-history"]')!);
    await screen.findByTestId('webhook-url-prefix');
  }

  it('shows the URL prefix only, with its times', async () => {
    await expandRule();
    expect(screen.getByTestId('webhook-url-prefix')).toHaveTextContent('https://api.talyn.dev/api/v1/webhooks/in/c1/…');
    const section = document.querySelector('[data-attr="webhook-url-section"]') as HTMLElement;
    expect(within(section).getAllByText('never')).toHaveLength(2);
    expect(api.workflows.webhook).toHaveBeenCalledWith('wf1');
  });

  it('rotates after a confirm and shows the new URL once', async () => {
    const rotate = jest.spyOn(api.workflows, 'rotateWebhook').mockResolvedValue({ ...reveal, url: 'https://new/url' });
    await expandRule();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate URL' }));
    expect(screen.getByText('The old URL stops working at once. Send requests to the new URL after you rotate.')).toBeInTheDocument();
    expect(rotate).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button', { name: 'Rotate URL' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(rotate).toHaveBeenCalledWith('wf1'));
    const dialog = await screen.findByRole('dialog', { name: 'Copy your webhook URL' });
    expect(within(dialog).getByTestId('webhook-url')).toHaveTextContent('https://new/url');
    await waitFor(() => expect(api.workflows.webhook).toHaveBeenCalledTimes(2));
  });

  it('keeps the old URL when the user cancels', async () => {
    const rotate = jest.spyOn(api.workflows, 'rotateWebhook');
    await expandRule();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate URL' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(rotate).not.toHaveBeenCalled();
  });
});

describe('Webhook deliveries', () => {
  it.each([
    ['handled', 'Handled'],
    ['ignored', 'No rule matched'],
    ['failed', 'Failed'],
    [null, 'Waiting'],
  ] as const)('outcome %p reads %p', async (outcome, label) => {
    jest.spyOn(api.workflows, 'deliveries').mockResolvedValue([delivery(1, { outcome })]);
    render(<WebhookDeliveriesList ruleId="wf1" />);
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it('shows the size, attempts and replay marker', async () => {
    jest.spyOn(api.workflows, 'deliveries').mockResolvedValue([
      delivery(1, { payloadBytes: 2048, attempts: 3, replayOf: 'd0', error: 'boom' }),
    ]);
    render(<WebhookDeliveriesList ruleId="wf1" />);
    expect(await screen.findByText('event-1')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('3 attempts')).toBeInTheDocument();
    expect(screen.getByText('Replay', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    jest.spyOn(api.workflows, 'deliveries').mockResolvedValue([]);
    render(<WebhookDeliveriesList ruleId="wf1" />);
    expect(await screen.findByText('No requests yet. Send a request to the URL to see it here.')).toBeInTheDocument();
  });

  it('loads more by the last received time', async () => {
    const first = Array.from({ length: 25 }, (_, i) => delivery(i));
    const deliveries = jest.spyOn(api.workflows, 'deliveries')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([delivery(25)]);
    render(<WebhookDeliveriesList ruleId="wf1" />);
    await screen.findByText('event-24');
    expect(document.querySelectorAll('[data-attr="webhook-delivery-row"]')).toHaveLength(25);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('event-25');
    expect(deliveries).toHaveBeenLastCalledWith('wf1', { limit: 25, cursor: first[24]!.receivedAt });
    expect(document.querySelectorAll('[data-attr="webhook-delivery-row"]')).toHaveLength(26);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('replays a delivery and refreshes the list', async () => {
    const deliveries = jest.spyOn(api.workflows, 'deliveries')
      .mockResolvedValueOnce([delivery(1)])
      .mockResolvedValueOnce([delivery(2, { replayOf: 'd1', outcome: null }), delivery(1)]);
    const replay = jest.spyOn(api.workflows, 'replayDelivery').mockResolvedValue(delivery(2, { replayOf: 'd1' }));
    render(<WebhookDeliveriesList ruleId="wf1" />);
    await screen.findByText('event-1');
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(replay).toHaveBeenCalledWith('wf1', 'd1'));
    await screen.findByText('event-2');
    expect(deliveries).toHaveBeenLastCalledWith('wf1', { limit: 25, cursor: null });
    expect(screen.getByText('Waiting')).toBeInTheDocument();
  });

  it('opens a delivery to show its body and headers', async () => {
    jest.spyOn(api.workflows, 'deliveries').mockResolvedValue([delivery(1)]);
    const one = jest.spyOn(api.workflows, 'delivery').mockResolvedValue({
      ...delivery(1),
      payload: { action: 'opened', issue: { number: 7 } },
      headers: { 'x-talyn-event': 'issue' },
    });
    render(<WebhookDeliveriesList ruleId="wf1" />);
    await screen.findByText('event-1');
    fireEvent.click(screen.getByRole('button', { name: 'Show body' }));
    await waitFor(() => expect(one).toHaveBeenCalledWith('wf1', 'd1'));
    const payload = await screen.findByTestId('webhook-delivery-payload');
    expect(payload.textContent).toBe(JSON.stringify({ action: 'opened', issue: { number: 7 } }, null, 2));
    expect(screen.getByText('x-talyn-event')).toBeInTheDocument();
    expect(screen.getByText('issue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide body' }));
    expect(screen.queryByTestId('webhook-delivery-payload')).toBeNull();
  });
});
