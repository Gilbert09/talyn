import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { POSTHOG_CODE_RETIRED_NOTICE, type CloudAgentChoice } from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { PostHogCodeCard } from '../renderer/components/panels/SettingsPanel';
import { LoopEditorPage } from '../renderer/components/panels/loops/LoopEditorPage';

/**
 * The `posthogCodeRetired` flag on the desktop: a workspace that has not
 * connected PostHog Code is not offered it, and one that has keeps its card
 * with a notice. With the flag off or unknown, nothing changes.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

type FlagState = boolean | null;
const features = (flag: FlagState) => (flag === null ? null : ({ posthogCodeRetired: flag } as never));

beforeEach(() => {
  jest.spyOn(api.posthog, 'getStatus').mockResolvedValue({ connected: false } as never);
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('PostHogCodeCard', () => {
  function mount(flag: FlagState, status: Record<string, unknown>) {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws-1',
      features: features(flag),
      posthogStatus: status as never,
    });
    return render(<PostHogCodeCard />);
  }

  it.each<[string, FlagState]>([
    ['unknown', null],
    ['off', false],
  ])('offers the sign-in with the flag %s', async (_label, flag) => {
    mount(flag, { connected: false, oauthAvailable: true });
    await waitFor(() => expect(screen.getByText('Connect with PostHog')).toBeTruthy());
    expect(screen.queryByText(POSTHOG_CODE_RETIRED_NOTICE)).toBeNull();
  });

  it('draws nothing with the flag on and nothing connected', () => {
    const { container } = mount(true, { connected: false, oauthAvailable: true });
    expect(container.textContent).toBe('');
  });

  it.each<[string, Record<string, unknown>]>([
    ['connected', { connected: true, authMethod: 'oauth', projectId: '2', oauthAvailable: true }],
    ['needing a reconnect', { connected: true, authMethod: 'oauth', needsReauth: true, oauthAvailable: true }],
    ['on a host no longer allowed', { connected: false, hostNotAllowed: true, oauthAvailable: true }],
  ])('keeps the card and shows the notice with the flag on, %s', async (_label, status) => {
    mount(true, status);
    await waitFor(() => expect(screen.getByText('PostHog Code')).toBeTruthy());
    expect(screen.getByText(POSTHOG_CODE_RETIRED_NOTICE)).toBeTruthy();
  });

  it('shows no notice for a connected workspace with the flag off', async () => {
    mount(false, { connected: true, authMethod: 'oauth', projectId: '2', oauthAvailable: true });
    await waitFor(() => expect(screen.getByText('Reconnect')).toBeTruthy());
    expect(screen.queryByText(POSTHOG_CODE_RETIRED_NOTICE)).toBeNull();
  });
});

describe('LoopEditorPage on a PostHog Code loop', () => {
  const AGENTS: CloudAgentChoice[] = [
    {
      type: 'posthog_code',
      displayName: 'PostHog Code',
      model: 'claude-opus-5',
      models: [{ id: 'claude-opus-5', label: 'Opus 5', blurb: 'Newest Opus.' }],
    },
  ];

  it.each<[string, FlagState, boolean]>([
    ['on', true, true],
    ['off', false, false],
    ['unknown', null, false],
  ])('with the flag %s', (_label, flag, shown) => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      features: features(flag),
      repositories: [{ id: 'repo-1', workspaceId: 'ws1', owner: 'acme', repo: 'widget', fullName: 'acme/widget' }],
    } as never);
    render(<LoopEditorPage editing={null} agents={AGENTS} onCancel={() => {}} onSave={async () => {}} />);
    expect(screen.queryByText(POSTHOG_CODE_RETIRED_NOTICE) !== null).toBe(shown);
  });
});
