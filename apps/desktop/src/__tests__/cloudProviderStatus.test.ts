import { describe, it, expect } from '@jest/globals';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { cloudProviderStatus } from '@talyn/shared';
import { CloudProviderStatus } from '../renderer/components/layout/CloudProviderStatus';
import type { CloudProviderInfo } from '@talyn/client';

let mockProviders: CloudProviderInfo[] = [];
let mockPosthogNeedsReauth = false;
const mockOpenSettings = jest.fn();
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({
    cloudProviders: mockProviders,
    posthogStatus: { needsReauth: mockPosthogNeedsReauth },
    openSettings: mockOpenSettings,
  }),
}));

describe('cloudProviderStatus', () => {
  it.each([
    [
      'a provider with no credentials',
      { connected: false },
      { tone: 'disconnected', agents: [], detail: 'Not connected' },
    ],
    [
      'a single-agent provider',
      { connected: true },
      { tone: 'connected', agents: [], detail: 'Connected' },
    ],
    [
      'the fleet with one agent',
      { connected: true, connectedAgents: ['claude'] },
      { tone: 'connected', agents: ['claude'], detail: 'Claude connected' },
    ],
    [
      'the fleet with both agents',
      { connected: true, connectedAgents: ['claude', 'codex'] },
      { tone: 'connected', agents: ['claude', 'codex'], detail: 'Claude and Codex connected' },
    ],
    [
      'a rejected sign-in on one agent',
      { connected: true, connectedAgents: ['claude', 'codex'], reauthAgents: ['codex'] },
      { tone: 'reauth', agents: ['claude', 'codex'], detail: 'Reconnect needed: Codex' },
    ],
    [
      'PostHog Code with a rejected grant',
      { connected: true, needsReconnect: true },
      { tone: 'reauth', agents: [], detail: 'Reconnect needed' },
    ],
    [
      'an agent this build has never heard of',
      { connected: true, connectedAgents: ['gemini'] },
      { tone: 'connected', agents: ['gemini'], detail: 'gemini connected' },
    ],
    [
      'a stale agent list on a disconnected provider',
      { connected: false, connectedAgents: ['claude'] },
      { tone: 'disconnected', agents: [], detail: 'Not connected' },
    ],
    [
      'a stale reconnect flag on a disconnected provider',
      { connected: false, needsReconnect: true },
      { tone: 'disconnected', agents: [], detail: 'Not connected' },
    ],
  ])('describes %s', (_name, provider, expected) => {
    expect(cloudProviderStatus(provider)).toEqual(expected);
  });
});

describe('sidebar provider dots', () => {
  it.each([
    ['healthy', { connected: true }, 'bg-green-500', 'Connected'],
    ['reconnect', { connected: true, needsReconnect: true }, 'bg-amber-500', 'Reconnect needed'],
    ['disconnected', { connected: false }, 'bg-muted-foreground/40', 'Not connected'],
    ['fleet reconnect', { connected: true, connectedAgents: ['codex'], reauthAgents: ['codex'] }, 'bg-amber-500', 'Reconnect needed'],
  ])('renders the %s dot and opens Integrations', (_name, provider, dotClass, tooltip) => {
    mockProviders = [{ type: 'posthog_code', displayName: 'PostHog Code', ...provider }];
    mockPosthogNeedsReauth = false;
    mockOpenSettings.mockClear();
    const view = render(createElement(CloudProviderStatus, { collapsed: true }));
    const button = screen.getByRole('button', { name: new RegExp(tooltip) });
    expect(button.querySelector('span.rounded-full')?.className).toContain(dotClass);
    fireEvent.click(button);
    expect(mockOpenSettings).toHaveBeenCalledWith('integrations');
    view.unmount();
  });

  it('shows reconnect when Settings has newer PostHog status than the provider list', () => {
    mockProviders = [{ type: 'posthog_code', displayName: 'PostHog Code', connected: true, needsReconnect: false }];
    mockPosthogNeedsReauth = true;
    const view = render(createElement(CloudProviderStatus, { collapsed: true }));
    const button = screen.getByRole('button', { name: /Reconnect needed/ });
    expect(button.querySelector('span.rounded-full')?.className).toContain('bg-amber-500');
    view.unmount();
  });
});
