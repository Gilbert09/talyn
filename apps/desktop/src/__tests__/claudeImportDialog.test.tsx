/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Features, Workbench, WorkbenchChat, WorkbenchReadiness, Workspace } from '@talyn/shared';
import type { ClaudeConversation } from '../workbenchBridgeTypes';
import { NewWorkbenchPage } from '../renderer/pages/NewWorkbenchPage';
import { CommandPalette } from '../renderer/components/CommandPalette';
import {
  ContinueClaudeConversationDialog,
  useClaudeImportDialog,
} from '../renderer/components/workbench/new/ContinueClaudeConversation';
import { CLAUDE_IMPORT_NOTICE, continueClaudeConversation } from '../renderer/lib/claudeImport';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { useNavigationStore } from '../renderer/stores/navigation';
import { usePullRequestStore } from '../renderer/stores/pullRequests';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

const mockApi = {
  readiness: jest.fn(),
  create: jest.fn(),
  get: jest.fn(),
  import: jest.fn(),
  remove: jest.fn(),
  updateChat: jest.fn(),
  events: jest.fn(),
};
jest.mock('../renderer/lib/api', () => ({
  ApiNetworkError: class ApiNetworkError extends Error {},
  api: {
    workbenches: new Proxy({}, { get: (_t, key: string) => (...args: unknown[]) => (mockApi as Record<string, jest.Mock>)[key](...args) }),
    pullRequests: {},
  },
}));
jest.mock('../renderer/lib/localWorkbench', () => ({ createLocalWorkbench: jest.fn() }));

const READY: WorkbenchReadiness = { sandbox: { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: true } } } };
const REPOS = [{ id: 'r1', workspaceId: 'ws1', owner: 'acme', repo: 'api', fullName: 'acme/api' }];

const AVAILABLE: ClaudeConversation = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  cwd: '/Users/x/dev/api',
  gitBranch: 'feature',
  title: 'Fix login',
  firstPrompt: 'Fix the login bug',
  lastActivity: new Date().toISOString(),
  bytes: 2048,
  repoFullName: 'acme/api',
  unavailableReason: null,
};
const UNAVAILABLE: ClaudeConversation = {
  ...AVAILABLE,
  sessionId: '00000000-0000-4000-8000-000000000002',
  cwd: '/Users/x/dev/other',
  firstPrompt: 'Something elsewhere',
  repoFullName: null,
  unavailableReason: 'Not a repository this workspace watches.',
};

const bridge = { list: jest.fn(), prepare: jest.fn() };

function setBridge(present: boolean) {
  (window as unknown as { electron?: unknown }).electron = present ? { workbench: { claudeImport: bridge } } : undefined;
}

function wb(over: Partial<Workbench> = {}): Workbench {
  return {
    id: 'wb1', workspaceId: 'ws1', repositoryId: 'r1', repoFullName: 'acme/api', name: 'lima', branch: 'lima', baseBranch: 'main',
    runtime: 'sandbox', agent: 'claude', status: 'ready', sandboxState: 'running', pullRequestId: null, archivedAt: null,
    settings: {}, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z', ...over,
  } as Workbench;
}

const chat = { id: 'c1', workbenchId: 'wb1', title: 'Fix the login bug', agent: 'claude', agentSessionId: AVAILABLE.sessionId } as WorkbenchChat;

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  setBridge(true);
  bridge.list.mockResolvedValue([AVAILABLE, UNAVAILABLE]);
  bridge.prepare.mockResolvedValue({ body: new Uint8Array([1, 2, 3]), sessionBytes: 1, patchBytes: 1, base: 'b'.repeat(40), root: '/r', untrackedFiles: 0 });
  mockApi.readiness.mockResolvedValue(READY);
  mockApi.create.mockResolvedValue(wb({ status: 'provisioning' }));
  mockApi.get.mockResolvedValue(wb());
  mockApi.import.mockResolvedValue({ chat, events: 5, turns: 2 });
  mockApi.remove.mockResolvedValue(undefined);
  mockApi.events.mockResolvedValue({ events: [], cursor: 0, hasOlder: false, oldestSeq: null });
  useClaudeImportDialog.setState({ open: false });
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', name: 'Acme', repos: [{ id: 'x1', name: 'acme/api', url: '', defaultBranch: 'main' }], settings: {} } as unknown as Workspace],
    repositories: REPOS,
    features: { workbenches: true } as Features,
  });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', []);
  usePullRequestStore.setState({ rows: [] });
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => {
  cleanup();
  setBridge(false);
});

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe('entry points', () => {
  const chip = () => screen.queryByRole('button', { name: 'Continue a Claude Code conversation' });

  it.each([
    ['shows', true, true, true],
    ['hides without the desktop bridge', false, true, false],
    ['hides when sessions are not offered', true, false, false],
  ])('the New session page %s', async (_label, bridgePresent, offered, shown) => {
    setBridge(bridgePresent);
    useWorkspaceStore.setState({ features: { workbenches: offered } as Features });
    render(<NewWorkbenchPage />);
    await flush();
    expect(Boolean(chip())).toBe(shown);
    if (shown) {
      fireEvent.click(chip()!);
      expect(useClaudeImportDialog.getState().open).toBe(true);
      expect(await screen.findByText('Fix the login bug')).toBeInTheDocument();
      expect(bridge.list).toHaveBeenCalledWith(['acme/api']);
    }
  });

  it.each([
    [true, true, true],
    [false, true, false],
    [true, false, false],
  ])('the palette item (bridge=%s, offered=%s) shows=%s and opens the dialog on Home', (bridgePresent, offered, shown) => {
    setBridge(bridgePresent);
    useWorkspaceStore.setState({ features: { workbenches: offered } as Features });
    useNavigationStore.getState().navigate({ view: 'prs', tab: 'mine' } as never);
    useNavigationStore.setState({ paletteOpen: true });
    render(<CommandPalette />);
    const item = screen.queryByText('Continue a Claude Code conversation');
    expect(Boolean(item)).toBe(shown);
    if (item) {
      fireEvent.click(item);
      expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
      expect(useClaudeImportDialog.getState().open).toBe(true);
    }
  });
});

describe('the picker', () => {
  function renderDialog(blockedReason: string | null = null) {
    useClaudeImportDialog.setState({ open: true });
    return render(<ContinueClaudeConversationDialog workspaceId="ws1" repositories={REPOS} blockedReason={blockedReason} />);
  }
  const row = (text: string) => screen.getByText(text).closest('button')!;

  it('lists conversations and greys out the ones it cannot continue, with the reason', async () => {
    renderDialog();
    await screen.findByText('Fix the login bug');
    expect(row('Fix the login bug')).toBeEnabled();
    expect(row('Fix the login bug')).toHaveTextContent('acme/api · feature · just now · 2 KB');
    expect(row('Something elsewhere')).toBeDisabled();
    expect(row('Something elsewhere')).toHaveTextContent('Not a repository this workspace watches.');
  });

  it('asks before anything leaves the machine, and Cancel goes back', async () => {
    renderDialog();
    fireEvent.click(await screen.findByText('Fix the login bug'));
    expect(screen.getByRole('note')).toHaveTextContent(CLAUDE_IMPORT_NOTICE);
    expect(bridge.prepare).not.toHaveBeenCalled();
    expect(mockApi.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Something elsewhere')).toBeInTheDocument();
  });

  it('disables every row when a sandbox Claude session cannot start', async () => {
    renderDialog('Connect Claude to Talyn Fleet.');
    await screen.findByText('Fix the login bug');
    expect(screen.getByText('Connect Claude to Talyn Fleet.')).toBeInTheDocument();
    expect(row('Fix the login bug')).toBeDisabled();
  });

  it('says so when there is nothing to list, or the list fails', async () => {
    bridge.list.mockResolvedValueOnce([]);
    const { unmount } = renderDialog();
    expect(await screen.findByText('No Claude Code conversations on this machine.')).toBeInTheDocument();
    unmount();
    useClaudeImportDialog.setState({ open: false });
    bridge.list.mockRejectedValueOnce(new Error('EACCES'));
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent('EACCES');
  });

  it('Continue creates the session, uploads, opens it and closes', async () => {
    mockApi.create.mockResolvedValue(wb());
    renderDialog();
    fireEvent.click(await screen.findByText('Fix the login bug'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(useClaudeImportDialog.getState().open).toBe(false));
    expect(mockApi.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws1', repositoryId: 'r1', runtime: 'sandbox', agent: 'claude' }));
    expect(mockApi.create.mock.calls[0][0]).not.toHaveProperty('prompt');
    expect(bridge.prepare).toHaveBeenCalledWith({ sessionId: AVAILABLE.sessionId, cwd: AVAILABLE.cwd });
    expect(mockApi.import).toHaveBeenCalledWith('wb1', new Uint8Array([1, 2, 3]));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb1' });
  });

  it('shows the error and the step when the upload fails', async () => {
    mockApi.import.mockRejectedValue(new Error('Could not apply your changes in the sandbox.'));
    mockApi.create.mockResolvedValue(wb());
    renderDialog();
    fireEvent.click(await screen.findByText('Fix the login bug'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not apply your changes in the sandbox.');
    expect(screen.getByRole('button', { name: 'Open the session' })).toBeInTheDocument();
    expect(mockApi.remove).not.toHaveBeenCalled();
  });
});

describe('continueClaudeConversation', () => {
  const run = (onStep: (step: string) => void = () => undefined) =>
    continueClaudeConversation({ bridge: { claudeImport: bridge }, conversation: AVAILABLE, workspaceId: 'ws1', repositoryId: 'r1', onStep });

  it('reports the steps in order and waits for the box before uploading', async () => {
    const steps: string[] = [];
    mockApi.create.mockResolvedValue(wb({ status: 'provisioning' }));
    const done = run((s) => {
      steps.push(s);
    });
    await waitFor(() => expect(steps).toEqual(['create', 'wait']));
    expect(mockApi.import).not.toHaveBeenCalled();
    act(() => useWorkbenchStore.getState().upsertWorkbench(wb({ status: 'ready' })));
    await done;
    expect(steps).toEqual(['create', 'wait', 'prepare', 'upload', 'open']);
    expect(useWorkbenchStore.getState().selectedChatByWorkbench.wb1).toBe('c1');
  });

  it.each([
    ['the box fails to start', () => mockApi.create.mockResolvedValue(wb({ status: 'error', statusMessage: 'No capacity.' })), 'wait', 'No capacity.'],
    ['reading the changes fails', () => {
      mockApi.create.mockResolvedValue(wb());
      bridge.prepare.mockRejectedValue(new Error('Remove large untracked files'));
    }, 'prepare', 'Remove large untracked files'],
  ])('removes the new session when %s', async (_label, arrange, step, message) => {
    arrange();
    await expect(run()).rejects.toMatchObject({ step, message, workbenchId: null });
    expect(mockApi.remove).toHaveBeenCalledWith('wb1');
    expect(mockApi.import).not.toHaveBeenCalled();
  });

  it('creates nothing when create is refused', async () => {
    mockApi.create.mockRejectedValue(new Error('Connect Claude to Talyn Fleet.'));
    await expect(run()).rejects.toMatchObject({ step: 'create', workbenchId: null });
    expect(bridge.prepare).not.toHaveBeenCalled();
  });
});
