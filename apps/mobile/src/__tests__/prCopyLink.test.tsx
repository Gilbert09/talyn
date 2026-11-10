import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';

import type { PRRow } from '@talyn/client/native';

import { prCopyText, prLinkActions, prMarkdownLink } from '../features/prs/copyLink';
import { PullRequestDetailScreen } from '../features/prs/PullRequestDetailScreen';
import { PullRequestsScreen } from '../features/prs/PullRequestsScreen';
import { prLinkTarget } from '../features/prs/usePrLinkMenu';
import { fixture, pr } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
jest.mock('expo-router', () => {
  const { View } = jest.requireActual('react-native');
  const React_ = jest.requireActual('react');
  return {
    useLocalSearchParams: () => ({ id: 'pr-one' }),
    usePathname: () => '/pulls',
    Link: ({ children }: { children: React.ReactNode }) => children,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
    Stack: { Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) => React_.createElement(View, null, options?.headerRight?.()) },
  };
});
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store }), useNetwork: () => 'online',
  useWorkspace: () => ({ status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
const clipboard = Clipboard as jest.Mocked<typeof Clipboard>;

const URL = 'https://github.com/example/project/pull/42';
beforeEach(() => { mockActive.store.dispose(); mockActive = fixture(); clipboard.setStringAsync.mockClear(); });
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

describe('PR link copy model', () => {
  it.each([
    ['Fix the bug', URL, `[Fix the bug](${URL})`],
    ['', URL, `[(no title)](${URL})`],
  ])('builds the Markdown link for %j', (title, url, expected) => {
    expect(prMarkdownLink(title, url)).toBe(expected);
  });

  it.each([
    ['copy_link', { text: URL, done: 'Link copied.' }],
    ['copy_markdown', { text: `[T](${URL})`, done: 'Markdown link copied.' }],
  ] as const)('%s writes the right text', (kind, expected) => {
    expect(prCopyText(kind, 'T', URL)).toEqual(expected);
  });

  it('puts the plain link first and offers nothing without a URL', () => {
    expect(prLinkActions(URL)).toEqual(['copy_link', 'copy_markdown', 'share', 'open']);
    expect(prLinkActions(null)).toEqual([]);
  });

  it.each([['javascript:alert(1)'], ['https://user:pass@github.com/x'], ['']])('refuses an unsafe URL %j', (url) => {
    expect(prLinkTarget(pr({ summary: { ...pr().summary, url } }))).toBeNull();
  });

  it('names the PR by repository and number', () => {
    expect(prLinkTarget(pr())).toEqual({ title: 'Review current work', url: URL, ref: 'example/project #42' });
  });
});

describe('PR link copy on screens', () => {
  it('a long press on a row opens the menu, and each copy writes its text', async () => {
    mockActive.api.pullRequests.list.mockResolvedValue([pr({ authored: true, reviewRequested: false })]);
    await render(<PullRequestsScreen tab="mine" />);
    const row = await screen.findByRole('link', { name: /^Review current work\./ });
    await fireEvent(row, 'longPress');
    expect(screen.getByText('example/project #42')).toBeVisible();
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Copy link' })); });
    expect(clipboard.setStringAsync).toHaveBeenLastCalledWith(URL);
    expect(await screen.findByText('Link copied.')).toBeVisible();

    await fireEvent(row, 'longPress');
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Copy as Markdown link' })); });
    expect(clipboard.setStringAsync).toHaveBeenLastCalledWith(`[Review current work](${URL})`);
  });

  it('shares the plain link', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction', activityType: undefined });
    mockActive.api.pullRequests.list.mockResolvedValue([pr({ authored: true, reviewRequested: false })]);
    await render(<PullRequestsScreen tab="mine" />);
    await fireEvent(await screen.findByRole('link', { name: /^Review current work\./ }), 'longPress');
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Share' })); });
    expect(share).toHaveBeenCalledWith({ message: URL, url: URL });
  });

  it('the detail header copies the plain link on tap and opens the menu on long press', async () => {
    mockActive.api.pullRequests.get.mockResolvedValue({ row: pr() as PRRow, fresh: null });
    await render(<PullRequestDetailScreen />);
    const button = await screen.findByRole('button', { name: 'Copy link' });
    await act(async () => { fireEvent.press(button); });
    expect(clipboard.setStringAsync).toHaveBeenLastCalledWith(URL);
    await fireEvent(button, 'longPress');
    expect(screen.getByRole('button', { name: 'Copy as Markdown link' })).toBeVisible();
  });
});
