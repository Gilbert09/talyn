import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { SlackStatus } from '@talyn/shared';
import { SlackSettings } from '../components/panels/SlackSettings';

const mockGetStatus = vi.fn();
const mockInstall = vi.fn();
const mockLink = vi.fn();
const mockUpdateLink = vi.fn();
const mockUnlink = vi.fn();
const mockForget = vi.fn();
const mockListEmoji = vi.fn();
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
      listEmoji: (...a: unknown[]) => mockListEmoji(...a),
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

// Radix popovers measure their content.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;

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
  triggerEmojis: ['thumbsup', 'white_check_mark'],
  installed: true,
  createdAt: '2026-10-01T00:00:00Z',
};
const PARTY = { name: 'partyparrot', url: 'https://emoji.slack-edge.com/T1/partyparrot/a.png' };

function status(overrides: Partial<SlackStatus> = {}): SlackStatus {
  return { installations: [INSTALLATION], links: [LINK], ...overrides };
}

function openMenu() {
  fireEvent.keyDown(screen.getByLabelText('Actions for Acme Slack'), { key: 'Enter' });
}

async function openPicker() {
  fireEvent.click(await screen.findByText('Add emoji'));
  return screen.findByLabelText('Search emoji');
}

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign, search: '', pathname: '/settings' },
  });
  state.workbenches = true;
  vi.clearAllMocks();
  mockGetStatus.mockResolvedValue(status());
  mockListEmoji.mockResolvedValue({ emoji: [PARTY] });
  mockUpdateLink.mockImplementation(async (_id: string, input: object) => ({ ...LINK, ...input }));
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
  });

  it('connects Slack and opens the authorize URL', async () => {
    mockGetStatus.mockResolvedValue(status({ installations: [], links: [] }));
    mockInstall.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/x' });
    render(<SlackSettings />);
    fireEvent.click(await screen.findByText('Connect Slack'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/x'));
    expect(mockInstall).toHaveBeenCalledWith({ workspaceId: 'ws1' });
  });

  it('draws ONE card for a team that is installed and linked', async () => {
    const { container } = render(<SlackSettings />);
    await screen.findByText('Connected');
    expect(container.querySelectorAll('[data-attr="settings-slack-team-card"]')).toHaveLength(1);
    expect(screen.getAllByText('Acme Slack')).toHaveLength(1);
    expect(screen.queryByText('Installed by you')).toBeNull();
    expect(screen.queryByText('Linked')).toBeNull();
  });

  it('draws one card per team, a link without its app included', async () => {
    mockGetStatus.mockResolvedValue(
      status({
        links: [LINK, { ...LINK, id: 'link2', teamId: 'T2', teamName: null, installed: false }],
      })
    );
    const { container } = render(<SlackSettings />);
    await screen.findByText('App removed');
    expect(container.querySelectorAll('[data-attr="settings-slack-team-card"]')).toHaveLength(2);
  });

  it('shows only a Link button when the team is installed but the user is not linked', async () => {
    mockGetStatus.mockResolvedValue(status({ links: [] }));
    mockLink.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/link' });
    render(<SlackSettings />);
    expect(await screen.findByText('Not linked')).toBeTruthy();
    expect(screen.queryByText('Workspace')).toBeNull();
    expect(screen.queryByText('Add emoji')).toBeNull();
    fireEvent.click(screen.getByText('Link my Slack account'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/link'));
    expect(mockLink).toHaveBeenCalledWith({ workspaceId: 'ws1' });
  });

  it('offers Reconnect and a warning pill when the install needs reinstalling', async () => {
    mockGetStatus.mockResolvedValue(
      status({ installations: [{ ...INSTALLATION, needsReinstall: true }] })
    );
    mockInstall.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/re' });
    render(<SlackSettings />);
    expect(await screen.findByText('Needs reconnect')).toBeTruthy();
    fireEvent.click(screen.getByText('Reconnect'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/re'));
  });

  it('adds a small link to connect another Slack workspace', async () => {
    mockInstall.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/more' });
    render(<SlackSettings />);
    fireEvent.click(await screen.findByText('Add another Slack workspace'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/more'));
  });

  describe('card menu', () => {
    it('Reconnect starts the install flow', async () => {
      mockInstall.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/re' });
      render(<SlackSettings />);
      await screen.findByText('Connected');
      openMenu();
      fireEvent.click(await screen.findByText('Reconnect'));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/re'));
    });

    it('unlinks only after the inline confirm', async () => {
      mockUnlink.mockResolvedValue(undefined);
      render(<SlackSettings />);
      await screen.findByText('Connected');
      openMenu();
      fireEvent.click(await screen.findByText('Unlink my account'));
      expect(mockUnlink).not.toHaveBeenCalled();
      expect(screen.getByText('Unlink your Slack account from Acme Slack?')).toBeTruthy();
      fireEvent.click(screen.getByText('Cancel'));
      expect(mockUnlink).not.toHaveBeenCalled();
      expect(screen.queryByText('Unlink your Slack account from Acme Slack?')).toBeNull();

      openMenu();
      fireEvent.click(await screen.findByText('Unlink my account'));
      fireEvent.click(screen.getByText('Unlink'));
      await waitFor(() => expect(mockUnlink).toHaveBeenCalledWith('link1'));
    });

    it('disconnects only after the inline confirm', async () => {
      mockForget.mockResolvedValue({ teamId: 'T1', message: 'Remove it in Slack too.' });
      render(<SlackSettings />);
      await screen.findByText('Connected');
      openMenu();
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
      await screen.findByText('Connected');
      openMenu();
      await screen.findByText('Unlink my account');
      expect(screen.queryByText('Disconnect workspace')).toBeNull();
    });
  });

  describe('target workspace', () => {
    it('defaults to the first workspace, saves on change and shows Saved', async () => {
      render(<SlackSettings />);
      const select = (await screen.findByLabelText('Target workspace')) as HTMLSelectElement;
      expect(select.value).toBe('ws1');
      expect(screen.queryByText('Save emojis')).toBeNull();
      fireEvent.change(select, { target: { value: 'ws2' } });
      await waitFor(() =>
        expect(mockUpdateLink).toHaveBeenCalledWith('link1', { workspaceId: 'ws2' })
      );
      expect(await screen.findByText('Saved')).toBeTruthy();
      expect(select.value).toBe('ws2');
    });

    it('rolls back and offers Retry when the save fails', async () => {
      mockUpdateLink.mockRejectedValueOnce(new Error('nope'));
      render(<SlackSettings />);
      const select = (await screen.findByLabelText('Target workspace')) as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'ws2' } });
      fireEvent.click(await screen.findByText('Retry'));
      await waitFor(() => expect(mockUpdateLink).toHaveBeenCalledTimes(2));
      expect(mockUpdateLink).toHaveBeenLastCalledWith('link1', { workspaceId: 'ws2' });
      expect(await screen.findByText('Saved')).toBeTruthy();
      expect(select.value).toBe('ws2');
    });
  });

  describe('trigger emoji', () => {
    it('renders a glyph for standard emoji and an image for a custom one', async () => {
      mockGetStatus.mockResolvedValue(
        status({ links: [{ ...LINK, triggerEmojis: ['thumbsup', 'white_check_mark', 'partyparrot'] }] })
      );
      render(<SlackSettings />);
      await waitFor(() => expect(screen.getByLabelText('thumbsup').textContent).toBe('\u{1F44D}'));
      expect(screen.getByLabelText('white_check_mark').textContent).toBe('✅');
      const img = (await screen.findByAltText(':partyparrot:')) as HTMLImageElement;
      expect(img.src).toBe(PARTY.url);
      expect(screen.getByText(':thumbsup:')).toBeTruthy();
      expect(mockListEmoji).toHaveBeenCalledWith('T1');
    });

    it('has no Save emojis button and no text input', async () => {
      render(<SlackSettings />);
      await screen.findByText(':thumbsup:');
      expect(screen.queryByText('Save emojis')).toBeNull();
      expect(screen.queryByPlaceholderText(':robot_face:')).toBeNull();
    });

    it('removes a chip and saves straight away', async () => {
      render(<SlackSettings />);
      fireEvent.click(await screen.findByLabelText('Remove :thumbsup:'));
      expect(screen.queryByText(':thumbsup:')).toBeNull();
      await waitFor(() =>
        expect(mockUpdateLink).toHaveBeenCalledWith('link1', { triggerEmojis: ['white_check_mark'] })
      );
    });

    it('puts a removed chip back when the save fails', async () => {
      mockUpdateLink.mockRejectedValueOnce(new Error('nope'));
      render(<SlackSettings />);
      fireEvent.click(await screen.findByLabelText('Remove :thumbsup:'));
      expect(await screen.findByText(':thumbsup:')).toBeTruthy();
    });

    it('searches the picker and adds with Enter', async () => {
      render(<SlackSettings />);
      const search = await openPicker();
      fireEvent.change(search, { target: { value: 'tada' } });
      await screen.findByRole('option', { name: 'tada' });
      fireEvent.keyDown(search, { key: 'Enter' });
      await waitFor(() =>
        expect(mockUpdateLink).toHaveBeenCalledWith('link1', {
          triggerEmojis: ['thumbsup', 'white_check_mark', 'tada'],
        })
      );
      expect(screen.queryByLabelText('Search emoji')).toBeNull();
      expect(await screen.findByText(':tada:')).toBeTruthy();
    });

    it('moves with the arrow keys before Enter', async () => {
      render(<SlackSettings />);
      const search = await openPicker();
      fireEvent.change(search, { target: { value: 'heart' } });
      const grid = within(await screen.findByRole('listbox'));
      const names = grid.getAllByRole('option').map((o) => o.getAttribute('aria-label'));
      expect(names.length).toBeGreaterThan(2);
      fireEvent.keyDown(search, { key: 'ArrowRight' });
      fireEvent.keyDown(search, { key: 'ArrowRight' });
      fireEvent.keyDown(search, { key: 'ArrowLeft' });
      fireEvent.keyDown(search, { key: 'Enter' });
      await waitFor(() =>
        expect(mockUpdateLink).toHaveBeenCalledWith('link1', {
          triggerEmojis: ['thumbsup', 'white_check_mark', names[1]],
        })
      );
    });

    it('finds the workspace custom emoji and adds it by click', async () => {
      render(<SlackSettings />);
      const search = await openPicker();
      fireEvent.change(search, { target: { value: 'partyp' } });
      fireEvent.click(await screen.findByRole('option', { name: 'partyparrot' }));
      await waitFor(() =>
        expect(mockUpdateLink).toHaveBeenCalledWith('link1', {
          triggerEmojis: ['thumbsup', 'white_check_mark', 'partyparrot'],
        })
      );
    });

    it('does not offer an emoji that is already a trigger', async () => {
      render(<SlackSettings />);
      const search = await openPicker();
      fireEvent.change(search, { target: { value: 'thumbsup' } });
      await waitFor(() => expect(screen.queryByText('Loading emoji…')).toBeNull());
      expect(screen.queryByRole('option', { name: 'thumbsup' })).toBeNull();
      expect(screen.queryByRole('option', { name: '+1' })).toBeNull();
    });

    it('says to reconnect when Slack lacks the emoji scope', async () => {
      mockListEmoji.mockResolvedValue({ emoji: [], needsScope: 'emoji:read' });
      mockInstall.mockResolvedValue({ authorizeUrl: 'https://slack.com/oauth/re' });
      render(<SlackSettings />);
      expect(
        await screen.findByText(/Reconnect Slack to show your workspace.s custom emoji/)
      ).toBeTruthy();
      fireEvent.click(screen.getByText('Reconnect'));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://slack.com/oauth/re'));
    });

    it('stays quiet when the custom emoji call fails', async () => {
      mockListEmoji.mockRejectedValue(new Error('502'));
      render(<SlackSettings />);
      await screen.findByText(':thumbsup:');
      expect(screen.queryByText(/custom emoji/)).toBeNull();
    });
  });

  describe('invite hint', () => {
    it('names the bot and copies the command', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
      render(<SlackSettings />);
      expect(await screen.findByText('/invite @talyn')).toBeTruthy();
      expect(screen.getByText(/Add Talyn to a channel:/)).toBeTruthy();
      fireEvent.click(screen.getByLabelText('Copy invite command'));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('/invite @talyn'));
    });
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
    await screen.findByText('Connected');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
