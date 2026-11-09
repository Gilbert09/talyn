import type { ApiToken, Features } from '@talyn/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Alert } from 'react-native';

import { ApiTokensScreen } from '../features/apiTokens/ApiTokensScreen';
import { CreateApiTokenScreen } from '../features/apiTokens/CreateApiTokenScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockList = jest.fn();
const mockCreate = jest.fn();
const mockRevoke = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();
let mockFeatures: Partial<Features> | null;

jest.mock('@talyn/client/native', () => ({
  apiTokens: {
    list: (...args: unknown[]) => mockList(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    revoke: (...args: unknown[]) => mockRevoke(...args),
  },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'w1', choices: [{ id: 'w1', name: 'PostHog' }, { id: 'w2', name: 'Talyn' }] }),
  useNetwork: () => 'online',
}));
jest.mock('../lib/features', () => ({ useFeatures: () => mockFeatures }));
jest.mock('expo-router', () => ({
  useFocusEffect: jest.fn(),
  useRouter: () => ({ push: mockPush, back: mockBack, replace: jest.fn() }),
  router: { navigate: jest.fn() },
}));
jest.mock('../features/settings/editors/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({ leave: (go: () => void) => go() }), DISCARD_TITLE: 'Discard changes?',
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const SECRET = 'talyn_pat_ab12cd_secretpart';
const token = (overrides: Partial<ApiToken> = {}): ApiToken => ({
  id: 't1', name: 'CI script', tokenPrefix: 'talyn_pat_ab12cd', scopes: ['workspaces:read', 'sessions:read', 'sessions:write'],
  workspaceIds: ['w2'], createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), lastUsedAt: null,
  expiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(), ...overrides,
});
const clipboard = Clipboard as jest.Mocked<typeof Clipboard>;

beforeEach(() => {
  mockFeatures = { publicApi: true };
  mockList.mockResolvedValue([token()]);
  mockRevoke.mockResolvedValue(undefined);
  mockCreate.mockResolvedValue({ token: SECRET, apiToken: token({ id: 't2' }) });
});

describe('API tokens list', () => {
  it('shows a token by its prefix and revokes it after a confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(<ApiTokensScreen />);
    expect(await screen.findByText('CI script')).toBeTruthy();
    expect(screen.getByText('talyn_pat_ab12cd…')).toBeTruthy();
    expect(screen.getByText('Sessions: read & write')).toBeTruthy();
    expect(screen.getByText('Talyn')).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();

    await act(async () => { fireEvent.press(screen.getByLabelText('Revoke CI script')); });
    expect(alert).toHaveBeenCalledWith('Revoke "CI script"?', 'Anything that uses this token stops working at once. You cannot undo this.', expect.any(Array));
    expect(mockRevoke).not.toHaveBeenCalled();
    await act(async () => { alert.mock.calls[0]![2]!.find((button) => button.text === 'Revoke token')!.onPress!(); });
    expect(mockRevoke).toHaveBeenCalledWith('t1');
    expect(screen.queryByText('CI script')).toBeNull();
    alert.mockRestore();
  });

  it('keeps the token and says why when a revoke fails', async () => {
    mockRevoke.mockRejectedValue(Object.assign(new Error('Token not found'), { status: 404 }));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(<ApiTokensScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Revoke CI script')); });
    await act(async () => { alert.mock.calls[0]![2]!.find((button) => button.text === 'Revoke token')!.onPress!(); });
    expect(alert).toHaveBeenLastCalledWith('Could not revoke the token', 'Token not found');
    expect(screen.getByText('CI script')).toBeTruthy();
    alert.mockRestore();
  });

  it('opens the create screen', async () => {
    await render(<ApiTokensScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Create token')); });
    expect(mockPush).toHaveBeenCalledWith('/settings/apiTokens/new');
  });

  it('lets old tokens be revoked when new ones cannot be made', async () => {
    mockFeatures = { publicApi: false };
    await render(<ApiTokensScreen />);
    expect(await screen.findByText('You cannot create new tokens right now. You can still revoke the tokens you have.')).toBeTruthy();
    expect(screen.queryByLabelText('Create token')).toBeNull();
    expect(screen.getByLabelText('Revoke CI script')).toBeTruthy();
  });

  it('says the feature is not available when it is off and there are no tokens', async () => {
    mockFeatures = { publicApi: false };
    mockList.mockResolvedValue([]);
    await render(<ApiTokensScreen />);
    expect(await screen.findByText('API tokens are not available')).toBeTruthy();
  });
});

describe('create an API token', () => {
  it('creates the token, shows it once and copies it', async () => {
    await render(<CreateApiTokenScreen />);
    expect(screen.getByLabelText('Create token').props.accessibilityState.disabled).toBe(true);
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Name'), '  Deploy bot '); });
    await act(async () => { fireEvent.press(screen.getByRole('tab', { name: '1 year' })); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Full access')); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Create token')); });
    expect(mockCreate).toHaveBeenCalledWith({ name: 'Deploy bot', scopes: ['workspaces:read', 'repositories:read', 'sessions:read', 'sessions:write'],
      workspaceIds: null, expiresInDays: 365 });

    expect(screen.getByText(SECRET)).toBeTruthy();
    expect(screen.getByText("You won't see this token again. Copy it now and keep it somewhere safe.")).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Copy token')); });
    expect(clipboard.setStringAsync).toHaveBeenCalledWith(SECRET);
    expect(screen.getByText('Token copied')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Copy curl command')); });
    expect(clipboard.setStringAsync).toHaveBeenLastCalledWith(`curl https://api.talyn.dev/v1/me -H "Authorization: Bearer ${SECRET}"`);
    await act(async () => { fireEvent.press(screen.getByLabelText('Done')); });
    expect(mockBack).toHaveBeenCalled();
  });

  it('shows the server message and no token when the create fails', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('You have too many tokens.'), { status: 400 }));
    await render(<CreateApiTokenScreen />);
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Name'), 'CI'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Create token')); });
    expect(screen.getByText('You have too many tokens.')).toBeTruthy();
    expect(screen.queryByText(SECRET)).toBeNull();
  });

  it('limits the token to one workspace', async () => {
    await render(<CreateApiTokenScreen />);
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Name'), 'CI'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Workspace: All workspaces. Change')); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Talyn')); });
    await act(async () => { fireEvent.press(screen.getByRole('tab', { name: 'No expiry' })); });
    expect(screen.getByText('A token with no expiry stays valid until you revoke it.')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByLabelText('Create token')); });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ workspaceIds: ['w2'], expiresInDays: null }));
  });

  it('needs at least one kind of access', async () => {
    await render(<CreateApiTokenScreen />);
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Name'), 'CI'); });
    for (const label of ['Workspaces access', 'Repositories access', 'Sessions access']) {
      await act(async () => { fireEvent.press(within(screen.getByLabelText(label)).getByRole('tab', { name: 'None' })); });
    }
    expect(screen.getByText('Give the token access to at least one thing.')).toBeTruthy();
    expect(screen.getByLabelText('Create token').props.accessibilityState.disabled).toBe(true);
  });

  it('does not offer the form when minting is off', async () => {
    mockFeatures = { publicApi: false };
    await render(<CreateApiTokenScreen />);
    expect(screen.getByText('You cannot create new tokens right now')).toBeTruthy();
    expect(screen.queryByLabelText('Name')).toBeNull();
  });
});
