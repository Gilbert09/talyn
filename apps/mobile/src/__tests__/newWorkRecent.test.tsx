import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Workbench } from '@talyn/shared';

import { NewWorkScreen } from '../features/create/NewWorkScreen';
import { branchChanges, composerLayout, LIFT_AFTER, recentLift, recentWork, RECENT_LIMIT, shortRepository } from '../features/create/recent';
import { chat, fixture, pr, session, thread } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
let mockKeyboard = { open: false, inset: 0 };
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  usePathname: () => '/home',
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => mockRouter,
  Stack: { Screen: () => null },
}));
const mockContextSnapshot = { status: 'ready' as const, spaceId: null };
const mockContext = { getSnapshot: () => mockContextSnapshot, subscribe: () => () => {}, select: jest.fn(async () => {}) };
const mockWorkspace = { status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] };
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store, lifecycle: mockActive.lifecycle, workspace: { getSnapshot: () => mockWorkspace, select: jest.fn() },
    context: mockContext }),
  useNetwork: () => 'online', useAuth: () => ({ user: { id: 'user-one' } }),
  useWorkspace: () => mockWorkspace,
}));
jest.mock('../lib/keyboard', () => ({ ...jest.requireActual('../lib/keyboard'), useKeyboardInset: () => mockKeyboard }));

beforeEach(() => {
  mockActive.store.dispose(); mockActive = fixture(); mockKeyboard = { open: false, inset: 0 };
  jest.clearAllMocks();
});
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`;
const item = (id: string, patch: Partial<Workbench> = {}) => session({ id, createdAt: at(1), ...patch });

describe('recentWork', () => {
  it.each<[string, Workbench[], Workbench[], string[]]>([
    ['nothing held', [], [], []],
    ['sessions and threads, newest first', [item('a', { createdAt: at(2) }), item('b', { createdAt: at(4) })],
      [item('t', { kind: 'thread', createdAt: at(3) })], ['b', 't', 'a']],
    ['an archived row left out', [item('a'), item('gone', { archivedAt: at(5), createdAt: at(9) })], [], ['a']],
    ['a row in both lists once', [item('a', { createdAt: at(2) })], [item('a', { createdAt: at(2) })], ['a']],
  ])('lists %s', (_name, sessions, threads, ids) => {
    expect(recentWork(sessions, threads).map((row) => row.id)).toEqual(ids);
  });

  it('keeps the newest rows up to the limit', () => {
    const many = Array.from({ length: RECENT_LIMIT + 3 }, (_, index) => item(`s${index}`, { createdAt: at(index + 1) }));
    const rows = recentWork(many, undefined);
    expect(rows).toHaveLength(RECENT_LIMIT);
    expect(rows[0].id).toBe(`s${RECENT_LIMIT + 2}`);
  });

  it('reads undefined lists as empty', () => expect(recentWork(undefined, undefined)).toEqual([]));
});

describe('branchChanges', () => {
  const stat = (added: number, removed: number) => ({ added, removed, files: 1 });
  it.each<[string, Parameters<typeof branchChanges>[0], ReturnType<typeof branchChanges>]>([
    ['no stats', { diffStat: null }, null],
    ['zero lines', { diffStat: stat(0, 0) }, null],
    ['an older server with only the top totals', { diffStat: stat(3, 1) }, { added: 3, removed: 1 }],
    ['committed and uncommitted work', { diffStat: stat(3, 1), uncommittedStats: stat(3, 1), committedStats: stat(10, 4) }, { added: 13, removed: 5 }],
    ['committed work only', { diffStat: stat(9, 9), uncommittedStats: null, committedStats: stat(10, 4) }, { added: 10, removed: 4 }],
    ['only removed lines', { diffStat: stat(0, 7) }, { added: 0, removed: 7 }],
  ])('counts %s', (_name, input, expected) => expect(branchChanges(input)).toEqual(expected));
});

describe('shortRepository', () => {
  it.each([
    ['example/project', 'project'],
    ['project', 'project'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('shortens %s to %s', (input, expected) => expect(shortRepository(input)).toBe(expected));
});

describe('composerLayout', () => {
  const idle = { prompt: '', images: 0, focused: false, keyboardOpen: false, busy: false };
  it.each<[string, Partial<typeof idle>, 'centered' | 'docked']>([
    ['nothing typed', {}, 'centered'],
    ['only spaces typed', { prompt: '   ' }, 'centered'],
    ['focus without a keyboard', { focused: true }, 'centered'],
    ['a keyboard that stays after the field lost focus', { keyboardOpen: true }, 'centered'],
    ['focus with the keyboard open', { focused: true, keyboardOpen: true }, 'docked'],
    ['text typed and the keyboard closed', { prompt: 'Fix it' }, 'docked'],
    ['an image attached', { images: 1 }, 'docked'],
    ['a start in progress', { busy: true }, 'docked'],
  ])('puts the composer for %s', (_name, patch, expected) => expect(composerLayout({ ...idle, ...patch })).toBe(expected));
});

describe('recentLift', () => {
  it.each<[string, number, boolean, boolean, boolean]>([
    ['a drag past the threshold lifts', LIFT_AFTER + 1, true, false, true],
    ['a drag to the threshold keeps it down', LIFT_AFTER, true, false, false],
    ['a drag inside the threshold keeps a lift', 10, true, true, true],
    ['a drag inside the threshold keeps it down', 10, true, false, false],
    ['a drag back to the top drops the lift', 0, true, true, false],
    ['a pull past the top drops the lift', -30, true, true, false],
    ['a far drag keeps a lift', 400, true, true, true],
    ['a layout move to the top keeps a lift', 0, false, true, true],
    ['a layout move far down does not lift', 400, false, false, false],
  ])('%s', (_name, offset, dragging, lifted, expected) => expect(recentLift({ offset, dragging, lifted })).toBe(expected));
});

describe('home composer with recent work', () => {
  const recent = () => screen.queryByLabelText('Recent sessions');

  it('lists recent sessions and threads below the composer, and opens one on tap', async () => {
    await render(<NewWorkScreen presentation="home" />);
    expect(await screen.findByRole('link', { name: /^Current work\./ })).toBeVisible();
    expect(screen.getByRole('link', { name: /^Planning work\..*Thread\./ })).toBeVisible();
    await fireEvent.press(screen.getByRole('link', { name: /^Current work\./ }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/sessions/[id]', params: { id: 'session-one' } });
    await fireEvent.press(screen.getByRole('link', { name: /^Planning work\./ }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/threads/[id]', params: { id: 'thread-one' } });
  });

  it('moves the composer down while typing and back when the text is cleared', async () => {
    await render(<NewWorkScreen presentation="home" />);
    await waitFor(() => expect(recent()).not.toBeNull());
    await fireEvent.changeText(screen.getByLabelText('Task'), 'Fix the header');
    expect(recent()).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('Task'), '');
    await waitFor(() => expect(recent()).not.toBeNull());
  });

  it('keeps the same field while it moves, so focus stays', async () => {
    await render(<NewWorkScreen presentation="home" />);
    await waitFor(() => expect(recent()).not.toBeNull());
    const field = screen.getByLabelText('Task');
    mockKeyboard = { open: true, inset: 300 };
    await fireEvent(field, 'focus');
    expect(recent()).toBeNull();
    expect(screen.getByLabelText('Task')).toBe(field);
    mockKeyboard = { open: false, inset: 0 };
    await fireEvent(field, 'blur');
    await waitFor(() => expect(recent()).not.toBeNull());
    expect(screen.getByLabelText('Task')).toBe(field);
  });

  it('stays in the middle when the field has focus but no keyboard shows', async () => {
    await render(<NewWorkScreen presentation="home" />);
    await waitFor(() => expect(recent()).not.toBeNull());
    await fireEvent(screen.getByLabelText('Task'), 'focus');
    expect(recent()).not.toBeNull();
  });

  it('follows live session events', async () => {
    await render(<NewWorkScreen presentation="home" />);
    await screen.findByRole('link', { name: /^Current work\./ });
    await act(async () => { mockActive.emit('workbench:chat', { chat: chat({ status: 'running' }) }); });
    expect(screen.getByRole('link', { name: /^Current work\. Working\./ })).toBeVisible();
    await act(async () => {
      mockActive.emit('workbench:updated', { workbench: session({ title: 'Renamed work', chats: [chat({ status: 'awaiting_input' })],
        diffStat: { added: 12, removed: 3, files: 2 }, committedStats: null }) });
    });
    expect(screen.getByRole('link', { name: /^Renamed work\. Waiting for your answer\..*12 lines added, 3 removed\./ })).toBeVisible();
    expect(screen.getByText('+12')).toBeVisible();
    expect(screen.getByText(' −3')).toBeVisible();
  });

  it('shows the pull request state from the live pull request row', async () => {
    mockActive.api.pullRequests.list.mockResolvedValue([pr({ summary: { ...pr().summary, mergeable: 'CONFLICTING' } })]);
    await render(<NewWorkScreen presentation="home" />);
    expect(await screen.findByRole('link', { name: /^Current work\. #42 has conflicts\..*Pull request 42\./ })).toBeVisible();
    expect(mockActive.api.pullRequests.list).toHaveBeenCalled();
  });

  it('does not read pull requests when no recent row has one', async () => {
    mockActive.api.workbenches.list.mockResolvedValue([session({ pullRequestId: null }), thread()]);
    await render(<NewWorkScreen presentation="home" />);
    await screen.findByRole('link', { name: /^Current work\./ });
    expect(mockActive.api.pullRequests.list).not.toHaveBeenCalled();
  });

  it('shows no list while nothing has started yet', async () => {
    mockActive.api.workbenches.list.mockResolvedValue([]);
    await render(<NewWorkScreen presentation="home" />);
    expect(await screen.findByLabelText('Task')).toBeVisible();
    await waitFor(() => expect(mockActive.api.workbenches.list).toHaveBeenCalled());
    expect(recent()).toBeNull();
  });

  describe('lifted by a drag down the list', () => {
    const scroll = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 400, height: 900 },
      layoutMeasurement: { width: 400, height: 300 } } });
    const list = () => screen.getByTestId('recent-work');
    const heading = () => screen.queryByText('What do you want to build?');
    const compact = () => screen.queryByLabelText('Attach an image') === null;
    const dragTo = async (y: number) => {
      await fireEvent(list(), 'scrollBeginDrag', scroll(0));
      await fireEvent.scroll(list(), scroll(y));
      await fireEvent(list(), 'scrollEndDrag', scroll(y));
    };

    it('shows the full composer before a drag', async () => {
      await render(<NewWorkScreen presentation="home" />);
      await waitFor(() => expect(recent()).not.toBeNull());
      expect(compact()).toBe(false);
      expect(heading()).not.toBeNull();
    });

    it('turns compact after a drag down and back after a drag to the top', async () => {
      await render(<NewWorkScreen presentation="home" />);
      await waitFor(() => expect(recent()).not.toBeNull());
      await dragTo(LIFT_AFTER + 40);
      expect(compact()).toBe(true);
      expect(screen.getByLabelText('Task')).toBeVisible();
      expect(recent()).not.toBeNull();
      await dragTo(0);
      expect(compact()).toBe(false);
    });

    it('stays compact when the layout moves the list to the top without a drag', async () => {
      await render(<NewWorkScreen presentation="home" />);
      await waitFor(() => expect(recent()).not.toBeNull());
      await dragTo(LIFT_AFTER + 40);
      await fireEvent.scroll(list(), scroll(0));
      expect(compact()).toBe(true);
    });

    it('drops the lift when a fling ends at the top', async () => {
      await render(<NewWorkScreen presentation="home" />);
      await waitFor(() => expect(recent()).not.toBeNull());
      await dragTo(LIFT_AFTER + 40);
      await fireEvent(list(), 'momentumScrollBegin', scroll(LIFT_AFTER + 40));
      await fireEvent.scroll(list(), scroll(0));
      expect(compact()).toBe(false);
    });

    it('does not lift for a scroll that is not a drag', async () => {
      await render(<NewWorkScreen presentation="home" />);
      await waitFor(() => expect(recent()).not.toBeNull());
      await fireEvent.scroll(list(), scroll(LIFT_AFTER + 40));
      expect(compact()).toBe(false);
    });

    it('docks the full composer when the compact field gets focus, then comes back unlifted', async () => {
      await render(<NewWorkScreen presentation="home" />);
      await waitFor(() => expect(recent()).not.toBeNull());
      await dragTo(LIFT_AFTER + 40);
      const field = screen.getByLabelText('Task');
      mockKeyboard = { open: true, inset: 300 };
      await fireEvent(field, 'focus');
      expect(recent()).toBeNull();
      expect(compact()).toBe(false);
      expect(screen.getByLabelText('Task')).toBe(field);
      mockKeyboard = { open: false, inset: 0 };
      await fireEvent(field, 'blur');
      await waitFor(() => expect(recent()).not.toBeNull());
      expect(compact()).toBe(false);
    });
  });
});
