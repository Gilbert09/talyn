import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { validateWorkflow, workflowToInput, type WorkflowInput } from '@talyn/shared';
import { api } from '../lib/api';
import { useBillingStore } from '../stores/billing';
import { useWorkspaceStore } from '../stores/workspace';
import { WorkflowsPanel } from '../components/panels/workflows/WorkflowsPanel';

const installation = {
  teamId: 'T1', teamName: 'Acme Slack', teamUrl: null, botUserId: 'UBOT', botName: 'talyn',
  installedByMe: true, needsReinstall: false, canReply: true, installedAt: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1', repositories: [{ id: 'repo1', fullName: 'acme/app' }] } as never);
  useBillingStore.setState({ status: null } as never);
  vi.spyOn(api.workflows, 'list').mockResolvedValue([]);
  vi.spyOn(api.workflows, 'suggestions').mockResolvedValue({ repos: [], branches: [], labels: [], people: [], teams: [] } as never);
  vi.spyOn(api.ws, 'on').mockReturnValue(() => {});
  vi.spyOn(api.slack, 'getStatus').mockResolvedValue({ installations: [installation], links: [] });
  vi.spyOn(api.slack, 'listChannels').mockResolvedValue({ channels: [{ id: 'C1', name: 'general', isPrivate: false }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function openSlackEditor() {
  render(<WorkflowsPanel integration="slack" />);
  await waitFor(() => expect(api.workflows.list).toHaveBeenCalledWith('ws1', 'slack'));
  fireEvent.click(screen.getByText('New automation'));
  await screen.findByLabelText('Name');
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Start from Slack' } });
  fireEvent.change(screen.getByLabelText('Slack workspace'), { target: { value: 'T1' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Add channels' }));
  fireEvent.click(await screen.findByText('#general'));
}

async function addAction(label: string) {
  fireEvent.click(screen.getByText('Add action'));
  fireEvent.click(screen.getByRole('button', { name: new RegExp(label) }));
}

describe('Slack automations', () => {
  it('lists with a filter and creates a valid Slack definition', async () => {
    const create = vi.spyOn(api.workflows, 'create').mockImplementation(async (_workspaceId, input) => ({
      id: 'wf1', workspaceId: 'ws1', ...input,
      stats: { runsTotal: 0, runs24h: 0, runs7d: 0, failures7d: 0, tasksStarted: 0, lastRunAt: null, lastStatus: null },
    } as never));
    await openSlackEditor();
    await addAction('Add a reaction');
    fireEvent.click(document.querySelector('[data-attr="workflow-save"]')!);
    await waitFor(() => expect(create).toHaveBeenCalled());
    const [workspaceId, input] = create.mock.calls[0]!;
    expect(workspaceId).toBe('ws1');
    expect(input.integration).toBe('slack');
    const normalized = validateWorkflow(input as WorkflowInput);
    expect(normalized.conditions).toMatchObject({ slackTeamId: 'T1', channels: ['C1'] });
    expect(validateWorkflow(workflowToInput({ ...normalized, id: 'wf1', workspaceId: 'ws1' } as never))).toEqual(normalized);
  });

  it('shows the reply scope note and disables the reply option', async () => {
    vi.mocked(api.slack.getStatus).mockResolvedValue({ installations: [{ ...installation, canReply: false }], links: [] });
    await openSlackEditor();
    expect(await screen.findByText('Reinstall Slack to let Talyn reply')).toBeTruthy();
    fireEvent.click(screen.getByText('Add action'));
    expect(screen.getByRole('button', { name: /Reply in the thread/ }).hasAttribute('disabled')).toBe(true);
  });
});
