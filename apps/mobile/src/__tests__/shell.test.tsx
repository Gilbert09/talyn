import { fireEvent, renderRouter, screen, testRouter } from 'expo-router/testing-library';

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

const routes = {
  _layout: RootLayout,
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
    for (const note of screen.getAllByText('Example data. Your account is not connected.')) {
      expect(note).toBeVisible();
    }
    await fireEvent.press(screen.getByRole('link', { name: label }));
    expect(screen).toHavePathname(destination);
    expect(screen.getByRole('header', { name: detailHeading })).toBeVisible();
    await testRouter.back(url);
    expect(screen.getByRole('header', { name: heading })).toBeVisible();
  });

  it('shows accessible Settings without account actions', async () => {
    await renderRouter(routes, { initialUrl: '/settings' });
    expect(screen.getByRole('header', { name: 'Settings' })).toBeVisible();
    expect(screen.getByText('Sign-in and account settings are not available yet.')).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
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
