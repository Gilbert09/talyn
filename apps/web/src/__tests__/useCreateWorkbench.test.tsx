import { cleanup } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
/**
 * @jest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { useCreateWorkbench, type NewWorkbenchSpec } from '../components/workbench/new/useCreateWorkbench';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { useToastStore } from '../stores/toast';

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));

const mockApi = {
  create: vi.fn(),
  updateChat: vi.fn(),
  createChat: vi.fn(),
};
vi.mock('../lib/api', () => ({
  api: {
    workbenches: {
      create: (...args: unknown[]) => mockApi.create(...args),
      updateChat: (...args: unknown[]) => mockApi.updateChat(...args),
      createChat: (...args: unknown[]) => mockApi.createChat(...args),
    },
  },
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
  // Let pending state updates settle.
  await act(async () => {
    await Promise.resolve();
  });
  return { result, created: created as Workbench | null };
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkbenchStore.setState({
    workbenches: {},
    chats: {},
    selectedChatByWorkbench: {},
  });
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
      autoCreatePr: true,
    });
    expect(created?.id).toBe('wb1');
    expect(useWorkbenchStore.getState().workbenches.wb1).toBeDefined();
    expect(useNavigationStore.getState().route).toEqual({
      view: 'workbench',
      id: 'wb1',
    });
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(mockApi.updateChat).not.toHaveBeenCalled();
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
    expect(mockApi.create.mock.calls[0][0]).toMatchObject({
      branch: 'feat/x',
      fromPullRequestId: 'pr1',
      baseBranch: undefined,
    });
  });

  it.each([
    ['plan mode', { planMode: true, effort: 'high' as const }],
    ['effort', { planMode: false, effort: 'low' as const }],
    ['both', { planMode: true, effort: 'max' as const }],
  ])('sets %s on the first chat before its queued message runs', async (_label, over) => {
    mockApi.create.mockResolvedValue(workbench());
    mockApi.updateChat.mockResolvedValue(chat('c1', { planMode: over.planMode }));
    await run(spec(over));
    expect(mockApi.updateChat).toHaveBeenCalledWith('c1', {
      planMode: over.planMode,
      effort: over.effort,
    });
  });

  it('still opens the workbench when setting plan mode fails', async () => {
    mockApi.create.mockResolvedValue(workbench());
    mockApi.updateChat.mockRejectedValue(new Error('nope'));
    const { result } = await run(spec({ planMode: true }));
    expect(useNavigationStore.getState().route).toEqual({
      view: 'workbench',
      id: 'wb1',
    });
    expect(result.current.error).toBeNull();
  });

  it.each([
    [
      'a readiness refusal',
      Object.assign(new Error('Talyn Fleet is not deployed here.'), {
        status: 503,
      }),
    ],
    [
      'an agent refusal',
      Object.assign(new Error('Connect Claude to Talyn Fleet first.'), {
        status: 409,
      }),
    ],
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

afterEach(cleanup);
