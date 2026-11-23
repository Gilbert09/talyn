import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { FleetReconnectNotice } from '../features/agents/FleetReconnectNotice';
import { TurnFailureActions } from '../features/chat/TurnFailureActions';

const mockPush = jest.fn();
const mockRefresh = jest.fn();
const mockSend = jest.fn(async (..._args: unknown[]) => undefined);
const mockCancelResume = jest.fn(async (..._args: unknown[]) => undefined);
let mockProviders: unknown[] | undefined;
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../workflow/hooks', () => ({ useResource: () => ({ data: mockProviders }) }));
jest.mock('../auth/AuthProvider', () => ({ useMobileRuntime: () => ({ workflow: { refresh: mockRefresh } }) }));
jest.mock('../features/chat/actions', () => ({ chatActions: { cancelResume: (...args: unknown[]) => mockCancelResume(...args), send: (...args: unknown[]) => mockSend(...args) } }));

beforeEach(() => { mockProviders = undefined; jest.clearAllMocks(); });

it.each([undefined, [], [{ type: 'selfhosted', connectedAgents: ['claude'], reauthAgents: [] }]])('hides the notice without a reconnect: %j', async (providers) => {
  mockProviders = providers;
  await render(<FleetReconnectNotice />);
  expect(screen.queryByText('Reconnect')).toBeNull();
});

it('names affected accounts despite another working account and opens agent settings', async () => {
  mockProviders = [{ type: 'selfhosted', connectedAgents: ['claude', 'codex'], reauthAgents: ['claude'],
    reauthAccounts: [{ id: 'one', label: 'Personal Claude', agent: 'claude' }, { id: 'two', label: 'Work Claude', agent: 'claude' }] }];
  const view = await render(<FleetReconnectNotice />);
  expect(screen.getByText('Personal Claude and Work Claude need to be signed in again.')).toBeVisible();
  await fireEvent.press(screen.getByText('Reconnect'));
  expect(mockPush).toHaveBeenCalledWith('/agents');
  mockProviders = [{ type: 'selfhosted', reauthAgents: [] }];
  await view.rerender(<FleetReconnectNotice />);
  expect(screen.queryByText('Reconnect')).toBeNull();
});

it('offers Reconnect beside Retry and preserves the retry request', async () => {
  await render(<TurnFailureActions chatId="chat" workbenchId="wb" text="Sign in again" reconnect />);
  await fireEvent.press(screen.getByText('Reconnect'));
  expect(mockPush).toHaveBeenCalledWith('/agents');
  await fireEvent.press(screen.getByText('Retry'));
  await waitFor(() => expect(mockSend).toHaveBeenCalledWith('chat', {
    text: 'Continue from where you stopped. The last turn ended with an error: Sign in again.',
  }));
  expect(mockRefresh).toHaveBeenCalledWith('transcript', 'chat');
});

it('does not offer Reconnect for other errors', async () => {
  await render(<TurnFailureActions chatId="chat" workbenchId="wb" text="No capacity." reconnect={false} />);
  expect(screen.queryByText('Reconnect')).toBeNull();
  expect(screen.getByText('Retry')).toBeVisible();
});


it.each([true, false])('shows a waiting line with cancel, reconnect=%s', async (reconnect) => {
  await render(<TurnFailureActions chatId="chat" workbenchId="wb" text="Sign in again" reconnect={reconnect}
    resumeAt="2026-11-16T17:00:00Z" />);
  expect(screen.getByText(reconnect ? /Waiting for the account to be signed in again. Checks again at/ : /Waiting for usage. Resumes at/)).toBeVisible();
  expect(screen.queryByText('Retry')).toBeNull();
  await fireEvent.press(screen.getByText('Cancel'));
  await waitFor(() => expect(mockCancelResume).toHaveBeenCalledWith('chat'));
  expect(mockRefresh).toHaveBeenCalledWith('workbench', 'wb');
});
