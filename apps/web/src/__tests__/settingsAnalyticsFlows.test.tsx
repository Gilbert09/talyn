import React from 'react';
import { emptyLoopInput, emptyWorkflowInput } from '@talyn/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoopsPanel } from '../components/panels/loops/LoopsPanel';
import { WorkflowsPanel } from '../components/panels/workflows/WorkflowsPanel';
import { McpServersPanel } from '../components/panels/mcpServers/McpServersPanel';
import { trackEvent } from '../lib/analytics';

const { mockCreateLoop, mockCreateWorkflow, mockCreateMcp, mockLoopHook, mockWorkflowHook, mockMcpHook, mockLoopInput, mockWorkflowInput, mockMcpInput } = vi.hoisted(() => {
  const createLoop = vi.fn();
  const createWorkflow = vi.fn();
  const createMcp = vi.fn();
  return { mockCreateLoop: createLoop, mockCreateWorkflow: createWorkflow, mockCreateMcp: createMcp,
    mockLoopHook: { loops: [] as unknown[], error: null, create: createLoop, update: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(), runNow: vi.fn(), liveRuns: {}, agents: [] },
    mockWorkflowHook: { workflows: [] as unknown[], error: null, create: createWorkflow, update: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(), liveRuns: {}, suggestions: null, loadGithubSuggestions: vi.fn() },
    mockMcpHook: { servers: [] as unknown[], error: null, create: createMcp, update: vi.fn(), remove: vi.fn(), setEnabled: vi.fn(), test: vi.fn() },
    mockLoopInput: { name: 'Daily', cron: '0 9 * * *', internetAccess: true },
    mockWorkflowInput: { name: 'Triage', events: ['pr_opened'], actions: [{ type: 'add_label' }] },
    mockMcpInput: { name: 'Docs', url: 'https://example.com/mcp', authKind: 'bearer', tools: ['search'], enabled: true }
  };
});
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../stores/billing', () => ({ useBillingStore: { getState: () => ({ status: null, refresh: vi.fn() }) }, maybeHandleBillingLimit: () => false }));
vi.mock('../components/panels/loops/useLoops', () => ({ useLoops: () => mockLoopHook }));
vi.mock('../components/panels/workflows/useWorkflows', () => ({ useWorkflows: () => mockWorkflowHook }));
vi.mock('../components/panels/mcpServers/useMcpServers', () => ({ useMcpServers: () => mockMcpHook }));
vi.mock('../components/panels/workflows/FeedbackButton', () => ({ FeedbackButton: () => null }));
vi.mock('../components/panels/loops/LoopRunsList', () => ({ LoopRunsList: () => null }));
vi.mock('../components/panels/workflows/WorkflowRunsList', () => ({ WorkflowRunsList: () => null }));
vi.mock('../components/panels/loops/LoopEditorPage', () => ({ LoopEditorPage: ({ onSave }: { onSave: (input: typeof mockLoopInput) => Promise<void> }) => <button onClick={() => void onSave(mockLoopInput)}>Save loop</button> }));
vi.mock('../components/panels/workflows/WorkflowEditorPage', () => ({ WorkflowEditorPage: ({ onSave }: { onSave: (input: typeof mockWorkflowInput) => Promise<void> }) => <button onClick={() => void onSave(mockWorkflowInput)}>Save workflow</button> }));
vi.mock('../components/panels/mcpServers/McpServerEditorPage', () => ({ McpServerEditorPage: ({ onSave }: { onSave: (input: typeof mockMcpInput) => Promise<unknown> }) => <button onClick={() => void onSave(mockMcpInput)}>Save MCP</button> }));
vi.mock('../components/panels/mcpServers/LocalImport', () => ({ LocalImport: () => null }));

afterEach(() => { mockLoopHook.loops = []; mockWorkflowHook.workflows = []; mockMcpHook.servers = []; cleanup(); vi.clearAllMocks(); });

describe('settings analytics saves', () => {
  it('records a loop save without prompt text', async () => {
    mockCreateLoop.mockResolvedValue(undefined);
    render(<LoopsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'New scheduled rule' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save loop' }));
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('loop_saved', { new: true, schedule_kind: 'daily', internet_access: true }));
  });

  it('records workflow counts', async () => {
    mockCreateWorkflow.mockResolvedValue(undefined);
    render(<WorkflowsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('workflow_saved', { new: true, actions_count: 1, events_count: 1 }));
  });

  it('records MCP authentication and tool limits', async () => {
    mockCreateMcp.mockResolvedValue({ id: 'server-1' });
    render(<McpServersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save MCP' }));
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('mcp_server_saved', { auth_method: 'bearer', tools_restricted: true }));
  });
});

const loop = {
  ...emptyLoopInput('UTC'), id: 'loop-1', name: 'Daily', enabled: true,
  repoFullName: 'org/repo', nextRunAt: null, disabledReason: null,
  stats: { runsTotal: 0, runs7d: 0, failures7d: 0, lastRunAt: null, lastStatus: null },
};
const workflow = {
  ...emptyWorkflowInput(), id: 'workflow-1', name: 'Triage', enabled: true,
  stats: { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null },
};
const server = {
  id: 'server-1', name: 'Docs', displayName: null, url: 'https://example.com/mcp',
  catalogHandle: null, tools: null, enabled: true, lastProbe: null,
};

describe('settings analytics actions', () => {
  it('records loop disable, manual run, and delete after success', async () => {
    mockLoopHook.loops = [loop];
    mockLoopHook.setEnabled.mockResolvedValue(undefined);
    mockLoopHook.runNow.mockResolvedValue(undefined);
    mockLoopHook.remove.mockResolvedValue(undefined);
    render(<LoopsPanel />);
    fireEvent.click(document.querySelector('[data-attr="loop-toggle-enabled"]') as HTMLElement);
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('loop_disabled'));
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('loop_run_now'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('loop_deleted'));
  });

  it('records workflow disable and delete after success', async () => {
    mockWorkflowHook.workflows = [workflow];
    mockWorkflowHook.setEnabled.mockResolvedValue(undefined);
    mockWorkflowHook.remove.mockResolvedValue(undefined);
    render(<WorkflowsPanel />);
    fireEvent.click(document.querySelector('[data-attr="workflow-toggle-enabled"]') as HTMLElement);
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('workflow_disabled'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('workflow_deleted'));
  });

  it('records MCP deletion after success', async () => {
    mockMcpHook.servers = [server];
    mockMcpHook.remove.mockResolvedValue(undefined);
    render(<McpServersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('mcp_server_deleted'));
  });
});
