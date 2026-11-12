import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

/**
 * The agent step of the onboarding wizard: a fleet workspace must connect
 * Claude or Codex, PostHog Code is not offered there, and a workspace with no
 * fleet keeps the PostHog Code path so it is not trapped.
 */

vi.mock('../lib/api', () => ({
  loadAllRepos: vi.fn().mockResolvedValue([]),
  mergeRepos: vi.fn(),
  api: {
    github: {
      getStatus: vi.fn().mockResolvedValue({ configured: true, connected: true }),
      listInstallations: vi.fn().mockResolvedValue([]),
      getUser: vi.fn().mockResolvedValue({ login: 'octocat' }),
      installViaApp: vi.fn().mockResolvedValue({ installUrl: 'x', manageUrl: 'y' }),
    },
    repositories: { list: vi.fn().mockResolvedValue([]) },
    workspaces: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
    environments: { list: vi.fn().mockResolvedValue([]) },
    cloudProviders: { list: vi.fn().mockResolvedValue([]) },
    posthog: { getStatus: vi.fn().mockResolvedValue({ connected: false }) },
    ws: { on: vi.fn().mockReturnValue(() => {}) },
  },
}));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));

const { OnboardingWizard } = await import('../components/onboarding/OnboardingWizard');

const REPO = { id: 'r1', workspaceId: 'ws1', owner: 'acme', repo: 'app', fullName: 'acme/app' };

function nextButton() {
  return [...document.querySelectorAll('button')].find((b) => /^next/i.test(b.textContent ?? ''));
}

async function setup(options: {
  providers: unknown[];
  posthogConnected?: boolean;
  github?: boolean;
  repos?: unknown[];
}) {
  const { api } = await import('../lib/api');
  const { useWorkspaceStore } = await import('../stores/workspace');
  vi.mocked(api.cloudProviders.list).mockResolvedValue(options.providers as never);
  vi.mocked(api.posthog.getStatus).mockResolvedValue({ connected: options.posthogConnected ?? false } as never);
  vi.mocked(api.github.getStatus).mockResolvedValue({
    configured: true,
    connected: options.github ?? true,
  } as never);
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    repositories: (options.repos ?? [REPO]) as never,
    cloudProviders: null,
    posthogStatus: null,
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
  vi.clearAllMocks();
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
    expect(screen.queryByText('Connect Claude or ChatGPT to continue.') !== null).toBe(!canAdvance);
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
    expect(screen.queryByText('Connect PostHog Code to continue.') !== null).toBe(!canAdvance);
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
    vi.useFakeTimers();
    try {
      const { api } = await import('../lib/api');
      const { renderHook, act } = await import('@testing-library/react');
      const { useGithubConnection } = await import('../hooks/useGithubConnection');
      const getStatus = vi.mocked(api.github.getStatus);
      getStatus.mockReset();
      getStatus.mockResolvedValueOnce({ configured: true, connected: false } as never);
      getStatus.mockResolvedValue({ configured: true, connected: true } as never);

      const { result } = renderHook(() => useGithubConnection('ws1', { pollMs: 1000 }));
      await act(async () => {});
      expect(result.current.status?.connected).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current.status?.connected).toBe(true);

      const calls = getStatus.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(getStatus.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
