import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { Space } from '@talyn/shared';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { NavDrawer } from '../features/nav/NavDrawer';
import { PULL_TO_SEARCH } from '../features/nav/pullToSearch';
import { SpaceDrawerList } from '../features/nav/SpaceDrawer';
import { fixture } from './workflowFixtures';

let mockActive: ReturnType<typeof fixture>;
const mockRefresh = jest.fn(async () => {});
const mockWorkspace = { status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Fixture workspace' }] };
const mockWorkspaceController = { getSnapshot: () => mockWorkspace, select: jest.fn(async () => {}), subscribe: () => () => {} };
const mockContextSnapshot = { status: 'ready' as const, spaceId: null };
const mockContext = { getSnapshot: () => mockContextSnapshot, subscribe: () => () => {}, select: jest.fn(async () => {}) };

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: React.ReactElement }) => children,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true }),
  usePathname: () => '/home', useGlobalSearchParams: () => ({}),
}));
jest.mock('../features/usage/data', () => ({ useBillingStatus: () => ({ status: 'idle', data: undefined, stale: false, refreshing: false }) }));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store, lifecycle: mockActive.lifecycle, workspace: mockWorkspaceController, context: mockContext }),
  useAuth: () => ({ user: { id: 'user-tom' } }),
  useWorkspace: () => mockWorkspace,
  useNetwork: () => 'online',
}));
jest.mock('../features/spaces/data', () => ({
  ...jest.requireActual('../features/spaces/data'),
  useSpaceItems: () => ({ status: 'ready', data: { sessions: { items: [], hiddenCount: 0 }, tasks: { items: [], hiddenCount: 0 } },
    refreshing: false, stale: false, refresh: mockRefresh }),
  useSpacePresence: () => [],
  useSpaceEvents: () => {},
}));

const insets = { frame: { x: 0, y: 0, width: 400, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const space = { id: 'space-1', name: 'Platform' } as Space;
const os = Platform.OS;
const endDrag = (label: string, y: number) =>
  act(async () => { fireEvent(screen.getByLabelText(label), 'scrollEndDrag', { nativeEvent: { contentOffset: { x: 0, y } } }); });
const openDrawer = async () => {
  await render(<SafeAreaProvider initialMetrics={insets}><NavDrawer close={jest.fn()} /></SafeAreaProvider>);
  expect(await screen.findByRole('link', { name: /Current work/ })).toBeVisible();
};

beforeEach(() => {
  mockRefresh.mockClear();
  mockActive = fixture();
  mockActive.api.features.get.mockResolvedValue({ workbenches: true });
});
afterEach(() => { mockActive.store.dispose(); Platform.OS = os; });

describe('drawer lists without pull to refresh', () => {
  it.each(['ios', 'android'] as const)('has no refresh control on the personal list on %s', async (platform) => {
    Platform.OS = platform;
    await openDrawer();
    expect(screen.getByLabelText('Sessions and threads').props.refreshControl).toBeUndefined();
  });

  it('opens search from the button on Android, where a pull does nothing', async () => {
    Platform.OS = 'android';
    await openDrawer();
    await endDrag('Sessions and threads', -(PULL_TO_SEARCH + 10));
    expect(screen.queryByLabelText('Search sessions and threads')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByRole('button', { name: 'Search' })); });
    expect(screen.getByLabelText('Search sessions and threads')).toBeVisible();
  });

  it.each([
    [-(PULL_TO_SEARCH + 10), 1],
    [-20, 0],
  ])('a space list pull to %d opens search %d times and never refreshes', async (y, calls) => {
    const onPull = jest.fn();
    await render(<SpaceDrawerList space={space} owned={new Map()} query="" onLongPress={jest.fn()}
      pull={{ listProps: { onScrollEndDrag: (event) => { if (event.nativeEvent.contentOffset.y <= -PULL_TO_SEARCH) onPull(); } }, hint: null }} />);
    const list = screen.getByLabelText('Sessions and threads in Platform');
    expect(list.props.refreshControl).toBeUndefined();
    await endDrag('Sessions and threads in Platform', y);
    expect(onPull).toHaveBeenCalledTimes(calls);
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
