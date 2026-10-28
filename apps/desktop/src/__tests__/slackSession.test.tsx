/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SlackNoticeEvent, SlackPendingRequest, SlackSessionSource, Workbench } from '@talyn/shared';

const openExternal = jest.fn();
const startPending = jest.fn();
const listPending = jest.fn();
jest.mock('../renderer/lib/openExternal', () => ({ openExternal: (...a: unknown[]) => openExternal(...a) }));
jest.mock('../renderer/lib/api', () => ({
  api: {
    slack: {
      startPending: (...a: unknown[]) => startPending(...a),
      listPending: (...a: unknown[]) => listPending(...a),
    },
  },
}));
const toastSuccess = jest.fn();
const toastError = jest.fn();
jest.mock('../renderer/stores/toast', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    info: jest.fn(),
  },
}));
const showNative = jest.fn();
jest.mock('../renderer/lib/workbenchNotify', () => ({
  showNativeNotification: (...a: unknown[]) => showNative(...a),
}));

import { SlackSessionMark, SlackThreadChip } from '../renderer/components/workbench/SlackThreadChip';
import { SidebarWorkbenchList } from '../renderer/components/layout/SidebarWorkbenchList';
import { SidebarSlackPending } from '../renderer/components/layout/SidebarSlackPending';
import { slackChannelLabel, slackDeepLink } from '../renderer/lib/slackSession';
import { handleSlackNotice, loadSlackPending } from '../renderer/lib/slackNotices';
import { useSlackPendingStore } from '../renderer/stores/slackPending';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { installNavigation, useNavigationStore } from '../renderer/stores/navigation';
import { useWorkspaceStore } from '../renderer/stores/workspace';

const source: SlackSessionSource = {
  kind: 'slack',
  teamId: 'T1',
  teamName: 'Acme',
  channelId: 'C1',
  channelName: 'eng',
  messageTs: '1.1',
  threadTs: '1.0',
  permalink: 'https://acme.slack.com/archives/C1/p11',
};

function pendingRequest(over: Partial<SlackPendingRequest> = {}): SlackPendingRequest {
  return {
    id: 'p1',
    workspaceId: 'ws1',
    prompt: 'Fix the login bug\n\nthread text',
    source,
    candidates: [{ repositoryId: 'r2', repoFullName: 'acme/api' }],
    createdAt: '2026-10-28T00:00:00Z',
    ...over,
  };
}

beforeAll(() => installNavigation());
beforeEach(() => {
  jest.clearAllMocks();
  openExternal.mockResolvedValue(undefined);
  useSlackPendingStore.setState({ pending: [], focusId: null });
  useWorkspaceStore.setState({
    repositories: [
      { id: 'r1', workspaceId: 'ws1', owner: 'acme', repo: 'app', fullName: 'acme/app' },
      { id: 'r2', workspaceId: 'ws1', owner: 'acme', repo: 'api', fullName: 'acme/api' },
    ],
  });
});
afterEach(() => cleanup());

describe('slackChannelLabel / slackDeepLink', () => {
  it.each([
    [{ channelId: 'C1', channelName: 'eng' }, '#eng'],
    [{ channelId: 'D1', channelName: null }, 'Slack DM'],
    [{ channelId: 'D1', channelName: 'x' }, 'Slack DM'],
    [{ channelId: 'C1', channelName: null }, 'Slack'],
  ])('%j -> %s', (input, expected) => {
    expect(slackChannelLabel(input)).toBe(expected);
  });

  it('prefers the thread ts and falls back to the message ts', () => {
    expect(slackDeepLink(source)).toBe('slack://channel?team=T1&id=C1&message=1.0');
    expect(slackDeepLink({ ...source, threadTs: '' })).toBe('slack://channel?team=T1&id=C1&message=1.1');
  });
});

describe('SlackThreadChip', () => {
  it('shows the channel and opens the deep link', async () => {
    render(<SlackThreadChip source={source} />);
    const chip = screen.getByRole('button', { name: /Open the Slack thread in #eng/ });
    expect(chip).toHaveAttribute('data-attr', 'session-open-slack-thread');
    expect(chip).toHaveAttribute('title', expect.stringContaining('Acme'));
    expect(chip).toHaveTextContent('#eng');
    expect(chip).toHaveTextContent('Open thread');
    fireEvent.click(chip);
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('slack://channel?team=T1&id=C1&message=1.0'));
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('falls back to the permalink when the deep link fails', async () => {
    openExternal.mockRejectedValueOnce(new Error('no handler'));
    render(<SlackThreadChip source={source} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(2));
    expect(openExternal).toHaveBeenLastCalledWith(source.permalink);
  });

  it('labels a DM', () => {
    render(<SlackThreadChip source={{ ...source, channelId: 'D9', channelName: null }} />);
    expect(screen.getByRole('button')).toHaveTextContent('Slack DM');
  });
});

describe('SlackSessionMark', () => {
  it('renders only for a Slack source', () => {
    const { container, rerender } = render(<SlackSessionMark source={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SlackSessionMark source={source} />);
    expect(screen.getByLabelText(/From Slack/)).toBeInTheDocument();
  });
});

describe('SidebarSlackPending', () => {
  it('renders nothing with no pending requests', () => {
    const { container } = render(<SidebarSlackPending />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists candidates first, then the other repositories', () => {
    useSlackPendingStore.setState({ pending: [pendingRequest()] });
    render(<SidebarSlackPending />);
    expect(screen.getByText('Fix the login bug')).toBeInTheDocument();
    expect(screen.getByText(/#eng/)).toBeInTheDocument();
    const options = Array.from(screen.getByLabelText('Repository').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['acme/api', 'acme/app']);
    expect(screen.getByLabelText('Repository')).toHaveValue('r2');
  });

  it('starts the request, navigates to the session and removes the item', async () => {
    const created = { id: 'wb9', workspaceId: 'ws1', repoFullName: 'acme/api' } as Workbench;
    startPending.mockResolvedValue(created);
    useSlackPendingStore.setState({ pending: [pendingRequest()] });
    render(<SidebarSlackPending />);
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'r1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(startPending).toHaveBeenCalledWith('p1', { repositoryId: 'r1' }));
    await waitFor(() => expect(useSlackPendingStore.getState().pending).toEqual([]));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb9' });
    expect(useWorkbenchStore.getState().workbenches.wb9).toBeDefined();
  });

  it('keeps the item and toasts when Start fails', async () => {
    startPending.mockRejectedValue(new Error('boom'));
    useSlackPendingStore.setState({ pending: [pendingRequest()] });
    render(<SidebarSlackPending />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not start the session', 'boom'));
    expect(useSlackPendingStore.getState().pending).toHaveLength(1);
  });

  it('offers every repository with no candidates and disables Start until one is picked', () => {
    useSlackPendingStore.setState({ pending: [pendingRequest({ candidates: [] })] });
    render(<SidebarSlackPending />);
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'r1' } });
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
  });
});

describe('slack notices', () => {
  const base = { workspaceId: 'ws1', source };

  it('pick_repository adds the item and toasts with a focus action', () => {
    const pending = pendingRequest();
    handleSlackNotice({ ...base, kind: 'pick_repository', message: 'Pick one', pending } as SlackNoticeEvent);
    expect(useSlackPendingStore.getState().pending).toEqual([pending]);
    const action = toastSuccess.mock.calls[0][2];
    expect(action.label).toBe('Pick repository');
    action.onClick();
    expect(useSlackPendingStore.getState().focusId).toBe('p1');
    expect(showNative).toHaveBeenCalled();
  });

  it.each(['start_failed', 'not_set_up'] as const)('%s shows an error toast with the message', (kind) => {
    handleSlackNotice({ ...base, kind, message: 'Nope' } as SlackNoticeEvent);
    expect(toastError).toHaveBeenCalledWith(expect.any(String), 'Nope');
    expect(useSlackPendingStore.getState().pending).toEqual([]);
    expect(showNative).toHaveBeenCalledWith(expect.any(String), 'Nope', expect.any(Function));
  });

  it('loadSlackPending fills the store and swallows errors', async () => {
    listPending.mockResolvedValueOnce([pendingRequest()]);
    await loadSlackPending();
    expect(useSlackPendingStore.getState().pending).toHaveLength(1);
    listPending.mockRejectedValueOnce(new Error('403'));
    await expect(loadSlackPending()).resolves.toBeUndefined();
    expect(useSlackPendingStore.getState().pending).toHaveLength(1);
  });
});

describe('sidebar rows', () => {
  it('draws the Slack mark only for Slack sessions, beside the state icon', () => {
    const mk = (id: string, over: Partial<Workbench> = {}) =>
      ({
        id, workspaceId: 'ws1', repositoryId: 'r1', repoFullName: 'acme/app', name: id, branch: id,
        baseBranch: 'main', runtime: 'sandbox', sandboxState: 'running', status: 'ready', pullRequestId: null,
        diffStat: null, archivedAt: null, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z', ...over,
      }) as Workbench;
    const slackWb = mk('from-slack', { source });
    const plain = mk('plain');
    useWorkbenchStore.getState().setWorkspace('ws1');
    useWorkbenchStore.getState().setWorkbenches('ws1', [slackWb, plain]);
    render(<SidebarWorkbenchList workbenches={[slackWb, plain]} />);
    const rows = screen.getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('[data-attr="session-slack-mark"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-attr="session-slack-mark"]')).toBeNull();
  });
});
