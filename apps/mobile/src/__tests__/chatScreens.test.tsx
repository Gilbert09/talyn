import { PLAN_APPROVED_MESSAGE, type AgentEvent, type WorkbenchEvent } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';

import { Markdown } from '../features/chat/Markdown';
import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { chat, fixture, session } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
let mockParams = { id: 'session-one' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  Stack: { Screen: () => null },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store }), useNetwork: () => 'online',
  useWorkspace: () => ({ selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
}));
const mockActions = { stop: jest.fn(async (_chatId: string) => undefined), approvePlan: jest.fn(async (_chatId: string) => ({ queued: false })),
  setPlanMode: jest.fn(async (_chatId: string, _planMode: boolean) => ({})) };
jest.mock('../features/chat/actions', () => ({ get chatActions() { return mockActions; } }));
beforeEach(() => { mockActive.store.dispose(); mockActive = fixture(); mockParams = { id: 'session-one' }; });
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const ev = (seq: number, body: Record<string, unknown>, turn = 1): WorkbenchEvent =>
  ({ chatId: 'chat-one', seq, turn, createdAt: '2026-11-08T11:00:00Z', event: { seq, ...body } as AgentEvent });
const transcript = (events: WorkbenchEvent[]) => mockActive.api.workbenches.events.mockResolvedValue({ events, cursor: events.length, oldestSeq: 1, hasOlder: false });

describe('markdown messages', () => {
  it('renders markdown without raw syntax and keeps links inline behind a confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await render(<Markdown text={'## Title\n\nSee **the** [docs](https://example.com/docs) and `code`.\n\n```sh\nnpm test\n```'} />);
    expect(screen.getByRole('header', { name: 'Title' })).toBeVisible();
    expect(screen.queryByText(/\*\*|\[docs\]/)).toBeNull();
    expect(screen.queryByText(/^Open /)).toBeNull();
    expect(screen.getByText('npm test')).toBeVisible();
    await fireEvent.press(screen.getByRole('link', { name: 'Open website: docs' }));
    expect(open).not.toHaveBeenCalled();
    await act(async () => alert.mock.calls[0][2]![1].onPress?.());
    expect(open).toHaveBeenCalledWith('https://example.com/docs');
  });
  it('renders an unsafe link as plain text', async () => {
    await render(<Markdown text="[click](javascript:alert(1))" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('click')).toBeVisible();
  });
});

describe('conversation rows', () => {
  it('shows a user bubble, agent text, and a compact tool line that expands to its result', async () => {
    transcript([
      ev(1, { type: 'user', talyn_user_message: true, message: { content: [{ type: 'text', text: 'Please build' }] } }),
      ev(2, { type: 'assistant', message: { content: [{ type: 'text', text: 'Listing **now**' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm run build' } }] } }),
      ev(3, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"files":["a\\nb"]}' }] } }),
    ]);
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByLabelText(/^You said: Please build/)).toBeVisible();
    expect(screen.getByLabelText('Agent said: Listing **now**')).toBeVisible();
    expect(screen.queryByText(/Tool result|Time unavailable|^Agent$|^System$/)).toBeNull();
    const line = screen.getByRole('button', { name: 'bash npm run build' });
    expect(screen.queryByText(/"files"/)).toBeNull();
    await fireEvent.press(line);
    expect(screen.getByText('Input')).toBeVisible(); expect(screen.getAllByText('npm run build')).toHaveLength(2);
    expect(screen.getByText(/"files": \[\n {4}"a\nb"/, { normalizer: (text) => text })).toBeVisible();
  });
  it('shows a failed turn inline and the opened pull request as a link to its detail', async () => {
    transcript([
      ev(1, { type: 'talyn_pr', ok: true, number: 132020, url: 'https://github.com/example/project/pull/132020' }),
      ev(2, { type: 'result', subtype: 'error', is_error: true, result: 'Out of memory' }),
    ]);
    mockActive.api.workbenches.get.mockResolvedValue(session({ pr: { number: 132020, state: 'open' } as never }));
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByRole('link', { name: 'Opened pull request #132020. Open pull request' })).toBeVisible();
    expect(screen.getByRole('alert', { name: 'Turn failed. Out of memory' })).toBeVisible();
  });
  it('shows a permission request without the old desktop copy', async () => {
    transcript([ev(1, { type: 'talyn_permission_request', requestId: 'r1', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })]);
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByLabelText('Bash is waiting for approval. rm -rf build')).toBeVisible();
    expect(screen.queryByText(/desktop or web/)).toBeNull();
  });
});

describe('plans and stopping', () => {
  const planEvents = [
    ev(1, { type: 'user', talyn_user_message: true, message: { content: [{ type: 'text', text: 'Plan the change' }] } }),
    ev(2, { type: 'assistant', message: { content: [{ type: 'text', text: 'My plan.\n\n```talyn-plan\n1. Edit the file\n```' }] } }),
  ];
  it('approves an open plan with one tap and refreshes the conversation', async () => {
    transcript(planEvents);
    await render(<WorkbenchDetailScreen kind="session" />);
    const calls = mockActive.api.workbenches.get.mock.calls.length;
    await fireEvent.press(await screen.findByRole('button', { name: 'Approve and build' }));
    expect(mockActions.approvePlan).toHaveBeenCalledWith('chat-one');
    await waitFor(() => expect(mockActive.api.workbenches.get.mock.calls.length).toBeGreaterThan(calls));
  });
  it('keeps planning by turning plan mode on', async () => {
    transcript(planEvents);
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: /^Keep planning/ }));
    expect(mockActions.setPlanMode).toHaveBeenCalledWith('chat-one', true);
  });
  it('marks a plan approved by the next message and offers no buttons', async () => {
    transcript([...planEvents, ev(3, { type: 'user', talyn_user_message: true, message: { content: [{ type: 'text', text: PLAN_APPROVED_MESSAGE }] } }, 2)]);
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByText('Approved')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Approve and build' })).toBeNull();
  });
  it('replaces send with a single-tap stop while the agent works', async () => {
    mockActive.api.workbenches.get.mockResolvedValue(session({ chats: [chat({ status: 'running' })] }));
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByText('Working')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Stop the agent' }));
    expect(mockActions.stop).toHaveBeenCalledWith('chat-one');
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Next');
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeEnabled();
  });
  it('has no text buttons for paging', async () => {
    await render(<WorkbenchDetailScreen kind="session" />); await screen.findByText('Agent response 1');
    expect(screen.queryByRole('button', { name: /Load older|Load latest|Conversation details/ })).toBeNull();
  });
});
