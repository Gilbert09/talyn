import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Features, SessionOrigin, WorkbenchSource } from '@talyn/shared';
import { AutomationChip } from '../components/workbench/AutomationChip';
import { useAutomationFocus } from '../lib/automationFocus';
import { useNavigationStore } from '../stores/navigation';
import { useWorkspaceStore } from '../stores/workspace';

const { mockOrigin, mockOpenExternal } = vi.hoisted(() => ({
  mockOrigin: vi.fn<(id: string) => Promise<SessionOrigin | null>>(),
  mockOpenExternal: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/api', () => ({ api: { workbenches: { origin: mockOrigin } } }));
vi.mock('../lib/openExternal', () => ({ openExternal: mockOpenExternal }));

const ALL_FEATURES = { workbenches: true, workflows: true, slackChannelRules: true, webhookRules: true, issueRules: true, loops: true, posthogInboxRules: true } as Features;

const ORIGIN: SessionOrigin = {
  type: 'workflow',
  automationId: 'wf1',
  automationName: 'Fix P1 reports',
  runId: 'r',
  startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  trigger: 'event',
  triggeredBy: null,
  event: 'Report ready for work',
  subject: { label: 'Signup button fails on Safari', url: 'https://us.posthog.com/report/1' },
  facts: [
    { label: 'Priority', value: 'P1' },
    { label: 'Repository', value: 'acme/web' },
  ],
  excerpt: 'Users on Safari cannot sign up.',
};

beforeEach(() => {
  useWorkspaceStore.setState({ features: ALL_FEATURES });
  useNavigationStore.getState().navigate({ view: 'home' });
  useAutomationFocus.getState().clear();
  mockOrigin.mockReset();
  mockOpenExternal.mockReset();
  mockOrigin.mockResolvedValue(ORIGIN);
});

afterEach(() => {
  cleanup();
  useAutomationFocus.getState().clear();
});

function openChip(label: string) {
  fireEvent.click(screen.getByRole('button', { name: `Show the ${label} automation that started this session` }));
}

describe('AutomationChip', () => {
  it.each<[string, WorkbenchSource, string, { type: 'workflow' | 'loop'; id: string; kind: string }]>([
    ['a GitHub rule', { kind: 'workflow', workflowId: 'wf1', runId: 'r' }, 'GitHub', { type: 'workflow', id: 'wf1', kind: 'github' }],
    ['a webhook rule', { kind: 'workflow', workflowId: 'wf2', runId: 'r', integration: 'webhook' }, 'Webhooks', { type: 'workflow', id: 'wf2', kind: 'webhook' }],
    ['a Linear rule', { kind: 'workflow', workflowId: 'wf3', runId: 'r', integration: 'linear' }, 'Linear', { type: 'workflow', id: 'wf3', kind: 'linear' }],
    ['a PostHog Inbox rule', { kind: 'workflow', workflowId: 'wf4', runId: 'r', integration: 'posthog_inbox' }, 'PostHog Inbox', { type: 'workflow', id: 'wf4', kind: 'posthog_inbox' }],
    ['a scheduled loop', { kind: 'loop', loopId: 'lp1', runId: 'r' }, 'Schedule', { type: 'loop', id: 'lp1', kind: 'schedule' }],
  ])('%s opens its automation from the popover', async (_name, source, label, target) => {
    render(<AutomationChip workbenchId="wb1" source={source} />);
    const chip = screen.getByRole('button', { name: `Show the ${label} automation that started this session` });
    expect(chip).toHaveTextContent(label);
    expect(mockOrigin).not.toHaveBeenCalled();
    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole('button', { name: `Open the ${label} automation that started this session` }));
    expect(useAutomationFocus.getState().target).toEqual(target);
    expect(useNavigationStore.getState().route).toEqual({ view: 'integrations', kind: target.kind });
  });

  it('shows the rule, the event and what it acted on', async () => {
    render(<AutomationChip workbenchId="wb1" source={{ kind: 'workflow', workflowId: 'wf1', runId: 'r', integration: 'posthog_inbox' }} />);
    openChip('PostHog Inbox');
    expect(await screen.findByTestId('automation-origin-name')).toHaveTextContent('Fix P1 reports');
    const popover = screen.getByTestId('automation-origin');
    expect(popover).toHaveTextContent('Report ready for work · Fired · 5 minutes ago');
    expect(popover).toHaveTextContent('PriorityP1');
    expect(popover).toHaveTextContent('Repositoryacme/web');
    expect(popover).toHaveTextContent('Users on Safari cannot sign up.');
    expect(mockOrigin).toHaveBeenCalledWith('wb1');
    fireEvent.click(screen.getByRole('button', { name: /Signup button fails on Safari/ }));
    expect(mockOpenExternal).toHaveBeenCalledWith('https://us.posthog.com/report/1');
  });

  it.each<[string, Partial<SessionOrigin>, string]>([
    ['who ran it by hand', { trigger: 'manual', triggeredBy: 'tom@example.test' }, 'Run by tom@example.test'],
    ['a manual run with no name', { trigger: 'manual', triggeredBy: null }, 'Run by hand'],
    ['a scheduled loop run', { type: 'loop', event: null, trigger: 'schedule' }, 'Scheduled run'],
    ['a deleted automation', { automationName: null }, 'Deleted automation'],
  ])('shows %s', async (_name, patch, text) => {
    mockOrigin.mockResolvedValue({ ...ORIGIN, ...patch });
    render(<AutomationChip workbenchId="wb1" source={{ kind: 'workflow', workflowId: 'wf1', runId: 'r' }} />);
    openChip('GitHub');
    await screen.findByTestId('automation-origin-name');
    expect(screen.getByTestId('automation-origin')).toHaveTextContent(text);
  });

  it('shows a subject with no link as text', async () => {
    mockOrigin.mockResolvedValue({ ...ORIGIN, subject: { label: 'Webhook request', url: null } });
    render(<AutomationChip workbenchId="wb1" source={{ kind: 'workflow', workflowId: 'wf1', runId: 'r' }} />);
    openChip('GitHub');
    expect(await screen.findByText('Webhook request')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Webhook request/ })).toBeNull();
  });

  it('says so when the details do not load, and still links the automation', async () => {
    mockOrigin.mockRejectedValue(new Error('boom'));
    render(<AutomationChip workbenchId="wb1" source={{ kind: 'workflow', workflowId: 'wf1', runId: 'r' }} />);
    openChip('GitHub');
    expect(await screen.findByText('Could not load the details.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the GitHub automation that started this session' })).toBeInTheDocument();
  });

  it('loads the details once per session', async () => {
    render(<AutomationChip workbenchId="wb1" source={{ kind: 'workflow', workflowId: 'wf1', runId: 'r' }} />);
    openChip('GitHub');
    await screen.findByTestId('automation-origin-name');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    openChip('GitHub');
    await screen.findByTestId('automation-origin-name');
    expect(mockOrigin).toHaveBeenCalledTimes(1);
  });

  it.each<[string, WorkbenchSource | null]>([
    ['the composer', null],
    ['a Slack mention', { kind: 'slack', teamId: 'T', teamName: null, channelId: 'C1', channelName: 'eng', messageTs: '1', threadTs: '1', permalink: null }],
    ['a memory review', { kind: 'memory_review', runId: 'r' } as WorkbenchSource],
  ])('renders nothing for %s', (_name, source) => {
    const { container } = render(<AutomationChip workbenchId="wb1" source={source} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the account cannot see that integration\'s automations', () => {
    useWorkspaceStore.setState({ features: { workbenches: true } as Features });
    const { container } = render(<AutomationChip workbenchId="wb1" source={{ kind: 'loop', loopId: 'lp1', runId: 'r' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
