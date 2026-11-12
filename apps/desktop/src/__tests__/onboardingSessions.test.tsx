import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { defaultFleetModelForAgent, PLAN_LIMITS, SESSION_STARTER_PROMPTS, type Workbench } from '@talyn/shared';
import { api, loadAllRepos, type CloudProviderInfo, type PRRow } from '../renderer/lib/api';
import { captureAnalyticsException, trackEvent } from '../renderer/lib/analytics';
import { OnboardingWizard } from '../renderer/components/onboarding/OnboardingWizard';
import { SidebarWorkbenchList } from '../renderer/components/layout/SidebarWorkbenchList';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { useNavigationStore } from '../renderer/stores/navigation';
import { usePullRequestStore } from '../renderer/stores/pullRequests';

jest.mock('../renderer/lib/api', () => ({
  loadAllRepos: jest.fn(),
  mergeRepos: jest.fn(),
  ApiError: class ApiError extends Error {},
  ApiNetworkError: class ApiNetworkError extends Error {},
  api: {
    github: {
      getStatus: jest.fn(),
      getUser: jest.fn().mockResolvedValue({ login: 'octocat' }),
      listInstallations: jest.fn().mockResolvedValue([]),
    },
    repositories: { add: jest.fn(), remove: jest.fn().mockResolvedValue(undefined) },
    workspaces: { list: jest.fn().mockResolvedValue([]) },
    cloudProviders: { list: jest.fn() },
    posthog: { getStatus: jest.fn() },
    workbenches: { create: jest.fn() },
    ws: { on: jest.fn().mockReturnValue(() => {}) },
  },
}));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/lib/localWorkbench', () => ({ createLocalWorkbench: jest.fn() }));

const repos = [
  { id: 'r1', workspaceId: 'ws1', owner: 'acme', repo: 'app', fullName: 'acme/app' },
  { id: 'r2', workspaceId: 'ws1', owner: 'acme', repo: 'api', fullName: 'acme/api' },
];
const session: Workbench = {
  id: 'session-1', workspaceId: 'ws1', repositoryId: 'r1', repoFullName: 'acme/app',
  runtime: 'sandbox', agent: 'claude', name: 'First session', branch: 'tom/first', status: 'provisioning',
  baseBranch: 'main', deviceId: null, localPath: null, sandboxId: null, sandboxState: 'creating',
  pullRequestId: null, settings: {}, diffStat: null, archivedAt: null,
  createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z',
};

function fleet(agents: Array<'claude' | 'codex'> = []): CloudProviderInfo[] {
  return [{ type: 'selfhosted', displayName: 'Talyn Fleet', connected: agents.length > 0, connectedAgents: agents }];
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  jest.mocked(api.github.getStatus).mockResolvedValue({ configured: true, connected: true } as never);
  jest.mocked(loadAllRepos).mockResolvedValue([
    { id: 1, owner: { login: 'acme' }, name: 'app', full_name: 'acme/app' },
    { id: 3, owner: { login: 'acme' }, name: 'unwatched', full_name: 'acme/unwatched' },
  ] as never);
  jest.mocked(api.repositories.add).mockResolvedValue(repos[0] as never);
  jest.mocked(api.cloudProviders.list).mockResolvedValue(fleet());
  jest.mocked(api.posthog.getStatus).mockResolvedValue({ connected: false } as never);
  jest.mocked(api.workbenches.create).mockResolvedValue(session);
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1', repositories: [], workspaces: [],
    cloudProviders: null, posthogStatus: null, onboardingComplete: false, justOnboarded: false,
  });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', []);
  useWorkbenchStore.setState({ newWorkbench: { seq: 0, prefill: null } });
  useNavigationStore.getState().navigate({ view: 'history' });
});

afterEach(cleanup);

const next = () => screen.getByRole('button', { name: 'Next' });

async function toRepos() {
  render(<OnboardingWizard />);
  await waitFor(() => expect(next()).toBeEnabled());
  fireEvent.click(next());
  await screen.findByRole('heading', { name: 'Choose where your agent will work.' });
}

async function toAgent() {
  useWorkspaceStore.setState({ repositories: repos });
  await toRepos();
  fireEvent.click(next());
  await waitFor(() => expect(api.cloudProviders.list).toHaveBeenCalledWith('ws1'));
  await waitFor(() => expect(useWorkspaceStore.getState().cloudProviders).not.toBeNull());
}

async function toSession(agent: 'claude' | 'codex' = 'claude') {
  jest.mocked(api.cloudProviders.list).mockResolvedValue(fleet([agent]));
  await toAgent();
  await waitFor(() => expect(next()).toBeEnabled());
  fireEvent.click(next());
  expect(screen.getByRole('heading', { name: 'Start your first session' })).toBeInTheDocument();
}

function enterPrompt() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Session prompt' }), { target: { value: 'Fix the private issue' } });
}

it('requires a watched repository and blocks Next again after removal', async () => {
  await toRepos();
  expect(next()).toBeDisabled();
  fireEvent.click(await screen.findByRole('button', { name: /acme\/app/ }));
  await waitFor(() => expect(next()).toBeEnabled());
  expect(api.repositories.add).toHaveBeenCalledWith('ws1', 'acme', 'app');
  act(() => useWorkspaceStore.setState({ repositories: [] }));
  expect(next()).toBeDisabled();
});

it.each(['claude', 'codex', 'posthog_code'] as const)('requires an agent and accepts %s from the store', async (vendor) => {
  if (vendor === 'posthog_code') jest.mocked(api.cloudProviders.list).mockResolvedValue([]);
  await toAgent();
  expect(next()).toBeDisabled();
  expect(trackEvent).not.toHaveBeenCalledWith('onboarding_agent_connected', expect.anything());
  fireEvent.click(next());
  expect(screen.queryByRole('textbox', { name: 'Session prompt' })).not.toBeInTheDocument();
  if (vendor === 'posthog_code') {
    expect(screen.queryByRole('button', { name: /^Claude/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Codex/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /PostHog Code/ })).toBeInTheDocument();
    act(() => useWorkspaceStore.setState({ posthogStatus: { connected: true } as never }));
  } else {
    act(() => useWorkspaceStore.setState({ cloudProviders: fleet([vendor]) }));
  }
  expect(next()).toBeEnabled();
  expect(trackEvent).toHaveBeenCalledWith('onboarding_agent_connected', { vendor });
  fireEvent.click(next());
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await waitFor(() => expect(api.cloudProviders.list).toHaveBeenCalledTimes(2));
  expect(jest.mocked(trackEvent).mock.calls.filter(([event]) => event === 'onboarding_agent_connected')).toHaveLength(1);
});

it('does not accept an aggregate provider connection without a connected agent', async () => {
  jest.mocked(api.cloudProviders.list).mockResolvedValue([
    { type: 'selfhosted', displayName: 'Talyn Fleet', connected: true, connectedAgents: [] },
  ]);
  await toAgent();
  expect(next()).toBeDisabled();
});

it('requires a prompt and a repository that is still watched', async () => {
  await toSession();
  fireEvent.change(screen.getByRole('textbox', { name: 'Session prompt' }), { target: { value: '  \n ' } });
  expect(screen.getByRole('button', { name: 'Start session' })).toBeDisabled();
  enterPrompt();
  act(() => useWorkspaceStore.setState({ repositories: [] }));
  const start = screen.getByRole('button', { name: 'Start session' });
  expect(start).toBeDisabled();
  fireEvent.click(start);
  expect(api.workbenches.create).not.toHaveBeenCalled();
});

it('offers only the subscription cards, in order, where the fleet is offered', async () => {
  await toAgent();
  expect(screen.getByText('Use your Claude or ChatGPT subscription')).toBeInTheDocument();
  const choices = screen.getAllByRole('button').filter((button) => /^(Claude|Codex|PostHog Code)/.test(button.textContent ?? ''));
  expect(choices.map((button) => button.textContent?.split('Use')[0])).toEqual(['Claude', 'Codex']);
  expect(screen.queryByRole('heading', { name: 'Other options' })).not.toBeInTheDocument();
  expect(screen.getByText('Connect Claude or ChatGPT to continue.')).toBeInTheDocument();
});

it.each(['claude', 'codex'] as const)('creates and opens a real session through the API with %s', async (agent) => {
  await toSession(agent);
  const prompt = screen.getByRole('textbox', { name: 'Session prompt' });
  expect(prompt).toHaveValue('');
  expect(prompt).not.toHaveAttribute('placeholder');
  expect(screen.getByRole('button', { name: 'Start session' })).toBeDisabled();
  expect(screen.getByText(`Free includes ${PLAN_LIMITS.free.includedBoxHours} box-hours a month.`)).toBeInTheDocument();
  expect(screen.getByText('The first start can take a little longer while your sandbox image is prepared.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Repository' }));
  expect(screen.queryByRole('option', { name: /unwatched/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('option', { name: 'acme/api' }));
  enterPrompt();
  fireEvent.click(screen.getByRole('button', { name: 'Reddit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
  await waitFor(() => expect(useWorkspaceStore.getState().onboardingComplete).toBe(true));
  expect(api.workbenches.create).toHaveBeenCalledTimes(1);
  expect(api.workbenches.create).toHaveBeenCalledWith(expect.objectContaining({
    workspaceId: 'ws1', repositoryId: 'r2', runtime: 'sandbox', agent,
    model: defaultFleetModelForAgent(agent), prompt: 'Fix the private issue',
  }));
  expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: session.id });
  expect(useWorkbenchStore.getState().workbenches[session.id]).toEqual(session);
  expect(useWorkspaceStore.getState().justOnboarded).toBe(true);
  expect(trackEvent).toHaveBeenCalledWith('first_session_created', { from: 'onboarding' });
  expect(trackEvent).toHaveBeenCalledWith('onboarding_completed', {
    github_connected: true, repos_watched: 2, agent_connected: true, signup_source: 'reddit',
  });
  for (const step of ['github', 'repos', 'agent', 'first_session']) {
    expect(trackEvent).toHaveBeenCalledWith('onboarding_step_viewed', { step });
    expect(trackEvent).toHaveBeenCalledWith('onboarding_step_completed', { step });
  }
  expect(JSON.stringify(jest.mocked(trackEvent).mock.calls)).not.toContain('Fix the private issue');
  expect(screen.queryByText(/code review/i)).not.toBeInTheDocument();
});

it('keeps onboarding open after failure and lets the user retry', async () => {
  jest.mocked(api.workbenches.create).mockRejectedValueOnce(new Error('Could not start this session.'));
  await toSession();
  enterPrompt();
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not start this session.');
  expect(captureAnalyticsException).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({ operation: 'create_session' }),
  );
  expect(useWorkspaceStore.getState().onboardingComplete).toBe(false);
  expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
  expect(trackEvent).not.toHaveBeenCalledWith('first_session_created', expect.anything());
  expect(screen.getByRole('textbox', { name: 'Session prompt' })).toHaveValue('Fix the private issue');
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
  await waitFor(() => expect(useWorkspaceStore.getState().onboardingComplete).toBe(true));
});

it('blocks duplicate starts, Back, and Skip while creation is pending', async () => {
  let resolve: (workbench: Workbench) => void = () => {};
  jest.mocked(api.workbenches.create).mockReturnValue(new Promise((done) => { resolve = done; }));
  await toSession();
  enterPrompt();
  fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
  const starting = screen.getByRole('button', { name: 'Starting session…' });
  expect(starting).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Skip for now' })).toBeDisabled();
  fireEvent.click(starting);
  expect(api.workbenches.create).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Hacker News' }));
  await act(async () => resolve(session));
  expect(trackEvent).toHaveBeenCalledWith('onboarding_completed', expect.objectContaining({ signup_source: 'hacker_news' }));
});

it('skips the first session, completes onboarding, and opens Home', async () => {
  await toSession();
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
  expect(api.workbenches.create).not.toHaveBeenCalled();
  expect(useWorkspaceStore.getState().onboardingComplete).toBe(true);
  expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  expect(trackEvent).toHaveBeenCalledWith('onboarding_first_session_skipped');
  expect(trackEvent).toHaveBeenCalledWith('onboarding_completed', {
    github_connected: true, repos_watched: 2, agent_connected: true, signup_source: null,
  });
});

it('opens the normal new-session UI from the sidebar empty state', () => {
  usePullRequestStore.setState({ rows: [] });
  render(<SidebarWorkbenchList workbenches={[]} />);
  expect(screen.getByText('Hand work to an agent')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start a session' }));
  expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  expect(useWorkbenchStore.getState().newWorkbench).toEqual({ seq: 1, prefill: null });
});

it('offers general starters when no pull request needs work', () => {
  usePullRequestStore.setState({ rows: [] });
  render(<SidebarWorkbenchList workbenches={[]} />);
  fireEvent.click(screen.getByRole('button', { name: /Explain a repository/ }));
  expect(useWorkbenchStore.getState().newWorkbench.prefill).toEqual({ prompt: SESSION_STARTER_PROMPTS.explain });
  expect(trackEvent).toHaveBeenCalledWith('session_starter_clicked', { kind: 'explain', from_pull_request: false });
});

it('starts a session on a pull request with failing checks from the sidebar', () => {
  const row = {
    id: 'pr-1', workspaceId: 'ws1', repositoryId: 'r1', owner: 'acme', repo: 'app', number: 42, state: 'open',
    authored: true, reviewRequested: false,
    summary: { title: 'Add billing', headBranch: 'tom/billing', baseBranch: 'main', blockingReason: 'checks_failed' },
  } as unknown as PRRow;
  usePullRequestStore.setState({ rows: [row] });
  render(<SidebarWorkbenchList workbenches={[]} />);
  expect(screen.getByText('#42 Add billing')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Fix the failing checks/ }));
  expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  expect(useWorkbenchStore.getState().newWorkbench.prefill).toEqual({
    repositoryId: 'r1', fromPullRequestId: 'pr-1', baseBranch: 'main', branch: 'tom/billing',
    prompt: SESSION_STARTER_PROMPTS.fix_checks,
  });
});
