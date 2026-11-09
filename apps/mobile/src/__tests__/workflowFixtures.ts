import type { Workbench, WorkbenchChat, WorkbenchEvent, WorkbenchReadiness } from '@talyn/shared';
import type { ClientLifecycleEvent, ClientState, PRRow } from '@talyn/client/native';

import { WorkflowStore, type WorkflowApi, type WorkflowSocket } from '../workflow/store';
import type { Scope } from '../workflow/model';

export const scope: Scope = { environment: 'test-environment', user: 'test-user', workspace: 'one' };
export const chat = (patch: Partial<WorkbenchChat> = {}): WorkbenchChat => ({
  id: 'chat-one', workbenchId: 'session-one', title: 'Conversation', agent: 'codex', model: null, effort: null,
  planMode: false, agentSessionId: null, status: 'idle', queuedMessages: [], createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T11:00:00Z', ...patch,
});
export const session = (patch: Partial<Workbench> = {}): Workbench => ({
  id: 'session-one', workspaceId: 'one', kind: 'session', threadId: null, repositoryId: 'repo-one', repoFullName: 'example/project',
  name: 'session-one', title: 'Current work', branch: 'tom/example', baseBranch: 'main', runtime: 'sandbox', agent: 'codex',
  deviceId: null, localPath: null, sandboxId: null, sandboxState: 'running', status: 'ready', pullRequestId: 'pr-one', settings: {},
  diffStat: null, archivedAt: null, chats: [chat()], createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T11:00:00Z', ...patch,
});
export const thread = () => session({ id: 'thread-one', kind: 'thread', title: 'Planning work', repoFullName: '', repositoryId: null,
  pullRequestId: null, chats: [chat({ id: 'thread-chat', workbenchId: 'thread-one' })] });
export const pr = (patch: Partial<PRRow> = {}): PRRow => ({
  id: 'pr-one', workspaceId: 'one', repositoryId: 'repo-one', taskId: null, owner: 'example', repo: 'project', number: 42, state: 'open',
  reviewRequested: true, authored: false, watching: false, mergedAt: null, lastPolledAt: '2026-11-08T11:00:00Z',
  summary: { title: 'Review current work', author: 'example-author', draft: false, headBranch: 'tom/example', baseBranch: 'main',
    headSha: 'test-sha', updatedAt: '2026-11-08T11:00:00Z', url: 'https://github.com/example/project/pull/42', mergeable: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED', blockingReason: 'unknown', checks: { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 },
    ciStatus: 'none', humanGates: [], stack: null },
  autoKeepMergeable: false, mergeQueued: false, mergeMethod: 'squash', mergeQueue: null,
  createdAt: '2026-11-08T10:00:00Z', updatedAt: '2026-11-08T11:00:00Z', ...patch,
});
export const event = (seq: number, patch: Partial<WorkbenchEvent> = {}): WorkbenchEvent => ({
  chatId: 'chat-one', seq, turn: 1, event: { seq, type: 'assistant', timestamp: '2026-11-08T11:00:00Z',
    message: { content: [{ type: 'text', text: `Agent response ${seq}` }] } }, ...patch,
});
export const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { resolve, reject, promise };
};
export function fixture() {
  let state: ClientState = { activity: 'active', reachability: 'online' };
  const lifecycleListeners = new Set<(value: ClientLifecycleEvent) => void>();
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const socket = {
    connect: jest.fn(async () => {}), subscribe: jest.fn(), unsubscribe: jest.fn(), setCapabilities: jest.fn(),
    on: jest.fn((name: string, handler: (payload: unknown) => void) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(handler);
      return () => { handlers.get(name)!.delete(handler); };
    }),
  };
  const api = {
    workbenches: {
      list: jest.fn(async (_workspace?: string, _opts?: unknown) => [session(), thread()]),
      get: jest.fn(async (id: string) => id.includes('thread') ? thread() : session({ id })),
      threadSessions: jest.fn(async () => [session({ threadId: 'thread-one' })]),
      readiness: jest.fn(async (): Promise<WorkbenchReadiness> => ({ sandbox: { ok: true, reasons: [], agents: { claude: { ok: true }, codex: { ok: true } } } })),
      events: jest.fn(async (_id?: string, _opts?: unknown) => ({ events: [event(1, { chatId: _id ?? 'chat-one' })], cursor: 1, oldestSeq: 1, hasOlder: false })),
      sendMessage: jest.fn(async (_id?: string, _input?: unknown) => ({ queued: false })),
      create: jest.fn(async (input: { kind?: string; repositoryId?: string }) => input.kind === 'thread' ? thread() : session({ id: 'session-new' })),
      update: jest.fn(async (id: string, patch: { title?: string }) => session({ id, ...patch })),
      archive: jest.fn(async (id: string) => session({ id, status: 'archived', archivedAt: '2026-11-09T10:00:00Z' })),
      restore: jest.fn(async (id: string) => session({ id })),
      retry: jest.fn(async (id: string) => session({ id, status: 'provisioning' })),
      wake: jest.fn(async (_id?: string): Promise<{ status: string; code?: string; notice?: unknown }> => ({ status: 'resuming' })),
      cancel: jest.fn(async (_chatId?: string) => undefined),
      action: jest.fn(async (_id?: string, _action?: string) => ({})),
    },
    pullRequests: {
      list: jest.fn(async () => [pr()]), get: jest.fn(async () => ({ row: pr(), fresh: null })),
      mergeQueueTimeline: jest.fn(async () => ({ events: [] })),
      merge: jest.fn(async (_id?: string) => ({ merged: true, message: 'Merged.' } as { merged: boolean; message: string; submitted?: boolean; alreadyTerminal?: boolean })),
      setMergeQueue: jest.fn(async (_id?: string, _enabled?: boolean) => null),
      setAutoKeepMergeable: jest.fn(async (_id?: string, _enabled?: boolean) => null),
      resubmitMergeQueue: jest.fn(async (_id?: string) => null),
    },
    features: { get: jest.fn(async () => ({ workbenches: true } as Record<string, boolean>)) },
    repositories: { list: jest.fn(async () => [{ id: 'repo-one', workspaceId: 'one', owner: 'example', repo: 'project',
      fullName: 'example/project', defaultBranch: 'main' }]) },
    cloudProviders: { list: jest.fn(async () => [{ type: 'selfhosted', displayName: 'Talyn Fleet', connected: true, connectedAgents: ['claude'] },
      { type: 'posthog_code', displayName: 'PostHog Code', connected: true }]) },
    workspaces: { get: jest.fn(async () => ({ id: 'one', name: 'Test workspace', settings: {} as Record<string, unknown>, repos: [] })) },
    environments: { list: jest.fn(async () => [{ id: 'env-fleet', type: 'selfhosted' }, { id: 'env-posthog', type: 'posthog_code' }]) },
    tasks: {
      get: jest.fn(async (_id?: string) => ({ id: 'task-one', status: 'completed' })),
      create: jest.fn(async (_input?: Record<string, unknown>) => ({ id: 'task-new' })),
    },
  };
  const lifecycle = { getSnapshot: () => state, subscribe: (listener: (value: ClientLifecycleEvent) => void) => {
    lifecycleListeners.add(listener); return () => { lifecycleListeners.delete(listener); };
  } };
  const store = new WorkflowStore(lifecycle, api as unknown as WorkflowApi, socket as unknown as WorkflowSocket);
  store.setScope(scope);
  return { store, api, socket, lifecycle, handlers,
    emit: (name: string, payload: unknown) => { for (const handler of handlers.get(name) ?? []) handler(payload); },
    network: (patch: Partial<ClientState>) => {
      state = { ...state, ...patch }; for (const listener of lifecycleListeners) listener({ type: 'state', state });
    },
  };
}
