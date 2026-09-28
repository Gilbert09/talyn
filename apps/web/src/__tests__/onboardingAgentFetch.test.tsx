import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';

/**
 * The Connect-an-agent step fetches what its cards read.
 *
 * It did not, and nothing about the screen said so. `useSystemStatus` — the one
 * loader of `cloudProviders` and `posthogStatus` — mounts in `MainLayout`, which
 * renders only once onboarding is COMPLETE. So this step ran with both values
 * null for its entire life, and null is read everywhere as "still loading, draw
 * nothing". Two visible consequences, both reported from a real install:
 *
 *  - no Talyn Fleet card at all, on a screen whose own paragraph invites you to
 *    connect Claude or Codex to run on Talyn Fleet;
 *  - PostHog Code falling back to its personal-API-key form, because
 *    `oauthAvailable` is a field of the status nobody had fetched.
 *
 * Neither is a rendering bug, so neither would be caught by asserting on what
 * the step draws. What this pins is the fetch.
 */

const listCloudProviders = vi.fn().mockResolvedValue([]);
const getPostHogStatus = vi.fn().mockResolvedValue({ connected: false });

vi.mock('../lib/api', () => ({
  api: {
    cloudProviders: { list: (...a: unknown[]) => listCloudProviders(...a) },
    posthog: { getStatus: (...a: unknown[]) => getPostHogStatus(...a) },
    ws: { on: () => () => {} },
  },
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

const { useAgentConnections } = await import('../hooks/useAgentConnections');
const { useWorkspaceStore } = await import('../stores/workspace');

/** The hook alone — the cards themselves are covered by their own suites. */
function Harness() {
  useAgentConnections();
  return null;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws-1' });
});

describe('the agent connections the onboarding step needs', () => {
  it('asks the backend which cloud providers this workspace has', async () => {
    render(<Harness />);
    await waitFor(() => expect(listCloudProviders).toHaveBeenCalledWith('ws-1'));
  });

  it('asks for the PostHog status, which is where oauthAvailable lives', async () => {
    render(<Harness />);
    await waitFor(() => expect(getPostHogStatus).toHaveBeenCalledWith('ws-1'));
  });

  it('puts both into the store, so the cards stop reading null', async () => {
    listCloudProviders.mockResolvedValueOnce([{ type: 'selfhosted', connectedAgents: [] }]);
    getPostHogStatus.mockResolvedValueOnce({ connected: false, oauthAvailable: true });
    render(<Harness />);
    await waitFor(() => {
      expect(useWorkspaceStore.getState().cloudProviders).toHaveLength(1);
      expect(useWorkspaceStore.getState().posthogStatus?.oauthAvailable).toBe(true);
    });
  });

  it('asks for nothing when there is no workspace yet', async () => {
    useWorkspaceStore.setState({ currentWorkspaceId: null });
    render(<Harness />);
    await waitFor(() => expect(useWorkspaceStore.getState().cloudProviders).toBeNull());
    expect(listCloudProviders).not.toHaveBeenCalled();
    expect(getPostHogStatus).not.toHaveBeenCalled();
  });
});
