import type { AgentEvent, WorkbenchEvent } from '@talyn/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { FlatList } from 'react-native';

import { FIND_PARTIAL_DETAIL, FIND_PARTIAL_HINT } from '../features/chat/FindBar';
import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { fixture } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'session-one' }),
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  // Draw the header so the test can open the session menu.
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => ReactNode } }) => options?.headerRight?.() ?? null },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store }), useNetwork: () => 'online',
  useWorkspace: () => ({ selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
}));
beforeEach(() => { mockActive.store.dispose(); mockActive = fixture(); });
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const ev = (seq: number, body: Record<string, unknown>, turn = 1): WorkbenchEvent =>
  ({ chatId: 'chat-one', seq, turn, createdAt: '2026-11-08T11:00:00Z', event: { seq, ...body } as AgentEvent });
const said = (seq: number, text: string, turn = 1) => ev(seq, { type: 'assistant', message: { content: [{ type: 'text', text }] } }, turn);
const asked = (seq: number, text: string, turn: number) => ev(seq, { type: 'user', talyn_user_message: true, message: { content: [{ type: 'text', text }] } }, turn);

async function openSearch() {
  await fireEvent.press(screen.getByRole('button', { name: 'Session actions' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Find in transcript' }));
}

async function openFind(events: WorkbenchEvent[], hasOlder = false) {
  mockActive.api.workbenches.events.mockResolvedValue({ events, cursor: events.length, oldestSeq: 1, hasOlder });
  await render(<WorkbenchDetailScreen kind="session" />);
  await screen.findAllByLabelText(/^Agent said: /);
  await openSearch();
}

describe('find in the conversation', () => {
  const events = [asked(1, 'Fix the build', 1), said(2, 'The build is fixed.', 1), asked(3, 'Thanks', 2), said(4, 'Build passed again.', 2)];

  it('counts the matches and selects the newest first', async () => {
    const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    await openFind(events);
    await fireEvent.changeText(screen.getByPlaceholderText('Find in transcript'), 'BUILD');
    expect(screen.getByText('3 of 3')).toBeVisible();
    // The list is newest first, so the newest match is at index 0.
    expect(scroll).toHaveBeenLastCalledWith(expect.objectContaining({ index: 0 }));
  });

  it('moves between matches and wraps at each end', async () => {
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    await openFind(events);
    const field = screen.getByPlaceholderText('Find in transcript');
    await fireEvent.changeText(field, 'build');
    await fireEvent.press(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText('2 of 3')).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Previous match' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText('3 of 3')).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('1 of 3')).toBeVisible();
    await fireEvent(field, 'submitEditing');
    expect(screen.getByText('2 of 3')).toBeVisible();
  });

  it('says when nothing matches and disables the arrows', async () => {
    await openFind(events);
    await fireEvent.changeText(screen.getByPlaceholderText('Find in transcript'), 'deploy');
    expect(screen.getByText('No results')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled();
  });

  it('marks the matched words in a message', async () => {
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    await openFind(events);
    await fireEvent.changeText(screen.getByPlaceholderText('Find in transcript'), 'passed');
    expect(screen.getByText('passed')).toBeVisible();
  });

  it('closes and clears the query', async () => {
    await openFind(events);
    await fireEvent.changeText(screen.getByPlaceholderText('Find in transcript'), 'build');
    await fireEvent.press(screen.getByRole('button', { name: 'Close find' }));
    expect(screen.queryByPlaceholderText('Find in transcript')).toBeNull();
    expect(screen.queryByText('3 of 3')).toBeNull();
    await openSearch();
    expect(screen.getByPlaceholderText('Find in transcript')).toHaveProp('value', '');
  });

  it('says that only loaded messages are searched while older ones are not loaded', async () => {
    await openFind(events, true);
    expect(screen.getByText(FIND_PARTIAL_HINT)).toBeVisible();
    expect(screen.getByLabelText(FIND_PARTIAL_DETAIL)).toBeVisible();
  });

  it('has no hint when the whole conversation is loaded', async () => {
    await openFind(events, false);
    expect(screen.queryByText(FIND_PARTIAL_HINT)).toBeNull();
  });

  it('keeps the selected match when new messages arrive', async () => {
    jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
    await openFind(events);
    await fireEvent.changeText(screen.getByPlaceholderText('Find in transcript'), 'build');
    await fireEvent.press(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText('2 of 3')).toBeVisible();
    const more = [...events, asked(5, 'One more build', 3)];
    mockActive.api.workbenches.events.mockResolvedValue({ events: more, cursor: more.length, oldestSeq: 1, hasOlder: false });
    await act(async () => { await mockActive.store.load('transcript', 'chat-one'); });
    expect(await screen.findByText('2 of 4')).toBeVisible();
  });
});
