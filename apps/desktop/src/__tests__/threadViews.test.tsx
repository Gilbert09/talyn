/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentEvent, MemoryEntrySummary, Workbench, WorkbenchChat } from '@talyn/shared';
import type { PRRow } from '../renderer/lib/api';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { AgentBlocks } from '../renderer/components/terminal/AgentConversation';
import { WorkPanel } from '../renderer/components/workbench/WorkPanel';
import { WorkbenchHeader } from '../renderer/components/workbench/WorkbenchHeader';
import { ComposerPopover } from '../renderer/components/workbench/ComposerPopover';
import { createThread } from '../renderer/lib/threadActions';
import { useNavigationStore } from '../renderer/stores/navigation';
import { usePullRequestStore } from '../renderer/stores/pullRequests';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { toast } from '../renderer/stores/toast';

const memoryList = jest.fn();
const continueAsThread = jest.fn();
const create = jest.fn();
const update = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: {
    pullRequests: { get: jest.fn(() => new Promise(() => {})) },
    workbenches: {
      memory: { list: (...a: unknown[]) => memoryList(...a) },
      continueAsThread: (...a: unknown[]) => continueAsThread(...a),
      create: (...a: unknown[]) => create(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}));
const openExternal = jest.fn();
jest.mock('../renderer/lib/openExternal', () => ({ openExternal: (...a: unknown[]) => openExternal(...a) }));

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: id,
    branch: `tom/${id}`,
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    deviceId: null,
    localPath: null,
    sandboxId: null,
    sandboxState: 'running',
    status: 'ready',
    pullRequestId: null,
    settings: {},
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

const THREAD = wb('t1', { kind: 'thread', repositoryId: null, repoFullName: '', branch: '', baseBranch: '', title: 'Fleet hardening' });

function memory(id: string, scope: MemoryEntrySummary['scope'], over: Partial<MemoryEntrySummary> = {}): MemoryEntrySummary {
  return {
    id,
    workspaceId: 'ws1',
    scope,
    repositoryId: null,
    threadId: scope === 'thread' ? 't1' : null,
    type: 'project',
    name: `Note ${id}`,
    description: `About ${id}`,
    bytes: 10,
    source: { kind: 'user' },
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:00:00Z',
    forgottenAt: null,
    ...over,
  };
}

function ops(): WorkbenchOps {
  return {
    runtime: 'sandbox',
    unavailable: null,
    canRemoveQueued: false,
    canAttach: false,
    runAction: jest.fn(async () => {}),
    send: jest.fn(async () => ({ queued: false })),
  } as unknown as WorkbenchOps;
}

const openSettings = jest.fn();

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  useWorkspaceStore.setState({ repositories: [], openSettings } as never);
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', [
    THREAD,
    wb('a', { repoFullName: 'acme/web', threadId: 't1', pullRequestId: 'pr1', createdAt: '2026-10-14T00:00:00Z' }),
    wb('b', { repoFullName: 'acme/api', threadId: 't1', createdAt: '2026-10-15T00:00:00Z' }),
    wb('c', { repoFullName: 'acme/web', threadId: 't1', archivedAt: '2026-10-16T00:00:00Z', createdAt: '2026-10-16T00:00:00Z' }),
    wb('other', { repoFullName: 'acme/zzz' }),
  ]);
  useWorkbenchStore.setState({ chats: { b: [{ id: 'cb', workbenchId: 'b', status: 'running', createdAt: '' } as WorkbenchChat] }, unread: {} });
  usePullRequestStore.setState({
    rows: [
      {
        id: 'pr1',
        number: 12,
        state: 'open',
        summary: { draft: false, ciStatus: 'failing_required', mergeable: 'MERGEABLE', url: 'https://github.com/acme/web/pull/12' },
      } as unknown as PRRow,
    ],
  });
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('WorkPanel', () => {
  it('lists the sessions with repository, branch, state, PR and CI, and opens one', async () => {
    memoryList.mockResolvedValue([]);
    render(<WorkPanel thread={THREAD} />);
    const sessions = screen.getByRole('list', { name: 'Sessions of this thread' });
    const rows = within(sessions).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('acme/web · tom/a');
    expect(rows[0]).toHaveTextContent('#12');
    expect(rows[0]).toHaveTextContent('CI failing');
    expect(rows[1]).toHaveTextContent('Working');
    expect(rows[2]).toHaveTextContent('Archived');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Open b' }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'b' });
    await waitFor(() => expect(memoryList).toHaveBeenCalledWith({ workspaceId: 'ws1', threadId: 't1' }));
  });

  it('lists the repositories the sessions touch', async () => {
    memoryList.mockResolvedValue([]);
    render(<WorkPanel thread={THREAD} />);
    const repos = screen.getByRole('list', { name: 'Repositories of this thread' });
    expect(within(repos).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['acme/api', 'acme/web']);
    await screen.findByText('Nothing saved yet.');
  });

  it('shows the first memory entries, hides forgotten ones, and Open all goes to Instructions', async () => {
    memoryList.mockResolvedValue([
      memory('m1', 'thread'),
      memory('m2', 'workspace'),
      memory('gone', 'workspace', { forgottenAt: '2026-10-31T00:00:00Z' }),
      memory('m3', 'workspace'),
      memory('m4', 'workspace'),
      memory('m5', 'workspace'),
      memory('m6', 'workspace'),
      memory('m7', 'workspace'),
    ]);
    render(<WorkPanel thread={THREAD} />);
    const list = await screen.findByRole('list', { name: 'Memory of this thread' });
    expect(within(list).getByText('Note m1')).toBeInTheDocument();
    expect(within(list).getAllByText('Thread')).toHaveLength(1);
    expect(within(list).queryByText('Note gone')).not.toBeInTheDocument();
    expect(within(list).queryByText('Note m6')).not.toBeInTheDocument();
    expect(within(list).getByText('2 more')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open all' }));
    expect(openSettings).toHaveBeenCalledWith('instructions');
  });

  it('says so when memory cannot load', async () => {
    memoryList.mockRejectedValue(new Error('boom'));
    render(<WorkPanel thread={THREAD} />);
    expect(await screen.findByText('Could not load memory.')).toBeInTheDocument();
  });

  it('says what to do when the thread has no sessions', async () => {
    memoryList.mockResolvedValue([]);
    render(<WorkPanel thread={wb('t2', { kind: 'thread', repoFullName: '' })} />);
    expect(screen.getByText('No sessions yet. Ask the thread to start one.')).toBeInTheDocument();
    expect(screen.getByText('No repositories yet.')).toBeInTheDocument();
    await screen.findByText('Nothing saved yet.');
  });
});

describe('thread transcript cards', () => {
  const threadEvent = (seq: number, action: string, extra: Record<string, unknown> = {}): AgentEvent =>
    ({ seq, type: 'talyn_thread', action, sessionId: 'a', name: 'fix-login', repo: 'acme/web', status: 'idle', ...extra }) as unknown as AgentEvent;

  it.each<[string, Record<string, unknown>, string]>([
    ['session_started', {}, 'Session started'],
    ['session_finished', {}, 'Session finished its turn'],
    ['session_finished', { status: 'error' }, 'Session stopped with an error'],
    ['pr_opened', { prUrl: 'https://github.com/acme/web/pull/12' }, 'Pull request opened'],
    ['needs_input', { status: 'awaiting_input' }, 'Session needs an answer'],
  ])('%s %j', (action, extra, title) => {
    render(<AgentBlocks events={[threadEvent(1, action, extra)]} />);
    const card = screen.getByTestId('thread-session-card');
    expect(card).toHaveTextContent(title);
    expect(card).toHaveTextContent('fix-login · acme/web');
    fireEvent.click(within(card).getByRole('button', { name: 'Open the session fix-login' }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'a' });
    const prButton = within(card).queryByRole('button', { name: 'Pull request' });
    if (extra.prUrl) {
      fireEvent.click(prButton!);
      expect(openExternal).toHaveBeenCalledWith(extra.prUrl);
    } else {
      expect(prButton).toBeNull();
    }
  });

  it('shows why the thread paused and how to continue', () => {
    render(<AgentBlocks events={[threadEvent(1, 'paused')]} />);
    const card = screen.getByTestId('thread-session-card');
    expect(card).toHaveTextContent('Paused');
    expect(card).toHaveTextContent('The thread stopped waking itself because its sessions made no progress since its last turn. It waits for the person.');
    expect(card).toHaveTextContent('Send a message to continue.');
    expect(within(card).queryByRole('button', { name: /Open/ })).not.toBeInTheDocument();
  });

  it('draws a Talyn message as a compact note, not a user bubble', () => {
    const event = {
      seq: 2,
      type: 'user',
      talyn: { origin: 'talyn' },
      message: { role: 'user', content: [{ type: 'text', text: 'Session fix-login finished its turn.' }] },
    } as unknown as AgentEvent;
    render(<AgentBlocks events={[event]} />);
    const note = screen.getByTestId('talyn-message');
    expect(note).toHaveTextContent('Talyn');
    expect(note).toHaveTextContent('Session fix-login finished its turn.');
  });

  it('skips a talyn_thread event it cannot read', () => {
    render(<AgentBlocks events={[threadEvent(3, 'unknown_action')]} />);
    expect(screen.queryByTestId('thread-session-card')).not.toBeInTheDocument();
  });
});

describe('WorkbenchHeader and threads', () => {
  const chat = { id: 'c1' } as WorkbenchChat;

  it('shows "Part of <thread>" on a session in a thread, and opens the thread', () => {
    render(<WorkbenchHeader workbench={wb('a', { threadId: 't1' })} pr={null} chat={chat} ops={ops()} />);
    const chip = screen.getByRole('button', { name: 'Open the thread Fleet hardening' });
    expect(chip).toHaveTextContent('Part ofFleet hardening');
    fireEvent.click(chip);
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 't1' });
  });

  it('shows no thread chip for a session outside a thread', () => {
    render(<WorkbenchHeader workbench={wb('other')} pr={null} chat={chat} ops={ops()} />);
    expect(screen.queryByRole('button', { name: /Open the thread/ })).not.toBeInTheDocument();
  });

  it('hides repository actions for a thread: no branch, no terminal, only Archive', () => {
    render(<WorkbenchHeader workbench={THREAD} pr={null} chat={chat} ops={ops()} />);
    expect(screen.getByText('Thread')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy the branch name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Toggle the terminal' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('workbench-primary-action')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['ArchiveCtrl+Shift+A']);
  });

  it('does not offer Continue as thread for a session already in a thread', () => {
    render(<WorkbenchHeader workbench={wb('a', { threadId: 't1' })} pr={null} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    expect(screen.queryByRole('menuitem', { name: 'Continue as thread' })).not.toBeInTheDocument();
  });

  it('continues a session as a thread and opens the thread', async () => {
    const session = wb('other');
    const created = wb('t9', { kind: 'thread', repositoryId: null, repoFullName: '', title: 'other' });
    continueAsThread.mockResolvedValue(created);
    render(<WorkbenchHeader workbench={session} pr={null} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Continue as thread' }));
    await waitFor(() => expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 't9' }));
    expect(continueAsThread).toHaveBeenCalledWith('other');
    expect(useWorkbenchStore.getState().workbenches.t9).toEqual(created);
    expect(useWorkbenchStore.getState().workbenches.other.threadId).toBe('t9');
  });

  it('says so when Continue as thread fails', async () => {
    continueAsThread.mockRejectedValue(new Error('No sandbox'));
    render(<WorkbenchHeader workbench={wb('other')} pr={null} chat={chat} ops={ops()} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Continue as thread' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not continue as a thread', 'No sandbox'));
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });
});

describe('createThread', () => {
  it.each<[string, string, boolean]>([
    ['with a name', 'Fleet hardening', true],
    ['without a name', '   ', false],
  ])('%s', async (_name, name, renamed) => {
    const thread = wb('t5', { kind: 'thread', repositoryId: null, repoFullName: '', name: 'harden-fleet' });
    create.mockResolvedValue(thread);
    update.mockImplementation(async (_id: string, patch: { title: string }) => ({ ...thread, title: patch.title }));
    await createThread({ workspaceId: 'ws1', name, prompt: '  Harden the fleet  ', agent: 'codex', model: 'gpt-x' });
    expect(create).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      kind: 'thread',
      runtime: 'sandbox',
      agent: 'codex',
      model: 'gpt-x',
      prompt: 'Harden the fleet',
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty('repositoryId');
    if (renamed) expect(update).toHaveBeenCalledWith('t5', { title: 'Fleet hardening' });
    else expect(update).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().workbenches.t5.title).toBe(renamed ? 'Fleet hardening' : undefined);
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 't5' });
  });

  it('keeps the thread when the rename fails', async () => {
    const thread = wb('t6', { kind: 'thread', repositoryId: null, repoFullName: '' });
    create.mockResolvedValue(thread);
    update.mockRejectedValue(new Error('nope'));
    await expect(createThread({ workspaceId: 'ws1', name: 'X', prompt: 'go', agent: 'claude' })).resolves.toEqual(thread);
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 't6' });
  });
});

describe('ComposerPopover in a thread', () => {
  beforeAll(() => {
    // jsdom has no layout, so no scrollIntoView.
    Element.prototype.scrollIntoView = jest.fn();
  });

  it('shows the labels of sessions and repositories and inserts the value', () => {
    const onPick = jest.fn();
    render(
      <ComposerPopover
        kind="mention"
        items={['session:a', 'acme/web']}
        active={0}
        loading={false}
        onPick={onPick}
        onHover={() => {}}
        mentions={{ heading: 'Sessions and repositories', empty: 'None.', labels: { 'session:a': 'fix-login · acme/web', 'acme/web': 'acme/web' } }}
      />
    );
    expect(screen.getByText('Sessions and repositories')).toBeInTheDocument();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['fix-login · acme/web', 'acme/web']);
    fireEvent.mouseDown(screen.getByText('fix-login · acme/web'));
    expect(onPick).toHaveBeenCalledWith('session:a');
  });

  it('says what is missing when nothing matches', () => {
    render(
      <ComposerPopover
        kind="mention"
        items={[]}
        active={0}
        loading={false}
        onPick={() => {}}
        onHover={() => {}}
        mentions={{ heading: 'Sessions and repositories', empty: 'No matching session or repository.', labels: {} }}
      />
    );
    expect(screen.getByText('No matching session or repository.')).toBeInTheDocument();
  });
});
