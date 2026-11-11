import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { renderRouter, screen as routerScreen } from 'expo-router/testing-library';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { fixture } from './workflowFixtures';

let mockWorkflow = fixture();
const mockContextSnapshot = { status: 'ready', spaceId: null };
const mockWorkspace = { status: 'ready', choices: [{ id: 'one', name: 'One' }], selected: 'one' };
jest.mock('@talyn/client/native', () => {
const github = {
  getStatus: jest.fn(async () => ({ configured: true, connected: false })),
  getUser: jest.fn(async () => ({ id: 1, login: 'alice', name: null, avatar_url: '' })),
  listInstallations: jest.fn(async () => [{ accountLogin: 'acme', accountType: 'Organization', suspended: false, repositorySelection: 'all' }]),
  listAllRepos: jest.fn(async () => [
    { id: 1, name: 'api', full_name: 'acme/api', private: true, html_url: '', default_branch: 'main', owner: { login: 'acme', avatar_url: '' } },
    { id: 2, name: 'tool', full_name: 'other/tool', private: false, html_url: '', default_branch: 'main', owner: { login: 'other', avatar_url: '' } },
  ]),
  installViaApp: jest.fn(async () => ({ installUrl: 'https://github.com/install', manageUrl: 'https://github.com/manage', state: 's' })),
};
const repositories = {
  add: jest.fn(async (_ws: string, owner: string, repo: string) => ({ id: 'repo-new', workspaceId: 'one', owner, repo,
    fullName: `${owner}/${repo}`, defaultBranch: 'main' })),
  remove: jest.fn(async () => undefined),
  sandboxSize: { get: jest.fn(async () => ({ setting: 'auto', detected: null, effective: 'standard' })), set: jest.fn() },
};

  return { ...jest.requireActual('@talyn/client/native'), github, repositories };
});
const { github: mockGithub, repositories: mockRepositories } = jest.requireMock('@talyn/client/native') as {
  github: Record<string, jest.Mock>; repositories: Record<string, jest.Mock>;
};
jest.mock('../auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ status: 'signedIn', user: { id: 'alice', email: 'alice@example.com' }, issue: null }),
  useNetwork: () => 'online',
  useWorkspace: () => mockWorkspace,
  useMobileRuntime: () => ({ workflow: mockWorkflow.store, lifecycle: mockWorkflow.lifecycle,
    auth: { signIn: jest.fn(), signOut: jest.fn(), cancelSignIn: jest.fn(), restore: jest.fn() },
    workspace: { getSnapshot: () => mockWorkspace, load: jest.fn(), select: jest.fn() },
    context: { getSnapshot: () => mockContextSnapshot, subscribe: () => () => {}, select: jest.fn() } }),
}));
jest.mock('../features/usage/data', () => ({ useBillingStatus: () => ({ status: 'idle', data: undefined, stale: false, refreshing: false }) }));
jest.mock('../features/agents/connect/ConnectAgentSheet', () => ({ ConnectAgentPanel: () => null, ConnectAgentSheet: () => null }));

import RootLayout from '../../app/_layout';
import Index from '../../app';
import DrawerLayout from '../../app/(drawer)/_layout';
import HomeRoute from '../../app/(drawer)/home';
import OnboardingLayout from '../../app/onboarding/_layout';
import OnboardingIndex from '../../app/onboarding';
import GithubStep from '../../app/onboarding/github';
import ReposStep from '../../app/onboarding/repos';
import AgentStep from '../../app/onboarding/agent';
import { onboardingProgress, progressKey } from '../features/onboarding/progress';
import { RepositoriesPanel } from '../features/repositories/RepositoriesScreen';
import { clearRepoCache } from '../features/repositories/data';

const routes = {
  _layout: RootLayout, index: Index, '(drawer)/_layout': DrawerLayout, '(drawer)/home': HomeRoute,
  'onboarding/_layout': OnboardingLayout, 'onboarding/index': OnboardingIndex, 'onboarding/github': GithubStep,
  'onboarding/repos': ReposStep, 'onboarding/agent': AgentStep,
};
const insets = { frame: { x: 0, y: 0, width: 400, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const key = progressKey('alice', 'one');
const githubWorkspace = { id: 'one', name: 'One', settings: {}, repos: [], integrations: { github: { enabled: true, watchedRepos: [] } } };

// The root layout names every app screen. This test mounts only the setup ones.
const warn = console.warn;
beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
  if (!String(args[0]).startsWith('[Layout children]')) warn(...args);
}); });
beforeEach(() => {
  mockWorkflow.store.dispose();
  mockWorkflow = fixture();
  onboardingProgress.finish(key);
  clearRepoCache();
});
afterEach(() => { mockWorkflow.store.dispose(); });

describe('onboarding gate', () => {
  it('sends an account without GitHub from home to the GitHub step', async () => {
    mockWorkflow.api.workspaces.get.mockResolvedValue({ ...githubWorkspace, integrations: {} } as never);
    await renderRouter(routes, { initialUrl: '/home' });
    await waitFor(() => expect(routerScreen).toHavePathname('/onboarding/github'));
    expect(await routerScreen.findByRole('header', { name: 'Connect GitHub' })).toBeVisible();
    expect(routerScreen.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    expect(routerScreen.getByRole('progressbar', { name: 'Step 1 of 3' })).toBeVisible();
    expect(routerScreen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(onboardingProgress.read(key)).toBe(true);
  });

  it('resumes a started setup at the first open step', async () => {
    onboardingProgress.start(key);
    mockWorkflow.api.workspaces.get.mockResolvedValue(githubWorkspace as never);
    mockWorkflow.api.repositories.list.mockResolvedValue([]);
    await renderRouter(routes, { initialUrl: '/home' });
    await waitFor(() => expect(routerScreen).toHavePathname('/onboarding/repos'));
    expect(await routerScreen.findByText('Choose at least one repository for your sessions.')).toBeVisible();
  });

  it('opens home for a returning account and clears a finished setup', async () => {
    onboardingProgress.start(key);
    mockWorkflow.api.workspaces.get.mockResolvedValue(githubWorkspace as never);
    await renderRouter(routes, { initialUrl: '/home' });
    expect(await routerScreen.findByText('What do you want to build?')).toBeVisible();
    expect(routerScreen).toHavePathname('/home');
    await waitFor(() => expect(onboardingProgress.read(key)).toBe(false));
  });

  it('requires an agent connection and says so', async () => {
    onboardingProgress.start(key);
    mockWorkflow.api.workspaces.get.mockResolvedValue(githubWorkspace as never);
    mockWorkflow.api.workbenches.readiness.mockResolvedValue({ sandbox: { ok: true, reasons: [], agents: {
      claude: { ok: false, reason: { code: 'agent_not_connected', message: 'Connect Claude.' } },
      codex: { ok: false, reason: { code: 'agent_not_connected', message: 'Connect Codex.' } } } } });
    await renderRouter(routes, { initialUrl: '/home' });
    await waitFor(() => expect(routerScreen).toHavePathname('/onboarding/agent'));
    expect(await routerScreen.findByLabelText('Claude Code: Connect Claude.')).toBeVisible();
    expect(routerScreen.getByRole('button', { name: 'Start using Talyn' })).toBeDisabled();
    expect(routerScreen.getByText('Connect Claude or ChatGPT to continue.')).toBeVisible();
    expect(routerScreen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
  });

  it('lets a person skip the agent step when the sandbox is unavailable', async () => {
    onboardingProgress.start(key);
    mockWorkflow.api.workspaces.get.mockResolvedValue(githubWorkspace as never);
    mockWorkflow.api.workbenches.readiness.mockResolvedValue({ sandbox: { ok: false,
      reasons: [{ code: 'fleet_disabled', message: 'Paused.' }], agents: {} } } as never);
    await renderRouter(routes, { initialUrl: '/home' });
    await waitFor(() => expect(routerScreen).toHavePathname('/onboarding/agent'));
    await act(async () => { fireEvent.press(await routerScreen.findByRole('button', { name: 'Skip for now' })); });
    await waitFor(() => expect(routerScreen).toHavePathname('/home'));
    expect(onboardingProgress.read(key)).toBe(false);
  });
});

describe('repositories', () => {
  it('adds a repository and the store sees it', async () => {
    const added = { id: 'repo-new', workspaceId: 'one', owner: 'acme', repo: 'api', fullName: 'acme/api', defaultBranch: 'main' };
    mockWorkflow.api.repositories.list.mockResolvedValueOnce([]).mockResolvedValue([added]);
    mockGithub.getStatus.mockResolvedValue({ configured: true, connected: true });
    await render(<SafeAreaProvider initialMetrics={insets}><RepositoriesPanel workspaceId="one" /></SafeAreaProvider>);

    expect(await screen.findByRole('button', { name: 'Add acme/api' })).toBeVisible();
    expect(screen.getByText('Private')).toBeVisible();
    expect(await screen.findByText('App not installed')).toBeVisible();
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Search repositories'), 'ACME'); });
    expect(screen.queryByRole('button', { name: 'Add other/tool' })).toBeNull();

    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Add acme/api' })); });
    expect(mockRepositories.add).toHaveBeenCalledWith('one', 'acme', 'api');
    expect(await screen.findByText('Your repositories')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove acme/api' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add acme/api' })).toBeNull();
    await waitFor(() => expect(mockWorkflow.store.read('repositories').data).toEqual([added]));
  });
});
