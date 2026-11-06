import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench, WorkbenchChat, Workspace } from '@talyn/shared';
import { ApiError } from '../lib/api';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { WorkbenchHeader } from '../components/workbench/WorkbenchHeader';
import { Composer } from '../components/workbench/Composer';
import { requestWorkbenchAction } from '../lib/workbenchActions';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';
import { useSpacesStore } from '../stores/spaces';
import { toast } from '../stores/toast';
import { wakeWorkbench } from '../lib/wakeWorkbench';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));
vi.mock('../lib/wakeWorkbench', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wakeWorkbench')>()),
  wakeWorkbench: vi.fn(),
}));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

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

function makeOps(send = vi.fn(async () => ({ queued: false }))): WorkbenchOps {
  return {
    runtime: 'sandbox',
    unavailable: null,
    readUnavailable: null,
    canRemoveQueued: false,
    canAttach: false,
    send,
    runAction: vi.fn(async () => {}),
    listFiles: vi.fn(async () => []),
  } as unknown as WorkbenchOps;
}

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
  vi.clearAllMocks();
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
    const send = vi.fn(async () => {
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
    expect(vi.mocked(wakeWorkbench)).toHaveBeenCalledTimes(wakes);
  });

  it('a refusal on my own session still goes to a toast', async () => {
    const send = vi.fn(async () => {
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
