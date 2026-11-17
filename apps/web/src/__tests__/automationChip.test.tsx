import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Features, WorkbenchSource } from '@talyn/shared';
import { AutomationChip } from '../components/workbench/AutomationChip';
import { useAutomationFocus } from '../lib/automationFocus';
import { useNavigationStore } from '../stores/navigation';
import { useWorkspaceStore } from '../stores/workspace';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

const ALL_FEATURES = { workbenches: true, workflows: true, slackChannelRules: true, webhookRules: true, issueRules: true, loops: true } as Features;

beforeEach(() => {
  useWorkspaceStore.setState({ features: ALL_FEATURES });
  useNavigationStore.getState().navigate({ view: 'home' });
  useAutomationFocus.getState().clear();
});

afterEach(() => {
  cleanup();
  useAutomationFocus.getState().clear();
});

describe('AutomationChip', () => {
  it.each<[string, WorkbenchSource, string, { type: 'workflow' | 'loop'; id: string; kind: string }]>([
    ['a GitHub rule', { kind: 'workflow', workflowId: 'wf1', runId: 'r' }, 'GitHub', { type: 'workflow', id: 'wf1', kind: 'github' }],
    ['a webhook rule', { kind: 'workflow', workflowId: 'wf2', runId: 'r', integration: 'webhook' }, 'Webhooks', { type: 'workflow', id: 'wf2', kind: 'webhook' }],
    ['a Linear rule', { kind: 'workflow', workflowId: 'wf3', runId: 'r', integration: 'linear' }, 'Linear', { type: 'workflow', id: 'wf3', kind: 'linear' }],
    ['a scheduled loop', { kind: 'loop', loopId: 'lp1', runId: 'r' }, 'Schedule', { type: 'loop', id: 'lp1', kind: 'schedule' }],
  ])('%s opens its automation', (_name, source, label, target) => {
    render(<AutomationChip source={source} />);
    const chip = screen.getByRole('button', { name: `Open the ${label} automation that started this session` });
    expect(chip).toHaveTextContent(label);
    fireEvent.click(chip);
    expect(useAutomationFocus.getState().target).toEqual(target);
    expect(useNavigationStore.getState().route).toEqual({ view: 'integrations', kind: target.kind });
  });

  it.each<[string, WorkbenchSource | null]>([
    ['the composer', null],
    ['a Slack mention', { kind: 'slack', teamId: 'T', teamName: null, channelId: 'C1', channelName: 'eng', messageTs: '1', threadTs: '1', permalink: null }],
    ['a memory review', { kind: 'memory_review', runId: 'r' } as WorkbenchSource],
  ])('renders nothing for %s', (_name, source) => {
    const { container } = render(<AutomationChip source={source} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the account cannot see that integration\'s automations', () => {
    useWorkspaceStore.setState({ features: { workbenches: true } as Features });
    const { container } = render(<AutomationChip source={{ kind: 'loop', loopId: 'lp1', runId: 'r' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
