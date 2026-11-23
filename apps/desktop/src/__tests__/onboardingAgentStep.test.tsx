import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

/**
 * The agent step of the onboarding wizard: a fleet workspace must connect
 * Claude or Codex, PostHog Code is not offered there, and a workspace with no
 * fleet keeps the PostHog Code path so it is not trapped.
 */

jest.mock('../renderer/lib/api', () => ({
  loadAllRepos: jest.fn().mockResolvedValue([]),
  mergeRepos: jest.fn(),
  api: {
    github: {
      getStatus: jest.fn().mockResolvedValue({ configured: true, connected: true }),
      listInstallations: jest.fn().mockResolvedValue([]),
      getUser: jest.fn().mockResolvedValue({ login: 'octocat' }),
      installViaApp: jest.fn().mockResolvedValue({ installUrl: 'x', manageUrl: 'y' }),
    },
    repositories: { list: jest.fn().mockResolvedValue([]) },
    workspaces: { list: jest.fn().mockResolvedValue([]), create: jest.fn() },
    environments: { list: jest.fn().mockResolvedValue([]) },
    cloudProviders: { list: jest.fn().mockResolvedValue([]) },
    posthog: { getStatus: jest.fn().mockResolvedValue({ connected: false }) },
    features: { get: jest.fn().mockResolvedValue(null) },
    ws: { on: jest.fn().mockReturnValue(() => {}) },
  },
}));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { OnboardingWizard } = require('../renderer/components/onboarding/OnboardingWizard');

const REPO = { id: 'r1', workspaceId: 'ws1', owner: 'acme', repo: 'app', fullName: 'acme/app' };

function nextButton() {
  return [...document.querySelectorAll('button')].find((b) => /^next/i.test(b.textContent ?? ''));
}

async function setup(options: {
  providers: unknown[];
  posthogConnected?: boolean;
  github?: boolean;
  repos?: unknown[];
  features?: unknown;
}) {
  const { api } = await import('../renderer/lib/api');
  const { useWorkspaceStore } = await import('../renderer/stores/workspace');
  jest.mocked(api.cloudProviders.list).mockResolvedValue(options.providers as never);
  jest.mocked(api.posthog.getStatus).mockResolvedValue({ connected: options.posthogConnected ?? false } as never);
  jest.mocked(api.github.getStatus).mockResolvedValue({
    configured: true,
    connected: options.github ?? true,
  } as never);
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    repositories: (options.repos ?? [REPO]) as never,
    cloudProviders: null,
    posthogStatus: null,
    features: (options.features ?? null) as never,
  });
}

async function walkToAgentStep() {
  render(<OnboardingWizard />);
  await waitFor(() => expect(nextButton()?.hasAttribute('disabled')).toBe(false));
  fireEvent.click(nextButton()!);
  fireEvent.click(nextButton()!);
  await screen.findByText('Connect your agent', { selector: 'h2' });
}

beforeEach(() => {
  cleanup();
  jest.clearAllMocks();
  localStorage.clear();
});

describe('agent step gating', () => {
  it.each([
    ['claude connected', ['claude'], false, true],
    ['codex connected', ['codex'], false, true],
    ['both connected', ['claude', 'codex'], false, true],
    ['nothing connected', [], false, false],
    ['only PostHog Code connected', [], true, false],
  ])('fleet offered, %s', async (_name, agents, posthogConnected, canAdvance) => {
    await setup({
      providers: [{ type: 'selfhosted', connected: agents.length > 0, connectedAgents: agents }],
      posthogConnected,
    });
    await walkToAgentStep();

    await waitFor(() => expect(screen.queryByText('Checking your agents...')).toBeNull());
    expect(screen.getByRole('button', { name: /Claude/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Codex/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /PostHog Code/ })).toBeNull();
    expect(nextButton()?.hasAttribute('disabled')).toBe(!canAdvance);
    expect(screen.queryByText('Connect Claude or ChatGPT to start sessions, or skip for now.') !== null).toBe(!canAdvance);
  });

  it.each([
    ['connected', true, true],
    ['not connected', false, false],
  ])('no fleet, PostHog Code %s keeps the PostHog Code path', async (_name, posthogConnected, canAdvance) => {
    await setup({ providers: [{ type: 'posthog_code', connected: posthogConnected }], posthogConnected });
    await walkToAgentStep();

    await screen.findByRole('button', { name: /PostHog Code/ });
    expect(screen.queryByRole('button', { name: /Claude/ })).toBeNull();
    expect(nextButton()?.hasAttribute('disabled')).toBe(!canAdvance);
    expect(screen.queryByText('Connect PostHog Code to start sessions, or skip for now.') !== null).toBe(!canAdvance);
  });
});

describe('with PostHog Code retired', () => {
  it.each([
    ['not connected, hidden', false, false],
    ['connected, still shown', true, true],
  ])('no fleet, PostHog Code %s', async (_name, posthogConnected, shown) => {
    await setup({ providers: [{ type: 'posthog_code', connected: posthogConnected }], posthogConnected });
    const { useWorkspaceStore } = await import('../renderer/stores/workspace');
    useWorkspaceStore.setState({ features: { posthogCodeRetired: true } as never });
    await walkToAgentStep();

    await waitFor(() => expect(screen.queryByText('Checking your agents...')).toBeNull());
    if (shown) await screen.findByRole('button', { name: /PostHog Code/ });
    else await waitFor(() => expect(screen.queryByRole('button', { name: /PostHog Code/ })).toBeNull());
  });

  it('names only Claude or Codex when nothing can be connected', async () => {
    await setup({ providers: [], posthogConnected: false });
    const { useWorkspaceStore } = await import('../renderer/stores/workspace');
    useWorkspaceStore.setState({ features: { posthogCodeRetired: true } as never });
    await walkToAgentStep();

    await screen.findByText(/Sessions run on Claude or Codex\./);
    expect(screen.getByText('Connect Claude or ChatGPT to start sessions, or skip for now.')).toBeTruthy();
    expect(screen.queryByText(/Connect PostHog Code/)).toBeNull();
  });
});

function skipButton() {
  return screen.queryByRole('button', { name: 'Skip for now' });
}

describe('skip at the agent step', () => {
  it('shows Skip for now only while no session agent is connected', async () => {
    await setup({ providers: [{ type: 'selfhosted', connected: true, connectedAgents: ['claude'] }] });
    await walkToAgentStep();
    await waitFor(() => expect(nextButton()?.hasAttribute('disabled')).toBe(false));
    expect(skipButton()).toBeNull();
  });

  it.each([
    ['fleet offered', [{ type: 'selfhosted', connected: false, connectedAgents: [] }]],
    ['no fleet', [{ type: 'posthog_code', connected: false }]],
  ])('%s: skipping tracks the event, goes home and finishes onboarding', async (_name, providers) => {
    const { trackEvent } = await import('../renderer/lib/analytics');
    const { useWorkspaceStore } = await import('../renderer/stores/workspace');
    const { useNavigationStore } = await import('../renderer/stores/navigation');
    const originalNavigate = useNavigationStore.getState().navigate;
    const navigate = jest.fn();
    useNavigationStore.setState({ navigate } as never);
    await setup({ providers });
    await walkToAgentStep();
    await waitFor(() => expect(screen.queryByText('Checking your agents...')).toBeNull());

    fireEvent.click(skipButton()!);

    expect(trackEvent).toHaveBeenCalledWith('onboarding_agent_skipped');
    expect(trackEvent).toHaveBeenCalledWith(
      'onboarding_completed',
      expect.objectContaining({ agent_skipped: true, agent_connected: false, agent_mode: 'none' })
    );
    expect(trackEvent).not.toHaveBeenCalledWith('onboarding_step_completed', { step: 'agent' });
    expect(navigate).toHaveBeenCalledWith({ view: 'home' }, { replace: true });
    expect(useWorkspaceStore.getState().onboardingComplete).toBe(true);
    expect(useWorkspaceStore.getState().justOnboarded).toBe(true);
    useNavigationStore.setState({ navigate: originalNavigate });
  });

  it('tracks the option the user picks', async () => {
    const { trackEvent } = await import('../renderer/lib/analytics');
    await setup({ providers: [{ type: 'selfhosted', connected: false, connectedAgents: [] }] });
    await walkToAgentStep();
    fireEvent.click(await screen.findByRole('button', { name: /Codex/ }));
    expect(trackEvent).toHaveBeenCalledWith('onboarding_agent_option_selected', { agent: 'codex' });
  });
});

describe('hints under a disabled Next', () => {
  it('names the GitHub requirement', async () => {
    await setup({ providers: [], github: false });
    render(<OnboardingWizard />);
    expect(
      await screen.findByText(
        'Connect GitHub and install the Talyn GitHub App on at least one account to continue.'
      )
    ).toBeTruthy();
    expect(nextButton()?.hasAttribute('disabled')).toBe(true);
  });

  it('names the repository requirement', async () => {
    await setup({ providers: [], repos: [] });
    render(<OnboardingWizard />);
    await waitFor(() => expect(nextButton()?.hasAttribute('disabled')).toBe(false));
    fireEvent.click(nextButton()!);
    expect(await screen.findByText('Choose at least one repository to continue.')).toBeTruthy();
    expect(nextButton()?.hasAttribute('disabled')).toBe(true);
  });
});

describe('GitHub status polling during onboarding', () => {
  it('re-checks on an interval until connected, then stops', async () => {
    jest.useFakeTimers();
    try {
      const { api } = await import('../renderer/lib/api');
      const { renderHook, act } = await import('@testing-library/react');
      const { useGithubConnection } = await import('../renderer/hooks/useGithubConnection');
      const getStatus = jest.mocked(api.github.getStatus);
      getStatus.mockReset();
      getStatus.mockResolvedValueOnce({ configured: true, connected: false } as never);
      getStatus.mockResolvedValue({ configured: true, connected: true } as never);

      const { result } = renderHook(() => useGithubConnection('ws1', { pollMs: 1000 }));
      await act(async () => {});
      expect(result.current.status?.connected).toBe(false);

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(result.current.status?.connected).toBe(true);

      const calls = getStatus.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(getStatus.mock.calls.length).toBe(calls);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the local agent option', () => {
  const LOCAL_OPTION = 'Claude Code or Codex on this computer';
  const READY = { claude: { ok: true, path: '/usr/bin/claude' }, codex: { ok: false }, pty: { ok: true }, git: { ok: true } };
  const readiness = jest.fn();
  const FLAG_ON = { onboardingLocalAgent: true };

  function installBridge(local: unknown) {
    readiness.mockReset();
    readiness.mockResolvedValue(local);
    (window as unknown as { electron?: unknown }).electron = { workbench: { readiness } };
  }

  async function events(name: string) {
    const { trackEvent } = await import('../renderer/lib/analytics');
    return jest.mocked(trackEvent).mock.calls.filter(([event]) => event === name);
  }

  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('is hidden, and nothing is checked, while the flag is off', async () => {
    installBridge(READY);
    await setup({ providers: [{ type: 'selfhosted', connected: false, connectedAgents: [] }] });
    await walkToAgentStep();
    await screen.findByRole('button', { name: /^Codex/ });
    expect(screen.queryByRole('button', { name: new RegExp(LOCAL_OPTION) })).toBeNull();
    expect(readiness).not.toHaveBeenCalled();
    expect(await events('onboarding_local_agent_checked')).toHaveLength(0);
    expect(nextButton()?.hasAttribute('disabled')).toBe(true);
  });

  it('reads the flag from GET /features when the store has none', async () => {
    installBridge(READY);
    const { api } = await import('../renderer/lib/api');
    jest.mocked(api.features.get).mockResolvedValueOnce({ onboardingLocalAgent: true } as never);
    await setup({ providers: [{ type: 'selfhosted', connected: false, connectedAgents: [] }] });
    await walkToAgentStep();
    expect(await screen.findByRole('button', { name: new RegExp(LOCAL_OPTION) })).toBeTruthy();
  });

  it('reports what this computer has once per wizard', async () => {
    installBridge({ claude: { ok: true, path: '/c' }, codex: { ok: false }, pty: { ok: false }, git: { ok: true } });
    await setup({ providers: [{ type: 'selfhosted', connected: false, connectedAgents: [] }], features: FLAG_ON });
    await walkToAgentStep();
    await waitFor(async () => expect(await events('onboarding_local_agent_checked')).toHaveLength(1));
    expect(await events('onboarding_local_agent_checked')).toEqual([
      ['onboarding_local_agent_checked', { claude_installed: true, codex_installed: false, git_installed: true, pty_ok: false }],
    ]);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(LOCAL_OPTION) }));
    fireEvent.click(await screen.findByRole('button', { name: /Re-check/ }));
    await waitFor(() => expect(readiness).toHaveBeenCalledWith(true));
    expect(await events('onboarding_local_agent_checked')).toHaveLength(1);
  });

  it.each([
    ['only Claude Code', { claude: true, codex: false, git: true }, undefined, 'claude'],
    ['only Codex', { claude: false, codex: true, git: true }, undefined, 'codex'],
    ['both, Claude Code by default', { claude: true, codex: true, git: true }, undefined, 'claude'],
    ['both, Codex as the session default', { claude: true, codex: true, git: true }, 'codex', 'codex'],
    ['Codex default but only Claude Code', { claude: true, codex: false, git: true }, 'codex', 'claude'],
    ['neither', { claude: false, codex: false, git: true }, undefined, null],
    ['no git', { claude: true, codex: true, git: false }, undefined, null],
  ] as const)('%s', async (_name, found, defaultAgent, expected) => {
    if (defaultAgent) localStorage.setItem('talyn.session.defaults', JSON.stringify({ agent: defaultAgent }));
    installBridge({
      claude: { ok: found.claude, path: found.claude ? '/c' : undefined },
      codex: { ok: found.codex, path: found.codex ? '/x' : undefined },
      pty: { ok: true },
      git: { ok: found.git },
    });
    await setup({ providers: [{ type: 'selfhosted', connected: false, connectedAgents: [] }], features: FLAG_ON });
    const { trackEvent } = await import('../renderer/lib/analytics');
    await walkToAgentStep();

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(LOCAL_OPTION) }));
    expect(trackEvent).toHaveBeenCalledWith('onboarding_agent_option_selected', { agent: 'local' });
    await waitFor(() => expect(readiness).toHaveBeenCalled());

    if (expected) {
      const name = expected === 'claude' ? 'Claude Code' : 'Codex';
      expect(await screen.findByText(`Your sessions will use ${name} on this computer.`)).toBeTruthy();
      await waitFor(() => expect(nextButton()?.hasAttribute('disabled')).toBe(false));
      fireEvent.click(nextButton()!);
      expect(trackEvent).toHaveBeenCalledWith('onboarding_local_agent_chosen', { agent: expected });
      await screen.findByText('Start your first session', { selector: 'h2' });
    } else {
      await screen.findByText(/Install Claude Code or Codex, then press Re-check\./);
      expect(nextButton()?.hasAttribute('disabled')).toBe(true);
      expect(screen.getByText('Install Claude Code or Codex on this computer, or skip for now.')).toBeTruthy();
      expect(trackEvent).not.toHaveBeenCalledWith('onboarding_local_agent_chosen', expect.anything());
    }
  });

  it('goes back to the subscriptions when another agent is chosen', async () => {
    installBridge(READY);
    await setup({ providers: [{ type: 'selfhosted', connected: false, connectedAgents: [] }], features: FLAG_ON });
    await walkToAgentStep();
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(LOCAL_OPTION) }));
    await waitFor(() => expect(nextButton()?.hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Choose a different agent/ }));
    expect(nextButton()?.hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: new RegExp(LOCAL_OPTION) })).toBeTruthy();
  });

  it('keeps the local choice after Back from the first session step', async () => {
    installBridge(READY);
    await setup({ providers: [{ type: 'selfhosted', connected: false, connectedAgents: [] }], features: FLAG_ON });
    await walkToAgentStep();
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(LOCAL_OPTION) }));
    await waitFor(() => expect(nextButton()?.hasAttribute('disabled')).toBe(false));
    fireEvent.click(nextButton()!);
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(await screen.findByText('Your sessions will use Claude Code on this computer.')).toBeTruthy();
    expect(nextButton()?.hasAttribute('disabled')).toBe(false);
  });

  it('skipping after choosing local reports no agent', async () => {
    installBridge({ claude: { ok: false }, codex: { ok: false }, pty: { ok: true }, git: { ok: true } });
    await setup({ providers: [{ type: 'selfhosted', connected: false, connectedAgents: [] }], features: FLAG_ON });
    const { trackEvent } = await import('../renderer/lib/analytics');
    await walkToAgentStep();
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(LOCAL_OPTION) }));
    await screen.findByText(/Install Claude Code or Codex, then press Re-check\./);
    fireEvent.click(skipButton()!);
    expect(trackEvent).toHaveBeenCalledWith('onboarding_completed', expect.objectContaining({ agent_skipped: true, agent_mode: 'none' }));
  });
});
