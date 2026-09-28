import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { api } from '../renderer/lib/api';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { PostHogCodeCard } from '../renderer/components/panels/SettingsPanel';

/**
 * PostHog Code connects with OAuth, not a pasted key — wherever OAuth exists.
 *
 * The key path used to sit one click behind the OAuth button on every
 * deployment, which made a long-lived credential carrying the user's whole
 * project the easier of the two choices for anyone who did not know the
 * difference. The OAuth grant is narrowed to one project and task read/write
 * and is revocable from PostHog's own Connected Apps screen.
 *
 * What must NOT change: a deployment with no POSTHOG_OAUTH_* configured still
 * gets the key form, because SETUP §6b documents that as the fall-back and it is
 * the local-dev default. And a workspace already connected with a key keeps
 * working — this is a change to what is OFFERED, never to what is stored.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

beforeEach(() => {
  jest.spyOn(api.posthog, 'getStatus').mockResolvedValue({ connected: false } as never);
  jest
    .spyOn(api.posthog, 'startOAuth')
    .mockResolvedValue({ authorizeUrl: 'https://us.posthog.com/oauth' } as never);
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

function mount(status: Record<string, unknown>) {
  useWorkspaceStore.setState({ currentWorkspaceId: 'ws-1', posthogStatus: status as never });
  return render(<PostHogCodeCard />);
}

describe('PostHog Code — how a workspace connects', () => {
  it('offers only the sign-in when OAuth is configured', async () => {
    mount({ connected: false, oauthAvailable: true });
    await waitFor(() => expect(screen.getByText('Connect with PostHog')).toBeTruthy());
    // The escape hatch that made the weaker credential a one-click default.
    expect(screen.queryByText('Use a personal API key')).toBeNull();
    expect(screen.queryByText('Personal API key')).toBeNull();
  });

  it('still offers the key form where OAuth is not configured', async () => {
    // Self-hosted and local dev. Removing this would leave them no way to
    // connect at all.
    mount({ connected: false, oauthAvailable: false });
    await waitFor(() => expect(screen.getByText('Personal API key')).toBeTruthy());
    expect(screen.queryByText('Connect with PostHog')).toBeNull();
  });

  it('offers a key connection the move to OAuth rather than a key edit', async () => {
    mount({ connected: true, authMethod: 'key', projectId: '2', oauthAvailable: true });
    await waitFor(() => expect(screen.getByText('Switch to PostHog sign-in')).toBeTruthy());
    expect(screen.queryByText('Edit')).toBeNull();
  });

  it('leaves a key connection editable where OAuth is not configured', async () => {
    mount({ connected: true, authMethod: 'key', projectId: '2', oauthAvailable: false });
    await waitFor(() => expect(screen.getByText('Edit')).toBeTruthy());
    expect(screen.queryByText('Switch to PostHog sign-in')).toBeNull();
  });

  it('offers an OAuth connection a reconnect, which re-picks the project', async () => {
    mount({ connected: true, authMethod: 'oauth', projectId: '2', oauthAvailable: true });
    await waitFor(() => expect(screen.getByText('Reconnect')).toBeTruthy());
    expect(screen.queryByText('Edit')).toBeNull();
  });
});
