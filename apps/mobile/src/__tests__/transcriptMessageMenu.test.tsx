import type { Workbench } from '@talyn/shared';
import * as Clipboard from 'expo-clipboard';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { MessageMenuContext, useMessageMenu } from '../features/chat/messageMenu';
import { AgentText, UserBubble } from '../features/chat/TranscriptParts';
import { MESSAGE_ACTION_LABEL, selectedText } from '../features/sessions/actions';
import { trackEvent } from '../lib/analytics';
import { session, thread } from './workflowFixtures';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('../lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../auth/AuthProvider', () => ({ useMobileRuntime: () => ({}), useNetwork: () => 'online' }));

const MESSAGE = 'Fix the login bug.\nThen add a test.';

function Harness({ item, children }: { item: Workbench; children: React.ReactNode }) {
  const menu = useMessageMenu(item);
  return <MessageMenuContext.Provider value={menu.open}>{children}{menu.elements}</MessageMenuContext.Provider>;
}

const renderAgent = (item: Workbench = session()) =>
  render(<Harness item={item}><AgentText text={MESSAGE} streaming={false} /></Harness>);
const agentMessage = () => screen.getByLabelText(`Agent said: ${MESSAGE}`);
const openMenu = async () => { await fireEvent(agentMessage(), 'longPress'); };
const pressAction = async (label: string) => { await fireEvent.press(await screen.findByRole('button', { name: label })); };

beforeEach(() => jest.clearAllMocks());

describe('selectedText', () => {
  it.each<[string, { start: number; end: number }, string]>([
    ['a range', { start: 4, end: 9 }, 'the l'],
    ['a reversed range', { start: 9, end: 4 }, 'the l'],
    ['a collapsed caret', { start: 3, end: 3 }, ''],
    ['only whitespace', { start: 3, end: 4 }, ''],
    ['past the end', { start: 30, end: 99 }, 'test.'],
    ['before the start', { start: -5, end: 3 }, 'Fix'],
    ['all of it', { start: 0, end: MESSAGE.length }, MESSAGE],
  ])('%s', (_name, selection, expected) => expect(selectedText(MESSAGE, selection)).toBe(expected));
});

describe('the message long-press menu', () => {
  it('lists the three message actions', async () => {
    await renderAgent();
    await openMenu();
    for (const label of [MESSAGE_ACTION_LABEL.new_session, MESSAGE_ACTION_LABEL.copy, MESSAGE_ACTION_LABEL.select]) {
      expect(await screen.findByRole('button', { name: label })).toBeVisible();
    }
  });

  it.each<[string, Workbench, Record<string, string>]>([
    ['a session: the session repository', session(), { mode: 'session', repository: 'example/project', prompt: '> Fix the login bug.\n> Then add a test.\n\n' }],
    ['a thread: no repository', thread(), { mode: 'session', prompt: '> Fix the login bug.\n> Then add a test.\n\n' }],
  ])('starts a new session from the whole message in %s', async (_name, item, params) => {
    await renderAgent(item);
    await openMenu();
    await pressAction(MESSAGE_ACTION_LABEL.new_session);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/new', params });
    expect(trackEvent).toHaveBeenCalledWith('session_from_selection', expect.objectContaining({
      chars: MESSAGE.length, via: 'message', repository_prefilled: Boolean(params.repository) }));
  });

  it('copies the message', async () => {
    await renderAgent();
    await openMenu();
    await pressAction(MESSAGE_ACTION_LABEL.copy);
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(MESSAGE);
    expect(await screen.findByText('Message copied.')).toBeVisible();
  });

  it('opens a user message too', async () => {
    await render(<Harness item={session()}><UserBubble text="Please fix it" timestamp={null} attachments={0} now={0} /></Harness>);
    await fireEvent(screen.getByLabelText('You said: Please fix it'), 'longPress');
    expect(await screen.findByRole('button', { name: MESSAGE_ACTION_LABEL.new_session })).toBeVisible();
  });

  it('offers the menu to screen readers as an action', async () => {
    await renderAgent();
    await fireEvent(agentMessage(), 'accessibilityAction', { nativeEvent: { actionName: 'longpress' } });
    expect(await screen.findByRole('button', { name: MESSAGE_ACTION_LABEL.copy })).toBeVisible();
  });

  it('keeps native selection outside a conversation', async () => {
    await render(<AgentText text="Plain" streaming={false} />);
    expect(screen.getByText('Plain').props.selectable).toBe(true);
  });

  it('turns native selection off inside a conversation', async () => {
    await render(<Harness item={session()}><AgentText text="Plain" streaming={false} /></Harness>);
    expect(screen.getByText('Plain').props.selectable).toBe(false);
  });
});

describe('Select text', () => {
  const openSelect = async () => {
    await renderAgent();
    await openMenu();
    await pressAction(MESSAGE_ACTION_LABEL.select);
    return screen.findByTestId('select-text-input');
  };

  it('starts a new session from the selected part', async () => {
    const input = await openSelect();
    expect(screen.getByRole('button', { name: MESSAGE_ACTION_LABEL.new_session })).toBeVisible();
    // RNTL drops events on a non-editable field (the iOS setting); a real iOS field still reports its selection.
    await act(() => input.props.onSelectionChange({ nativeEvent: { selection: { start: 4, end: 18 } } }));
    await pressAction(MESSAGE_ACTION_LABEL.new_from_selection);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/new', params: { mode: 'session', repository: 'example/project', prompt: '> the login bug.\n\n' } });
    expect(trackEvent).toHaveBeenCalledWith('session_from_selection', expect.objectContaining({ via: 'selection', chars: 14 }));
    expect(screen.queryByTestId('select-text-input')).toBeNull();
  });

  it('uses the whole message with no selection', async () => {
    await openSelect();
    await pressAction(MESSAGE_ACTION_LABEL.new_session);
    expect(mockRouter.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ prompt: '> Fix the login bug.\n> Then add a test.\n\n' }) }));
  });

  it('ignores edits and closes', async () => {
    const input = await openSelect();
    await act(() => input.props.onChangeText('changed'));
    expect(screen.getByTestId('select-text-input').props.value).toBe(MESSAGE);
    await pressAction('Close');
    expect(screen.queryByTestId('select-text-input')).toBeNull();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});
