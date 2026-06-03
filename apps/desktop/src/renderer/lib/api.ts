import { getSupabase, isSupabaseConfigured } from './supabase';
import type {
  Workspace,
  Environment,
  Agent,
  Task,
  InboxItem,
  BacklogSource,
  BacklogItem,
  CreateBacklogSourceRequest,
  UpdateBacklogSourceRequest,
  CreateWorkspaceRequest,
  CreateEnvironmentRequest,
  CreateTaskRequest,
  StartAgentRequest,
  ApiResponse,
  WSEvent,
} from '@fastowl/shared';

// Resolve the backend URL from the build-time env (see webpack configs).
// Falls back to local dev so a fresh checkout Just Works.
const BASE_URL = process.env.FASTOWL_API_URL || 'http://localhost:4747';
const API_BASE = `${BASE_URL}/api/v1`;
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';

// ============================================================================
// HTTP Client
// ============================================================================

/**
 * Pull the current access token off the Supabase client's in-memory session.
 * Returns null when we're not logged in; callers surface a clear error then.
 */
async function getAuthToken(): Promise<string | null> {
  if (!isSupabaseConfigured()) return null;
  const { data } = await getSupabase().auth.getSession();
  return data.session?.access_token ?? null;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = await getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await response.json()) as ApiResponse<T>;

  if (!data.success) {
    throw new Error(data.error || 'Request failed');
  }

  return data.data as T;
}

// Workspaces
export const workspaces = {
  list: () => request<Workspace[]>('GET', '/workspaces'),
  get: (id: string) => request<Workspace>('GET', `/workspaces/${id}`),
  create: (data: CreateWorkspaceRequest) =>
    request<Workspace>('POST', '/workspaces', data),
  update: (id: string, data: Partial<Workspace>) =>
    request<Workspace>('PATCH', `/workspaces/${id}`, data),
  delete: (id: string) => request<void>('DELETE', `/workspaces/${id}`),
};

// Environments
interface UpdateDaemonResult {
  newSha: string;
  message: string;
}

export const environments = {
  list: () => request<Environment[]>('GET', '/environments'),
  get: (id: string) => request<Environment>('GET', `/environments/${id}`),
  create: (data: CreateEnvironmentRequest) =>
    request<Environment>('POST', '/environments', data),
  update: (id: string, data: Partial<Environment>) =>
    request<Environment>('PATCH', `/environments/${id}`, data),
  delete: (id: string) => request<void>('DELETE', `/environments/${id}`),
  test: (id: string) =>
    request<{ connected: boolean }>('POST', `/environments/${id}/test`),
  pairingToken: (id: string) =>
    request<{ pairingToken: string; expiresInSeconds: number }>(
      'POST',
      `/environments/${id}/pairing-token`
    ),
  updateDaemon: (id: string) =>
    request<UpdateDaemonResult>('POST', `/environments/${id}/update-daemon`),
};

// Agents
export const agents = {
  list: (params?: { workspaceId?: string; environmentId?: string }) => {
    const query = new URLSearchParams();
    if (params?.workspaceId) query.set('workspaceId', params.workspaceId);
    if (params?.environmentId) query.set('environmentId', params.environmentId);
    const queryStr = query.toString();
    return request<Agent[]>('GET', `/agents${queryStr ? `?${queryStr}` : ''}`);
  },
  get: (id: string) => request<Agent>('GET', `/agents/${id}`),
  start: (data: StartAgentRequest) => request<Agent>('POST', '/agents/start', data),
  sendInput: (id: string, input: string) =>
    request<void>('POST', `/agents/${id}/input`, { input }),
  stop: (id: string) => request<Agent>('POST', `/agents/${id}/stop`),
  delete: (id: string) => request<void>('DELETE', `/agents/${id}`),
};

// Task metadata generation response
export interface TaskMetadata {
  title: string;
  description: string;
  suggestedPriority: 'low' | 'medium' | 'high' | 'urgent';
}

// Tasks
export const tasks = {
  list: (params?: { workspaceId?: string; status?: string; type?: string }) => {
    const query = new URLSearchParams();
    if (params?.workspaceId) query.set('workspaceId', params.workspaceId);
    if (params?.status) query.set('status', params.status);
    if (params?.type) query.set('type', params.type);
    const queryStr = query.toString();
    return request<Task[]>('GET', `/tasks${queryStr ? `?${queryStr}` : ''}`);
  },
  get: (id: string) => request<Task>('GET', `/tasks/${id}`),
  create: (data: CreateTaskRequest) => request<Task>('POST', '/tasks', data),
  update: (id: string, data: Partial<Task>) =>
    request<Task>('PATCH', `/tasks/${id}`, data),
  retry: (id: string) => request<Task>('POST', `/tasks/${id}/retry`),
  delete: (id: string) => request<void>('DELETE', `/tasks/${id}`),
  // Task execution control
  start: (id: string) => request<Task>('POST', `/tasks/${id}/start`),
  sendInput: (id: string, input: string) =>
    request<void>('POST', `/tasks/${id}/input`, { input }),
  continue: (id: string, prompt: string) =>
    request<Task>('POST', `/tasks/${id}/continue`, { prompt }),
  stop: (id: string) => request<Task>('POST', `/tasks/${id}/stop`),
  readyForReview: (id: string) =>
    request<Task>('POST', `/tasks/${id}/ready-for-review`),
  approve: (id: string) => request<Task>('POST', `/tasks/${id}/approve`),
  reject: (id: string) => request<Task>('POST', `/tasks/${id}/reject`),
  retryPullRequest: (id: string) =>
    request<{ pullRequest: { number: number; url: string } }>(
      'POST',
      `/tasks/${id}/retry-pr`
    ),
  getTerminal: (id: string) =>
    request<{
      terminalOutput: string;
      transcript?: Task['transcript'];
      runtime?: string;
    }>('GET', `/tasks/${id}/terminal`),
  respondToPermission: (
    taskId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    persist: boolean
  ) =>
    request<{ success: boolean }>('POST', `/tasks/${taskId}/permission`, {
      requestId,
      decision,
      persist,
    }),
  listPendingPermissions: (taskId: string) =>
    request<{ pending: Array<{ requestId: string; toolName: string; toolInput: unknown; toolUseId?: string; requestedAt: string }> }>(
      'GET',
      `/tasks/${taskId}/permission/pending`
    ),
  getDiff: (id: string) =>
    request<{ diff: string }>('GET', `/tasks/${id}/diff`),
  getChangedFiles: (id: string) =>
    request<{
      files: Array<{
        path: string;
        status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
        added: number;
        removed: number;
        binary: boolean;
      }>;
      source: 'live' | 'cache';
    }>('GET', `/tasks/${id}/diff/files`),
  getFileDiff: (id: string, path: string) =>
    request<{ diff: string; source: 'live' | 'cache' }>(
      'GET',
      `/tasks/${id}/diff/file?path=${encodeURIComponent(path)}`
    ),
  getGitLog: (id: string) =>
    request<{
      entries: Array<{
        ts: string;
        command: string;
        cwd?: string;
        exitCode: number;
        stdoutPreview: string;
        stderrPreview: string;
        durationMs: number;
      }>;
    }>('GET', `/tasks/${id}/git-log`),
  // Generate task metadata from prompt using AI
  generateMetadata: (prompt: string) =>
    request<TaskMetadata>('POST', '/tasks/generate-metadata', { prompt }),
  // Kick a PostHog Code (cloud) task's log stream/backfill on demand.
  // Transcript events arrive over the WS, so the response is just ok.
  refreshLogs: (id: string) => request<void>('POST', `/tasks/${id}/refresh-logs`),
  // Send a follow-up message to a PostHog Code (cloud) task — resumes a
  // finished run or injects into a live one. Transcript updates arrive
  // over the WS.
  sendCloudMessage: (
    id: string,
    body: { message: string; model?: string; reasoningEffort?: string }
  ) => request<void>('POST', `/tasks/${id}/message`, body),
};

// Inbox
export const inbox = {
  list: (params?: { workspaceId?: string; status?: string; type?: string }) => {
    const query = new URLSearchParams();
    if (params?.workspaceId) query.set('workspaceId', params.workspaceId);
    if (params?.status) query.set('status', params.status);
    if (params?.type) query.set('type', params.type);
    const queryStr = query.toString();
    return request<InboxItem[]>('GET', `/inbox${queryStr ? `?${queryStr}` : ''}`);
  },
  get: (id: string) => request<InboxItem>('GET', `/inbox/${id}`),
  markRead: (id: string) => request<InboxItem>('POST', `/inbox/${id}/read`),
  markActioned: (id: string) => request<InboxItem>('POST', `/inbox/${id}/action`),
  snooze: (id: string, until: string) =>
    request<InboxItem>('POST', `/inbox/${id}/snooze`, { until }),
  delete: (id: string) => request<void>('DELETE', `/inbox/${id}`),
  bulkRead: (ids: string[]) =>
    request<{ updated: number }>('POST', '/inbox/bulk/read', { ids }),
  bulkAction: (ids: string[]) =>
    request<{ updated: number }>('POST', '/inbox/bulk/action', { ids }),
};

// GitHub Integration
export interface GitHubStatus {
  configured: boolean;
  connected: boolean;
  message?: string;
  scopes?: string[];
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

// GitHub OAuth + repo discovery only. Every PR-management surface
// (list / get / create / merge / review / comment) was removed in
// Phase 7 — the new pull_requests client (see below) replaces the
// list/get path; "manage on github" is the user's deliberate
// model for everything actionable.
export const github = {
  getStatus: (workspaceId?: string) => {
    const query = workspaceId ? `?workspaceId=${workspaceId}` : '';
    return request<GitHubStatus>('GET', `/github/status${query}`);
  },
  connect: (workspaceId: string) =>
    request<{ authUrl: string; state: string }>('POST', '/github/connect', { workspaceId }),
  disconnect: (workspaceId: string) =>
    request<void>('POST', '/github/disconnect', { workspaceId }),
  getUser: (workspaceId: string) =>
    request<GitHubUser>('GET', `/github/user?workspaceId=${workspaceId}`),
  listRepos: (workspaceId: string) =>
    request<GitHubRepo[]>('GET', `/github/repos?workspaceId=${workspaceId}`),
  // User's own repos + all their orgs' repos, merged. Expensive — the
  // desktop caches this in localStorage behind a manual refresh.
  listAllRepos: (workspaceId: string) =>
    request<GitHubRepo[]>('GET', `/github/all-repos?workspaceId=${workspaceId}`),
  listOrgs: (workspaceId: string) =>
    request<Array<{ login: string; avatar_url: string }>>(
      'GET',
      `/github/orgs?workspaceId=${workspaceId}`
    ),
  listOrgRepos: (workspaceId: string, org: string) =>
    request<GitHubRepo[]>(
      'GET',
      `/github/orgs/${encodeURIComponent(org)}/repos?workspaceId=${workspaceId}`
    ),
};

// PostHog Code (cloud tasks) integration — per-workspace credentials.
export interface PostHogCodeStatus {
  connected: boolean;
  projectId?: string;
  host?: string;
}

export const posthog = {
  getStatus: (workspaceId: string) =>
    request<PostHogCodeStatus>('GET', `/posthog/status?workspaceId=${workspaceId}`),
  saveConfig: (
    workspaceId: string,
    config: { apiKey: string; projectId: string; host?: string }
  ) =>
    request<PostHogCodeStatus>('PUT', '/posthog/config', { workspaceId, ...config }),
  test: (workspaceId: string) =>
    request<{ connected: boolean; error?: string }>('POST', '/posthog/test', {
      workspaceId,
    }),
  disconnect: (workspaceId: string) =>
    request<void>('DELETE', `/posthog/config?workspaceId=${workspaceId}`),
};

// Watched Repositories
export interface WatchedRepo {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  fullName: string;
  localPath?: string;
  defaultBranch: string;
}

// PullRequests — read-only client for the Phase 1-3 backend surface.
export type PRBlockingReason =
  | 'mergeable'
  | 'merge_conflicts'
  | 'changes_requested'
  | 'checks_failed'
  // Mergeable, but non-required checks are failing — de-emphasised (amber)
  // rather than the hard red 'checks_failed'.
  | 'checks_failed_optional'
  | 'blocked'
  | 'unknown';

export type PRMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type PRReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type PRState = 'open' | 'closed' | 'merged';

export interface PRChecks {
  total: number;
  passed: number;
  failed: number;
  inProgress: number;
  skipped: number;
}

export type PRCheckState =
  | 'success'
  | 'failure'
  | 'pending'
  | 'in_progress'
  | 'skipped';

export interface PRCheckContext {
  name: string;
  state: PRCheckState;
  url: string | null;
}

/**
 * The persisted lastSummary jsonb from `pull_requests`. Same shape the
 * backend's `summaryToJsonb` writes — minimal columns for instant
 * render without a round-trip.
 */
export interface PRSummaryShape {
  title: string;
  author: string;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  /** When the PR was opened on GitHub. Optional for rows cached before
   *  this field was tracked. */
  createdAt?: string;
  updatedAt: string;
  url: string;
  mergeable: PRMergeable;
  mergeStateStatus: string;
  reviewDecision: PRReviewDecision;
  blockingReason: PRBlockingReason;
  checks: PRChecks;
  /** Unresolved review threads (capped at the first 100). Optional for
   *  rows cached before this field was tracked. */
  unresolvedReviewThreads?: number;
}

export interface PRRow {
  id: string;
  workspaceId: string;
  repositoryId: string;
  taskId: string | null;
  owner: string;
  repo: string;
  number: number;
  state: PRState;
  /**
   * True when the PR is awaiting the user's review — they're a requested
   * reviewer (directly or via a team) and haven't reviewed it yet. Cleared
   * once they submit a review, so an approved PR leaves the "Review" list.
   */
  reviewRequested: boolean;
  /** True when the PR was opened by the user. Drives the "Mine" tab. */
  authored: boolean;
  mergedAt: string | null;
  lastPolledAt: string;
  summary: PRSummaryShape;
  /** Unread inbox items linked to this PR (new reviews/comments/CI). */
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Always-fresh GraphQL detail returned alongside the persisted row by
 * GET /pull-requests/:id. recentReviews/comments are limited to the
 * last 5 each — the Reviews tab paginates further on demand.
 */
export interface PRFreshDetail {
  recentReviews: Array<{
    id: string;
    author: string;
    state: string;
    submittedAt: string | null;
    url: string;
  }>;
  recentReviewComments: Array<{
    id: string;
    author: string;
    createdAt: string;
    url: string;
  }>;
  recentComments: Array<{
    id: string;
    author: string;
    createdAt: string;
    url: string;
  }>;
  // The fresh fetch returns the full PRSummary shape — include the
  // body for the Overview tab.
  body: string;
  // Per-check rows behind the rollup counts (live fetch only).
  checkContexts: PRCheckContext[];
}

/**
 * One changed file in a PR. Mirrors GitHub's `/pulls/:n/files` payload:
 * `patch` is the unified diff (absent for binary files / very large
 * diffs GitHub omits).
 */
export interface PRFile {
  sha: string;
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

/** Full review/comment detail for the PR detail Reviews tab. */
export interface PRReviewDetailReview {
  id: string;
  author: string;
  avatarUrl: string | null;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED. */
  state: string;
  body: string;
  submittedAt: string | null;
  url: string;
}

export interface PRReviewThreadComment {
  id: string;
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface PRReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  diffHunk: string | null;
  comments: PRReviewThreadComment[];
}

export interface PRConversationComment {
  id: string;
  author: string;
  avatarUrl: string | null;
  body: string;
  createdAt: string;
  url: string;
}

export interface PRReviewDetail {
  reviews: PRReviewDetailReview[];
  threads: PRReviewThread[];
  comments: PRConversationComment[];
}

export const pullRequests = {
  list: (params: {
    workspaceId: string;
    state?: 'open' | 'closed' | 'merged' | 'all';
    repo?: string;
    taskOnly?: boolean;
    search?: string;
    relationship?: 'authored' | 'review_requested' | 'all';
  }) => {
    const query = new URLSearchParams();
    query.set('workspaceId', params.workspaceId);
    if (params.state) query.set('state', params.state);
    if (params.repo) query.set('repo', params.repo);
    if (params.taskOnly) query.set('taskOnly', 'true');
    if (params.search) query.set('search', params.search);
    if (params.relationship) query.set('relationship', params.relationship);
    return request<PRRow[]>('GET', `/pull-requests?${query.toString()}`);
  },
  get: (id: string) =>
    request<{ row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null }>(
      'GET',
      `/pull-requests/${id}`
    ),
  refresh: (id: string) =>
    request<PRRow>('POST', `/pull-requests/${id}/refresh`),
  focus: (id: string, focused = true) =>
    request<null>('POST', `/pull-requests/${id}/focus`, { focused }),
  // Tell the backend which list is on screen so it can hard-poll that cohort
  // and slack-poll the other. 'none' = the GitHub panel isn't visible.
  setView: (workspaceId: string, view: 'mine' | 'review' | 'all' | 'none') =>
    request<null>('POST', `/pull-requests/view`, { workspaceId, view }),
  markSeen: (id: string) =>
    request<null>('POST', `/pull-requests/${id}/seen`),
  files: (id: string) =>
    request<PRFile[]>('GET', `/pull-requests/${id}/files`),
  reviews: (id: string) =>
    request<PRReviewDetail>('GET', `/pull-requests/${id}/reviews`),
  merge: (id: string, method: 'merge' | 'squash' | 'rebase' = 'squash') =>
    request<{ sha: string; merged: boolean; message: string }>(
      'POST',
      `/pull-requests/${id}/merge`,
      { method }
    ),
};

export const repositories = {
  list: (workspaceId: string) =>
    request<WatchedRepo[]>('GET', `/repositories?workspaceId=${workspaceId}`),
  add: (workspaceId: string, owner: string, repo: string, localPath?: string) =>
    request<WatchedRepo>('POST', '/repositories', { workspaceId, owner, repo, localPath }),
  update: (id: string, updates: { localPath?: string | null }) =>
    request<null>('PATCH', `/repositories/${id}`, updates),
  remove: (id: string) =>
    request<void>('DELETE', `/repositories/${id}`),
  forcePoll: () =>
    request<{ message: string }>('POST', '/repositories/poll'),
};

// Backlog (Continuous Build)
export const backlog = {
  listSources: (workspaceId: string) =>
    request<BacklogSource[]>('GET', `/backlog/sources?workspaceId=${workspaceId}`),
  getSource: (id: string) => request<BacklogSource>('GET', `/backlog/sources/${id}`),
  createSource: (data: CreateBacklogSourceRequest) =>
    request<BacklogSource>('POST', '/backlog/sources', data),
  updateSource: (id: string, data: UpdateBacklogSourceRequest) =>
    request<BacklogSource>('PATCH', `/backlog/sources/${id}`, data),
  deleteSource: (id: string) => request<void>('DELETE', `/backlog/sources/${id}`),
  syncSource: (id: string) =>
    request<{ added: number; updated: number; retired: number }>(
      'POST',
      `/backlog/sources/${id}/sync`
    ),
  listItems: (sourceId: string) =>
    request<BacklogItem[]>('GET', `/backlog/sources/${sourceId}/items`),
  listItemsForWorkspace: (workspaceId: string) =>
    request<BacklogItem[]>('GET', `/backlog/items?workspaceId=${workspaceId}`),
  schedule: (workspaceId: string) =>
    request<void>('POST', '/backlog/schedule', { workspaceId }),
};

// ============================================================================
// WebSocket Client
// ============================================================================

type EventHandler<T = unknown> = (payload: T) => void;

// How often the client pings the server to prove the socket is alive.
// The backend replies to `{type:'ping'}` with `connection:status {pong}`.
const HEARTBEAT_INTERVAL_MS = 25_000;
// Backoff cap. We retry forever (a dev backend restart shouldn't leave the
// list permanently frozen until app relaunch) but never wait longer than this.
const MAX_RECONNECT_DELAY_MS = 30_000;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private reconnectTimer: number | null = null;
  // Drives only the backoff curve, not a give-up threshold — reset to 0 on
  // every successful open so the next outage starts fast again.
  private reconnectAttempts = 0;
  private heartbeatTimer: number | null = null;
  // True once a ping has been sent and we're still waiting for its pong. If
  // the next heartbeat tick fires while still awaiting, the socket is a
  // zombie (half-open after sleep / killed backend) and we force a reconnect.
  private awaitingPong = false;
  private lifecycleBound = false;
  private subscribedWorkspaces: Set<string> = new Set();
  private authenticated = false;

  async connect(): Promise<void> {
    this.bindLifecycle();
    // Bail if a socket is already open or mid-handshake — re-entry from a
    // focus/online wake would otherwise orphan the in-flight socket.
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    )
      return;

    const token = await getAuthToken();
    if (!token) {
      // Defer until we have a session — callers usually gate this behind
      // the AuthProvider so it's a transient case on cold start.
      console.log('WebSocket connect deferred: no auth token yet');
      return;
    }
    console.log('Connecting to WebSocket...');
    // Token rides in the first frame after open, not the URL, so it
    // doesn't end up in access/edge logs. The backend closes the
    // socket if auth doesn't arrive within its handshake window.
    this.authenticated = false;
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      console.log('WebSocket opened; authenticating…');
      this.reconnectAttempts = 0;
      this.ws?.send(JSON.stringify({ type: 'auth', token }));
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WSEvent;
        const payload = data.payload as
          | { connected?: boolean; pong?: boolean }
          | undefined;
        // Any pong clears the in-flight heartbeat — the socket is alive.
        if (data.type === 'connection:status' && payload?.pong) {
          this.awaitingPong = false;
          return;
        }
        // The server emits connection:status {connected:true} only
        // after auth succeeds. That's our signal to resubscribe.
        if (
          data.type === 'connection:status' &&
          payload?.connected &&
          !this.authenticated
        ) {
          this.authenticated = true;
          for (const workspaceId of this.subscribedWorkspaces) {
            this.send({ type: 'subscribe', workspaceId });
          }
        }
        this.emit(data.type, data.payload);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('WebSocket disconnected');
      this.authenticated = false;
      this.stopHeartbeat();
      this.emit('connection:status', { connected: false });
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
  }

  subscribe(workspaceId: string): void {
    this.subscribedWorkspaces.add(workspaceId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'subscribe', workspaceId });
    }
  }

  unsubscribe(workspaceId: string): void {
    this.subscribedWorkspaces.delete(workspaceId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: 'unsubscribe', workspaceId });
    }
  }

  on<T>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler as EventHandler);
    };
  }

  private emit(event: string, payload: unknown): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`Handler error for ${event}:`, err);
        }
      }
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    // Already a reconnect queued — don't stack timers (focus/online events
    // and an onclose can all fire near-simultaneously).
    if (this.reconnectTimer) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempts++;

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  /**
   * Heartbeat: ping the server every interval. If a tick fires while the
   * previous ping is still unanswered, the socket is half-open (laptop slept,
   * backend was killed without a clean close) — terminate it so onclose runs
   * and the backoff loop reconnects.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        console.warn('WebSocket heartbeat missed; reconnecting');
        this.awaitingPong = false;
        this.ws.close();
        return;
      }
      this.awaitingPong = true;
      this.send({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingPong = false;
  }

  /**
   * Reconnect immediately when the window regains focus or the network comes
   * back, instead of waiting out the backoff. Bound once, lazily, the first
   * time we connect.
   */
  private bindLifecycle(): void {
    if (this.lifecycleBound || typeof window === 'undefined') return;
    this.lifecycleBound = true;
    const wake = () => {
      if (this.ws?.readyState === WebSocket.OPEN) return;
      // Cancel any pending backoff timer and retry now from a clean slate.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempts = 0;
      void this.connect();
    };
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
  }
}

/**
 * Fetch the backend's "latest daemon version" — a short SHA the
 * current build was deployed from. Unauthenticated (public constant)
 * and on `/daemon/...`, not `/api/v1/...`. Used by Settings to
 * compare against each env's reported version.
 */
export async function fetchLatestDaemonVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}/daemon/latest-version`);
    if (!res.ok) return null;
    const json = (await res.json()) as { success?: boolean; data?: { version?: string } };
    return json?.data?.version ?? null;
  } catch {
    return null;
  }
}

// Singleton instance
export const wsClient = new WebSocketClient();

// ============================================================================
// Combined API export
// ============================================================================

export const api = {
  workspaces,
  environments,
  agents,
  tasks,
  inbox,
  github,
  posthog,
  repositories,
  pullRequests,
  backlog,
  ws: wsClient,
};
