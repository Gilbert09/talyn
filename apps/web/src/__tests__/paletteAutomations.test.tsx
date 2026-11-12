import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { emptyLoopInput, emptyWorkflowInput, type Features, type LoopWithStats, type WorkflowIntegration, type WorkflowWithStats } from '@talyn/shared';
import { api } from '../lib/api';
import { CommandPalette } from '../components/CommandPalette';
import { WorkflowsPanel } from '../components/panels/workflows/WorkflowsPanel';
import { LoopsPanel } from '../components/panels/loops/LoopsPanel';
import { openAutomation, useAutomationFocus } from '../lib/automationFocus';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../components/panels/workflows/WorkflowEditorPage', () => ({
  WorkflowEditorPage: ({ editing }: { editing: { name: string } | null }) => (
    <div data-testid="workflow-editor">{editing?.name ?? 'new'}</div>
  ),
}));
vi.mock('../components/panels/loops/LoopEditorPage', () => ({
  LoopEditorPage: ({ editing }: { editing: { name: string } | null }) => (
    <div data-testid="loop-editor">{editing?.name ?? 'new'}</div>
  ),
}));

const STATS = { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null };
const ALL_FEATURES = { workbenches: true, workflows: true, slackChannelRules: true, webhookRules: true, issueRules: true, loops: true } as Features;

function rule(id: string, name: string, integration: WorkflowIntegration = 'github', enabled = true): WorkflowWithStats {
  return { ...emptyWorkflowInput(integration), id, workspaceId: 'ws1', name, enabled, integration, createdAt: '', updatedAt: '', stats: STATS } as WorkflowWithStats;
}

function loop(id: string, name: string, enabled = true): LoopWithStats {
  return { ...emptyLoopInput('UTC'), id, workspaceId: 'ws1', name, enabled, createdAt: '', updatedAt: '', stats: STATS } as unknown as LoopWithStats;
}

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.spyOn(api.workbenches, 'list').mockResolvedValue([]);
  vi.spyOn(api.workflows, 'list').mockResolvedValue([
    rule('wf1', 'Label risky PRs'),
    rule('wf2', 'Triage support channel', 'slack', false),
    rule('wf3', 'Deploy hook', 'webhook'),
  ]);
  vi.spyOn(api.workflows, 'suggestions').mockResolvedValue({ repos: [], branches: [], labels: [], people: [], teams: [], partial: false } as never);
  vi.spyOn(api.loops, 'list').mockResolvedValue([loop('lp1', 'Morning triage')]);
  vi.spyOn(api.ws, 'on').mockReturnValue(() => {});
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1', features: ALL_FEATURES });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', []);
  useNavigationStore.getState().navigate({ view: 'home' });
  useNavigationStore.setState({ paletteOpen: true });
  useAutomationFocus.getState().clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const search = (text: string) => fireEvent.change(screen.getByRole('combobox'), { target: { value: text } });

describe('CommandPalette automations', () => {
  it('reads rules and loops once on open and lists them only while the person types', async () => {
    render(<CommandPalette />);
    await waitFor(() => expect(api.loops.list).toHaveBeenCalledWith('ws1'));
    expect(api.workflows.list).toHaveBeenCalledTimes(1);
    expect(api.workflows.list).toHaveBeenCalledWith('ws1');
    await act(async () => {});
    expect(screen.queryByText('Label risky PRs')).toBeNull();
    expect(screen.queryByText('Morning triage')).toBeNull();

    search('automation');

    expect(await screen.findByText('Label risky PRs')).toBeInTheDocument();
    for (const name of ['Triage support channel', 'Deploy hook', 'Morning triage']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getAllByText('Automation')).toHaveLength(4);
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it.each([
    ['risky', 'Label risky PRs', ['Deploy hook', 'Morning triage']],
    ['webhook', 'Deploy hook', ['Label risky PRs']],
    ['schedule', 'Morning triage', ['Deploy hook']],
  ])('filters by %s', async (query, shown, hidden) => {
    render(<CommandPalette />);
    await waitFor(() => expect(api.loops.list).toHaveBeenCalled());
    search(query);
    expect(await screen.findByText(shown)).toBeInTheDocument();
    for (const name of hidden) expect(screen.queryByText(name)).toBeNull();
  });

  it('ranks a name match above a match on the integration', async () => {
    vi.mocked(api.workflows.list).mockResolvedValue([rule('wf1', 'Notify on Slack'), rule('wf2', 'Slack triage', 'slack')]);
    render(<CommandPalette />);
    await waitFor(() => expect(api.loops.list).toHaveBeenCalled());
    search('slack');
    await screen.findByText('Slack triage');
    const rows = screen.getAllByText('Automation').map((tag) => tag.closest('[cmdk-item]')?.textContent ?? '');
    expect(rows[0]).toContain('Slack triage');
    expect(rows[1]).toContain('Notify on Slack');
  });

  it.each([
    ['a rule', 'Label risky PRs', { type: 'workflow', id: 'wf1', kind: 'github' }],
    ['a Slack rule', 'Triage support channel', { type: 'workflow', id: 'wf2', kind: 'slack' }],
    ['a loop', 'Morning triage', { type: 'loop', id: 'lp1', kind: 'schedule' }],
  ] as const)('picking %s opens its integration page and asks for its editor', async (_label, name, target) => {
    render(<CommandPalette />);
    await waitFor(() => expect(api.loops.list).toHaveBeenCalled());
    search(name);
    fireEvent.click(await screen.findByText(name));

    expect(useNavigationStore.getState().paletteOpen).toBe(false);
    expect(useNavigationStore.getState().route).toEqual({ view: 'integrations', kind: target.kind });
    expect(useAutomationFocus.getState().target).toEqual(target);
  });

  it('leaves out the automations of integrations the workspace does not offer', async () => {
    useWorkspaceStore.setState({ features: { workbenches: true, workflows: true } as Features });
    render(<CommandPalette />);
    await waitFor(() => expect(api.workflows.list).toHaveBeenCalled());
    search('automation');
    expect(await screen.findByText('Label risky PRs')).toBeInTheDocument();
    expect(screen.queryByText('Triage support channel')).toBeNull();
    expect(screen.queryByText('Deploy hook')).toBeNull();
    expect(api.loops.list).not.toHaveBeenCalled();
  });

  it('reads nothing when no automation is offered', async () => {
    useWorkspaceStore.setState({ features: { workbenches: true } as Features });
    render(<CommandPalette />);
    search('automation');
    await act(async () => {});
    expect(api.workflows.list).not.toHaveBeenCalled();
    expect(api.loops.list).not.toHaveBeenCalled();
    expect(screen.queryByText('Automation')).toBeNull();
  });

  it('shows the loops when the rules fail to load', async () => {
    vi.mocked(api.workflows.list).mockRejectedValue(new Error('down'));
    render(<CommandPalette />);
    await waitFor(() => expect(api.loops.list).toHaveBeenCalled());
    search('automation');
    expect(await screen.findByText('Morning triage')).toBeInTheDocument();
    expect(screen.queryByText('Label risky PRs')).toBeNull();
  });
});

describe('opening an automation from the palette', () => {
  it('opens the rule editor once the list loads, then forgets the target', async () => {
    openAutomation({ type: 'workflow', id: 'wf3', kind: 'webhook' });
    vi.mocked(api.workflows.list).mockResolvedValue([rule('wf3', 'Deploy hook', 'webhook')]);
    render(<WorkflowsPanel integration="webhook" />);
    expect(await screen.findByTestId('workflow-editor')).toHaveTextContent('Deploy hook');
    expect(useAutomationFocus.getState().target).toBeNull();
  });

  it('opens the rule editor on a page that is already showing', async () => {
    vi.mocked(api.workflows.list).mockResolvedValue([rule('wf1', 'Label risky PRs')]);
    render(<WorkflowsPanel integration="github" />);
    expect(await screen.findByText('Label risky PRs')).toBeInTheDocument();

    act(() => openAutomation({ type: 'workflow', id: 'wf1', kind: 'github' }));

    expect(await screen.findByTestId('workflow-editor')).toHaveTextContent('Label risky PRs');
  });

  it("leaves another integration's target alone", async () => {
    openAutomation({ type: 'workflow', id: 'wf2', kind: 'slack' });
    vi.mocked(api.workflows.list).mockResolvedValue([rule('wf1', 'Label risky PRs')]);
    render(<WorkflowsPanel integration="github" />);
    expect(await screen.findByText('Label risky PRs')).toBeInTheDocument();
    expect(screen.queryByTestId('workflow-editor')).toBeNull();
    expect(useAutomationFocus.getState().target).toEqual({ type: 'workflow', id: 'wf2', kind: 'slack' });
  });

  it('shows the list and forgets the target when the rule is gone', async () => {
    openAutomation({ type: 'workflow', id: 'deleted', kind: 'github' });
    vi.mocked(api.workflows.list).mockResolvedValue([rule('wf1', 'Label risky PRs')]);
    render(<WorkflowsPanel integration="github" />);
    expect(await screen.findByText('Label risky PRs')).toBeInTheDocument();
    await waitFor(() => expect(useAutomationFocus.getState().target).toBeNull());
    expect(screen.queryByTestId('workflow-editor')).toBeNull();
  });

  it('opens the loop editor', async () => {
    openAutomation({ type: 'loop', id: 'lp1', kind: 'schedule' });
    render(<LoopsPanel />);
    expect(await screen.findByTestId('loop-editor')).toHaveTextContent('Morning triage');
    expect(useAutomationFocus.getState().target).toBeNull();
  });
});
