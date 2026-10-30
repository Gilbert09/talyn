import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { cloudProviderStatus } from '@talyn/shared';
import { CloudProviderStatus } from '../components/layout/CloudProviderStatus';
import type { CloudProviderInfo } from '@talyn/client';

const mockState = vi.hoisted(() => ({ providers: [] as CloudProviderInfo[], posthogNeedsReauth: false, openSettings: vi.fn() }));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({
    cloudProviders: mockState.providers,
    posthogStatus: { needsReauth: mockState.posthogNeedsReauth },
    openSettings: mockState.openSettings,
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
    ['healthy', { connected: true }, 'bg-success', 'Connected'],
    ['reconnect', { connected: true, needsReconnect: true }, 'bg-warning', 'Reconnect needed'],
    ['disconnected', { connected: false }, 'bg-muted-foreground/40', 'Not connected'],
    ['fleet reconnect', { connected: true, connectedAgents: ['codex'], reauthAgents: ['codex'] }, 'bg-warning', 'Reconnect needed'],
  ])('renders the %s dot and opens Integrations', (_name, provider, dotClass, tooltip) => {
    mockState.providers = [{ type: 'posthog_code', displayName: 'PostHog Code', ...provider }];
    mockState.posthogNeedsReauth = false;
    mockState.openSettings.mockClear();
    const view = render(createElement(CloudProviderStatus, { collapsed: true }));
    const button = screen.getByRole('button', { name: new RegExp(tooltip) });
    expect(button.querySelector('span.rounded-full')?.className).toContain(dotClass);
    fireEvent.click(button);
    expect(mockState.openSettings).toHaveBeenCalledWith('integrations');
    view.unmount();
  });

  it('shows reconnect when Settings has newer PostHog status than the provider list', () => {
    mockState.providers = [{ type: 'posthog_code', displayName: 'PostHog Code', connected: true, needsReconnect: false }];
    mockState.posthogNeedsReauth = true;
    const view = render(createElement(CloudProviderStatus, { collapsed: true }));
    const button = screen.getByRole('button', { name: /Reconnect needed/ });
    expect(button.querySelector('span.rounded-full')?.className).toContain('bg-warning');
    view.unmount();
  });
});
