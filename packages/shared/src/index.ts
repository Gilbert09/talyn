// Core types for FastOwl

// PR mergeable helpers (shared by the desktop button + backend watcher).
export * from './prMergeable';

// ============================================================================
// Workspace
// ============================================================================

/**
 * A workspace's logo. Either an auto-generated identicon (rendered
 * deterministically from `seed`) or a user-uploaded image (a downscaled
 * `data:image/...` URL).
 */
export type WorkspaceLogo =
  | { kind: 'identicon'; seed: string }
  | { kind: 'image'; dataUrl: string };

export interface Workspace {
  id: string;
  name: string;
  description?: string;
  logo?: WorkspaceLogo;
  repos: Repository[];
  integrations: WorkspaceIntegrations;
  settings: WorkspaceSettings;
  createdAt: string;
  updatedAt: string;
}

export interface Repository {
  id: string;
  name: string; // e.g., "posthog/posthog"
  url: string;
  defaultBranch: string;
}

export interface WorkspaceIntegrations {
  github?: GitHubIntegration;
  posthog?: PostHogIntegration;
}

export interface GitHubIntegration {
  enabled: boolean;
  accessToken?: string;
  org?: string;
  watchedRepos: string[];
}

export interface PostHogIntegration {
  enabled: boolean;
  apiKey?: string;
  projectId?: string;
  host?: string;
}

/**
 * Claude models a workspace can run Claude Code tasks on, cheapest-capable
 * first in cost. Sonnet is the default — PR fix/respond/review work doesn't
 * warrant Opus pricing. Ids are the Anthropic model ids passed to the
 * Managed Agents API.
 */
export const CLAUDE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', blurb: 'Balanced capability and cost — the default.' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', blurb: 'Most capable, most expensive.' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', blurb: 'Fastest and cheapest.' },
] as const;

export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]['id'];

/** Default Claude model for Claude Code tasks when the workspace hasn't picked one. */
export const DEFAULT_CLAUDE_MODEL_ID: ClaudeModelId = 'claude-sonnet-4-6';

/** Type guard for a stored/incoming value being a known Claude model id. */
export function isClaudeModelId(value: unknown): value is ClaudeModelId {
  return typeof value === 'string' && CLAUDE_MODELS.some((m) => m.id === value);
}

export interface WorkspaceSettings {
  continuousBuild?: ContinuousBuildSettings;
  /**
   * Which cloud provider new tasks dispatch to when more than one is connected.
   * A specific provider pins it; `'ask'` makes the desktop prompt per task (and
   * backend auto-fixes fall back to a deterministic order); unset = auto
   * (prefer PostHog Code, else Claude Code).
   */
  defaultCloudProvider?: CloudProviderType | 'ask';
  /** Which Claude model Claude Code tasks run on. Unset = {@link DEFAULT_CLAUDE_MODEL_ID}. */
  claudeModel?: ClaudeModelId;
}

export interface ContinuousBuildSettings {
  enabled: boolean;
  /** How many code_writing tasks can be in-flight at once. */
  maxConcurrent: number;
  /** If true, wait for user to approve a task before spawning the next. */
  requireApproval: boolean;
}

// ============================================================================
// Environment
// ============================================================================

/**
 * Environment type. Both types transport exec/stream/git over the
 * daemon WS protocol; they only differ in where the daemon is running:
 *   - `local`  — the daemon bundled with the desktop app, running on
 *               the user's own machine (installed as a launchd/systemd
 *               user service by the desktop app).
 *   - `remote` — a daemon the user installed on a separate machine
 *               (VM, workstation, etc.) via the pairing flow.
 *
 * Legacy types ('ssh', 'coder', 'daemon') were removed in the "daemon
 * everywhere" refactor (docs/DAEMON_EVERYWHERE.md).
 *
 *   - `posthog_code` — not daemon-backed at all. A delegation marker: a
 *               task assigned to this env is handed off to PostHog Code,
 *               which runs the whole agent loop on its own sandboxed
 *               machine and opens a PR. FastOwl creates the remote task,
 *               polls its run, and ingests the resulting PR. Credentials
 *               live on the task's workspace (`PostHogIntegration`), not
 *               on the env. See services/posthogCode/*.
 */
export type EnvironmentType = 'local' | 'remote' | 'posthog_code';

export type EnvironmentStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'error';

export interface Environment {
  id: string;
  name: string;
  type: EnvironmentType;
  status: EnvironmentStatus;
  config: EnvironmentConfig;
  lastConnected?: string;
  error?: string;
  /**
   * When true, autonomous Claude tasks on this env bypass every
   * permission prompt (bash / edits / MCP trust). Appropriate for
   * throwaway daemon VMs; dangerous for `local`. Defaults to false;
   * toggle from Settings → Environments. See
   * `services/agent.ts` for how this gates the --permission-mode flag.
   */
  autonomousBypassPermissions: boolean;
  /**
   * How tasks on this env are driven + rendered:
   *  - `pty`         (default) spawns the `claude` CLI in an interactive
   *                  PTY. Raw bytes flow through XTerm. Works for every
   *                  env type.
   *  - `structured`  spawns `claude -p --output-format stream-json` and
   *                  consumes JSONL events. Desktop renders a structured
   *                  conversation (markdown text, collapsible tool calls,
   *                  per-tool permission prompts). Slice 1 supports
   *                  `local` envs only.
   */
  renderer: EnvironmentRenderer;
  /**
   * Tool names pre-approved on this env — the structured renderer's
   * PreToolUse hook skips the permission prompt when the requested
   * tool is in this list. Populated by the "Allow always" button in
   * the Approve/Deny UI. Scoped per-env (not per-task) so approvals
   * stick across every task on that machine.
   */
  toolAllowlist: string[];
  /**
   * Version string reported by the daemon on its most recent hello,
   * shape `<pkgVersion>+<shortSha>` (e.g. `0.1.0+a1b2c3d`). Undefined
   * for envs that have never successfully paired. Compared against
   * the backend's own build SHA to surface "stale daemon" warnings.
   */
  daemonVersion?: string;
  /**
   * Opt-in auto-update: when true, the backend triggers this env's
   * daemon self-update on reconnect (and on a periodic scheduler
   * tick) whenever it sees a stale version. Off by default.
   */
  autoUpdateDaemon: boolean;
}

export type EnvironmentRenderer = 'pty' | 'structured';

export type EnvironmentConfig =
  | LocalEnvironmentConfig
  | RemoteEnvironmentConfig
  | PostHogCodeEnvironmentConfig;

export interface LocalEnvironmentConfig {
  type: 'local';
  /** Where the daemon runs — usually the user's hostname, for display. */
  hostname?: string;
  workingDirectory?: string;
}

export interface RemoteEnvironmentConfig {
  type: 'remote';
  /** Where the daemon runs, for UI display. */
  hostname?: string;
  workingDirectory?: string;
}

/**
 * PostHog Code (cloud) env config. Deliberately a marker with no
 * secrets — the personal API key + project id live on the task's
 * workspace `PostHogIntegration` so one set of credentials is shared
 * by every cloud task in the workspace. `projectId`/`host` here are
 * optional display hints only.
 */
export interface PostHogCodeEnvironmentConfig {
  type: 'posthog_code';
  /** Display-only, for parity with the other configs. Unused for cloud. */
  hostname?: string;
  workingDirectory?: string;
  /** Default agent runtime for tasks on this env. */
  runtimeAdapter?: PostHogCodeRuntimeAdapter;
  /** Default agent model for tasks on this env. */
  model?: string;
}

export type PostHogCodeRuntimeAdapter = 'claude' | 'codex';

// ============================================================================
// Task
// ============================================================================

export type TaskType =
  | 'code_writing'
  | 'pr_response'
  | 'pr_review'
  | 'manual';

/** Types FastOwl delegates to a cloud agent (everything except `manual`). */
export const AGENT_TASK_TYPES: readonly TaskType[] = [
  'code_writing',
  'pr_response',
  'pr_review',
];

/** True if FastOwl dispatches this task to a cloud agent. */
export function isAgentTask(type: TaskType): boolean {
  return type !== 'manual';
}

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Task {
  id: string;
  workspaceId: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  title: string;
  description: string;
  prompt?: string; // Prompt for Claude agent
  repositoryId?: string; // Repository to run the task in
  branch?: string; // Git branch for this task (auto-created for code tasks)
  assignedEnvironmentId?: string;
  result?: TaskResult;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /**
   * Structured JSONL event log for tasks driven by the `structured`
   * renderer. One entry per event emitted by the CLI's stream-json
   * output (assistant/tool_use/tool_result/result/etc). Null for
   * PTY-rendered tasks.
   */
  transcript?: AgentEvent[];
}

export interface TaskResult {
  success: boolean;
  summary?: string;
  output?: string;
  error?: string;
}

// ============================================================================
// Structured agent events (stream-json renderer)
// ============================================================================

/**
 * A single event from the `claude -p --output-format stream-json --verbose`
 * pipeline. We store these verbatim — shape matches the CLI's output —
 * plus a monotonically-increasing `seq` so reconnecting clients can ask
 * for "everything after N".
 *
 * Deliberately permissive typing: the CLI's stream is still evolving, and
 * we don't want a schema mismatch to drop events we could otherwise
 * render. Renderer should switch on `type` + `subtype` and ignore things
 * it doesn't recognize.
 */
export interface AgentEvent {
  /** Monotonic per-task sequence number, assigned backend-side. */
  seq: number;
  /** The CLI event type: `system` | `assistant` | `user` | `stream_event` | `result` | `rate_limit_event` | ... */
  type: string;
  /** The CLI event subtype (e.g. `init`, `status`, `success`). Not all events have one. */
  subtype?: string;
  /** Session id the CLI assigned to this run. Lets us `--resume` later. */
  session_id?: string;
  /** For assistant/user events — the message content blocks. */
  message?: {
    role?: string;
    content?: unknown;
    [k: string]: unknown;
  };
  /** For `stream_event` — the partial API delta. */
  event?: unknown;
  /** For `result` — final summary. */
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  permission_denials?: Array<{ tool_name: string; tool_use_id?: string; tool_input?: unknown }>;
  usage?: unknown;
  /** Anything else the CLI emits. */
  [k: string]: unknown;
}

// ============================================================================
// WebSocket Events
// ============================================================================

export type WSEventType =
  | 'task:status'
  | 'task:event'
  | 'task:created'
  | 'task:update'
  | 'task:deleted'
  | 'task:files_changed'
  | 'pull_request:updated'
  | 'merge_queue:blocked'
  | 'environment:status'
  | 'environment:created'
  | 'connection:status'
  // Developer debug stream — one event per observed internal activity
  // (HTTP request, poll tick, WS broadcast, …). Broadcast to all clients;
  // the desktop Debug panel tails it. See DebugEvent below.
  | 'debug:event';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  payload: T;
  timestamp: string;
}

// ============================================================================
// Debug Tooling
// ============================================================================

/**
 * Buckets a {@link DebugEvent} into one of the app's internal activity
 * channels. Drives the filter chips in the desktop Debug panel.
 */
export type DebugCategory =
  | 'http' // outbound request to an external service (GitHub, PostHog Code)
  | 'db' // a Postgres query and the (estimated) bytes its result pulled back
  | 'polling' // a poll loop tick
  | 'websocket' // client connect/disconnect, inbound message, outbound broadcast
  | 'event' // in-process domain event (e.g. task:status)
  | 'webhook' // an inbound GitHub webhook delivery (receipt → enqueue → process)
  | 'error'; // an unexpected failure worth surfacing on its own

/**
 * A single observed internal activity. Metadata only — never request/response
 * bodies, auth headers, or tokens (URLs are stripped of their query string at
 * the recording site). Safe to surface in the UI and leave recording on.
 */
export interface DebugEvent {
  /** Monotonic per-process id; also used as a stable React key. */
  id: number;
  timestamp: string;
  category: DebugCategory;
  /** Originating subsystem, e.g. 'github', 'posthog_code', 'pr_monitor', 'ws'. */
  service: string;
  /** What happened, e.g. 'request', 'tick', 'connect', 'broadcast'. */
  action: string;
  /** Whether the activity succeeded (false for a failed request / errored tick). */
  ok: boolean;
  /** Human-readable one-liner for the stream row. */
  summary: string;
  durationMs?: number;
  /** Extra redacted context shown when a row is expanded. */
  meta?: Record<string, unknown>;
  /**
   * The FastOwl account this activity belongs to, when it can be attributed to
   * one (e.g. a GitHub call for a workspace that account owns). null for
   * backend-internal activity not tied to a single account. Used by the
   * admin-only Debug panel to filter by user.
   */
  ownerId?: string | null;
  /** Display label for {@link ownerId} (email or GitHub username). */
  ownerLabel?: string | null;
}

/** A FastOwl account that has debug activity attributed to it. */
export interface DebugOwner {
  ownerId: string;
  label: string;
}

/** Live state of one poll loop, surfaced in the Debug panel snapshot bar. */
export interface DebugPollerState {
  name: string;
  /** Human-readable explanation of what this loop does (shown as a tooltip). */
  description: string;
  /** Current cadence — the live interval, which may be stretched from the base. */
  intervalMs: number;
  /**
   * The un-throttled base cadence. Equals {@link intervalMs} unless the adaptive
   * rate-budget governor has slowed the loop to protect the GitHub budget — then
   * `intervalMs > baseIntervalMs` and the panel flags it as throttled.
   */
  baseIntervalMs: number;
  tickCount: number;
  lastTickAt: string | null;
  lastDurationMs: number | null;
  lastOk: boolean | null;
  lastError: string | null;
}

/** Point-in-time view of the backend's internals for the Debug panel. */
export interface DebugSnapshot {
  pollers: DebugPollerState[];
  /** Lifetime event counts keyed by {@link DebugCategory}. */
  counters: Record<string, number>;
  /** Current number of buffered events. */
  bufferSize: number;
  /** Currently-connected WebSocket clients. */
  wsClients: number;
  /** Accounts with attributed debug activity, for the per-user filter. */
  owners: DebugOwner[];
  /** Cumulative Postgres query stats since the last clear. */
  dbStats: DebugDbStats;
  /**
   * Webhook consumer lag (enqueue→pickup) over recent processed deliveries —
   * dominated by the fast check_run/check_suite firehose.
   */
  webhookLag: DebugWebhookLag;
  /**
   * Lag of the SLOW lane only: pull_request/review/comment deliveries, which run
   * a bounded-concurrency `refreshPr`. Surfaces a backed-up refresh pool even
   * when the firehose (`webhookLag`) is at zero.
   */
  webhookLagSlow: DebugWebhookLag;
}

/**
 * How far behind real-time the webhook worker is: the enqueue→pickup latency of
 * recently processed deliveries. A healthy worker sits near zero; a rising
 * `maxMs` means the consumer can't keep up with the ingest stream.
 */
export interface DebugWebhookLag {
  /** Most recent processed delivery's enqueue→pickup lag, ms. */
  lastMs: number;
  /** Median lag across the recent sample window, ms. */
  medianMs: number;
  /** Worst lag in the recent sample window, ms. */
  maxMs: number;
  /** Number of samples behind the figures (0 = nothing processed yet). */
  samples: number;
  /** ISO time of the most recent processed delivery, or null if none yet. */
  observedAt: string | null;
}

/**
 * Running totals for Postgres traffic, surfaced as tiles on the Debug panel.
 * `egressBytes` is an estimate — the serialized size of each query's result
 * rows, not exact wire bytes — but directionally accurate for spotting which
 * queries dominate database egress.
 */
export interface DebugDbStats {
  /** Total queries issued since the last clear. */
  requests: number;
  /** Estimated total bytes returned by those queries since the last clear. */
  egressBytes: number;
}

export interface TaskStatusEvent {
  taskId: string;
  status: TaskStatus;
  result?: TaskResult;
}

export interface TaskUpdateEvent {
  taskId: string;
  updates: Partial<Task>;
}

export interface TaskDeletedEvent {
  taskId: string;
}

/**
 * Fired when a task is created on the BACKEND (merge-queue / auto-keep-mergeable
 * fix runs, or any non-desktop creator). Lets the desktop add it to the task
 * list live, so backend-created tasks show up in the Tasks screen and the PR's
 * task badge deep-links to a real, present task. The desktop dedupes by id, so
 * it's harmless when the creating client already added it optimistically.
 */
export interface TaskCreatedEvent {
  task: Task;
}

/**
 * Fired once when a PR in the FastOwl merge queue exhausts its auto-fix retry
 * budget and transitions into `blocked` — the queue has given up and the PR
 * now needs a human. The desktop turns this into an OS notification + in-app
 * toast. Distinct from the idempotent `pull_request:updated` (which is replayed
 * on reconnect/backfill) so the notification fires exactly once.
 */
export interface MergeQueueBlockedEvent {
  pullRequestId: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  /** Short human reason, e.g. "merge conflicts with the base branch". */
  reason: string;
  /** How many fix runs were attempted before giving up. */
  attempts: number;
}

export interface EnvironmentStatusEvent {
  environmentId: string;
  status: EnvironmentStatus;
  error?: string;
}

export interface EnvironmentCreatedEvent {
  environment: Environment;
}

export interface TaskEventBroadcast {
  taskId: string;
  event: AgentEvent;
}

// ============================================================================
// API Types
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ============================================================================
// MCP tokens
// ============================================================================

/**
 * A long-lived personal access token for the hosted MCP endpoint, as shown
 * in the desktop "MCP server" settings list. Never carries the secret — only
 * the human-readable prefix. The plaintext token is returned exactly once at
 * creation (see {@link CreateMcpTokenResponse}).
 */
export interface McpToken {
  id: string;
  name: string;
  /** Human-readable head, e.g. `fowl_mcp_ab12cd` — for disambiguation only. */
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface CreateMcpTokenRequest {
  /** Optional label so the user can tell tokens apart. */
  name?: string;
  /** Days until expiry. Defaults to 90; null/0 means non-expiring. */
  expiresInDays?: number | null;
}

/** Returned once on creation — `token` is never retrievable again. */
export interface CreateMcpTokenResponse {
  /** The full plaintext token. Show once, then discard server-side. */
  token: string;
  token_meta: McpToken;
}

// Workspace API
export interface CreateWorkspaceRequest {
  name: string;
  description?: string;
  logo?: WorkspaceLogo;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  description?: string;
  logo?: WorkspaceLogo;
  settings?: Partial<WorkspaceSettings>;
}

// Task API
export interface CreateTaskRequest {
  workspaceId: string;
  type: TaskType;
  title: string;
  description: string;
  prompt?: string;
  priority?: TaskPriority;
  repositoryId?: string;
  assignedEnvironmentId?: string;
  /**
   * Associate the new task with an existing pull_requests row (its `id`).
   * Set when the task is started from a PR row ("Get PR mergeable" /
   * "Address PR") so the GitHub screen can show a live in-progress
   * indicator on that row and deep-link back to the task. Best-effort:
   * an unknown / cross-workspace id is silently ignored.
   */
  pullRequestId?: string;
  /**
   * Cloud (PostHog Code) overrides. Only meaningful when the task is
   * assigned to a `posthog_code` env; ignored otherwise. `runtimeAdapter`
   * falls back to the env's default, then `claude`. `model` falls back to
   * the env's default, then the backend default — the PostHog Code API
   * requires a concrete model on every run, so it's always resolved server-side.
   */
  runtimeAdapter?: PostHogCodeRuntimeAdapter;
  model?: string;
}

/**
 * Fields FastOwl writes onto `task.metadata` for a cloud (PostHog Code)
 * run. Stored loosely (metadata is `Record<string, unknown>`); this
 * interface documents the shape the poller + UI rely on.
 */
export interface PostHogCodeTaskMetadata {
  /** Remote PostHog task id. */
  posthogTaskId: string;
  /** Remote run id (the `run/` response). */
  posthogRunId?: string;
  /** PostHog project (team) id the task was created under. */
  posthogProjectId: string;
  /** PostHog host the task lives on, e.g. https://us.posthog.com. */
  posthogHost: string;
  /** Deep link to the run's log/console in the PostHog UI. */
  posthogLogUrl?: string;
  /** PR URL once the cloud run opens one. */
  posthogPrUrl?: string;
  /** Last remote run status we observed. */
  posthogStatus?: string;
}

/**
 * Cloud task providers FastOwl can delegate a task to. A provider runs the
 * whole agent loop on its own sandbox and opens a PR; FastOwl kicks off the
 * run and reconciles status/transcript back. `posthog_code` is live today;
 * the other two are planned drop-ins (see docs/CLOUD_PROVIDERS.md).
 */
export type CloudProviderType = 'posthog_code' | 'codex_cloud' | 'claude_code';

/**
 * Neutral, provider-agnostic cloud-run metadata stored on
 * `task.metadata.cloudTask`. Supersedes the legacy `posthog*` fields; a
 * read-through helper ({@link readCloudTaskMeta}) maps old tasks forward.
 */
export interface CloudTaskMetadata {
  /** Which provider owns this task. */
  provider: CloudProviderType;
  /** Remote task id on the provider. */
  remoteTaskId: string;
  /** Remote run id, once a run has started. */
  remoteRunId?: string;
  /** Last remote status observed. */
  status?: string;
  /** Deep link to the run's log/console in the provider's UI. */
  logUrl?: string;
  /** PR URL once the run opens one. */
  prUrl?: string;
  /** Provider-specific extras. */
  extra?: Record<string, unknown>;
}

/**
 * Resolve which cloud provider owns a task from its `provider` column
 * (preferred) or its metadata, falling back to the legacy `posthog*`
 * fields. Returns null for a task with no cloud association.
 */
export function readCloudTaskProvider(task: {
  provider?: string;
  metadata?: Record<string, unknown> | null;
}): CloudProviderType | null {
  const KNOWN: CloudProviderType[] = ['posthog_code', 'codex_cloud', 'claude_code'];
  if (task.provider && KNOWN.includes(task.provider as CloudProviderType)) {
    return task.provider as CloudProviderType;
  }
  const meta = task.metadata ?? {};
  const cloud = meta.cloudTask as CloudTaskMetadata | undefined;
  if (cloud?.provider && KNOWN.includes(cloud.provider)) return cloud.provider;
  if (typeof meta.posthogTaskId === 'string' && meta.posthogTaskId) {
    return 'posthog_code';
  }
  return null;
}

/**
 * Read the neutral cloud metadata for a task, mapping legacy `posthog*`
 * fields forward when `metadata.cloudTask` isn't present. Returns null if
 * the task carries no cloud run.
 */
export function readCloudTaskMeta(task: {
  metadata?: Record<string, unknown> | null;
}): CloudTaskMetadata | null {
  const meta = task.metadata ?? {};
  const cloud = meta.cloudTask as CloudTaskMetadata | undefined;
  if (cloud && cloud.remoteTaskId) return cloud;
  if (typeof meta.posthogTaskId === 'string' && meta.posthogTaskId) {
    return {
      provider: 'posthog_code',
      remoteTaskId: meta.posthogTaskId,
      remoteRunId: meta.posthogRunId as string | undefined,
      status: meta.posthogStatus as string | undefined,
      logUrl: meta.posthogLogUrl as string | undefined,
      prUrl: meta.posthogPrUrl as string | undefined,
    };
  }
  return null;
}

export interface GenerateTaskMetadataRequest {
  prompt: string;
  /** Optional env hint for resolving the cloud provider. */
  assignedEnvironmentId?: string;
}

export interface GenerateTaskMetadataResponse {
  title: string;
  description: string;
  suggestedPriority: TaskPriority;
}
