import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, I18nManager, Linking } from 'react-native';

import { NativeText, safeExternalUrl, StateNotice } from '../components/Workflow';
import { AttentionScreen } from '../features/prs/AttentionScreen';
import { PullRequestDetailScreen } from '../features/prs/PullRequestDetailScreen';
import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { WorkbenchListScreen } from '../features/sessions/WorkbenchListScreen';
import { chat, deferred, event, fixture, pr, session } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
let mockParams = { id: 'session-one' };
let mockNetwork = 'online';
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  // The header's right button renders in place, so tests can press it.
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => React.ReactNode } }) => options?.headerRight?.() ?? null },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store }), useNetwork: () => mockNetwork,
  useWorkspace: () => ({ selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
}));
beforeEach(() => { mockActive.store.dispose(); mockActive = fixture(); mockParams = { id: 'session-one' }; mockNetwork = 'online'; });
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

describe('native lists and useful states', () => {
  it.each(['session', 'thread'] as const)('provides an accessible %s list, scope, and pull to refresh', async (kind) => {
    await render(<WorkbenchListScreen kind={kind} />);
    expect(await screen.findByRole('link', { name: new RegExp(kind === 'session' ? 'Current work' : 'Planning work') })).toBeVisible();
    expect(screen.getAllByRole('header', { name: kind === 'session' ? 'Sessions' : 'Threads' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Refresh list' })).toBeNull();
    const calls = mockActive.api.workbenches.list.mock.calls.length;
    await act(async () => { screen.getByLabelText(kind === 'session' ? 'Sessions' : 'Threads').props.refreshControl.props.onRefresh(); });
    await waitFor(() => expect(mockActive.api.workbenches.list.mock.calls.length).toBeGreaterThan(calls));
    expect(screen.getByRole('link', { name: 'Workspace: Test workspace' })).toBeVisible();
  });
  it('shows loading and empty states', async () => {
    const pending = deferred<ReturnType<typeof session>[]>(); mockActive.api.workbenches.list.mockReturnValueOnce(pending.promise);
    await render(<WorkbenchListScreen kind="session" />); expect(screen.getByText('Loading')).toBeVisible();
    await act(async () => pending.resolve([])); expect(await screen.findByText('Sessions you start in this workspace show here.')).toBeVisible();
  });
  it.each([[503, 'This view could not load.', true], [403, 'Access is unavailable. Check your account and workspace.', true],
    [404, 'This item was deleted or is no longer available.', false]])('shows a safe state for HTTP %s', async (status, text, retry) => {
    mockActive.api.workbenches.list.mockRejectedValueOnce({ status, message: 'Private diagnostic' });
    await render(<WorkbenchListScreen kind="session" />); expect(await screen.findByRole('alert', { name: text })).toBeVisible();
    expect(screen.queryByText('Private diagnostic')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retry);
  });
  it.each([
    ['offline without data', { status: 'ready', stale: false, refreshing: false }, true, 'You are offline. Connect to load this view.'],
    ['offline with data', { status: 'ready', data: [], stale: true, refreshing: false }, true, 'You are offline. Showing what this app last loaded.'],
    ['a failed refresh with data', { status: 'error', data: [], stale: true, refreshing: false }, false, 'Could not refresh. Showing earlier data.'],
  ] as const)('labels %s', async (_name, resource, offline, text) => {
    await render(<StateNotice resource={resource} offline={offline} refresh={jest.fn()} />);
    expect(screen.getByText(text)).toBeVisible();
  });
  it.each([
    ['stale data', { status: 'ready', data: [], stale: true, refreshing: false }],
    ['a background refresh', { status: 'ready', data: [], stale: true, refreshing: true }],
    ['current data', { status: 'ready', data: [], stale: false, refreshing: false }],
  ] as const)('shows no banner for %s', async (_name, resource) => {
    await render(<StateNotice resource={resource} offline={false} refresh={jest.fn()} />);
    expect(screen.toJSON()).toBeNull();
  });
  it('keeps PR lists read-only with one status and a separate review pill', async () => {
    mockActive.api.pullRequests.list.mockResolvedValueOnce([pr({ authored: true, summary: { ...pr().summary, ciStatus: undefined } })]);
    await render(<AttentionScreen />);
    expect(await screen.findByRole('link', { name: /Status: Unknown\. Review: Needs approval\./ })).toBeVisible();
    expect(screen.getByText('#42')).toBeVisible();
    expect(screen.queryByText(/Review: Review required/)).toBeNull();
    expect(screen.queryByRole('button', { name: /merge|approve|queue/i })).toBeNull();
    expect(screen.getByText('Waiting for review')).toBeVisible();
  });
  it('virtualizes a performance fixture with ten thousand sessions', async () => {
    mockActive.api.workbenches.list.mockResolvedValueOnce(Array.from({ length: 10000 }, (_, index) => session({ id: `session-${index}`, title: `Work ${index}` })));
    await render(<WorkbenchListScreen kind="session" />); await screen.findByRole('link', { name: /Work 0\./ });
    expect(screen.getAllByRole('link').length).toBeLessThan(50);
    expect(screen.queryByRole('link', { name: /Work 9999\./ })).toBeNull();
  });
});

describe('detail and composer accessibility', () => {
  it('shows the transcript, state, and related PR without a readiness line when ready', async () => {
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByText('Agent response 1')).toBeVisible();
    expect(screen.getByRole('header', { name: 'Current work' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open related pull request' })).toBeVisible();
    expect(screen.queryByText(/Readiness/)).toBeNull(); expect(screen.getByLabelText('Message')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.getByText('Codex · GPT-6.1 Terra · High effort')).toBeVisible();
    expect(screen.queryByText(/Model:|Time unavailable/)).toBeNull();
  });
  it.each([
    ['the agent is not connected', { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: false, reason: { code: 'agent_not_connected', message: 'Connect Codex in Settings.' } } } }, 'Connect Codex in Settings.'],
    ['the sandbox is unavailable', { ok: false, reasons: [{ code: 'fleet_disabled', message: 'Sessions are paused.' }], agents: { claude: { ok: true }, codex: { ok: true } } }, 'Sessions are paused.'],
  ])('shows a readiness problem when %s', async (_name, sandbox, message) => {
    mockActive.api.workbenches.readiness.mockResolvedValueOnce({ sandbox } as Awaited<ReturnType<typeof mockActive.api.workbenches.readiness>>);
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByRole('alert', { name: message })).toBeVisible();
  });
  it('keeps the composer usable while a background refresh is owed', async () => {
    await render(<WorkbenchDetailScreen kind="session" />); await screen.findByText('Agent response 1');
    await act(async () => mockActive.emit('connection:status', { connected: false }));
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Still sendable');
    expect(screen.queryByText(/Refresh current session state/)).toBeNull();
    expect(screen.queryByText(/Stale data/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });
  it('supports a normal text send and shows acknowledged delivery', async () => {
    await render(<WorkbenchDetailScreen kind="session" />); await screen.findByText('Agent response 1');
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Hello from mobile');
    await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Sent')).toBeVisible();
    expect(mockActive.api.workbenches.sendMessage).toHaveBeenCalledWith('chat-one', { text: 'Hello from mobile' });
  });
  it('shows server queued state separately from Sent', async () => {
    mockActive.api.workbenches.sendMessage.mockResolvedValueOnce({ queued: true });
    await render(<WorkbenchDetailScreen kind="session" />); await screen.findByText('Agent response 1');
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Hello'); await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Queued on server')).toBeVisible(); expect(screen.queryByText('Sent')).toBeNull();
  });
  it('blocks offline sends and preserves the draft', async () => {
    await render(<WorkbenchDetailScreen kind="session" />); await screen.findByText('Agent response 1');
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Keep this draft'); mockNetwork = 'offline';
    await act(async () => mockActive.network({ reachability: 'offline' }));
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled(); expect(screen.getByDisplayValue('Keep this draft')).toBeVisible();
  });
  it('handles a supported human gate through text and leaves permissions read-only', async () => {
    mockActive.api.workbenches.get.mockResolvedValueOnce(session({ chats: [chat({ status: 'awaiting_input' })] }));
    await render(<WorkbenchDetailScreen kind="session" />); await screen.findByText('Agent response 1');
    expect(screen.getByText(/The agent is waiting for your reply/)).toBeVisible();
    expect(screen.getByPlaceholderText('Reply to the agent')).toBeVisible();
    expect(screen.queryByText(/desktop or web|Talyn on the web/)).toBeNull();
    expect(screen.queryByRole('button', { name: /approve|permission|terminal/i })).toBeNull();
  });
  it('shows the planning conversation and child sessions', async () => {
    mockParams = { id: 'thread-one' };
    await render(<WorkbenchDetailScreen kind="thread" />);
    expect(screen.queryByRole('link', { name: /^Current work\./ })).toBeNull();
    await fireEvent.press(await screen.findByRole('button', { name: 'Related sessions (1)' }));
    expect(mockActive.store.local('thread-chat').following).toBe(false);
    expect(await screen.findByRole('link', { name: /^Current work\./ })).toBeVisible();
    expect(screen.getByRole('header', { name: 'Planning work' })).toBeVisible();
    expect(await screen.findByLabelText('Message')).toBeVisible();
  });
  it('retains chat selection and drafts across detail navigation', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ chats: [chat(), chat({ id: 'chat-two', title: 'Second conversation' })] }));
    const view = await render(<WorkbenchDetailScreen kind="session" />); await screen.findByText('Agent response 1');
    await fireEvent.press(screen.getByRole('tab', { name: 'Second conversation · Idle' }));
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Second draft');
    expect(mockActive.store.local('selected:session-one').selectedChat).toBe('chat-two');
    await view.unmount(); await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByRole('tab', { name: 'Second conversation · Idle · Selected' })).toBeVisible();
    expect(screen.getByDisplayValue('Second draft')).toBeVisible();
  });
  it('shows a reviewer PR detail with one merge line and only the website link', async () => {
    mockParams = { id: 'pr-one' }; await render(<PullRequestDetailScreen />);
    expect(await screen.findByRole('header', { name: 'Review current work' })).toBeVisible();
    expect(screen.queryByText(/Mergeability|Merge state|Read only|on the web/)).toBeNull();
    expect(screen.getByText('GitHub has not said yet if this can merge.')).toBeVisible();
    expect(screen.getByLabelText('Status: Unknown')).toBeVisible();
    expect(screen.getByText('Live detail from GitHub is unavailable. Showing the last saved state.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open pull request website' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Merge$|Fix with agent/ })).toBeNull();
  });
  it('hides cached PR content until current authorization succeeds', async () => {
    await mockActive.store.load('pr', 'pr-one'); await mockActive.store.load('timeline', 'pr-one');
    const pending = deferred<Awaited<ReturnType<typeof mockActive.api.pullRequests.get>>>();
    mockActive.api.pullRequests.get.mockReturnValueOnce(pending.promise); mockParams = { id: 'pr-one' };
    await render(<PullRequestDetailScreen />); expect(screen.queryByText('Review current work')).toBeNull();
    await act(async () => pending.reject({ status: 403 }));
    expect(await screen.findByText('Access is unavailable. Check your account and workspace.')).toBeVisible();
    expect(screen.queryByText('Review current work')).toBeNull();
  });
  it('keeps uncertain delivery unknown and confirms manual resend', async () => {
    mockActive.api.workbenches.sendMessage.mockRejectedValueOnce(new TypeError('Network failure'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await render(<WorkbenchDetailScreen kind="session" />); await screen.findByText('Agent response 1');
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Hello'); await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Delivery unknown')).toBeVisible();
    await fireEvent.press(await screen.findByRole('button', { name: 'Review and resend' }));
    expect(mockActive.api.workbenches.sendMessage).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][2]![0]).toMatchObject({ text: 'Cancel', isPreferred: true });
    await act(async () => alert.mock.calls[0][2]![1].onPress?.());
    expect(mockActive.api.workbenches.sendMessage).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Sent')).toBeVisible();
  });
  it('renders only a bounded number of transcript rows', async () => {
    mockActive.api.workbenches.events.mockResolvedValueOnce({ events: Array.from({ length: 10000 }, (_, index) => event(index + 1)), cursor: 10000, oldestSeq: 1, hasOlder: false });
    await render(<WorkbenchDetailScreen kind="session" />); await screen.findByText(/History is limited/);
    expect(screen.getAllByText(/^Agent response /).length).toBeLessThan(50);
  });
});

describe('safe native text, links, and adaptable content', () => {
  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'https://user:pass@example.com', 'https://example.com\n/path'])('rejects %s', (url) => expect(safeExternalUrl(url)).toBeNull());
  it('renders code and raw HTML as selectable text without executing content', async () => {
    await render(<NativeText text={'<script>alert(1)</script>\n```ts\nconst value = 1;\n```'} />);
    expect(screen.getByText('<script>alert(1)</script>')).toBeVisible(); expect(screen.getByText('const value = 1;')).toBeVisible();
  });
  it('confirms external navigation and uses a minimum 48 point link target', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await render(<NativeText text="[Read docs](https://example.com/docs)" />);
    const link = screen.getByRole('link', { name: 'Open website: Read docs' }); expect(link).toHaveStyle({ minHeight: 48 });
    await fireEvent.press(link); expect(open).not.toHaveBeenCalled(); expect(alert).toHaveBeenCalled();
    await act(async () => alert.mock.calls[0][2]![1].onPress?.()); expect(open).toHaveBeenCalledWith('https://example.com/docs');
  });
  it('bounds long text and retains platform scaling with RTL text', async () => {
    jest.replaceProperty(I18nManager, 'isRTL', true);
    await render(<NativeText text={`مرحبا ${'long text '.repeat(3000)}`} />);
    expect(screen.getByText('Long text is limited in this view.')).toBeVisible();
    expect(screen.getByText(/^مرحبا/).props.maxFontSizeMultiplier).toBeUndefined();
  });
  it('preserves a failed draft and offers manual retry without resending', async () => {
    mockActive.api.workbenches.sendMessage.mockRejectedValueOnce({ status: 409 });
    await render(<WorkbenchDetailScreen kind="session" />); await screen.findByText('Agent response 1');
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Retry this'); await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Failed')).toBeVisible(); expect(screen.getByRole('button', { name: 'Retry message' })).toBeVisible();
    await waitFor(() => expect(mockActive.api.workbenches.sendMessage).toHaveBeenCalledTimes(1));
  });
});
