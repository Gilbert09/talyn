import { act, fireEvent, renderRouter, screen, testRouter } from 'expo-router/testing-library';

import { Alert } from 'react-native';

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
const mockWorkspace = { status: 'ready', choices: [{ id: 'one', name: 'One' }], selected: 'one' };
jest.mock('../auth/AuthProvider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
  useAuth: () => mockAuth,
  useNetwork: () => mockNetwork,
  useWorkspace: () => mockWorkspace,
  useMobileRuntime: () => ({
    auth: { signIn: mockSignIn, signOut: mockSignOut, cancelSignIn: jest.fn(), restore: jest.fn() },
    account: { deleteAccount: mockDelete }, workspace: { getSnapshot: () => mockWorkspace, load: jest.fn(), select: jest.fn(async () => {}) },
  }),
}));
beforeEach(() => {
  mockAuth = { status: 'signedIn', user: { id: 'alice', email: 'alice@example.com' }, issue: null };
  mockNetwork = 'online';
});

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
    ['/sessions', 'Sessions', 'Open example session', '/sessions/example-session', 'Example session'],
    ['/threads', 'Threads', 'Open example thread', '/threads/example-thread', 'Example thread'],
    ['/attention', 'Attention', 'Open example pull request', '/attention/example-pr', 'Example pull request'],
  ])('opens a detail from %s', async (url, heading, label, destination, detailHeading) => {
    await renderRouter(routes, { initialUrl: url });
    expect(screen.getByRole('header', { name: heading })).toBeVisible();
    await fireEvent.press(screen.getByRole('link', { name: label }));
    expect(screen).toHavePathname(destination);
    expect(screen.getByRole('header', { name: detailHeading })).toBeVisible();
    await testRouter.back(url);
    expect(screen.getByRole('header', { name: heading })).toBeVisible();
  });

  it('shows account details and accessible account actions', async () => {
    await renderRouter(routes, { initialUrl: '/settings' });
    expect(screen.getByRole('header', { name: 'Settings' })).toBeVisible();
    expect(screen.getByText('alice@example.com')).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['/sessions/linked-session', 'Session: linked-session'],
    ['/threads/linked-thread', 'Thread: linked-thread'],
    ['/attention/linked-pr', 'Pull request: linked-pr'],
  ])('opens the detail URL %s', async (url, label) => {
    await renderRouter(routes, { initialUrl: url });
    expect(screen).toHavePathname(url);
    expect(screen.getByText(label)).toBeVisible();
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
