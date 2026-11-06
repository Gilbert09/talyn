import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat, Workspace } from '@talyn/shared';
import { api, ApiError } from '../renderer/lib/api';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { WorkbenchHeader } from '../renderer/components/workbench/WorkbenchHeader';
import { ChatTabs } from '../renderer/components/workbench/ChatTabs';
import { SidebarWorkbenchList } from '../renderer/components/layout/SidebarWorkbenchList';
import { MoveToSpaceDialog, moveToSpace } from '../renderer/components/spaces/MoveToSpace';
import { buildAppShortcuts } from '../renderer/components/layout/appShortcuts';
import { useNavigationStore } from '../renderer/stores/navigation';
import { Composer } from '../renderer/components/workbench/Composer';
import { requestWorkbenchAction } from '../renderer/lib/workbenchActions';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useSpacesStore } from '../renderer/stores/spaces';
import { toast } from '../renderer/stores/toast';
import { wakeWorkbench } from '../renderer/lib/wakeWorkbench';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn(), captureAnalyticsException: jest.fn() }));
jest.mock('../renderer/lib/wakeWorkbench', () => ({
  ...jest.requireActual('../renderer/lib/wakeWorkbench'),
  wakeWorkbench: jest.fn(),
}));
jest.mock('../renderer/stores/toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));

const MINE: Workbench = {
  id: 'wb1',
  workspaceId: 'ws1',
  repositoryId: 'r1',
  repoFullName: 'acme/app',
  name: 'lisbon',
  branch: 'lisbon',
  baseBranch: 'main',
  runtime: 'sandbox',
  agent: 'claude',
  deviceId: null,
  localPath: null,
  sandboxId: 'sb1',
  sandboxState: 'running',
  status: 'ready',
  pullRequestId: null,
  settings: {},
  diffStat: null,
  spaceId: 's1',
  archivedAt: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};
const THEIRS: Workbench = { ...MINE, id: 'wb2', workspaceId: 'ws-ana', sandboxId: null };
const CHAT = { id: 'c1', workbenchId: 'wb2', status: 'idle', agent: 'claude', model: null, effort: null, planMode: false, queuedMessages: [] } as unknown as WorkbenchChat;

function makeOps(send = jest.fn(async () => ({ queued: false }))): WorkbenchOps {
  return {
    runtime: 'sandbox',
    unavailable: null,
    readUnavailable: null,
    canRemoveQueued: false,
    canAttach: false,
    send,
    runAction: jest.fn(async () => {}),
    listFiles: jest.fn(async () => []),
  } as unknown as WorkbenchOps;
}

beforeAll(() => {
  const globals = global as unknown as Record<string, unknown>;
  globals.DOMRect = class {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    static fromRect(rect: { x?: number; y?: number; width?: number; height?: number } = {}) {
      return new (globals.DOMRect as new (...args: (number | undefined)[]) => unknown)(rect.x, rect.y, rect.width, rect.height);
    }
    get left() { return this.x; }
    get top() { return this.y; }
    get right() { return this.x + this.width; }
    get bottom() { return this.y + this.height; }
  };
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  useWorkspaceStore.setState({
    workspaces: [{ id: 'ws1', name: 'Mine', repos: [] } as unknown as Workspace],
    currentWorkspaceId: 'ws1',
    features: { spaces: true, workbenches: true } as never,
  });
  useWorkbenchStore.setState({ workspaceId: 'ws1', workbenches: { wb1: MINE }, extraWorkbenchIds: {}, chats: {}, drafts: {} });
  useWorkbenchStore.getState().addExtraWorkbench(THEIRS);
  useSpacesStore.setState({
    selfUserId: 'me',
    dialog: null,
    teams: [{
      id: 't1', name: 'Acme', role: 'member', homeWorkspaceId: 'ws1', createdAt: '',
      spaces: [{ id: 's1', teamId: 't1', name: 'Web', color: '#10b981', createdByUserId: null, archivedAt: null, createdAt: '', updatedAt: '' }],
    }],
    sessions: {
      s1: {
        loaded: true, error: null, hiddenCount: 0,
        items: [{ id: 'wb2', creator: { userId: 'ana', githubLogin: 'ana', avatarUrl: null } } as never],
      },
    },
    presence: {
      s1: [
        { userId: 'ben', githubLogin: 'ben', avatarUrl: null, sessionId: 'wb2', state: 'active', at: 0 },
        { userId: 'me', githubLogin: 'me', avatarUrl: null, sessionId: 'wb2', state: 'active', at: 0 },
      ],
    },
  });
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('session header', () => {
  it.each([
    ['my session', MINE, true],
    ["a teammate's session", THEIRS, false],
  ])('%s: owner actions shown = %s', (_name, wb, owner) => {
    render(<WorkbenchHeader workbench={wb} pr={null} chat={null} ops={makeOps()} />);
    const present = (el: HTMLElement | null) => (owner ? expect(el).toBeInTheDocument() : expect(el).toBeNull());
    present(screen.queryByRole('button', { name: 'More actions' }));
    present(screen.queryByRole('button', { name: 'Toggle the terminal' }));
    expect(screen.queryByText("ana's session") !== null).toBe(!owner);
    expect(screen.getByText('Web')).toBeInTheDocument();
  });

  it("names who else is in a teammate's session, and leaves me out", () => {
    render(<WorkbenchHeader workbench={THEIRS} pr={null} chat={null} ops={makeOps()} />);
    expect(screen.getByText('ben is here')).toBeInTheDocument();
  });

  it('hides Restore on an archived teammate session', () => {
    const archived = { ...THEIRS, status: 'archived' as const, archivedAt: '2026-11-02T00:00:00Z' };
    useWorkbenchStore.getState().addExtraWorkbench(archived);
    render(<WorkbenchHeader workbench={archived} pr={null} chat={null} ops={makeOps()} />);
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull();
  });

  it("ignores a keyboard action on a teammate's session", () => {
    render(<WorkbenchHeader workbench={THEIRS} pr={null} chat={null} ops={makeOps()} />);
    act(() => requestWorkbenchAction(THEIRS.id, 'archive'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('a teammate session does not rename on double-click', () => {
    render(<WorkbenchHeader workbench={THEIRS} pr={null} chat={null} ops={makeOps()} />);
    fireEvent.doubleClick(screen.getByRole('heading', { name: 'lisbon' }));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('composer', () => {
  const renderComposer = (wb: Workbench, ops: WorkbenchOps) =>
    render(<Composer workbench={wb} chat={{ ...CHAT, workbenchId: wb.id }} ops={ops} todos={null} contextUsage={null} slashCommands={null} />);

  it.each([
    ['my session', MINE, false],
    ["a teammate's session", THEIRS, true],
  ])('%s: payer note shown = %s', (_name, wb, note) => {
    renderComposer(wb, makeOps());
    expect(screen.queryByText('Runs on your subscription and your box-hours') !== null).toBe(note);
  });

  it.each([
    ['payer_busy', new ApiError("Waiting for ana's turn to finish.", 409, 'payer_busy'), "Waiting for ana's turn to finish."],
    ['no agent account', new ApiError('Connect an agent to prompt here.', 403, 'no_agent_account'), 'Connect an agent to prompt here.'],
  ])('shows a %s refusal inline and keeps the draft', async (_name, err, text) => {
    const send = jest.fn(async () => {
      throw err;
    });
    renderComposer(THEIRS, makeOps(send));
    const box = screen.getByRole('textbox', { name: 'Message the agent' });
    fireEvent.change(box, { target: { value: 'please fix the test' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(text));
    expect(toast.error).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe('please fix the test');
  });

  it.each([
    ['my session', MINE, 1],
    ["a teammate's session", THEIRS, 0],
  ])('typing in %s wakes the box %s times', (_name, wb, wakes) => {
    renderComposer(wb, makeOps());
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'h' } });
    expect(jest.mocked(wakeWorkbench)).toHaveBeenCalledTimes(wakes);
  });

  it('a refusal on my own session still goes to a toast', async () => {
    const send = jest.fn(async () => {
      throw new ApiError('The sandbox is not ready.', 409, 'not_ready');
    });
    renderComposer(MINE, makeOps(send));
    const box = screen.getByRole('textbox', { name: 'Message the agent' });
    fireEvent.change(box, { target: { value: 'go' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});


describe('desktop ownership controls', () => {
  it.each([
    ['sandbox', true, true],
    ['local', true, false],
    ['sandbox', false, false],
    ['local', false, false],
  ] as const)('%s with spaces=%s offers move=%s', async (runtime, enabled, offered) => {
    useWorkspaceStore.setState({ features: { spaces: enabled } as never });
    render(<WorkbenchHeader workbench={{ ...MINE, runtime }} pr={null} chat={null} ops={makeOps()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'Move to space…' }) !== null).toBe(offered);
    expect(screen.queryByRole('menuitem', { name: 'Move to Personal' }) !== null).toBe(offered);
  });

  it.each(['sandbox', 'local'] as const)('the %s sidebar offers the correct move action', async (runtime) => {
    render(<SidebarWorkbenchList workbenches={[{ ...MINE, runtime }]} />);
    fireEvent.contextMenu(screen.getByRole('button', { name: /lisbon/ }));
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: 'Move to space…' }) !== null).toBe(runtime === 'sandbox');
  });

  it('refuses a local session move and does not open its move dialog', async () => {
    useWorkbenchStore.getState().upsertWorkbench({ ...MINE, runtime: 'local' });
    useSpacesStore.getState().openDialog({ kind: 'move', target: 'session', id: MINE.id, spaceId: null });
    const move = jest.spyOn(api.spaces, 'moveSession');
    render(<MoveToSpaceDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await moveToSpace('session', MINE.id, null, 's1')).toBe(false);
    expect(move).not.toHaveBeenCalled();
    move.mockRestore();
  });

  it.each([MINE, THEIRS])('hides chat changes for a member viewing $id', (workbench) => {
    const chat = { ...CHAT, workbenchId: workbench.id, title: 'Main' };
    useWorkbenchStore.getState().setChats(workbench.id, [chat]);
    render(<ChatTabs workbench={workbench} selected={chat} />);
    expect(screen.queryByRole('button', { name: 'New chat' }) !== null).toBe(workbench === MINE);
    expect(screen.queryByRole('button', { name: 'Close Main' }) !== null).toBe(workbench === MINE);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Main' }));
    expect(screen.queryByRole('textbox', { name: 'Chat title' }) !== null).toBe(workbench === MINE);
  });

  it('disables owner shortcuts on a teammate session', () => {
    useWorkbenchStore.getState().setChats(THEIRS.id, [CHAT]);
    useNavigationStore.getState().navigate({ view: 'workbench', id: THEIRS.id });
    const shortcuts = buildAppShortcuts();
    for (const id of ['chat.new', 'chat.close', 'terminal.toggle', 'workbench.sandbox', 'workbench.archive']) {
      expect(shortcuts.find((shortcut) => shortcut.id === id)?.when?.()).toBe(false);
    }
  });
});
