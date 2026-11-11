import type { SlackInstallationView, SlackStatus, SlackUserLinkView } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { SlackScreen } from '../features/slack/SlackScreen';
import { fixture } from './workflowFixtures';

const mockLifecycle = fixture().lifecycle;
const mockStatus = jest.fn();
const mockInstall = jest.fn();
const mockLink = jest.fn();
const mockUpdateLink = jest.fn();
const mockUnlink = jest.fn();
const mockEmoji = jest.fn();
const mockForget = jest.fn();
const mockOpenReturn = jest.fn();
const mockTrack = jest.fn();
let mockFeatures: Record<string, boolean> | null = { workbenches: true };
let mockChoices = [{ id: 'ws-1', name: 'Personal' }];

jest.mock('@talyn/client/native', () => ({
  ...jest.requireActual('@talyn/client/native'),
  slack: {
    getStatus: (...a: unknown[]) => mockStatus(...a), install: (...a: unknown[]) => mockInstall(...a), link: (...a: unknown[]) => mockLink(...a),
    updateLink: (...a: unknown[]) => mockUpdateLink(...a), unlink: (...a: unknown[]) => mockUnlink(...a),
    listEmoji: (...a: unknown[]) => mockEmoji(...a), forgetInstallation: (...a: unknown[]) => mockForget(...a),
  },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
  useWorkspace: () => ({ status: 'ready', selected: 'ws-1', choices: mockChoices }),
  useNetwork: () => 'online',
  useAuth: () => ({ user: { id: 'user-1' } }),
}));
jest.mock('../lib/features', () => ({ ...jest.requireActual('../lib/features'), useFeatures: () => mockFeatures }));
jest.mock('../lib/returnTo', () => ({
  appReturnBase: () => 'talyn-mobile://',
  openReturnFlow: (...a: unknown[]) => mockOpenReturn(...a),
}));
jest.mock('../lib/analytics', () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

const install = (extra: Partial<SlackInstallationView> = {}): SlackInstallationView => ({
  teamId: 'T1', teamName: 'Acme', teamUrl: null, botUserId: 'B1', botName: 'talyn', installedByMe: true, needsReinstall: false, canReply: true,
  installedAt: '2026-11-01T00:00:00Z', ...extra,
});
const link = (extra: Partial<SlackUserLinkView> = {}): SlackUserLinkView => ({
  id: 'L1', teamId: 'T1', teamName: 'Acme', slackUserId: 'U1', workspaceId: 'ws-1', triggerEmojis: ['robot_face'], installed: true,
  createdAt: '2026-11-01T00:00:00Z', ...extra,
});
const empty: SlackStatus = { installations: [], links: [] };
const connected: SlackStatus = { installations: [install()], links: [link()] };
const apiError = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, code });
const confirmAll = () => jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
  buttons?.find((b) => b.style === 'destructive')?.onPress?.();
});

beforeEach(() => {
  mockFeatures = { workbenches: true };
  mockChoices = [{ id: 'ws-1', name: 'Personal' }];
  mockStatus.mockResolvedValue(connected);
  mockEmoji.mockResolvedValue({ emoji: [] });
  mockOpenReturn.mockResolvedValue('returned');
  mockUpdateLink.mockResolvedValue(link());
});
afterEach(() => { jest.restoreAllMocks(); });

describe('gates', () => {
  it('is not available without sessions', async () => {
    mockFeatures = { workbenches: false };
    await render(<SlackScreen />);
    expect(screen.getByText('Slack is not available')).toBeVisible();
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('says Slack is not set up on this deployment', async () => {
    mockStatus.mockRejectedValue(apiError(503, 'Slack is not configured on this server.', 'slack_not_configured'));
    await render(<SlackScreen />);
    expect(await screen.findByText('Slack is not configured on this server.')).toBeVisible();
    expect(screen.queryByText('Connect Slack')).toBeNull();
  });

  it('says Slack is not available when the server refuses it', async () => {
    mockStatus.mockRejectedValue(apiError(403, 'Slack is not available.', 'slack_unavailable'));
    await render(<SlackScreen />);
    expect(await screen.findByText('Slack is not available')).toBeVisible();
  });

  it('offers a retry for any other error', async () => {
    mockStatus.mockRejectedValue(apiError(500, 'boom'));
    await render(<SlackScreen />);
    expect(await screen.findByText('This view could not load.')).toBeVisible();
  });
});

describe('install and link', () => {
  it('installs through the browser and reads the status again', async () => {
    mockStatus.mockResolvedValueOnce(empty).mockResolvedValue(connected);
    mockInstall.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/v2/authorize?x=1' });
    await render(<SlackScreen />);
    expect(await screen.findByText('Talyn is not installed in any Slack workspace yet.')).toBeVisible();
    await act(async () => { fireEvent.press(screen.getByLabelText('Connect Slack')); });
    expect(mockInstall).toHaveBeenCalledWith({ workspaceId: 'ws-1', returnTo: 'talyn-mobile://' });
    expect(mockOpenReturn).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?x=1', 'slack', expect.any(Function));
    expect(await screen.findByText('Acme')).toBeVisible();
    expect(screen.getByText('Connected')).toBeVisible();
    expect(mockStatus).toHaveBeenCalledTimes(2);
  });

  it('starts again without the return target on an older server', async () => {
    mockStatus.mockResolvedValue({ installations: [install()], links: [] });
    mockLink.mockRejectedValueOnce(apiError(400, 'Bad returnTo', 'invalid_return_to'))
      .mockResolvedValue({ authorizeUrl: 'https://slack.com/openid/connect/authorize' });
    mockOpenReturn.mockResolvedValue('dismissed');
    await render(<SlackScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Link my Slack account')); });
    expect(mockLink.mock.calls).toEqual([[{ workspaceId: 'ws-1', returnTo: 'talyn-mobile://' }], [{ workspaceId: 'ws-1' }]]);
    expect(mockOpenReturn).toHaveBeenCalledWith('https://slack.com/openid/connect/authorize', 'slack', expect.any(Function));
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['talyn-mobile://slack/callback?slack=installed', 'workspace'],
    ['talyn-mobile://slack/callback?slack=linked', 'account'],
    ['talyn-mobile://slack/callback?slack=error&message=no', null],
  ])('tracks the return %s as slack_connected for %s, like web', async (url, kind) => {
    mockStatus.mockResolvedValue(empty);
    mockInstall.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/v2/authorize?x=1' });
    mockOpenReturn.mockImplementation(async (_url: string, _kind: string, onReturn?: (value: string) => void) => { onReturn?.(url); return 'returned'; });
    mockTrack.mockClear();
    await render(<SlackScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Connect Slack')); });
    if (kind) expect(mockTrack).toHaveBeenCalledWith('slack_connected', { connection_kind: kind });
    else expect(mockTrack).not.toHaveBeenCalled();
    mockOpenReturn.mockReset();
  });

  it('shows the not-configured message when the start refuses', async () => {
    mockStatus.mockResolvedValue(empty);
    mockInstall.mockRejectedValue(apiError(503, 'No Slack app here.', 'slack_not_configured'));
    await render(<SlackScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Connect Slack')); });
    expect(await screen.findByText('No Slack app here.')).toBeVisible();
    expect(mockOpenReturn).not.toHaveBeenCalled();
  });

  it('shows why a start failed', async () => {
    mockStatus.mockResolvedValue(empty);
    mockInstall.mockRejectedValue(apiError(500, 'Server down'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(<SlackScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Connect Slack')); });
    expect(alert).toHaveBeenCalledWith('Could not start Slack sign-in', 'Server down');
  });

  it('offers a reconnect when Slack stopped accepting the token', async () => {
    mockStatus.mockResolvedValue({ installations: [install({ needsReinstall: true })], links: [link()] });
    mockInstall.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/v2/authorize' });
    await render(<SlackScreen />);
    expect(await screen.findByText('Needs reconnect')).toBeVisible();
    await act(async () => { fireEvent.press(screen.getByLabelText('Reconnect')); });
    expect(mockInstall).toHaveBeenCalledWith({ workspaceId: 'ws-1', returnTo: 'talyn-mobile://' });
  });
});

describe('a linked team', () => {
  it('unlinks after confirmation and reads the status again', async () => {
    mockStatus.mockResolvedValueOnce(connected).mockResolvedValue({ installations: [install()], links: [] });
    mockUnlink.mockResolvedValue(undefined);
    await render(<SlackScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Actions for Acme')); });
    const alert = confirmAll();
    await act(async () => { fireEvent.press(screen.getByLabelText('Unlink my account')); });
    expect(alert).toHaveBeenCalledWith('Unlink your Slack account from Acme?', undefined, expect.any(Array));
    expect(mockUnlink).toHaveBeenCalledWith('L1');
    expect(await screen.findByText('Not linked')).toBeVisible();
  });

  it('shows why an unlink failed', async () => {
    mockUnlink.mockRejectedValue(apiError(500, 'Could not reach Slack.'));
    await render(<SlackScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Actions for Acme')); });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((title, _m, buttons) => {
      if (title?.startsWith('Unlink')) buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await act(async () => { fireEvent.press(screen.getByLabelText('Unlink my account')); });
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Could not unlink', 'Could not reach Slack.'));
  });

  it('forgets the installation and shows the server note', async () => {
    mockForget.mockResolvedValue({ teamId: 'T1', message: 'Remove the app in Slack too.' });
    await render(<SlackScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Actions for Acme')); });
    const alert = confirmAll();
    await act(async () => { fireEvent.press(screen.getByLabelText('Disconnect workspace')); });
    expect(mockForget).toHaveBeenCalledWith('T1');
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Slack workspace disconnected', 'Remove the app in Slack too.'));
  });

  it('removes and adds trigger emoji', async () => {
    mockEmoji.mockResolvedValue({ emoji: [{ name: 'shipit', url: 'https://emoji.slack-edge.com/shipit.png' }] });
    await render(<SlackScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Remove :robot_face:')); });
    expect(mockUpdateLink).toHaveBeenLastCalledWith('L1', { triggerEmojis: [] });
    expect(screen.getByText('No emoji. Reactions will not start a session.')).toBeVisible();

    await act(async () => { fireEvent.press(screen.getByLabelText('Add emoji')); });
    await act(async () => { fireEvent.press(await screen.findByLabelText('Add :shipit:')); });
    expect(mockUpdateLink).toHaveBeenLastCalledWith('L1', { triggerEmojis: ['shipit'] });

    await act(async () => { fireEvent.press(screen.getByLabelText('Add emoji')); });
    await act(async () => { fireEvent.changeText(screen.getByLabelText('Search emoji'), ':Tada:'); });
    await act(async () => { fireEvent.press(screen.getByLabelText('Add :tada:')); });
    expect(mockUpdateLink).toHaveBeenLastCalledWith('L1', { triggerEmojis: ['shipit', 'tada'] });
  });

  it('puts the emoji back when the save fails', async () => {
    mockUpdateLink.mockRejectedValue(apiError(400, 'Not a Slack emoji name.'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await render(<SlackScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Remove :robot_face:')); });
    expect(alert).toHaveBeenCalledWith('Could not save trigger emojis', 'Not a Slack emoji name.');
    expect(screen.getByText(':robot_face:')).toBeVisible();
  });

  it('asks for a reconnect when custom emoji need a scope', async () => {
    mockEmoji.mockResolvedValue({ emoji: [], needsScope: 'emoji:read' });
    await render(<SlackScreen />);
    expect(await screen.findByText(/Reconnect Slack to show your workspace's custom emoji/)).toBeVisible();
  });

  it('moves sessions to another workspace', async () => {
    mockChoices = [{ id: 'ws-1', name: 'Personal' }, { id: 'ws-2', name: 'PostHog' }];
    await render(<SlackScreen />);
    await act(async () => { fireEvent.press(await screen.findByLabelText('Target workspace. Personal.')); });
    await act(async () => { fireEvent.press(screen.getByLabelText('PostHog')); });
    expect(mockUpdateLink).toHaveBeenCalledWith('L1', { workspaceId: 'ws-2' });
    expect(await screen.findByText('Saved')).toBeVisible();
  });

  it('hides the workspace choice with one workspace', async () => {
    await render(<SlackScreen />);
    await screen.findByText('Acme');
    expect(screen.queryByText('Workspace')).toBeNull();
    expect(screen.getByText('/invite @talyn')).toBeVisible();
  });
});
