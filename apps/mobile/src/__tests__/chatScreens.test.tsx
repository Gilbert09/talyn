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
  setPlanMode: jest.fn(async (_chatId: string, _planMode: boolean) => ({})),
  answerQuestion: jest.fn(async (_chatId: string, _text: string) => ({ queued: false })) };
jest.mock('../features/chat/actions', () => ({ get chatActions() { return mockActions; } }));
beforeEach(() => { mockActive.store.dispose(); mockActive = fixture(); mockParams = { id: 'session-one' }; });
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const ev = (seq: number, body: Record<string, unknown>, turn = 1): WorkbenchEvent =>
  ({ chatId: 'chat-one', seq, turn, createdAt: '2026-11-08T11:00:00Z', event: { seq, ...body } as AgentEvent });
const transcript = (events: WorkbenchEvent[]) => mockActive.api.workbenches.events.mockResolvedValue({ events, cursor: events.length, oldestSeq: 1, hasOlder: false });
const scrollTranscript = async (y: number) => fireEvent.scroll(screen.getByLabelText('Conversation transcript'), {
  nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 360, height: 2000 }, layoutMeasurement: { width: 360, height: 600 } },
});

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
  it('draws a long paragraph as several Text views, so Android does not draw a blank box', async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `Line ${index} of a long brief`);
    await render(<Markdown text={lines.join('\n')} />);
    expect(screen.getByText(/^Line 0 of a long brief/)).toBeVisible();
    expect(screen.getByText(/Line 199 of a long brief$/)).toBeVisible();
    expect(screen.getAllByText(/Line \d+ of a long brief/).length).toBeGreaterThan(1);
  });
  it('renders an unsafe link as plain text', async () => {
    await render(<Markdown text="[click](javascript:alert(1))" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('click')).toBeVisible();
  });
  const SHOT = 'https://github.com/user-attachments/assets/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  it('shows an image as a thumbnail that opens full screen, with an open in browser action', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await render(<Markdown text={`Before\n\n<img width="1096" height="1280" alt="Login screen" src="${SHOT}" />`} />);
    expect(screen.getByText('Before')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Close image' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Open image: Login screen' }));
    expect(screen.getByRole('button', { name: 'Close image' })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Open in browser' }));
    expect(alert).toHaveBeenCalledWith('Open external website?', SHOT, expect.any(Array));
    await fireEvent.press(screen.getByRole('button', { name: 'Close image' }));
    expect(screen.queryByRole('button', { name: 'Close image' })).toBeNull();
  });
  it('shows an image that does not load as a row that opens the image in the browser', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await render(<Markdown text={`![Diagram](${SHOT})`} />);
    await fireEvent(screen.getByTestId('markdown-image'), 'error');
    expect(screen.queryByRole('button', { name: 'Open image: Diagram' })).toBeNull();
    expect(screen.getByText('Image unavailable: Diagram')).toBeVisible();
    await fireEvent.press(screen.getByRole('link', { name: 'Image unavailable: Diagram. Open in browser' }));
    expect(alert).toHaveBeenCalledWith('Open external website?', SHOT, expect.any(Array));
  });
});

describe('conversation rows', () => {
  it('saves the scroll position without moving the open list', async () => {
    mockActive.store.rememberOffset('chat-one', 24);
    await render(<WorkbenchDetailScreen kind="session" />);
    await screen.findByText('Agent response 1');
    const getOffset = () => screen.getByLabelText('Conversation transcript').props.contentOffset;
    const notify = jest.fn();
    const unsubscribe = mockActive.store.subscribe(notify);
    expect(getOffset()).toEqual({ x: 0, y: 24 });

    await scrollTranscript(40);
    expect(mockActive.store.local('chat-one').offset).toBe(40);
    expect(getOffset()).toEqual({ x: 0, y: 24 });
    expect(notify).not.toHaveBeenCalled();

    await scrollTranscript(80);
    expect(mockActive.store.local('chat-one')).toMatchObject({ offset: 80, following: false });
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    expect(getOffset()).toEqual({ x: 0, y: 24 });
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

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
  it('answers an open question with one tap and refreshes the conversation', async () => {
    transcript([
      ev(1, { type: 'user', talyn_user_message: true, message: { content: [{ type: 'text', text: 'Add storage' }] } }),
      ev(2, { type: 'talyn_question', id: 'q1', questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] }),
    ]);
    await render(<WorkbenchDetailScreen kind="session" />);
    const calls = mockActive.api.workbenches.get.mock.calls.length;
    await fireEvent.press(await screen.findByRole('button', { name: 'SQLite' }));
    expect(mockActions.answerQuestion).toHaveBeenCalledWith('chat-one', 'Which database?\n→ SQLite');
    await waitFor(() => expect(mockActive.api.workbenches.get.mock.calls.length).toBeGreaterThan(calls));
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

describe('subagents in the conversation', () => {
  it.each([false, true])('gates the live turn count, enabled=%s', async (enabled) => {
    mockActive.api.features.get.mockResolvedValue({ workbenches: true, sessionSubagents: enabled });
    mockActive.api.workbenches.get.mockResolvedValue(session({ chats: [chat({ status: 'running', agent: 'claude' })] }));
    const call = (id: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description: id } }] } });
    transcript([ev(1, call('old'), 1), ev(2, call('current'), 2)]);
    await render(<WorkbenchDetailScreen kind="session" />);
    expect((await screen.findAllByText('current'))[0]).toBeVisible();
    expect(Boolean(screen.queryByText('1 subagent running'))).toBe(enabled);
    expect(Boolean(screen.queryByRole('tab', { name: 'Subagent current, running' }))).toBe(enabled);
    expect(screen.queryByText('2 subagents running')).toBeNull();
    await act(async () => mockActive.emit('workbench:event', { workspaceId: 'one', chatId: 'chat-one', events: [
      ev(3, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'current', content: 'done' }] } }, 2),
    ] }));
    expect(screen.queryByText('1 subagent running')).toBeNull();
  });

  const agent = (id: string, description: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent',
    input: { subagent_type: 'Explore', description, prompt: `Brief for ${description}.` } }] } });
  const step = (id: string, parent: string) => ({ type: 'assistant', parent_tool_use_id: parent,
    message: { content: [{ type: 'tool_use', id, name: 'Grep', input: { pattern: 'entry' } }] } });

  it('opens each running subagent from the chip, then goes back to the main transcript', async () => {
    mockActive.api.features.get.mockResolvedValue({ workbenches: true, sessionSubagents: true });
    mockActive.api.workbenches.get.mockResolvedValue(session({ chats: [chat({ status: 'running', agent: 'claude' })] }));
    transcript([ev(1, agent('a', 'Find the entry')), ev(2, agent('b', 'Check the tests')), ev(3, step('g', 'a'))]);
    await render(<WorkbenchDetailScreen kind="session" />);
    const chip = await screen.findByRole('button', { name: "2 subagents running. Open a subagent's tab" });
    expect(screen.getByRole('tab', { name: 'Main transcript', selected: true })).toBeVisible();
    await scrollTranscript(90);
    await fireEvent.press(chip);
    expect(screen.getByRole('tab', { name: 'Subagent Find the entry, running', selected: true })).toBeVisible();
    expect(screen.getByTestId('subagent-transcript')).toBeVisible();
    expect(screen.getByText('Brief for Find the entry.')).toBeVisible();
    expect(screen.getByText('Still working')).toBeVisible();
    await fireEvent.press(chip);
    expect(screen.getByRole('tab', { name: 'Subagent Check the tests, running', selected: true })).toBeVisible();
    expect(screen.getByText('Brief for Check the tests.')).toBeVisible();
    await fireEvent.press(screen.getByRole('tab', { name: 'Main transcript' }));
    expect(screen.queryByTestId('subagent-transcript')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Main transcript', selected: true })).toBeVisible();
    expect(screen.getByLabelText('Conversation transcript').props.contentOffset).toEqual({ x: 0, y: 90 });
  });

  it('opens a subagent tab from the card and shows its result when it ends', async () => {
    mockActive.api.features.get.mockResolvedValue({ workbenches: true, sessionSubagents: true });
    mockActive.api.workbenches.get.mockResolvedValue(session({ chats: [chat({ status: 'running', agent: 'claude' })] }));
    transcript([ev(1, agent('a', 'Find the entry'))]);
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Open Find the entry in a tab' }));
    expect(screen.getByTestId('subagent-transcript')).toBeVisible();
    await act(async () => mockActive.emit('workbench:event', { workspaceId: 'one', chatId: 'chat-one', events: [
      ev(2, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Found it in main.ts.' }] } }),
    ] }));
    expect(screen.getByText('Found it in main.ts.')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Subagent Find the entry', selected: true })).toBeVisible();
  });

  it('shows no tabs and no Open button with the flag off', async () => {
    mockActive.api.features.get.mockResolvedValue({ workbenches: true, sessionSubagents: false });
    mockActive.api.workbenches.get.mockResolvedValue(session({ chats: [chat({ status: 'running', agent: 'claude' })] }));
    transcript([ev(1, agent('a', 'Find the entry'))]);
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByText('Find the entry')).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Main transcript' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Find the entry in a tab' })).toBeNull();
  });

  it('shows the stopped subagents note with the flag off', async () => {
    mockActive.api.features.get.mockResolvedValue({ workbenches: true, sessionSubagents: false });
    transcript([ev(1, { type: 'system', subtype: 'subagents_stopped', text: 'Two subagents stopped.' })]);
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByText('Two subagents stopped.')).toBeVisible();
  });
});
