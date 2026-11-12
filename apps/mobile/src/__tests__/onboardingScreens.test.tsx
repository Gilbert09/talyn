import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { renderRouter, screen as routerScreen } from 'expo-router/testing-library';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { fixture } from './workflowFixtures';

let mockWorkflow = fixture();
const mockContextSnapshot = { status: 'ready', spaceId: null };
const mockWorkspace = { status: 'ready', choices: [{ id: 'one', name: 'One' }], selected: 'one' };
type MockPushState = 'disabled' | 'loading' | 'ready' | 'denied' | 'unavailable' | 'failed';
const mockPreferences = { schemaVersion: 1, workspaceId: 'one', enabled: false,
  categories: { session_update: true, pr_review: true, ci_failure: true, merge_ready: true, human_gate: true },
  quietHours: { enabled: false, start: '22:00', end: '08:00' }, timezone: 'UTC', sensitivePreview: false };
const mockNotifications = {
  snapshot: { state: 'disabled' as MockPushState, preferences: mockPreferences as typeof mockPreferences | null, providerAvailable: true, tapIssue: null },
  listeners: new Set<() => void>(),
  set(state: MockPushState) { this.snapshot = { ...this.snapshot, state }; this.listeners.forEach((listener) => listener()); },
  getSnapshot: () => mockNotifications.snapshot,
  subscribe: (listener: () => void) => { mockNotifications.listeners.add(listener); return () => { mockNotifications.listeners.delete(listener); }; },
  enableDevice: jest.fn(async () => { mockNotifications.set('ready'); }),
  refresh: jest.fn(async () => {}),
  setNavigation: jest.fn(), retryTap: jest.fn(), clearTapIssue: jest.fn(),
};
jest.mock('@talyn/client/native', () => {
const github = {
  getStatus: jest.fn(async () => ({ configured: true, connected: false })),
  getUser: jest.fn(async () => ({ id: 1, login: 'alice', name: null, avatar_url: '' })),
  listInstallations: jest.fn(async () => [{ accountLogin: 'acme', accountType: 'Organization', suspended: false, repositorySelection: 'all' }]),
  installViaApp: jest.fn(async () => ({ installUrl: 'https://github.com/install', manageUrl: 'https://github.com/manage', state: 's' })),
};
const repositories = {
  add: jest.fn(async (_ws: string, owner: string, repo: string) => ({ id: 'repo-new', workspaceId: 'one', owner, repo,
    fullName: `${owner}/${repo}`, defaultBranch: 'main' })),
  remove: jest.fn(async () => undefined),
  sandboxSize: { get: jest.fn(async () => ({ setting: 'auto', detected: null, effective: 'standard' })), set: jest.fn() },
};

const loadAllRepos = jest.fn(async () => [
  { id: 1, name: 'api', full_name: 'acme/api', private: true, html_url: '', default_branch: 'main', owner: { login: 'acme', avatar_url: '' } },
  { id: 2, name: 'tool', full_name: 'other/tool', private: false, html_url: '', default_branch: 'main', owner: { login: 'other', avatar_url: '' } },
]);

  return { ...jest.requireActual('@talyn/client/native'), github, repositories, loadAllRepos };
});
const { github: mockGithub, repositories: mockRepositories } = jest.requireMock('@talyn/client/native') as {
  github: Record<string, jest.Mock>; repositories: Record<string, jest.Mock>;
};
jest.mock('../auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => ({ status: 'signedIn', user: { id: 'alice', email: 'alice@example.com' }, issue: null }),
  useNetwork: () => 'online',
  useWorkspace: () => mockWorkspace,
  useMobileRuntime: () => ({ workflow: mockWorkflow.store, lifecycle: mockWorkflow.lifecycle, notifications: mockNotifications,
    auth: { signIn: jest.fn(), signOut: jest.fn(), cancelSignIn: jest.fn(), restore: jest.fn() },
    workspace: { getSnapshot: () => mockWorkspace, load: jest.fn(), select: jest.fn() },
    context: { getSnapshot: () => mockContextSnapshot, subscribe: () => () => {}, select: jest.fn() } }),
}));
jest.mock('../lib/analytics', () => ({ ...jest.requireActual('../lib/analytics'), trackEvent: jest.fn() }));
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
import NotificationsStep from '../../app/onboarding/notifications';
import { trackEvent } from '../lib/analytics';
import { onboardingProgress, progressKey } from '../features/onboarding/progress';
import { RepositoriesPanel } from '../features/repositories/RepositoriesScreen';
import { clearRepoCache } from '../features/repositories/data';

const routes = {
  _layout: RootLayout, index: Index, '(drawer)/_layout': DrawerLayout, '(drawer)/home': HomeRoute,
  'onboarding/_layout': OnboardingLayout, 'onboarding/index': OnboardingIndex, 'onboarding/github': GithubStep,
  'onboarding/repos': ReposStep, 'onboarding/agent': AgentStep, 'onboarding/notifications': NotificationsStep,
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
  mockNotifications.snapshot = { state: 'disabled', preferences: mockPreferences, providerAvailable: true, tapIssue: null };
  mockNotifications.enableDevice.mockClear();
  mockNotifications.refresh.mockClear();
  jest.mocked(trackEvent).mockClear();
});
afterEach(() => { mockWorkflow.store.dispose(); });

describe('onboarding gate', () => {
  it('sends an account without GitHub from home to the GitHub step', async () => {
    mockWorkflow.api.workspaces.get.mockResolvedValue({ ...githubWorkspace, integrations: {} } as never);
    await renderRouter(routes, { initialUrl: '/home' });
    await waitFor(() => expect(routerScreen).toHavePathname('/onboarding/github'));
    expect(await routerScreen.findByRole('header', { name: 'Connect GitHub' })).toBeVisible();
    expect(routerScreen.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    expect(routerScreen.getByRole('progressbar', { name: 'Step 1 of 4' })).toBeVisible();
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
    expect(routerScreen.getByRole('button', { name: 'Next' })).toBeDisabled();
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
    await waitFor(() => expect(routerScreen).toHavePathname('/onboarding/notifications'));
    await act(async () => { fireEvent.press(await routerScreen.findByRole('button', { name: 'Skip for now' })); });
    await waitFor(() => expect(routerScreen).toHavePathname('/home'));
    expect(onboardingProgress.read(key)).toBe(false);
    expect(trackEvent).not.toHaveBeenCalledWith('onboarding_completed', expect.anything());
  });
});

describe('notifications step', () => {
  const agentReadiness = { sandbox: { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: false } } } };
  async function openStep() {
    onboardingProgress.start(key);
    mockWorkflow.api.workspaces.get.mockResolvedValue(githubWorkspace as never);
    mockWorkflow.api.workbenches.readiness.mockResolvedValue(agentReadiness as never);
    await renderRouter(routes, { initialUrl: '/onboarding/notifications' });
    expect(await routerScreen.findByRole('header', { name: 'Turn on notifications' })).toBeVisible();
  }

  it('opens after the agent step', async () => {
    onboardingProgress.start(key);
    mockWorkflow.api.workspaces.get.mockResolvedValue(githubWorkspace as never);
    mockWorkflow.api.workbenches.readiness.mockResolvedValue(agentReadiness as never);
    await renderRouter(routes, { initialUrl: '/onboarding/agent' });
    await act(async () => { fireEvent.press(await routerScreen.findByRole('button', { name: 'Next' })); });
    await waitFor(() => expect(routerScreen).toHavePathname('/onboarding/notifications'));
    expect(routerScreen.getByRole('progressbar', { name: 'Step 4 of 4' })).toBeVisible();
    expect(trackEvent).toHaveBeenCalledWith('onboarding_step_completed', { step: 'agent' });
  });

  it('asks for permission only when the person taps, then finishes', async () => {
    await openStep();
    expect(routerScreen.getByText('A session needs your input')).toBeVisible();
    expect(mockNotifications.enableDevice).not.toHaveBeenCalled();
    await act(async () => { fireEvent.press(routerScreen.getByRole('button', { name: 'Turn on notifications' })); });
    expect(mockNotifications.enableDevice).toHaveBeenCalledTimes(1);
    expect(await routerScreen.findByText('Notifications are on for this device.')).toBeVisible();
    expect(routerScreen.queryByRole('button', { name: 'Skip for now' })).toBeNull();
    await act(async () => { fireEvent.press(routerScreen.getByRole('button', { name: 'Start using Talyn' })); });
    await waitFor(() => expect(routerScreen).toHavePathname('/home'));
    expect(onboardingProgress.read(key)).toBe(false);
    expect(trackEvent).toHaveBeenCalledWith('onboarding_step_completed', { step: 'notifications' });
    expect(trackEvent).toHaveBeenCalledWith('onboarding_completed', expect.objectContaining({ agent_connected: true, notifications_enabled: true }));
  });

  it('lets the person skip without a permission request', async () => {
    await openStep();
    await act(async () => { fireEvent.press(routerScreen.getByRole('button', { name: 'Skip for now' })); });
    await waitFor(() => expect(routerScreen).toHavePathname('/home'));
    expect(mockNotifications.enableDevice).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalledWith('onboarding_step_completed', { step: 'notifications' });
    expect(trackEvent).toHaveBeenCalledWith('onboarding_completed', expect.objectContaining({ notifications_enabled: false }));
  });

  it.each([
    ['denied', /permission is denied/, 'Open device notification settings'],
    ['unavailable', /not available on this device/, null],
  ] as const)('lets the person finish when permission is %s', async (state, message, extra) => {
    mockNotifications.snapshot = { ...mockNotifications.snapshot, state };
    await openStep();
    expect(routerScreen.getByRole('alert', { name: message })).toBeVisible();
    if (extra) expect(routerScreen.getByRole('button', { name: extra })).toBeVisible();
    expect(routerScreen.queryByRole('button', { name: 'Turn on notifications' })).toBeNull();
    expect(routerScreen.getByRole('button', { name: 'Start using Talyn' })).toBeEnabled();
  });

  it('retries after a failure', async () => {
    mockNotifications.snapshot = { ...mockNotifications.snapshot, state: 'failed' };
    await openStep();
    expect(routerScreen.getByRole('alert', { name: /could not be turned on/ })).toBeVisible();
    await act(async () => { fireEvent.press(routerScreen.getByRole('button', { name: 'Turn on notifications' })); });
    expect(mockNotifications.enableDevice).toHaveBeenCalledTimes(1);
  });

  it('loads missing settings before it asks', async () => {
    mockNotifications.snapshot = { ...mockNotifications.snapshot, preferences: null };
    await openStep();
    expect(mockNotifications.refresh).toHaveBeenCalled();
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
