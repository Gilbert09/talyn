import { act, fireEvent, renderRouter, screen, testRouter } from 'expo-router/testing-library';

import { router } from 'expo-router';
import { Alert, BackHandler } from 'react-native';
import { chat, fixture, session, thread } from './workflowFixtures';
import { clearIntent, rememberIntent } from '../navigation/intents';

let mockWorkflow = fixture();

import type { AuthSnapshot } from '../auth/controller';
import RootLayout from '../../app/_layout';
import Index from '../../app';
import NotFoundScreen from '../../app/+not-found';
import DrawerLayout from '../../app/(drawer)/_layout';
import AttentionList from '../../app/(drawer)/attention';
import HomeScreen from '../../app/(drawer)/home';
import SessionsList from '../../app/(drawer)/sessions';
import ThreadsList from '../../app/(drawer)/threads';
import PullsScreen from '../../app/pulls';
import SettingsScreen from '../../app/settings';
import PullRequestScreen from '../../app/attention/[id]';
import SessionScreen from '../../app/sessions/[id]';
import ThreadScreen from '../../app/threads/[id]';

import SignInScreen from '../../app/(auth)/sign-in';
import AuthLayout from '../../app/(auth)/_layout';
import CallbackScreen from '../../app/auth/callback';
import WorkspacesScreen from '../../app/workspaces';

let mockAuth: AuthSnapshot = { status: 'signedIn', user: { id: 'alice', email: 'alice@example.com' }, issue: null };
let mockNetwork = 'online';
const mockSignIn = jest.fn();
const mockSignOut = jest.fn();
const mockDelete = jest.fn(async () => 'blocked');
const mockWorkspace: { status: string; choices: { id: string; name: string }[]; selected: string | null } = {
  status: 'ready', choices: [{ id: 'one', name: 'One' }], selected: 'one',
};
const mockSelectWorkspace = jest.fn(async (id: string) => { mockWorkspace.selected = id; });
const mockContext = { getSnapshot: () => mockContextSnapshot, subscribe: () => () => {}, select: jest.fn(async () => {}) };
const mockContextSnapshot = { status: 'ready' as const, spaceId: null };
jest.mock('../auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mockAuth,
  useNetwork: () => mockNetwork,
  useWorkspace: () => mockWorkspace,
  useMobileRuntime: () => ({
    workflow: mockWorkflow.store, lifecycle: mockWorkflow.lifecycle,
    auth: { signIn: mockSignIn, signOut: mockSignOut, cancelSignIn: jest.fn(), restore: jest.fn() },
    account: { deleteAccount: mockDelete }, workspace: { getSnapshot: () => mockWorkspace, load: jest.fn(), select: mockSelectWorkspace },
    context: mockContext,
  }),
}));
jest.mock('../features/usage/data', () => ({ useBillingStatus: () => ({ status: 'idle', data: undefined, stale: false, refreshing: false }) }));
beforeEach(() => {
  clearIntent();
  mockWorkflow.store.dispose(); mockWorkflow = fixture();
  mockAuth = { status: 'signedIn', user: { id: 'alice', email: 'alice@example.com' }, issue: null };
  mockNetwork = 'online';
  mockWorkspace.selected = 'one';
});

afterEach(() => { mockWorkflow.store.dispose(); });

const routes = {
  _layout: RootLayout,
  '(auth)/_layout': AuthLayout,
  '(auth)/sign-in': SignInScreen,
  'auth/callback': CallbackScreen,
  workspaces: WorkspacesScreen,
  index: Index,
  '+not-found': NotFoundScreen,
  '(drawer)/_layout': DrawerLayout,
  '(drawer)/home': HomeScreen,
  '(drawer)/sessions': SessionsList,
  '(drawer)/threads': ThreadsList,
  '(drawer)/attention': AttentionList,
  'pulls/index': PullsScreen,
  settings: SettingsScreen,
  'sessions/[id]': SessionScreen,
  'threads/[id]': ThreadScreen,
  'attention/[id]': PullRequestScreen,
};

describe('native shell', () => {
  it('opens home at startup', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    expect(screen).toHavePathname('/home');
    expect(await screen.findByText('What do you want to build?')).toBeVisible();
    expect(screen.getByRole('header', { name: 'One' })).toBeVisible();
    expect(screen.queryByTestId('navigation-drawer')).toBeNull();
  });

  it('goes home from an unknown route', async () => {
    await renderRouter(routes, { initialUrl: '/missing' });
    expect(screen.getByRole('header', { name: 'Page unavailable' })).toBeVisible();
    await fireEvent.press(screen.getByRole('link', { name: 'Go home' }));
    expect(screen).toHavePathname('/home');
  });

  it.each([
    ['/sessions', 'Current work', '/sessions/session-one'],
    ['/threads', 'Planning work', '/threads/thread-one'],
  ])('opens the drawer for the old list link %s and its rows open details', async (url, label, destination) => {
    await renderRouter(routes, { initialUrl: url });
    expect(screen).toHavePathname('/home');
    expect(await screen.findByTestId('navigation-drawer')).toBeVisible();
    await fireEvent.press(await screen.findByRole('link', { name: new RegExp(label) }));
    expect(screen).toHavePathname(destination);
    expect(await screen.findByRole('header', { name: label })).toBeVisible();
    // Leaving home closed the drawer, so Back shows home itself.
    await testRouter.back('/home');
    expect(screen.queryByTestId('navigation-drawer')).toBeNull();
  });

  it('sends the old Attention link to My PRs', async () => {
    await renderRouter(routes, { initialUrl: '/attention' });
    expect(screen).toHavePathname('/pulls');
    expect(screen).toHaveSearchParams({ tab: 'mine' });
  });

  it('opens the drawer from the menu button and reaches every app page', async () => {
    await renderRouter(routes, { initialUrl: '/home' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByTestId('navigation-drawer');
    expect(drawer).toBeVisible();
    expect(screen.getByRole('button', { name: 'Workspace: One' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New session', selected: true })).toBeVisible();
    for (const name of ['Threads', 'Sessions']) expect(screen.getByRole('header', { name })).toBeVisible();
    expect(screen.getByRole('button', { name: 'example/project', expanded: true })).toBeVisible();
    for (const name of ['Pull requests', 'Merge queue', 'Insights', 'Agents', 'History']) expect(screen.getByRole('button', { name })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: /^Review requests/ }));
    expect(screen).toHavePathname('/pulls');
    expect(screen).toHaveSearchParams({ tab: 'reviews' });
    await testRouter.back('/home');
    await fireEvent.press(await screen.findByRole('button', { name: 'Open menu' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
    expect(screen).toHavePathname('/settings');
    expect(await screen.findByRole('header', { name: 'Settings' })).toBeVisible();
  });

  it('closes the open drawer with Android back, and back from a page returns home', async () => {
    // Hardware back runs the newest listener first, until one handles it.
    type Handler = Parameters<typeof BackHandler.addEventListener>[1];
    const handlers: Handler[] = [];
    const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_name, handler) => {
      handlers.push(handler);
      return { remove: () => { const at = handlers.lastIndexOf(handler); if (at >= 0) handlers.splice(at, 1); } };
    });
    const pressBack = () => [...handlers].reverse().some((handler) => (handler as () => boolean | null | undefined)() === true);
    await renderRouter(routes, { initialUrl: '/home' });
    await fireEvent.press(await screen.findByRole('button', { name: 'Open menu' }));
    expect(screen.getByTestId('navigation-drawer')).toBeVisible();
    await act(async () => { expect(pressBack()).toBe(true); });
    expect(screen.queryByTestId('navigation-drawer')).toBeNull();
    expect(screen).toHavePathname('/home');
    await fireEvent.press(screen.getByRole('button', { name: 'Open menu' }));
    await fireEvent.press(screen.getByRole('button', { name: /^Merge queue/ }));
    expect(screen).toHaveSearchParams({ tab: 'queue' });
    await act(async () => { expect(pressBack()).toBe(true); });
    expect(screen).toHavePathname('/home');
    expect(screen.queryByTestId('navigation-drawer')).toBeNull();
    // Home with the drawer closed has nothing to go back to, so the app may exit.
    await act(async () => { expect(pressBack()).toBe(false); });
    spy.mockRestore();
  });

  it('searches the drawer lists and clears the search', async () => {
    await renderRouter(routes, { initialUrl: '/sessions' });
    expect(await screen.findByRole('link', { name: /Current work/ })).toBeVisible();
    await fireEvent.changeText(screen.getByLabelText('Search sessions and threads'), 'planning');
    expect(screen.queryByRole('link', { name: /Current work/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Planning work/ })).toBeVisible();
    await fireEvent.changeText(screen.getByLabelText('Search sessions and threads'), 'nothing like this');
    expect(screen.getByText('No sessions or threads match.')).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('link', { name: /Current work/ })).toBeVisible();
  });

  it('collapses a repository group and a thread', async () => {
    mockWorkflow.api.workbenches.list.mockImplementation(async () => [
      session(), session({ id: 'child-one', title: 'Child work', threadId: 'thread-one' }), thread()]);
    await renderRouter(routes, { initialUrl: '/sessions' });
    // Under its thread and under its repository, like web.
    expect(await screen.findAllByRole('link', { name: /Child work/ })).toHaveLength(2);
    await fireEvent.press(screen.getByRole('button', { name: 'Hide sessions of Planning work' }));
    expect(screen.getAllByRole('link', { name: /Child work/ })).toHaveLength(1);
    await fireEvent.press(screen.getByRole('button', { name: 'example/project' }));
    expect(screen.queryByRole('link', { name: /Current work/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'example/project', expanded: false })).toBeVisible();
  });

  it('marks the menu and lists work that needs the person', async () => {
    mockWorkflow.api.workbenches.list.mockImplementation(async () => [
      session({ chats: [chat({ status: 'awaiting_input' })] }), thread()]);
    await renderRouter(routes, { initialUrl: '/home' });
    expect(await screen.findByTestId('menu-attention-dot')).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('header', { name: 'Needs you' })).toBeVisible();
    expect(screen.getAllByRole('link', { name: /Current work/ })).toHaveLength(2);
  });

  it('restores a cold session link after authentication', async () => {
    rememberIntent('/sessions/session-one');
    mockAuth = { status: 'signedOut', user: null, issue: null };
    await renderRouter(routes, { initialUrl: '/sessions/session-one' });
    expect(screen.getByRole('header', { name: 'Talyn' })).toBeVisible();
    mockAuth = { status: 'signedIn', user: { id: 'alice' }, issue: null };
    await act(async () => router.replace('/'));
    expect(await screen.findByRole('header', { name: 'Current work' })).toBeVisible();
    expect(screen).toHavePathname('/sessions/session-one');
  });

  it('fetches current authorized state for a warm pull request link', async () => {
    await renderRouter(routes, { initialUrl: '/home' });
    await act(async () => router.push('/attention/pr-one'));
    expect(await screen.findByRole('header', { name: 'Review current work' })).toBeVisible();
    expect(mockWorkflow.api.pullRequests.get).toHaveBeenCalledWith('pr-one');
  });

  it('waits for workspace selection before it fetches a pending detail', async () => {
    mockWorkspace.selected = null;
    await renderRouter(routes, { initialUrl: '/sessions/session-one' });
    expect(screen.getByRole('header', { name: 'Choose a workspace' })).toBeVisible();
    expect(mockWorkflow.api.workbenches.get).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Select workspace One', selected: false })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Select workspace One' }));
    expect(await screen.findByRole('header', { name: 'Current work' })).toBeVisible();
    expect(screen).toHavePathname('/sessions/session-one');
  });

  it('shows account details and accessible account actions', async () => {
    await renderRouter(routes, { initialUrl: '/settings' });
    expect(screen.getByRole('header', { name: 'Settings' })).toBeVisible();
    expect(screen.getByText('alice@example.com')).toBeVisible();
    expect(screen.queryByText('Account ID: alice')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Show account ID' }));
    expect(screen.getByText('Account ID: alice')).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Hide account ID' }));
    expect(screen.queryByText('Account ID: alice')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['/sessions/linked-session', 'Current work'],
    ['/threads/linked-thread', 'Planning work'],
    ['/attention/linked-pr', 'Review current work'],
  ])('opens the detail URL %s', async (url, label) => {
    await renderRouter(routes, { initialUrl: url });
    expect(screen).toHavePathname(url);
    expect(await screen.findByRole('header', { name: label })).toBeVisible();
  });
});

describe('auth route gates and accessible states', () => {
  it('gates private deep links while signed out', async () => {
    mockAuth = { status: 'signedOut', user: null, issue: null };
    await renderRouter(routes, { initialUrl: '/settings' });
    expect(screen.getByRole('header', { name: 'Talyn' })).toBeVisible();
    expect(screen.queryByText('alice@example.com')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    expect(mockSignIn).toHaveBeenCalledTimes(1);
  });
  it('gates the shell until restoration finishes', async () => {
    mockAuth = { status: 'restoring', user: null, issue: null };
    await renderRouter(routes, { initialUrl: '/home' });
    expect(screen.getByRole('progressbar', { name: 'Restoring sign-in' })).toBeVisible();
    expect(screen.queryByText('What do you want to build?')).toBeNull();
  });
  it('shows offline and retry states without exposing diagnostic errors', async () => {
    mockAuth = { status: 'signedOut', user: null, issue: 'failed' }; mockNetwork = 'offline';
    await renderRouter(routes, { initialUrl: '/sign-in' });
    expect(screen.getByRole('button', { name: 'Try GitHub sign-in again' })).toBeDisabled();
    expect(screen.getByText('You are offline. Connect to the internet, then try again.')).toBeVisible();
  });
  it('announces loading and permits cancellation', async () => {
    mockAuth = { status: 'signingIn', user: null, issue: null };
    await renderRouter(routes, { initialUrl: '/sign-in' });
    expect(screen.getByRole('alert', { name: 'Waiting for GitHub sign-in' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Opening browser…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel sign-in' })).toBeVisible();
  });
  it('uses a native destructive confirmation with Cancel preferred', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await renderRouter(routes, { initialUrl: '/settings' });
    await fireEvent.press(screen.getByRole('button', { name: 'Delete Talyn account' }));
    const buttons = alert.mock.calls[0][2]!;
    expect(buttons[0]).toMatchObject({ text: 'Cancel', style: 'cancel', isPreferred: true });
    expect(buttons[1]).toMatchObject({ text: 'Delete account', style: 'destructive' });
    expect(mockDelete).not.toHaveBeenCalled();
    await act(async () => { buttons[1].onPress?.(); });
    expect(screen.getByText(/Deletion is blocked because you are the last administrator/)).toBeVisible();
    alert.mockRestore();
  });
});
