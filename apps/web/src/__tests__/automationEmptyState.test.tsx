import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { api } from '../lib/api';
import { useBillingStore } from '../stores/billing';
import { useWorkspaceStore } from '../stores/workspace';
import { WorkflowsPanel } from '../components/panels/workflows/WorkflowsPanel';

beforeEach(() => {
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws1', repositories: [] } as never);
  useBillingStore.setState({ status: null } as never);
  vi.spyOn(api.workflows, 'list').mockResolvedValue([]);
  vi.spyOn(api.ws, 'on').mockReturnValue(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
