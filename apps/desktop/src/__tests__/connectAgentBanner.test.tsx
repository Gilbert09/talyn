import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { trackEvent } from '../renderer/lib/analytics';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { ConnectAgentBanner } from '../renderer/components/layout/ConnectAgentBanner';

jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));

const FLEET_COPY = /connect your Claude or ChatGPT subscription/;
const POSTHOG_COPY = /connect PostHog Code/;

function setAgents(cloudProviders: unknown[] | null, posthogConnected: boolean | null) {
  useWorkspaceStore.setState({
    cloudProviders: cloudProviders as never,
    posthogStatus: posthogConnected === null ? null : ({ connected: posthogConnected } as never),
    connectAgentOpen: false,
    connectAgentSource: null,
    pendingCloudTask: null,
  });
}

function fleet(agents: string[]) {
  return { type: 'selfhosted', connected: agents.length > 0, connectedAgents: agents };
}

beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(() => {
  cleanup();
  setAgents(null, null);
});

describe('ConnectAgentBanner', () => {
  it.each([
    ['the provider list has not loaded', null, false],
    ['fleet with Claude connected', [fleet(['claude'])], false],
    ['fleet with Codex connected', [fleet(['codex'])], false],
    ['no fleet and PostHog Code connected', [{ type: 'posthog_code', connected: true }], true],
    ['no fleet and the PostHog Code status not loaded', [{ type: 'posthog_code', connected: false }], null],
  ])('renders nothing when %s', (_name, providers, posthogConnected) => {
    setAgents(providers, posthogConnected);
    const { container } = render(<ConnectAgentBanner />);
    expect(container.innerHTML).toBe('');
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['fleet with no agent', [fleet([])], false, FLEET_COPY],
    ['fleet with only PostHog Code connected', [fleet([]), { type: 'posthog_code', connected: true }], true, FLEET_COPY],
    ['no fleet and PostHog Code not connected', [{ type: 'posthog_code', connected: false }], false, POSTHOG_COPY],
    ['no providers at all', [], false, POSTHOG_COPY],
  ])('shows when %s', (_name, providers, posthogConnected, copy) => {
    setAgents(providers, posthogConnected);
    render(<ConnectAgentBanner />);
    expect(screen.getByText('Connect an agent to start sessions.')).toBeTruthy();
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });

  it('tracks one view per mount', () => {
    setAgents([fleet([])], false);
    const { rerender } = render(<ConnectAgentBanner />);
    rerender(<ConnectAgentBanner />);
    setAgents([fleet([])], false);
    rerender(<ConnectAgentBanner />);
    expect(jest.mocked(trackEvent).mock.calls.filter((c) => c[0] === 'connect_agent_banner_viewed')).toEqual([
      ['connect_agent_banner_viewed', { fleet_offered: true }],
    ]);
  });

  it('opens the connect modal with no task and the banner source', () => {
    setAgents([fleet([])], false);
    render(<ConnectAgentBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect an agent' }));
    expect(trackEvent).toHaveBeenCalledWith('connect_agent_banner_clicked', { fleet_offered: true });
    const state = useWorkspaceStore.getState();
    expect(state.connectAgentOpen).toBe(true);
    expect(state.connectAgentSource).toBe('banner');
    expect(state.pendingCloudTask).toBeNull();
  });

  it('goes away when an agent connects', () => {
    setAgents([fleet([])], false);
    const { container, rerender } = render(<ConnectAgentBanner />);
    expect(container.innerHTML).not.toBe('');
    useWorkspaceStore.setState({ cloudProviders: [fleet(['claude'])] as never });
    rerender(<ConnectAgentBanner />);
    expect(container.innerHTML).toBe('');
  });
});
