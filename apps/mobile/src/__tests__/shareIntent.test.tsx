import { act, render, screen } from '@testing-library/react-native';
import { TRANSCRIPT_QUOTE_MAX_CHARS } from '@talyn/shared';

import { redirectSystemPath } from '../../app/+native-intent';
import { ShareIntentBridge } from '../features/share/ShareIntentBridge';
import { SHARE_WAIT_MS, ShareScreen } from '../features/share/ShareScreen';
import { sharedKind, sharedPrompt, type SharedItem } from '../features/share/sharedPrompt';
import {
  clearIntent, completeShare, consumeIntent, pendingShare, peekIntent, rememberIntent, rememberShare, SHARE_ROUTE, shareIntentPath,
} from '../navigation/intents';

let mockAuthStatus = 'signedIn';
let mockPathname = '/home';
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  useRouter: () => mockRouter,
  Redirect: ({ href }: { href: string }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>{`redirect:${href}`}</Text>;
  },
}));
jest.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ status: mockAuthStatus }) }));
jest.mock('../components/BootScreen', () => ({
  BootScreen: ({ label }: { label: string }) => {
    const { Text } = jest.requireActual('react-native');
    return <Text>{label}</Text>;
  },
}));
const mockTrack = jest.fn();
jest.mock('../lib/analytics', () => ({ trackEvent: (...args: unknown[]) => mockTrack(...args) }));

const EMPTY = { text: null, webUrl: null, files: null, type: null, meta: null };
let mockShare: { hasShareIntent: boolean; shareIntent: SharedItem & Record<string, unknown> } = { hasShareIntent: false, shareIntent: EMPTY };
const mockReset = jest.fn(() => { mockShare = { hasShareIntent: false, shareIntent: EMPTY }; });
jest.mock('expo-share-intent', () => ({
  useShareIntent: () => ({ ...mockShare, isReady: true, error: null, resetShareIntent: mockReset }),
}));

const LINK = 'https://github.com/example/project/issues/12';

beforeEach(() => {
  jest.clearAllMocks();
  clearIntent();
  mockAuthStatus = 'signedIn';
  mockPathname = '/home';
  mockShare = { hasShareIntent: false, shareIntent: EMPTY };
});

describe('sharedPrompt', () => {
  it.each<[string, SharedItem, string | null]>([
    ['a bare link', { text: LINK, webUrl: LINK }, `${LINK}\n\n`],
    ['a link with only webUrl', { text: null, webUrl: LINK }, `${LINK}\n\n`],
    ['a link with surrounding spaces', { text: `  ${LINK}\n`, webUrl: LINK }, `${LINK}\n\n`],
    ['a link with a page title', { text: LINK, webUrl: LINK, meta: { title: 'Crash on start' } }, `Crash on start\n${LINK}\n\n`],
    ['a link whose title is the link', { text: LINK, webUrl: LINK, meta: { title: LINK } }, `${LINK}\n\n`],
    ['a link with a blank title', { text: LINK, webUrl: LINK, meta: { title: '   ' } }, `${LINK}\n\n`],
    ['plain text', { text: 'The build fails on Windows', webUrl: null }, '> The build fails on Windows\n\n'],
    ['text on several lines', { text: 'one\r\ntwo\n\n\n\nthree', webUrl: null }, '> one\n> two\n>\n> three\n\n'],
    ['text that holds the link', { text: `Look at this ${LINK}`, webUrl: LINK }, `> Look at this ${LINK}\n\n`],
    ['text without its link', { text: 'Look at this', webUrl: LINK }, `> Look at this\n\n${LINK}\n\n`],
    ['empty text and no link', { text: '   ', webUrl: null }, null],
    ['nothing', { text: null, webUrl: null }, null],
    ['undefined fields', {}, null],
  ])('builds the composer text for %s', (_name, item, expected) => {
    expect(sharedPrompt(item)).toBe(expected);
  });

  it('cuts long text like a transcript quote', () => {
    const prompt = sharedPrompt({ text: 'a'.repeat(TRANSCRIPT_QUOTE_MAX_CHARS + 50) })!;
    expect(prompt.startsWith(`> ${'a'.repeat(TRANSCRIPT_QUOTE_MAX_CHARS)}…`)).toBe(true);
  });

  it.each<[SharedItem, 'link' | 'text']>([
    [{ text: LINK, webUrl: LINK }, 'link'],
    [{ webUrl: LINK }, 'link'],
    [{ text: `see ${LINK}`, webUrl: LINK }, 'text'],
    [{ text: 'hello' }, 'text'],
  ])('names the kind of %j', (item, kind) => expect(sharedKind(item)).toBe(kind));
});

describe('share intents', () => {
  it('keeps a shared item as a pending new-session route', () => {
    const href = rememberShare('> hello\n\n');
    expect(href).toBe(`/new?mode=session&prompt=${encodeURIComponent('> hello\n\n')}`);
    expect(shareIntentPath('> hello\n\n')).toBe(href);
    expect(pendingShare()).toBe(href);
    expect(consumeIntent()).toBe(href);
    expect(pendingShare()).toBeNull();
  });

  it('clears a shown share and keeps a product link', () => {
    rememberShare('one');
    completeShare();
    expect(peekIntent()).toBeNull();
    rememberIntent('talyn-mobile://sessions/abc');
    completeShare();
    expect(peekIntent()).toBe('/sessions/abc');
    expect(pendingShare()).toBeNull();
  });

  it('lets a later product link replace a pending share', () => {
    rememberShare('one');
    rememberIntent('https://app.talyn.dev/threads/xyz');
    expect(peekIntent()).toBe('/threads/xyz');
  });

  it('keeps a pending share when a non-product path is remembered', () => {
    const href = rememberShare('one');
    rememberIntent('/new');
    rememberIntent(SHARE_ROUTE);
    expect(peekIntent()).toBe(href);
  });
});

describe('redirectSystemPath for the iOS share extension', () => {
  it.each([
    'talyn-mobile://dataUrl=talyn-mobileShareKey?nonce=1A2B#weburl',
    'talyn-mobile-preview://dataUrl=talyn-mobile-previewShareKey?nonce=x#text',
    'talyn://dataUrl=talynShareKey#media',
  ])('opens the share page for %s', (path) => {
    expect(redirectSystemPath({ path, initial: false })).toBe(SHARE_ROUTE);
    expect(redirectSystemPath({ path, initial: true })).toBe(SHARE_ROUTE);
  });

  it.each([
    ['talyn-mobile://sessions/abc', '/sessions/abc'],
    ['talyn-mobile://pulls', '/pulls'],
    ['https://app.talyn.dev/dataUrl=x', '/dataUrl=x'],
  ])('leaves other links alone: %s', (path, expected) => {
    expect(redirectSystemPath({ path, initial: false })).toBe(expected);
  });
});

describe('ShareIntentBridge', () => {
  const share = (shareIntent: SharedItem) => { mockShare = { hasShareIntent: true, shareIntent: { ...EMPTY, ...shareIntent } }; };

  it('does nothing without a shared item', async () => {
    await render(<ShareIntentBridge />);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockReset).not.toHaveBeenCalled();
    expect(peekIntent()).toBeNull();
  });

  it('pushes the composer with a shared link when signed in', async () => {
    share({ text: LINK, webUrl: LINK, meta: { title: 'Crash' } });
    await render(<ShareIntentBridge />);
    const href = shareIntentPath(`Crash\n${LINK}\n\n`);
    expect(mockRouter.push).toHaveBeenCalledWith(href);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockReset).toHaveBeenCalledTimes(1);
    // The composer clears it once it shows the text, so a workspace choice in between keeps it.
    expect(pendingShare()).toBe(href);
  });

  it('replaces the share page on iOS', async () => {
    mockPathname = SHARE_ROUTE;
    share({ text: 'hello' });
    await render(<ShareIntentBridge />);
    expect(mockRouter.replace).toHaveBeenCalledWith(shareIntentPath('> hello\n\n'));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it.each(['signedOut', 'restoring', 'locked'])('keeps the item for after sign-in when %s', async (status) => {
    mockAuthStatus = status;
    share({ text: 'hello' });
    await render(<ShareIntentBridge />);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(consumeIntent()).toBe(shareIntentPath('> hello\n\n'));
  });

  it('drops an item with no text', async () => {
    share({ text: '  ' });
    await render(<ShareIntentBridge />);
    expect(mockReset).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(peekIntent()).toBeNull();
  });

  it.each<[SharedItem, string, Record<string, unknown>]>([
    [{ text: LINK, webUrl: LINK }, 'signedIn', { content: 'link', chars: LINK.length + 2, signed_in: true }],
    [{ text: 'secret plan' }, 'signedOut', { content: 'text', chars: '> secret plan\n\n'.length, signed_in: false }],
  ])('tracks the kind and length, never the text: %j', async (item, status, properties) => {
    mockAuthStatus = status;
    share(item);
    await render(<ShareIntentBridge />);
    expect(mockTrack).toHaveBeenCalledWith('share_received', properties);
    expect(JSON.stringify(mockTrack.mock.calls)).not.toContain('secret');
  });
});

describe('ShareScreen', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('opens an item that arrived first', async () => {
    const href = rememberShare('> hello\n\n');
    await render(<ShareScreen />);
    expect(mockRouter.replace).toHaveBeenCalledWith(href);
  });

  it('waits for the item, then goes back when none arrives', async () => {
    await render(<ShareScreen />);
    expect(screen.getByText('Opening what you shared')).toBeTruthy();
    await act(() => { jest.advanceTimersByTime(SHARE_WAIT_MS - 1); });
    expect(mockRouter.back).not.toHaveBeenCalled();
    await act(() => { jest.advanceTimersByTime(1); });
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('goes home when there is nothing to go back to', async () => {
    mockRouter.canGoBack.mockReturnValueOnce(false);
    await render(<ShareScreen />);
    await act(() => { jest.advanceTimersByTime(SHARE_WAIT_MS); });
    expect(mockRouter.replace).toHaveBeenCalledWith('/home');
  });

  it('stops waiting when it closes', async () => {
    const view = await render(<ShareScreen />);
    await view.unmount();
    await act(() => { jest.advanceTimersByTime(SHARE_WAIT_MS); });
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('sends a signed-out person to sign-in and keeps the item', async () => {
    mockAuthStatus = 'signedOut';
    const href = rememberShare('one');
    await render(<ShareScreen />);
    expect(screen.getByText('redirect:/')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(peekIntent()).toBe(href);
  });
});
