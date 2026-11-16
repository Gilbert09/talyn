import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { IntegrationsScreen } from '../features/integrations/IntegrationsScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockLoad = jest.fn(async (_entity: string) => undefined);
const mockStatus = jest.fn();
const mockSave = jest.fn();
const mockStartOAuth = jest.fn();
const mockDisconnect = jest.fn();
const mockTrunkStatus = jest.fn();
const mockTrunkSave = jest.fn();
const mockTrunkRemove = jest.fn();
const mockUpdate = jest.fn();
const mockOpenReturn = jest.fn();
const mockInboxStatus = jest.fn();
let mockFeatures: Record<string, boolean> | null = { trunkMergeEta: true };

jest.mock('@talyn/client/native', () => ({
  ...jest.requireActual('@talyn/client/native'),
  posthog: {
    getStatus: (...a: unknown[]) => mockStatus(...a), saveConfig: (...a: unknown[]) => mockSave(...a),
    startOAuth: (...a: unknown[]) => mockStartOAuth(...a), disconnect: (...a: unknown[]) => mockDisconnect(...a),
  },
  trunk: {
    getStatus: (...a: unknown[]) => mockTrunkStatus(...a), saveToken: (...a: unknown[]) => mockTrunkSave(...a),
    removeToken: (...a: unknown[]) => mockTrunkRemove(...a),
  },
  workspaces: { update: (...a: unknown[]) => mockUpdate(...a) },
  workflows: { posthogInboxStatus: (...a: unknown[]) => mockInboxStatus(...a) },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ lifecycle: mockLifecycle, workflow: { load: mockLoad } }),
  useWorkspace: () => ({ status: 'ready', selected: 'ws-1', choices: [] }),
  useNetwork: () => 'online',
}));
jest.mock('../workflow/hooks', () => ({
  useResource: () => ({ status: 'ready', data: { id: 'ws-1', settings: {} }, refresh: jest.fn() }),
}));
jest.mock('../lib/features', () => ({ ...jest.requireActual('../lib/features'), useFeatures: () => mockFeatures }));
jest.mock('../lib/returnTo', () => ({
  appReturnBase: () => 'talyn-mobile://',
  openReturnFlow: (...a: unknown[]) => mockOpenReturn(...a),
}));
jest.mock('expo-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => children }));

const apiError = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, code });

beforeEach(() => {
  mockFeatures = { trunkMergeEta: true };
  mockStatus.mockResolvedValue({ connected: false, oauthAvailable: false });
  mockTrunkStatus.mockResolvedValue({ connected: false, needsReauth: false });
  mockOpenReturn.mockResolvedValue('returned');
  mockDisconnect.mockResolvedValue(undefined);
});

describe('PostHog Code retired', () => {
  const NOTICE = 'PostHog Code is going away. Move your work to Claude or Codex.';

  it('offers no way to connect with the flag on and nothing connected', async () => {
    mockFeatures = { posthogCodeRetired: true };
    mockStatus.mockResolvedValue({ connected: false, oauthAvailable: true });
    await render(<IntegrationsScreen kind="posthog" />);
    expect(await screen.findByText(/no longer available for new connections/)).toBeVisible();
    expect(screen.queryByLabelText('Connect with PostHog')).toBeNull();
    expect(screen.queryByLabelText('Personal API key')).toBeNull();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('keeps a connection and its Disconnect with the flag on, and shows the notice', async () => {
    mockFeatures = { posthogCodeRetired: true };
    mockStatus.mockResolvedValue({ connected: true, oauthAvailable: true, authMethod: 'oauth', projectId: '9', host: 'https://eu.posthog.com' });
    await render(<IntegrationsScreen kind="posthog" />);
    expect(await screen.findByText(NOTICE)).toBeVisible();
    expect(screen.getByLabelText('Disconnect PostHog Code')).toBeVisible();
    expect(screen.getByLabelText('Reconnect')).toBeVisible();
  });

  it.each([
    ['off', { posthogCodeRetired: false }],
    ['unknown', null],
  ])('connects as today with the flag %s', async (_label, features) => {
    mockFeatures = features;
    mockStatus.mockResolvedValue({ connected: false, oauthAvailable: true });
    await render(<IntegrationsScreen kind="posthog" />);
    expect(await screen.findByLabelText('Connect with PostHog')).toBeVisible();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

describe('PostHog Code', () => {
  it('saves a personal API key, clears it, and shows the connection', async () => {
    const saved = { connected: true, projectId: '2', host: 'https://us.posthog.com', authMethod: 'personal_api_key' };
    mockSave.mockResolvedValue(saved);
    mockStatus.mockResolvedValueOnce({ connected: false, oauthAvailable: false }).mockResolvedValue(saved);
    await render(<IntegrationsScreen kind="posthog" />);
    const key = await screen.findByLabelText('Personal API key');
    expect(key.props.secureTextEntry).toBe(true);
    expect(key.props.autoCorrect).toBe(false);
    expect(screen.getByLabelText('Save & verify').props.accessibilityState.disabled).toBe(true);
    await act(async () => { fireEvent.changeText(key, '  phx_secret '); });
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Project (team) id'), ' 2 '); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save & verify')); });
    expect(mockSave).toHaveBeenCalledWith('ws-1', { apiKey: 'phx_secret', projectId: '2', host: 'https://us.posthog.com' });
    expect(await screen.findByText('Cloud tasks run under project 2 on https://us.posthog.com.')).toBeVisible();
    expect(screen.queryByLabelText('Personal API key')).toBeNull();
    expect(mockLoad.mock.calls.map(([entity]) => entity)).toEqual(expect.arrayContaining(['providers', 'readiness']));
    // Editing again starts from an empty key.
    await act(async () => { fireEvent.press(screen.getByLabelText('Edit')); });
    expect(screen.getByLabelText('Personal API key').props.value).toBe('');
    expect(screen.getByText('Model')).toBeVisible();
  });

  it('shows the server error and keeps the form', async () => {
    mockSave.mockRejectedValue(apiError(400, 'PostHog rejected the API key.'));
    await render(<IntegrationsScreen kind="posthog" />);
    await act(async () => { fireEvent.changeText(await screen.findByLabelText('Personal API key'), 'phx_bad'); });
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Project (team) id'), '2'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save & verify')); });
    expect(await screen.findByText('PostHog rejected the API key.')).toBeVisible();
    expect(screen.getByLabelText('Personal API key')).toBeVisible();
  });

  it('connects with OAuth in the browser and reads the status again', async () => {
    mockStatus.mockResolvedValueOnce({ connected: false, oauthAvailable: true })
      .mockResolvedValue({ connected: true, oauthAvailable: true, authMethod: 'oauth', projectId: '9', host: 'https://eu.posthog.com' });
    mockStartOAuth.mockResolvedValue({ authorizeUrl: 'https://eu.posthog.com/oauth/authorize?x=1' });
    await render(<IntegrationsScreen kind="posthog" />);
    expect(await screen.findByText(/Connect your PostHog account/)).toBeVisible();
    expect(screen.queryByLabelText('Personal API key')).toBeNull();
    await act(async () => { fireEvent.changeText(screen.getByLabelText('PostHog host'), 'https://eu.posthog.com'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Connect with PostHog')); });
    expect(mockStartOAuth).toHaveBeenCalledWith('ws-1', { host: 'https://eu.posthog.com', returnTo: 'talyn-mobile://' });
    expect(mockOpenReturn).toHaveBeenCalledWith('https://eu.posthog.com/oauth/authorize?x=1', 'posthog');
    expect(await screen.findByText(/authorized with your PostHog account/)).toBeVisible();
    expect(mockStatus).toHaveBeenCalledTimes(2);
  });

  it('starts OAuth again without the return target on an older server', async () => {
    mockStatus.mockResolvedValue({ connected: false, oauthAvailable: true });
    mockStartOAuth.mockRejectedValueOnce(apiError(400, 'Bad returnTo', 'invalid_return_to'))
      .mockResolvedValue({ authorizeUrl: 'https://us.posthog.com/oauth/authorize' });
    mockOpenReturn.mockResolvedValue('dismissed');
    await render(<IntegrationsScreen kind="posthog" />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Connect with PostHog')); });
    expect(mockStartOAuth.mock.calls).toEqual([
      ['ws-1', { host: 'https://us.posthog.com', returnTo: 'talyn-mobile://' }],
      ['ws-1', { host: 'https://us.posthog.com' }],
    ]);
    expect(mockOpenReturn).toHaveBeenCalledWith('https://us.posthog.com/oauth/authorize', 'posthog');
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(2));
  });

  it('disconnects after confirmation', async () => {
    mockStatus.mockResolvedValueOnce({ connected: true, projectId: '2', host: 'https://us.posthog.com', authMethod: 'personal_api_key' })
      .mockResolvedValue({ connected: false });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => { buttons?.find((b) => b.style === 'destructive')?.onPress?.(); });
    await render(<IntegrationsScreen kind="posthog" />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Disconnect PostHog Code')); });
    expect(alert).toHaveBeenCalledWith('Disconnect PostHog Code?', expect.any(String), expect.any(Array));
    expect(mockDisconnect).toHaveBeenCalledWith('ws-1');
    expect(await screen.findByLabelText('Personal API key')).toBeVisible();
    alert.mockRestore();
  });
});

describe('Trunk', () => {
  it('saves a key and shows it connected', async () => {
    mockTrunkSave.mockResolvedValue({ connected: true, needsReauth: false });
    await render(<IntegrationsScreen kind="trunk" />);
    const field = await screen.findByLabelText('Trunk API key');
    expect(field.props.secureTextEntry).toBe(true);
    await act(async () => { fireEvent.changeText(field, ' trunk_v2_abc '); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save Trunk API key')); });
    expect(mockTrunkSave).toHaveBeenCalledWith('ws-1', 'trunk_v2_abc');
    expect(await screen.findByLabelText('Replace key')).toBeVisible();
    expect(screen.queryByLabelText('Trunk API key')).toBeNull();
    expect(screen.getAllByText('Connected').length).toBeGreaterThan(0);
  });

  it('shows the server error when the save fails', async () => {
    mockTrunkSave.mockRejectedValue(apiError(400, 'Trunk refused this API key.'));
    await render(<IntegrationsScreen kind="trunk" />);
    await act(async () => { fireEvent.changeText(await screen.findByLabelText('Trunk API key'), 'trunk_v2_bad'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Save Trunk API key')); });
    expect(await screen.findByText('Trunk refused this API key.')).toBeVisible();
    expect(screen.getByLabelText('Trunk API key').props.value).toBe('trunk_v2_bad');
  });

  it('asks for a new key when Trunk refused the saved one', async () => {
    mockTrunkStatus.mockResolvedValue({ connected: true, needsReauth: true, reauthReason: 'Trunk answered 401.' });
    await render(<IntegrationsScreen kind="trunk" />);
    expect(await screen.findByText('Trunk answered 401. Paste a new key to see merge ETAs again.')).toBeVisible();
    expect(screen.getByText('Reconnect needed')).toBeVisible();
    await act(async () => { fireEvent.press(screen.getByLabelText('Reconnect')); });
    expect(screen.getByLabelText('Trunk API key')).toBeVisible();
  });

  it('removes the key after confirmation', async () => {
    mockTrunkStatus.mockResolvedValue({ connected: true, needsReauth: false });
    mockTrunkRemove.mockResolvedValue({ connected: false, needsReauth: false });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => { buttons?.find((b) => b.style === 'destructive')?.onPress?.(); });
    await render(<IntegrationsScreen kind="trunk" />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Remove the Trunk API key')); });
    expect(mockTrunkRemove).toHaveBeenCalledWith('ws-1');
    expect(await screen.findByLabelText('Trunk API key')).toBeVisible();
    alert.mockRestore();
  });

  it('is not drawn when the feature is off', async () => {
    mockFeatures = { trunkMergeEta: false };
    await render(<IntegrationsScreen kind="trunk" />);
    expect(screen.queryByText('Trunk merge queue')).toBeNull();
    expect(screen.queryByText('PostHog Code')).toBeNull();
    expect(mockTrunkStatus).not.toHaveBeenCalled();
  });
});

describe('PostHog Inbox push line', () => {
  const status = (over: Record<string, unknown> = {}) => ({
    access: 'ok', reason: null, authMethod: 'oauth', projectId: '42', host: 'https://us.posthog.com',
    lastPolledAt: null, lastError: null, lastPushAt: null, pushConfigured: false, ...over,
  });

  it.each([
    ['no URL', status(), /does not push to Talyn yet/],
    ['a URL without a push', status({ pushConfigured: true }), /no push from PostHog has arrived yet/],
    ['a recent push', status({ pushConfigured: true, lastPushAt: new Date().toISOString() }), /Last push from PostHog: .*every 30 minutes/],
  ])('shows %s read-only on the PostHog Inbox page', async (_name, value, text) => {
    mockInboxStatus.mockResolvedValue(value);
    await render(<IntegrationsScreen kind="posthog" inbox />);
    expect((await screen.findByTestId('posthog-inbox-push-line')).props.children).toMatch(text);
    expect(mockInboxStatus).toHaveBeenCalledWith('ws-1');
    expect(screen.getByText(/Make or rotate the webhook URL on the web/)).toBeVisible();
  });

  it('is not drawn on the PostHog Code page', async () => {
    mockInboxStatus.mockClear();
    await render(<IntegrationsScreen kind="posthog" />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('posthog-inbox-push-line')).toBeNull();
    expect(mockInboxStatus).not.toHaveBeenCalled();
  });
});
