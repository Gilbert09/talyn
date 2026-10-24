import { renderHook } from '@testing-library/react';
import type { PRRow } from '../renderer/lib/api';

// ---- module mocks ----
const openConnectAgent = jest.fn();
const createTask = jest.fn();
const patchRow = jest.fn();
const runAction = jest.fn();
const navigate = jest.fn();
const toastSuccess = jest.fn();
const loadWorkbench = jest.fn();
const createChat = jest.fn();

let storeValue: Record<string, unknown>;
let workbenchState: Record<string, unknown>;

class FakeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: () => storeValue,
}));
jest.mock('../renderer/stores/pullRequests', () => ({
  usePullRequestStore: { getState: () => ({ patchRow, removeRow: jest.fn() }) },
}));
jest.mock('../renderer/hooks/useApi', () => ({
  useTaskActions: () => ({ createTask }),
}));
jest.mock('../renderer/hooks/usePullRequestSync', () => ({ reloadPullRequests: jest.fn() }));
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: jest.fn(), info: jest.fn() },
}));
jest.mock('../renderer/stores/billing', () => ({ maybeHandleBillingLimit: jest.fn() }));
jest.mock('../renderer/lib/analytics', () => ({ trackEvent: jest.fn() }));
jest.mock('../renderer/lib/prClipboard', () => ({ copyRich: jest.fn() }));
jest.mock('../renderer/components/panels/github/stacks', () => ({ buildCopyListPayload: jest.fn() }));
jest.mock('../renderer/lib/api', () => ({
  api: { tasks: { get: jest.fn() }, workbenches: { createChat: (...a: unknown[]) => createChat(...a) } },
  ApiError: FakeApiError,
}));
jest.mock('../renderer/lib/workbenchOps', () => ({
  opsFor: (wb: { runtime: string; unavailable?: string }) => ({
    runtime: wb.runtime,
    unavailable: wb.unavailable ?? null,
    runAction: (...a: unknown[]) => runAction(...a),
  }),
}));
jest.mock('../renderer/lib/workbenchData', () => ({
  loadWorkbench: (...a: unknown[]) => loadWorkbench(...a),
}));
jest.mock('../renderer/stores/workbenches', () => ({
  useWorkbenchStore: { getState: () => workbenchState },
  visibleChats: (state: { chats: Record<string, unknown[]> }, id: string) => state.chats[id] ?? [],
}));
jest.mock('../renderer/stores/navigation', () => ({
  useNavigationStore: { getState: () => ({ navigate }) },
}));

import { useGitHubActions } from '../renderer/components/panels/github/useGitHubActions';
import { sessionFixAction, sessionFromConflict } from '../renderer/lib/prSessionFix';

const baseRow = {
  id: 'pr1',
  owner: 'acme',
  repo: 'w',
  number: 7,
  repositoryId: 'r1',
  state: 'open',
  summary: {
    title: 'A PR',
    url: 'https://github.com/acme/w/pull/7',
    headBranch: 'f',
    baseBranch: 'main',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    blockingReason: 'checks_failed',
    checks: { total: 2, failed: 1 },
  },
} as unknown as PRRow;

const withSession = (over: Partial<PRRow> = {}) =>
  ({ ...baseRow, session: { id: 'wb1', name: 'paris', status: 'ready' }, ...over }) as PRRow;

const sandbox = { id: 'wb1', runtime: 'sandbox', name: 'paris' };

beforeEach(() => {
  storeValue = {
    currentWorkspaceId: 'ws1',
    workspaces: [{ id: 'ws1', settings: {} }],
    environments: [{ id: 'env1', type: 'posthog_code' }],
    cloudProviders: [{ type: 'posthog_code', connected: true, displayName: 'PostHog Code' }],
    selectTask: jest.fn(),
    tasks: [],
    addTask: jest.fn(),
    setActivePanel: jest.fn(),
    openSettings: jest.fn(),
    openConnectAgent,
  };
  workbenchState = {
    workbenches: { wb1: sandbox },
    chats: {},
    selectedChatByWorkbench: {},
    upsertChat: jest.fn(),
  };
});

afterEach(() => jest.clearAllMocks());

describe('Fix on a PR a session works', () => {
  it('sends the fix to the session, toasts with Open, and does not navigate', async () => {
    const { result } = renderHook(() => useGitHubActions());
    const ok = await result.current.createPostHogTask(withSession());

    expect(ok).toBe(true);
    expect(createTask).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledWith('fix_checks', null);
    expect(navigate).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith(
      'Sent to session paris',
      'acme/w#7',
      expect.objectContaining({ label: 'Open' })
    );

    // The button opens the session; nothing else does.
    toastSuccess.mock.calls[0][2].onClick();
    expect(navigate).toHaveBeenCalledWith({ view: 'workbench', id: 'wb1' });
  });

  it('asks for conflicts to be resolved on a conflicting PR', async () => {
    const { result } = renderHook(() => useGitHubActions());
    await result.current.createPostHogTask(
      withSession({ summary: { ...baseRow.summary, blockingReason: 'merge_conflicts' } } as Partial<PRRow>)
    );
    expect(runAction).toHaveBeenCalledWith('resolve_conflicts', null);
  });

  it('loads the session when the store does not have it yet', async () => {
    workbenchState.workbenches = {};
    loadWorkbench.mockResolvedValue(sandbox);
    const { result } = renderHook(() => useGitHubActions());
    await result.current.createPostHogTask(withSession());
    expect(loadWorkbench).toHaveBeenCalledWith('wb1');
    expect(runAction).toHaveBeenCalled();
  });

  it('opens a chat first for a local session with none', async () => {
    workbenchState.workbenches = { wb1: { ...sandbox, runtime: 'local' } };
    createChat.mockResolvedValue({ id: 'c1' });
    const { result } = renderHook(() => useGitHubActions());
    await result.current.createPostHogTask(withSession());
    expect(createChat).toHaveBeenCalledWith('wb1');
    expect(runAction).toHaveBeenCalledWith('fix_checks', { id: 'c1' });
  });

  it('reports a session it cannot act on rather than starting a task', async () => {
    workbenchState.workbenches = { wb1: { ...sandbox, unavailable: 'This session is archived.' } };
    const { result } = renderHook(() => useGitHubActions());
    await expect(result.current.createPostHogTask(withSession())).rejects.toThrow('This session is archived.');
    expect(createTask).not.toHaveBeenCalled();
  });

  it('routes a 409 pr_has_session from the backend to the named session', async () => {
    createTask.mockRejectedValue(
      new FakeApiError('busy', 409, 'pr_has_session', { workbenchId: 'wb1', name: 'paris' })
    );
    const { result } = renderHook(() => useGitHubActions());
    const ok = await result.current.createPostHogTask(baseRow);
    expect(ok).toBe(true);
    expect(runAction).toHaveBeenCalledWith('fix_checks', null);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('rethrows any other failure', async () => {
    createTask.mockRejectedValue(new FakeApiError('nope', 409, 'something_else', {}));
    const { result } = renderHook(() => useGitHubActions());
    await expect(result.current.createPostHogTask(baseRow)).rejects.toThrow('nope');
    expect(runAction).not.toHaveBeenCalled();
  });
});

describe('sessionFromConflict', () => {
  it.each([
    ['the session conflict', new FakeApiError('x', 409, 'pr_has_session', { workbenchId: 'w', name: 'n' }), { id: 'w', name: 'n' }],
    ['a nameless one', new FakeApiError('x', 409, 'pr_has_session', { workbenchId: 'w' }), { id: 'w', name: 'session' }],
    ['no workbench id', new FakeApiError('x', 409, 'pr_has_session', {}), null],
    ['another 409', new FakeApiError('x', 409, 'task_active', { workbenchId: 'w' }), null],
    ['another status', new FakeApiError('x', 400, 'pr_has_session', { workbenchId: 'w' }), null],
    ['a plain error', new Error('x'), null],
  ])('%s', (_name, err, expected) => {
    expect(sessionFromConflict(err)).toEqual(expected);
  });
});

describe('sessionFixAction', () => {
  it.each([
    ['merge_conflicts', 'MERGEABLE', 'resolve_conflicts'],
    ['blocked', 'CONFLICTING', 'resolve_conflicts'],
    ['checks_failed', 'MERGEABLE', 'fix_checks'],
    ['changes_requested', 'MERGEABLE', 'fix_checks'],
  ])('%s / %s → %s', (blockingReason, mergeable, expected) => {
    const row = { ...baseRow, summary: { ...baseRow.summary, blockingReason, mergeable } } as PRRow;
    expect(sessionFixAction(row)).toBe(expected);
  });
});
