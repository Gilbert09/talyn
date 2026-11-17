import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { WorkbenchTranscriptMatch } from '@talyn/shared';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { NavDrawer } from '../features/nav/NavDrawer';
import { TRANSCRIPT_SEARCH_DEBOUNCE_MS } from '../features/nav/model';
import { deferred, fixture, session } from './workflowFixtures';

let mockActive: ReturnType<typeof fixture>;
const mockPush = jest.fn();
const mockWorkspace = { status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Fixture workspace' }] };
const mockWorkspaceController = { getSnapshot: () => mockWorkspace, select: jest.fn(async () => {}), subscribe: () => () => {} };
const mockContextSnapshot = { status: 'ready' as const, spaceId: null };
const mockContext = { getSnapshot: () => mockContextSnapshot, subscribe: () => () => {}, select: jest.fn(async () => {}) };

jest.mock('expo-router', () => {
  const React_ = jest.requireActual('react');
  return {
    // A link presses through to the router, so a test can see where a row goes.
    Link: ({ href, children }: { href: unknown; children: React.ReactElement }) => React_.cloneElement(children, { onPress: () => mockPush(href) }),
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true }),
    usePathname: () => '/home', useGlobalSearchParams: () => ({}),
  };
});
jest.mock('../features/usage/data', () => ({ useBillingStatus: () => ({ status: 'idle', data: undefined, stale: false, refreshing: false }) }));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store, lifecycle: mockActive.lifecycle, workspace: mockWorkspaceController, context: mockContext }),
  useAuth: () => ({ user: { id: 'user-tom' } }),
  useWorkspace: () => mockWorkspace,
  useNetwork: () => 'online',
}));

const insets = { frame: { x: 0, y: 0, width: 400, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
const archived = session({ id: 'old', title: 'Old idea', repoFullName: 'example/archive', archivedAt: '2026-11-09T10:00:00Z', chats: [] });
const match = (patch: Partial<WorkbenchTranscriptMatch> = {}): WorkbenchTranscriptMatch =>
  ({ workbench: archived, chatId: 'chat-old', seq: 4, role: 'assistant', snippet: '…moved the work queue to the backend…', ...patch });

const open = async () => {
  await render(<SafeAreaProvider initialMetrics={insets}><NavDrawer close={jest.fn()} /></SafeAreaProvider>);
  expect(await screen.findByRole('link', { name: /Current work/ })).toBeVisible();
};
const search = async (text: string) => {
  await act(async () => { fireEvent.changeText(screen.getByLabelText('Search sessions and threads'), text); });
};
const pastDebounce = () => act(async () => { await new Promise((done) => setTimeout(done, TRANSCRIPT_SEARCH_DEBOUNCE_MS + 100)); });

beforeEach(() => {
  mockPush.mockClear();
  mockActive = fixture();
  mockActive.api.features.get.mockResolvedValue({ workbenches: true });
});
afterEach(() => { mockActive.store.dispose(); });

describe('drawer transcript search', () => {
  it.each(['', 'wo', '  wo  '])('does not search transcripts for %j', async (text) => {
    await open();
    await search(text);
    await pastDebounce();
    expect(mockActive.api.workbenches.searchTranscripts).not.toHaveBeenCalled();
    expect(screen.queryByRole('header', { name: 'In transcripts' })).toBeNull();
  });

  it('lists transcript matches below the name matches, without repeats', async () => {
    mockActive.api.workbenches.searchTranscripts.mockResolvedValue([match({ workbench: session(), snippet: 'Named snippet' }), match()]);
    await open();
    await search(' work ');
    expect(await screen.findByRole('header', { name: 'In transcripts' })).toBeVisible();
    expect(mockActive.api.workbenches.searchTranscripts).toHaveBeenCalledTimes(1);
    expect(mockActive.api.workbenches.searchTranscripts).toHaveBeenCalledWith('one', 'work');
    expect(screen.getByText('Old idea')).toBeVisible();
    expect(screen.getByText('example/archive')).toBeVisible();
    expect(screen.getByText('…moved the work queue to the backend…')).toBeVisible();
    // "Current work" matches by name, so its transcript match is not listed again.
    expect(screen.getAllByText('Current work')).toHaveLength(1);
    expect(screen.queryByText('Named snippet')).toBeNull();
  });

  it('opens an archived match like a drawer row', async () => {
    mockActive.api.workbenches.searchTranscripts.mockResolvedValue([match(), match({ workbench: { ...archived, id: 'old-thread', kind: 'thread', title: 'Old plan' } })]);
    await open();
    await search('queue');
    expect(screen.getByText('Searching transcripts…')).toBeVisible();
    expect(screen.queryByText('No sessions or threads match.')).toBeNull();
    const row = await screen.findByRole('link', { name: /^Old idea\. example\/archive\. Archived\./ });
    await act(async () => { fireEvent.press(row); });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/sessions/[id]', params: { id: 'old' } });
    await act(async () => { fireEvent.press(screen.getByRole('link', { name: /^Old plan\. Thread\. Archived\./ })); });
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/threads/[id]', params: { id: 'old-thread' } });
    expect(screen.queryByText('Searching transcripts…')).toBeNull();
  });

  it('shows nothing from transcripts when the search fails', async () => {
    mockActive.api.workbenches.searchTranscripts.mockRejectedValue(new Error('offline'));
    await open();
    await search('queue');
    expect(await screen.findByText('No sessions or threads match.')).toBeVisible();
    expect(mockActive.api.workbenches.searchTranscripts).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('header', { name: 'In transcripts' })).toBeNull();
    expect(screen.queryByText('Searching transcripts…')).toBeNull();
  });

  it('drops an answer for an older search', async () => {
    const first = deferred<WorkbenchTranscriptMatch[]>();
    mockActive.api.workbenches.searchTranscripts.mockReturnValueOnce(first.promise).mockResolvedValueOnce([]);
    await open();
    await search('queue');
    await waitFor(() => expect(mockActive.api.workbenches.searchTranscripts).toHaveBeenCalledTimes(1));
    await search('queues');
    expect(await screen.findByText('No sessions or threads match.')).toBeVisible();
    await act(async () => { first.resolve([match()]); });
    expect(screen.queryByText('Old idea')).toBeNull();
  });

  it('does not search transcripts without sessions on the account', async () => {
    mockActive.api.features.get.mockResolvedValue({ workbenches: false });
    await render(<SafeAreaProvider initialMetrics={insets}><NavDrawer close={jest.fn()} /></SafeAreaProvider>);
    await pastDebounce();
    expect(screen.queryByLabelText('Search sessions and threads')).toBeNull();
    expect(mockActive.api.workbenches.searchTranscripts).not.toHaveBeenCalled();
  });
});
