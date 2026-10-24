import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PRRow } from '../lib/api';

const { createTask, runAction, loadWorkbench, toastSuccess, navigate, state } = vi.hoisted(() => ({
  createTask: vi.fn(),
  runAction: vi.fn(),
  loadWorkbench: vi.fn(),
  toastSuccess: vi.fn(),
  navigate: vi.fn(),
  state: { workspaces: {} as Record<string, unknown> },
}));

vi.mock('../lib/api', () => ({
  api: { tasks: { get: vi.fn() } },
  ApiError: class extends Error {
    constructor(message: string, public status: number, public code?: string, public details?: Record<string, unknown>) {
      super(message);
    }
  },
}));
vi.mock('../stores/workspace', () => ({ useWorkspaceStore: () => ({
  currentWorkspaceId: 'ws1',
  workspaces: [{ id: 'ws1', settings: {} }],
  environments: [{ id: 'env1', type: 'posthog_code' }],
  cloudProviders: [{ type: 'posthog_code', connected: true }],
  tasks: [],
  openConnectAgent: vi.fn(),
}) }));
vi.mock('../stores/pullRequests', () => ({ usePullRequestStore: { getState: () => ({ patchRow: vi.fn() }) } }));
vi.mock('../hooks/useApi', () => ({ useTaskActions: () => ({ createTask }) }));
vi.mock('../hooks/usePullRequestSync', () => ({ reloadPullRequests: vi.fn() }));
vi.mock('../stores/toast', () => ({ toast: { success: toastSuccess, error: vi.fn(), info: vi.fn() } }));
vi.mock('../stores/billing', () => ({ maybeHandleBillingLimit: vi.fn() }));
vi.mock('../lib/githubInstall', () => ({ openGithubAppFlow: vi.fn() }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('../lib/prClipboard', () => ({ copyRich: vi.fn() }));
vi.mock('../components/panels/github/stacks', () => ({ buildCopyListPayload: vi.fn() }));
vi.mock('../lib/workbenchOps', () => ({ opsFor: () => ({ unavailable: null, runAction }) }));
vi.mock('../lib/workbenchData', () => ({ loadWorkbench }));
vi.mock('../stores/workbenches', () => ({
  useWorkbenchStore: { getState: () => ({ workbenches: state.workspaces, selectedChatByWorkbench: {} }) },
  visibleChats: () => [],
}));
vi.mock('../lib/workbenchNavigation', () => ({ navigateToWorkbench: navigate }));

import { ApiError } from '../lib/api';
import { useGitHubActions } from '../components/panels/github/useGitHubActions';
import { sessionFixAction, sessionFromConflict } from '../lib/prSessionFix';

const row = {
  id: 'pr1', owner: 'acme', repo: 'w', number: 7, repositoryId: 'r1', state: 'open',
  summary: {
    title: 'A PR', url: 'https://github.com/acme/w/pull/7', headBranch: 'f', baseBranch: 'main',
    mergeable: 'MERGEABLE', blockingReason: 'checks_failed', reviewDecision: null,
    checks: { total: 1, failed: 1 },
  },
} as PRRow;
const session = { id: 'wb1', name: 'paris', status: 'ready' } as NonNullable<PRRow['session']>;

afterEach(() => {
  vi.clearAllMocks();
  state.workspaces = {};
});

describe('PR session fixes', () => {
  it('sends Fix to the linked sandbox session', async () => {
    state.workspaces = { wb1: { id: 'wb1', runtime: 'sandbox' } };
    const { result } = renderHook(() => useGitHubActions());
    expect(await result.current.createPostHogTask({ ...row, session })).toBe(true);
    expect(createTask).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledWith('fix_checks', null);
    expect(toastSuccess).toHaveBeenCalledWith('Sent to session paris', 'acme/w#7', expect.objectContaining({ label: 'Open' }));
    toastSuccess.mock.calls[0][2].onClick();
    expect(navigate).toHaveBeenCalledWith('wb1');
  });

  it('loads a session named by a 409 response', async () => {
    loadWorkbench.mockResolvedValue({ id: 'wb1', runtime: 'sandbox' });
    createTask.mockRejectedValue(new ApiError('busy', 409, 'pr_has_session', { workbenchId: 'wb1', name: 'paris' }));
    const { result } = renderHook(() => useGitHubActions());
    expect(await result.current.createPostHogTask(row)).toBe(true);
    expect(loadWorkbench).toHaveBeenCalledWith('wb1');
    expect(runAction).toHaveBeenCalledWith('fix_checks', null);
  });

  it.each([
    ['merge_conflicts', 'MERGEABLE', 'resolve_conflicts'],
    ['checks_failed', 'CONFLICTING', 'resolve_conflicts'],
    ['checks_failed', 'MERGEABLE', 'fix_checks'],
  ])('chooses %s and %s', (blockingReason, mergeable, expected) => {
    expect(sessionFixAction({ ...row, summary: { ...row.summary, blockingReason, mergeable } } as PRRow)).toBe(expected);
  });

  it('ignores other conflicts', () => {
    expect(sessionFromConflict(new ApiError('busy', 409, 'task_active'))).toBeNull();
    expect(sessionFromConflict(new ApiError('busy', 409, 'pr_has_session', { workbenchId: 'wb1' }))).toEqual({ id: 'wb1', name: 'session' });
  });
});
