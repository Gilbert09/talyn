import React from 'react';
import { emptyLoopInput, emptyWorkflowInput } from '@talyn/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { LoopsPanel } from '../renderer/components/panels/loops/LoopsPanel';
import { WorkflowsPanel } from '../renderer/components/panels/workflows/WorkflowsPanel';
import { McpServersPanel } from '../renderer/components/panels/mcpServers/McpServersPanel';
import { trackEvent } from '../renderer/lib/analytics';

const mockCreateLoop = jest.fn();
const mockCreateWorkflow = jest.fn();
const mockCreateMcp = jest.fn();
const mockLoopHook = { loops: [] as unknown[], error: null, create: mockCreateLoop, update: jest.fn(), remove: jest.fn(), setEnabled: jest.fn(), runNow: jest.fn(), liveRuns: {}, agents: [] };
const mockWorkflowHook = { workflows: [] as unknown[], error: null, create: mockCreateWorkflow, update: jest.fn(), remove: jest.fn(), setEnabled: jest.fn(), liveRuns: {}, suggestions: null, loadGithubSuggestions: jest.fn() };
const mockMcpHook = { servers: [] as unknown[], error: null, create: mockCreateMcp, update: jest.fn(), remove: jest.fn(), setEnabled: jest.fn(), test: jest.fn() };
const mockLoopInput = { name: 'Daily', cron: '0 9 * * *', internetAccess: true };
const mockWorkflowInput = { name: 'Triage', events: ['pr_opened'], actions: [{ type: 'add_label' }] };
const mockMcpInput = { name: 'Docs', url: 'https://example.com/mcp', authKind: 'bearer', tools: ['search'], enabled: true };

jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/stores/toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));
jest.mock('../renderer/stores/billing', () => ({ useBillingStore: { getState: () => ({ status: null, refresh: jest.fn() }) }, maybeHandleBillingLimit: () => false }));
jest.mock('../renderer/components/panels/loops/useLoops', () => ({ useLoops: () => mockLoopHook }));
jest.mock('../renderer/components/panels/workflows/useWorkflows', () => ({ useWorkflows: () => mockWorkflowHook }));
jest.mock('../renderer/components/panels/mcpServers/useMcpServers', () => ({ useMcpServers: () => mockMcpHook }));
jest.mock('../renderer/components/panels/workflows/FeedbackButton', () => ({ FeedbackButton: () => null }));
jest.mock('../renderer/components/panels/loops/LoopRunsList', () => ({ LoopRunsList: () => null }));
jest.mock('../renderer/components/panels/workflows/WorkflowRunsList', () => ({ WorkflowRunsList: () => null }));
jest.mock('../renderer/components/panels/loops/LoopEditorPage', () => ({ LoopEditorPage: ({ onSave }: { onSave: (input: typeof mockLoopInput) => Promise<void> }) => <button onClick={() => void onSave(mockLoopInput)}>Save loop</button> }));
jest.mock('../renderer/components/panels/workflows/WorkflowEditorPage', () => ({ WorkflowEditorPage: ({ onSave }: { onSave: (input: typeof mockWorkflowInput) => Promise<void> }) => <button onClick={() => void onSave(mockWorkflowInput)}>Save workflow</button> }));
jest.mock('../renderer/components/panels/mcpServers/McpServerEditorPage', () => ({ McpServerEditorPage: ({ onSave }: { onSave: (input: typeof mockMcpInput) => Promise<unknown> }) => <button onClick={() => void onSave(mockMcpInput)}>Save MCP</button> }));
jest.mock('../renderer/components/panels/mcpServers/LocalImport', () => ({ LocalImport: () => null }));

afterEach(() => { mockLoopHook.loops = []; mockWorkflowHook.workflows = []; mockMcpHook.servers = []; cleanup(); jest.clearAllMocks(); });

describe('settings analytics saves', () => {
  it('records a loop save without prompt text', async () => {
    mockCreateLoop.mockResolvedValue(undefined);
    render(<LoopsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'New loop' }));
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
