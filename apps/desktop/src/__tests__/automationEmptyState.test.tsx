import '@testing-library/jest-dom';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { api } from '../renderer/lib/api';
import { useBillingStore } from '../renderer/stores/billing';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { WorkflowsPanel } from '../renderer/components/panels/workflows/WorkflowsPanel';

beforeEach(() => {
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1', repositories: [] } as never);
  useBillingStore.setState({ status: null } as never);
  jest.spyOn(api.workflows, 'list').mockResolvedValue([]);
  jest.spyOn(api.ws, 'on').mockReturnValue(() => {});
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

describe('automations empty state', () => {
  it.each([
    ['slack', 'An automation watches Slack messages and can start a session, reply or react.'],
    ['github', 'An automation watches pull request events and can label, comment, request reviewers, start a session and more.'],
  ] as const)('uses the automation copy for %s', async (integration, description) => {
    render(<WorkflowsPanel integration={integration} />);
    expect(await screen.findByText('No automations yet')).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create an automation' })).toBeTruthy();
    expect(screen.queryByText(/workflow/i)).toBeNull();
  });
});
