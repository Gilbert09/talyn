import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { SlackStatus } from '@talyn/shared';
import { SlackSettings, emojiInputError } from '../components/panels/SlackSettings';

const mockGetStatus = vi.fn();
const mockInstall = vi.fn();
const mockLink = vi.fn();
const mockUpdateLink = vi.fn();
const mockUnlink = vi.fn();
const mockForget = vi.fn();
const assign = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    slack: {
      getStatus: () => mockGetStatus(),
      install: (...a: unknown[]) => mockInstall(...a),
      link: (...a: unknown[]) => mockLink(...a),
      updateLink: (...a: unknown[]) => mockUpdateLink(...a),
      unlink: (...a: unknown[]) => mockUnlink(...a),
      forgetInstallation: (...a: unknown[]) => mockForget(...a),
    },
  },
}));
vi.mock('../stores/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const state: { workbenches: boolean } = { workbenches: true };
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      features: { workbenches: state.workbenches },
      currentWorkspaceId: 'ws1',
      workspaces: [
        { id: 'ws1', name: 'Acme' },
        { id: 'ws2', name: 'Side project' },
      ],
    }),
}));

const INSTALLATION = {
  teamId: 'T1',
  teamName: 'Acme Slack',
  teamUrl: null,
  botUserId: 'UBOT',
  botName: 'talyn',
  installedByMe: true,
  needsReinstall: false,
  installedAt: '2026-10-01T00:00:00Z',
};
const LINK = {
  id: 'link1',
  teamId: 'T1',
  teamName: 'Acme Slack',
  slackUserId: 'U1',
  workspaceId: null,
  triggerEmojis: ['robot_face'],
  installed: true,
  createdAt: '2026-10-01T00:00:00Z',
};

function status(overrides: Partial<SlackStatus> = {}): SlackStatus {
  return { installations: [INSTALLATION], links: [LINK], ...overrides };
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign, search: '', pathname: '/settings' },
  });
  state.workbenches = true;
  vi.clearAllMocks();
  mockGetStatus.mockResolvedValue(status());
});
afterEach(cleanup);

describe('SlackSettings', () => {
  it('renders nothing and calls nothing when workbenches is off', () => {
    state.workbenches = false;
    const { container } = render(<SlackSettings />);
    expect(container.innerHTML).toBe('');
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('shows the message and no buttons when the deployment is not configured', async () => {
    mockGetStatus.mockRejectedValue(
      Object.assign(new Error('Slack is not set up here.'), { code: 'slack_not_configured' })
    );
    render(<SlackSettings />);
    expect(await screen.findByText('Slack is not set up here.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a retry on a load error', async () => {
    mockGetStatus.mockRejectedValueOnce(new Error('boom'));
    render(<SlackSettings />);
    expect(await screen.findByText('boom')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(mockGetStatus).toHaveBeenCalledTimes(2));
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
  });

  it('connects Slack and opens the authorize URL', async () => {
    mockGetStatus.mockResolvedValue(status({ installations: [], links: [] }));
    mockInstall.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/x' });
    render(<SlackSettings />);
    fireEvent.click(await screen.findByText('Connect Slack'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/x'));
    expect(mockInstall).toHaveBeenCalledWith({ workspaceId: 'ws1' });
  });

  it('links the account when installed but not linked', async () => {
    mockGetStatus.mockResolvedValue(status({ links: [] }));
    mockLink.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/link' });
    render(<SlackSettings />);
    fireEvent.click(await screen.findByText('Link my Slack account'));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/link')
    );
    expect(mockLink).toHaveBeenCalledWith({ workspaceId: 'ws1' });
  });

  it('adds, dedupes, validates, removes and saves emojis', async () => {
    mockUpdateLink.mockResolvedValue({ ...LINK, triggerEmojis: ['robot_face', 'eyes'] });
    render(<SlackSettings />);
    const input = await screen.findByPlaceholderText(':robot_face:');

    fireEvent.change(input, { target: { value: 'Bad Name!' } });
    expect(screen.getByText(/Use lowercase letters/)).toBeTruthy();
    expect((screen.getByText('Add').closest('button') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: ':robot_face:' } });
    expect(screen.getByText(/already in the list/)).toBeTruthy();

    fireEvent.change(input, { target: { value: ':EYES:' } });
    fireEvent.click(screen.getByText('Add'));
    expect(screen.getByText(':eyes:')).toBeTruthy();

    fireEvent.click(screen.getByText('Save emojis'));
    await waitFor(() =>
      expect(mockUpdateLink).toHaveBeenCalledWith('link1', {
        triggerEmojis: ['robot_face', 'eyes'],
      })
    );
  });

  it('removes a chip and keeps Save disabled until something changed', async () => {
    render(<SlackSettings />);
    const save = (await screen.findByText('Save emojis')).closest('button') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Remove :robot_face:'));
    expect(save.disabled).toBe(false);
    expect(screen.queryByText(':robot_face:')).toBeNull();
  });

  it('defaults the workspace select to the first workspace and saves a change', async () => {
    mockUpdateLink.mockResolvedValue({ ...LINK, workspaceId: 'ws2' });
    render(<SlackSettings />);
    const select = (await screen.findByLabelText('Target workspace')) as HTMLSelectElement;
    expect(select.value).toBe('ws1');
    fireEvent.change(select, { target: { value: 'ws2' } });
    await waitFor(() =>
      expect(mockUpdateLink).toHaveBeenCalledWith('link1', { workspaceId: 'ws2' })
    );
  });

  it('mentions the bot name in the invite hint', async () => {
    render(<SlackSettings />);
    expect(await screen.findByText(/\/invite @talyn/)).toBeTruthy();
  });

  it('unlinks only after the inline confirm', async () => {
    mockUnlink.mockResolvedValue(undefined);
    render(<SlackSettings />);
    fireEvent.click(await screen.findByText('Unlink'));
    expect(mockUnlink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    expect(mockUnlink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Unlink'));
    fireEvent.click(screen.getAllByText('Unlink').pop()!);
    await waitFor(() => expect(mockUnlink).toHaveBeenCalledWith('link1'));
  });

  it('disconnects the workspace only after the inline confirm, installer only', async () => {
    mockForget.mockResolvedValue({ teamId: 'T1', message: 'Remove it in Slack too.' });
    render(<SlackSettings />);
    fireEvent.click(await screen.findByText('Disconnect workspace'));
    expect(mockForget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Disconnect'));
    await waitFor(() => expect(mockForget).toHaveBeenCalledWith('T1'));
  });

  it('hides Disconnect from a non-installer', async () => {
    mockGetStatus.mockResolvedValue(
      status({ installations: [{ ...INSTALLATION, installedByMe: false }] })
    );
    render(<SlackSettings />);
    await screen.findByText('Save emojis');
    expect(screen.queryByText('Disconnect workspace')).toBeNull();
  });

  it('warns and offers Reconnect when the install needs reinstalling', async () => {
    mockGetStatus.mockResolvedValue(
      status({ installations: [{ ...INSTALLATION, needsReinstall: true }] })
    );
    mockInstall.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/re' });
    render(<SlackSettings />);
    fireEvent.click(await screen.findByText('Reconnect'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/re'));
  });
});

describe('callback banner', () => {
  it.each([
    ['?slack=installed', 'Slack workspace connected.'],
    ['?slack=linked', 'Slack account linked.'],
    ['?slack=error&message=Access%20denied', 'Access denied'],
    ['?slack=error', 'Slack could not be connected.'],
  ])('%s shows %j and clears the params', async (search, text) => {
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    (window.location as { search: string }).search = search;
    render(<SlackSettings />);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(replaceState).toHaveBeenCalledWith({}, '', '/settings');
    replaceState.mockRestore();
  });

  it('shows no banner without the param', async () => {
    render(<SlackSettings />);
    await screen.findByText('Save emojis');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('emojiInputError', () => {
  it.each([
    ['', [], null],
    ['robot_face', [], null],
    [':Robot_Face:', [], null],
    ['+1', [], null],
    ['has space', [], 'Use lowercase'],
    ['é', [], 'Use lowercase'],
    ['eyes', ['eyes'], 'already'],
    [':eyes:', ['eyes'], 'already'],
  ])('%j with %j', (raw, current, expected) => {
    const result = emojiInputError(raw, current as string[]);
    if (expected === null) expect(result).toBeNull();
    else expect(result).toContain(expected);
  });
});
