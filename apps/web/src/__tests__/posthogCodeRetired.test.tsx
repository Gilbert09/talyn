import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import {
  POSTHOG_CODE_RETIRED_NOTICE,
  posthogCodeConnectionExists,
  posthogCodeOffered,
  posthogCodeRetiringNotice,
  type CloudAgentChoice,
} from '@talyn/shared';

/**
 * The `posthogCodeRetired` flag on the web: a workspace that has not connected
 * PostHog Code is not offered it, and one that has keeps its card with a
 * notice. With the flag off or unknown, nothing changes.
 */

vi.mock('../lib/api', () => ({
  api: {
    posthog: {
      getStatus: vi.fn().mockResolvedValue({ connected: false }),
      startOAuth: vi.fn().mockResolvedValue({ authorizeUrl: 'https://us.posthog.com/oauth' }),
    },
    cloudProviders: { list: vi.fn().mockResolvedValue([]) },
    ws: { on: vi.fn().mockReturnValue(() => {}) },
  },
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));

const { PostHogCodeCard } = await import('../components/panels/SettingsPanel');
const { LoopEditorPage } = await import('../components/panels/loops/LoopEditorPage');
const { useWorkspaceStore } = await import('../stores/workspace');

type FlagState = boolean | null;
const features = (flag: FlagState) => (flag === null ? null : ({ posthogCodeRetired: flag } as never));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('shared helpers', () => {
  it.each<[string, FlagState, boolean, boolean, boolean]>([
    ['unknown features, not connected', null, false, true, false],
    ['flag off, not connected', false, false, true, false],
    ['flag off, connected', false, true, true, false],
    ['flag on, not connected', true, false, false, false],
    ['flag on, connected', true, true, true, true],
  ])('%s', (_label, flag, hasConnection, offered, notice) => {
    expect(posthogCodeOffered(features(flag), hasConnection)).toBe(offered);
    expect(posthogCodeRetiringNotice(features(flag), hasConnection)).toBe(notice);
  });

  it.each<[string, Parameters<typeof posthogCodeConnectionExists>[0], boolean]>([
    ['no status yet', null, false],
    ['not connected', { connected: false }, false],
    ['connected', { connected: true }, true],
    ['host no longer allowed', { connected: false, hostNotAllowed: true }, true],
  ])('a connection exists: %s', (_label, status, expected) => {
    expect(posthogCodeConnectionExists(status)).toBe(expected);
  });
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

// Since #284 a schedule always starts a Talyn Fleet session. The editor drops
// PostHog Code agents, so it has no PostHog Code notice to show.
describe('LoopEditorPage with a PostHog Code agent', () => {
  const AGENTS: CloudAgentChoice[] = [
    {
      type: 'posthog_code',
      displayName: 'PostHog Code',
      model: 'claude-opus-5',
      models: [{ id: 'claude-opus-5', label: 'Opus 5', blurb: 'Newest Opus.' }],
    },
  ];

  it.each<[string, FlagState, boolean]>([
    ['on', true, false],
    ['off', false, false],
    ['unknown', null, false],
  ])('shows no retirement notice with the flag %s', (_label, flag, shown) => {
    useWorkspaceStore.setState({
      currentWorkspaceId: 'ws1',
      features: features(flag),
      repositories: [{ id: 'repo-1', workspaceId: 'ws1', owner: 'acme', repo: 'widget', fullName: 'acme/widget' }],
    } as never);
    render(<LoopEditorPage editing={null} agents={AGENTS} onCancel={() => {}} onSave={async () => {}} />);
    expect(screen.queryByText(POSTHOG_CODE_RETIRED_NOTICE) !== null).toBe(shown);
  });
});
