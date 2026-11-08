import { act, fireEvent, renderRouter, screen, testRouter } from 'expo-router/testing-library';

import { router } from 'expo-router';
import { Alert } from 'react-native';
import { fixture } from './workflowFixtures';
import { clearIntent, rememberIntent } from '../navigation/intents';

let mockWorkflow = fixture();

import type { AuthSnapshot } from '../auth/controller';
import RootLayout from '../../app/_layout';
import Index from '../../app';
import NotFoundScreen from '../../app/+not-found';
import TabsLayout from '../../app/(tabs)/_layout';
import AttentionLayout from '../../app/(tabs)/attention/_layout';
import SessionsLayout from '../../app/(tabs)/sessions/_layout';
import SettingsLayout from '../../app/(tabs)/settings/_layout';
import ThreadsLayout from '../../app/(tabs)/threads/_layout';
import AttentionScreen from '../../app/(tabs)/attention';
import PullRequestScreen from '../../app/(tabs)/attention/[id]';
import SessionsScreen from '../../app/(tabs)/sessions';
import SessionScreen from '../../app/(tabs)/sessions/[id]';
import SettingsScreen from '../../app/(tabs)/settings';
import ThreadsScreen from '../../app/(tabs)/threads';
import ThreadScreen from '../../app/(tabs)/threads/[id]';

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
jest.mock('../auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mockAuth,
  useNetwork: () => mockNetwork,
  useWorkspace: () => mockWorkspace,
  useMobileRuntime: () => ({
    workflow: mockWorkflow.store,
    auth: { signIn: mockSignIn, signOut: mockSignOut, cancelSignIn: jest.fn(), restore: jest.fn() },
    account: { deleteAccount: mockDelete }, workspace: { getSnapshot: () => mockWorkspace, load: jest.fn(), select: mockSelectWorkspace },
  }),
}));
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
  '(tabs)/_layout': TabsLayout,
  '(tabs)/sessions/_layout': SessionsLayout,
  '(tabs)/threads/_layout': ThreadsLayout,
  '(tabs)/attention/_layout': AttentionLayout,
  '(tabs)/settings/_layout': SettingsLayout,
  '(tabs)/sessions/index': SessionsScreen,
  '(tabs)/sessions/[id]': SessionScreen,
  '(tabs)/threads/index': ThreadsScreen,
  '(tabs)/threads/[id]': ThreadScreen,
  '(tabs)/attention/index': AttentionScreen,
  '(tabs)/attention/[id]': PullRequestScreen,
  '(tabs)/settings/index': SettingsScreen,
};

describe('native shell', () => {
  it('opens Sessions at startup', async () => {
    await renderRouter(routes, { initialUrl: '/' });
    expect(screen).toHavePathname('/sessions');
    expect(screen.getByRole('header', { name: 'Sessions' })).toBeVisible();
  });

  it('returns to Sessions from an unknown route', async () => {
    await renderRouter(routes, { initialUrl: '/missing' });
    expect(screen.getByRole('header', { name: 'Page unavailable' })).toBeVisible();
    await fireEvent.press(screen.getByRole('link', { name: 'Open Sessions' }));
    expect(screen).toHavePathname('/sessions');
  });

  it.each([
    ['/sessions', 'Sessions', 'Current work', '/sessions/session-one', 'Current work'],
    ['/threads', 'Threads', 'Planning work', '/threads/thread-one', 'Planning work'],
    ['/attention', 'Attention', 'Review current work', '/attention/pr-one', 'Review current work'],
  ])('opens a detail from %s', async (url, heading, label, destination, detailHeading) => {
    await renderRouter(routes, { initialUrl: url });
    expect(screen.getByRole('header', { name: heading })).toBeVisible();
    await fireEvent.press(await screen.findByRole('link', { name: new RegExp(label) }));
    expect(screen).toHavePathname(destination);
    expect(await screen.findByRole('header', { name: detailHeading })).toBeVisible();
    await testRouter.back(url);
    expect(screen.getByRole('header', { name: heading })).toBeVisible();
  });

  it('restores a cold session link after authentication', async () => {
    rememberIntent('/sessions/session-one');
    mockAuth = { status: 'signedOut', user: null, issue: null };
    await renderRouter(routes, { initialUrl: '/sessions/session-one' });
    expect(screen.getByRole('header', { name: 'Sign in to Talyn' })).toBeVisible();
    mockAuth = { status: 'signedIn', user: { id: 'alice' }, issue: null };
    await act(async () => router.replace('/'));
    expect(await screen.findByRole('header', { name: 'Current work' })).toBeVisible();
    expect(screen).toHavePathname('/sessions/session-one');
  });

  it('fetches current authorized state for a warm pull request link', async () => {
    await renderRouter(routes, { initialUrl: '/sessions' });
    await act(async () => router.push('/attention/pr-one'));
    expect(await screen.findByRole('header', { name: 'Review current work' })).toBeVisible();
    expect(mockWorkflow.api.pullRequests.get).toHaveBeenCalledWith('pr-one');
  });

  it('waits for workspace selection before it fetches a pending detail', async () => {
    mockWorkspace.selected = null;
    await renderRouter(routes, { initialUrl: '/sessions/session-one' });
    expect(screen.getByRole('header', { name: 'Choose a workspace' })).toBeVisible();
    expect(mockWorkflow.api.workbenches.get).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Select workspace One' }));
    expect(await screen.findByRole('header', { name: 'Current work' })).toBeVisible();
    expect(screen).toHavePathname('/sessions/session-one');
  });

  it('shows account details and accessible account actions', async () => {
    await renderRouter(routes, { initialUrl: '/settings' });
    expect(screen.getByRole('header', { name: 'Settings' })).toBeVisible();
    expect(screen.getByText('alice@example.com')).toBeVisible();
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
    expect(screen.getByRole('header', { name: 'Sign in to Talyn' })).toBeVisible();
    expect(screen.queryByText('alice@example.com')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue with GitHub' }));
    expect(mockSignIn).toHaveBeenCalledTimes(1);
  });
  it('gates the shell until restoration finishes', async () => {
    mockAuth = { status: 'restoring', user: null, issue: null };
    await renderRouter(routes, { initialUrl: '/sessions' });
    expect(screen.getByRole('alert', { name: 'Restoring sign-in' })).toBeVisible();
    expect(screen.queryByRole('header', { name: 'Sessions' })).toBeNull();
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
    expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeDisabled();
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
