/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { useCreateWorkbench, type NewWorkbenchSpec } from '../renderer/components/workbench/new/useCreateWorkbench';
import { useWorkbenchStore } from '../renderer/stores/workbenches';
import { useNavigationStore } from '../renderer/stores/navigation';
import { useToastStore } from '../renderer/stores/toast';
import { useWorkspaceStore } from '../renderer/stores/workspace';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

const mockApi = {
  create: jest.fn(),
  updateChat: jest.fn(),
  createChat: jest.fn(),
};
jest.mock('../renderer/lib/api', () => ({
  api: {
    workbenches: {
      create: (...args: unknown[]) => mockApi.create(...args),
      updateChat: (...args: unknown[]) => mockApi.updateChat(...args),
      createChat: (...args: unknown[]) => mockApi.createChat(...args),
    },
  },
}));

const mockCreateLocal = jest.fn();
jest.mock('../renderer/lib/localWorkbench', () => ({
  createLocalWorkbench: (...args: unknown[]) => mockCreateLocal(...args),
}));

const mockSend = jest.fn();
jest.mock('../renderer/lib/workbenchOps', () => ({
  opsFor: () => ({ send: (...args: unknown[]) => mockSend(...args) }),
}));

function chat(id: string, over: Partial<WorkbenchChat> = {}): WorkbenchChat {
  return {
    id,
    workbenchId: 'wb1',
    title: 'Chat',
    agent: 'claude',
    model: null,
    status: 'idle',
    planMode: false,
    effort: null,
    queuedMessages: [],
    createdAt: '2026-10-14T00:00:00Z',
    updatedAt: '2026-10-14T00:00:00Z',
    ...over,
  } as unknown as WorkbenchChat;
}

function workbench(over: Partial<Workbench> = {}): Workbench {
  return {
    id: 'wb1',
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    name: 'fix-login',
    branch: 'fix-login',
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    deviceId: null,
    localPath: null,
    sandboxId: 'sb',
    sandboxState: 'creating',
    status: 'provisioning',
    pullRequestId: null,
    settings: {},
    diffStat: null,
    archivedAt: null,
    createdAt: '2026-10-14T00:00:00Z',
    updatedAt: '2026-10-14T00:00:00Z',
    chats: [chat('c1')],
    ...over,
  } as Workbench;
}

function spec(over: Partial<NewWorkbenchSpec> = {}): NewWorkbenchSpec {
  return {
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/app',
    runtime: 'sandbox',
    agent: 'claude',
    model: 'claude-sonnet',
    effort: 'high',
    planMode: false,
    internetAccess: true,
    prompt: '  Fix the login redirect  ',
    ...over,
  };
}

async function run(input: NewWorkbenchSpec) {
  const { result } = renderHook(() => useCreateWorkbench());
  let created: Workbench | null = null;
  await act(async () => {
    created = await result.current.create(input);
  });
  // Let the detached local first-message start settle.
  await act(async () => {
    await Promise.resolve();
  });
  return { result, created: created as Workbench | null };
}

beforeEach(() => {
  jest.clearAllMocks();
  useWorkbenchStore.setState({ workbenches: {}, chats: {}, selectedChatByWorkbench: {} });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', [workbench({ id: 'old', name: 'lisbon' })]);
  useNavigationStore.getState().navigate({ view: 'home' });
  useToastStore.setState({ toasts: [] });
});

describe('useCreateWorkbench: sandbox', () => {
  it('creates with the trimmed prompt, stores the workbench and opens it', async () => {
    mockApi.create.mockResolvedValue(workbench());
    const { result, created } = await run(spec({ baseBranch: ' develop ' }));

    expect(mockApi.create).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      repositoryId: 'r1',
      runtime: 'sandbox',
      agent: 'claude',
      model: 'claude-sonnet',
      baseBranch: 'develop',
      branch: undefined,
      fromPullRequestId: undefined,
      prompt: 'Fix the login redirect',
      internetAccess: true,
    });
    expect(created?.id).toBe('wb1');
    expect(useWorkbenchStore.getState().workbenches.wb1).toBeDefined();
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb1' });
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(mockApi.updateChat).not.toHaveBeenCalled();
    expect(mockCreateLocal).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   \n '],
  ])('sends no prompt for an %s task', async (_label, prompt) => {
    mockApi.create.mockResolvedValue(workbench());
    await run(spec({ prompt }));
    expect(mockApi.create.mock.calls[0][0].prompt).toBeUndefined();
  });

  it('passes an existing branch and a pull request through', async () => {
    mockApi.create.mockResolvedValue(workbench());
    await run(spec({ branch: 'feat/x', fromPullRequestId: 'pr1', baseBranch: '' }));
    expect(mockApi.create.mock.calls[0][0]).toMatchObject({ branch: 'feat/x', fromPullRequestId: 'pr1', baseBranch: undefined });
  });

  it.each([
    ['plan mode', { planMode: true, effort: 'high' as const }],
    ['effort', { planMode: false, effort: 'low' as const }],
    ['both', { planMode: true, effort: 'max' as const }],
  ])('sets %s on the first chat before its queued message runs', async (_label, over) => {
    mockApi.create.mockResolvedValue(workbench());
    mockApi.updateChat.mockResolvedValue(chat('c1', { planMode: over.planMode }));
    await run(spec(over));
    expect(mockApi.updateChat).toHaveBeenCalledWith('c1', { planMode: over.planMode, effort: over.effort });
  });

  it('still opens the workbench when setting plan mode fails', async () => {
    mockApi.create.mockResolvedValue(workbench());
    mockApi.updateChat.mockRejectedValue(new Error('nope'));
    const { result } = await run(spec({ planMode: true }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb1' });
    expect(result.current.error).toBeNull();
  });

  it.each([
    ['a readiness refusal', Object.assign(new Error('Talyn Fleet is not deployed here.'), { status: 503 })],
    ['an agent refusal', Object.assign(new Error('Connect Claude to Talyn Fleet first.'), { status: 409 })],
  ])('keeps the page on %s and says why', async (_label, err) => {
    mockApi.create.mockRejectedValue(err);
    const { result, created } = await run(spec());
    expect(created).toBeNull();
    expect(result.current.error).toBe(err.message);
    expect(result.current.busy).toBe(false);
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
    expect(Object.keys(useWorkbenchStore.getState().workbenches)).toEqual(['old']);
  });

  it('falls back to a generic message for an error with no text', async () => {
    mockApi.create.mockRejectedValue(new Error(''));
    const { result } = await run(spec());
    expect(result.current.error).toBe('Could not create the session.');
  });

  it('clearError forgets the error', async () => {
    mockApi.create.mockRejectedValue(new Error('x'));
    const { result } = await run(spec());
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});

describe('useCreateWorkbench: local', () => {
  const local = (over: Partial<NewWorkbenchSpec> = {}) => spec({ runtime: 'local', repoPath: '/code/app', ...over });

  it('makes the worktree from the recorded checkout, opens it, and sends the first message', async () => {
    const wb = workbench({ runtime: 'local', status: 'ready', localPath: '/wt/fix-login' });
    mockCreateLocal.mockResolvedValue(wb);
    mockSend.mockResolvedValue({ queued: false });
    const { created, result } = await run(local({ planMode: true, effort: 'high', branch: 'feat/x', fromPullRequestId: 'pr1' }));

    expect(mockCreateLocal).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      repositoryId: 'r1',
      repoFullName: 'acme/app',
      agent: 'claude',
      model: 'claude-sonnet',
      baseBranch: undefined,
      branch: 'feat/x',
      fromPullRequestId: 'pr1',
      repoPath: '/code/app',
      takenNames: ['lisbon'],
      prompt: 'Fix the login redirect',
    });
    expect(mockApi.create).not.toHaveBeenCalled();
    expect(created?.id).toBe('wb1');
    expect(result.current.error).toBeNull();
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb1' });
    expect(mockApi.createChat).not.toHaveBeenCalled();
    expect(mockApi.updateChat).toHaveBeenCalledWith('c1', { planMode: true, effort: 'high' });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), {
      text: 'Fix the login redirect',
      model: 'claude-sonnet',
      planMode: true,
      effort: 'high',
    });
    expect(useWorkbenchStore.getState().selectedChatByWorkbench.wb1).toBe('c1');
  });

  it('passes the workspace branch prefix to the local worktree', async () => {
    useWorkspaceStore.setState({
      workspaces: [{ id: 'ws1', name: 'WS', settings: { sessionBranchPrefix: 'tom/' } }] as never,
    });
    mockCreateLocal.mockResolvedValue(workbench({ runtime: 'local' }));
    await run(local());
    expect(mockCreateLocal).toHaveBeenCalledWith(expect.objectContaining({ branchPrefix: 'tom/' }));
    useWorkspaceStore.setState({ workspaces: [] });
  });

  it('creates the first chat when the row came back without one', async () => {
    mockCreateLocal.mockResolvedValue(workbench({ runtime: 'local', chats: [] }));
    mockApi.createChat.mockResolvedValue(chat('c9'));
    await run(local());
    expect(mockApi.createChat).toHaveBeenCalledWith('wb1', { model: 'claude-sonnet', effort: 'high', planMode: false });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ id: 'c9' }), expect.objectContaining({ text: 'Fix the login redirect' }));
  });

  it('sends nothing for an empty task', async () => {
    mockCreateLocal.mockResolvedValue(workbench({ runtime: 'local' }));
    await run(local({ prompt: '' }));
    expect(mockSend).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb1' });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
  ])('refuses without a recorded checkout (%s) and keeps the page', async (_label, repoPath) => {
    const { result, created } = await run(local({ repoPath }));
    expect(created).toBeNull();
    expect(mockCreateLocal).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Choose the folder of your acme/app checkout first.');
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('shows a worktree failure on the page', async () => {
    mockCreateLocal.mockRejectedValue(new Error('fatal: a branch named fix-login already exists'));
    const { result } = await run(local());
    expect(result.current.error).toBe('fatal: a branch named fix-login already exists');
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('a first message that fails to start is a toast, not a failed create', async () => {
    mockCreateLocal.mockResolvedValue(workbench({ runtime: 'local' }));
    mockSend.mockRejectedValue(new Error('claude: command not found'));
    const { result, created } = await run(local());
    expect(created?.id).toBe('wb1');
    expect(result.current.error).toBeNull();
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb1' });
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ variant: 'error', description: 'claude: command not found' }),
    ]);
  });
});
