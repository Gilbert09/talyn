// The operator console's contract (admin.talyn.dev ⇄ /api/v1/admin).
//
// Split out of index.ts because this surface is cross-tenant and nothing in
// the product apps should reach for it by accident — a separate file makes
// "why is apps/web importing AdminUserSummary?" a visible question in review.
//
// Everything here is JSON-over-the-wire, so timestamps are ISO strings rather
// than Dates. The backend's own view types (FleetHostView, the Drizzle row
// types) stay in the backend; these are what actually crosses the boundary.

// ============================================================================
// Access
// ============================================================================

/**
 * What a mutation the deploy actually permits.
 *
 * Reported by `GET /admin/me` so the console can hide a button the server will
 * refuse, rather than showing it and failing on click. NOT a permission model —
 * the server checks these itself on every call; this is the UI's copy.
 */
export type AdminCapability =
  | 'fleet.read'
  | 'fleet.mutate'
  | 'product.read'
  | 'product.comp'
  | 'product.grant_admin'
  | 'product.task_mutate';

export interface AdminAccess {
  admin: boolean;
  email: string | null;
  capabilities: AdminCapability[];
}

// ============================================================================
// Audit
// ============================================================================

/**
 * Every action the audit log records.
 *
 * This union IS the `admin_audit_log.action` column's contract — the column is
 * plain text, so this is the only place the vocabulary is written down. Adding
 * a mutation means adding a member here first.
 */
export type AdminAuditAction =
  | 'fleet.drain'
  | 'fleet.run.cancel'
  | 'fleet.golden.gc'
  | 'fleet.golden.pin'
  | 'fleet.golden.delete'
  | 'fleet.golden.rebake'
  | 'user.plan_override'
  | 'user.admin'
  | 'task.retry'
  | 'task.kill'
  | 'billing.grant_credits'
  | 'billing.reverse_credit_lot'
  // The one READ we audit: another tenant's agent conversation is the most
  // sensitive thing this console can show, and recording the access is what
  // makes showing it defensible.
  | 'task.transcript.read';

export type AdminAuditTargetKind = 'host' | 'run' | 'golden' | 'user' | 'workspace' | 'task';

/**
 * 'pending' means we wrote the row and then dialled out. A row STUCK on
 * pending is itself the signal — we started something and never learned how it
 * ended, which is exactly the state a crash mid-drain leaves behind.
 */
export type AdminAuditOutcome = 'pending' | 'ok' | 'error';

export interface AdminAuditEntry {
  id: string;
  at: string;
  actorId: string;
  actorEmail: string;
  action: AdminAuditAction;
  targetKind: AdminAuditTargetKind;
  targetId: string;
  reason: string;
  params: Record<string, unknown> | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  outcome: AdminAuditOutcome;
  error: string | null;
  durationMs: number | null;
}

// ============================================================================
// Usage billing
// ============================================================================

/** Money is integer micro-dollars (USD x 1e6); usage is integer weighted seconds. */
export interface AdminBillingLot {
  id: string;
  source: string;
  totalMicros: number;
  remainingMicros: number;
  purchasedAt: string;
  expiresAt: string;
  /** Credit is left and the lot has not expired: it can be reversed. */
  live: boolean;
}

export interface AdminBillingBox {
  id: string;
  subjectKind: string;
  subjectId: string;
  sandboxId: string;
  size: string;
  startedAt: string;
}

export interface AdminBillingInterval extends AdminBillingBox {
  endedAt: string | null;
  endReason: string | null;
  billedWsec: number;
}

export interface AdminBillingView {
  tier: string;
  /** Where the tier came from: override, subscription, team seat or default. */
  source: string;
  period: { start: string; end: string };
  /** Null when the owner has no usage row for this period yet. */
  usage: {
    tier: string;
    includedWsec: number;
    usedWsec: number;
    creditMicrosUsed: number;
    uncoveredMicros: number;
    exhaustedAt: string | null;
  } | null;
  openBoxes: AdminBillingBox[];
  lots: AdminBillingLot[];
  creditBalanceMicros: number;
  autoTopup: {
    enabled: boolean;
    triggerMicros: number;
    pack: string;
    monthlyLimitMicros: number;
    monthSpentMicros: number;
    lastFailure: string | null;
    lastFailureAt: string | null;
  } | null;
  recentIntervals: AdminBillingInterval[];
}

export interface AdminGrantCreditsRequest extends AdminMutationRequest {
  /** US dollars, whole cents. */
  amountUsd: number;
  /** Repeating a request with the same key grants once. The server makes one when absent. */
  idempotencyKey?: string;
}

export interface AdminGrantCreditsResult {
  lotId: string;
  created: boolean;
  micros: number;
}

export interface AdminReverseLotResult {
  lotId: string;
  reversedMicros: number;
}

export interface AdminUsageSummary {
  periodBoxWsec: number;
  ownersWithUsage: number;
  ownersExhausted: number;
  /** Month to date, UTC. `purchase` and `auto_topup` lots. */
  creditsSoldMicros: number;
  /** Month to date, UTC. `grant` lots. */
  creditsGrantedMicros: number;
}

// ============================================================================
// Requests
// ============================================================================

/** Every mutating admin request carries a reason. Enforced server-side. */
export interface AdminMutationRequest {
  reason: string;
}

/**
 * The two escalation mutations additionally require typing the TARGET's email.
 *
 * The "type the repo name to delete it" pattern: no new server state, no TTL,
 * and it makes a mis-clicked table row or a blind cross-site POST unexecutable,
 * because either would have to already know which specific account it meant.
 */
export interface AdminConfirmRequest extends AdminMutationRequest {
  confirm: string;
}

/** Bounds shared by every paginated admin list. */
export const ADMIN_PAGE_LIMIT_DEFAULT = 50;
export const ADMIN_PAGE_LIMIT_MAX = 100;
/** Shorter than this and an `ilike` scan is just "return everything, slowly". */
export const ADMIN_SEARCH_MIN_LENGTH = 2;
/** Long enough to say why; short enough that the column is not a document store. */
export const ADMIN_REASON_MAX_LENGTH = 500;

export interface AdminPage<T> {
  items: T[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

// ============================================================================
// Error codes
// ============================================================================
//
// Exported as consts, mirroring TASK_LIMIT_ERROR_CODE, so the console branches
// on `code` and never on a message string. A message is copy; a code is API.

export const ADMIN_REASON_REQUIRED = 'reason_required';
export const ADMIN_SELF_MUTATION_FORBIDDEN = 'self_mutation_forbidden';
export const ADMIN_CONFIRM_MISMATCH = 'confirm_mismatch';
export const ADMIN_GRANT_DISABLED = 'admin_grant_disabled';
export const ADMIN_LAST_ADMIN = 'last_admin';
export const ADMIN_HOST_UNKNOWN = 'host_unknown';
export const ADMIN_HOST_OFFLINE = 'host_offline';
export const ADMIN_HOST_NOT_DIALABLE = 'host_not_dialable';
export const ADMIN_FLEET_NOT_CONFIGURED = 'fleet_not_configured';
export const ADMIN_FLEET_UNREACHABLE = 'fleet_unreachable';

// ============================================================================
// Fleet
// ============================================================================

/** Why a live read of a host failed. `unreachable` is by far the common one. */
export type AdminFleetLiveErrorCode =
  | typeof ADMIN_HOST_OFFLINE
  | typeof ADMIN_HOST_NOT_DIALABLE
  | typeof ADMIN_FLEET_NOT_CONFIGURED
  | typeof ADMIN_FLEET_UNREACHABLE;

/** fleetd's `GET /v1/capacity`. */
export interface AdminFleetCapacity {
  draining: boolean;
  runsLive: number;
  runsMax: number;
  memReservedMib: number;
  memBudgetMib: number;
  accepting: boolean;
}

/**
 * fleetd's metrics snapshot, passed through whole.
 *
 * Deliberately loose: the fleet ships on its own cadence and adding a counter
 * there must not need a release here. The console reads known keys defensively
 * and renders the rest generically.
 */
export type AdminFleetMetrics = Record<string, unknown>;

/**
 * A host row.
 *
 * `live` is null whenever we could not or would not dial — and `liveError`
 * says which. That pairing is the whole degradation contract: the fleet page is
 * the page you open BECAUSE a host is misbehaving, so a dead box must render as
 * a row with a reason, never as a failed request.
 */
export interface AdminFleetHost {
  name: string;
  apiEndpoint: string | null;
  version: string | null;
  reportedAt: string;
  draining: boolean;
  runsLive: number;
  runsMax: number;
  memReservedMib: number;
  memBudgetMib: number;
  diskFreeMib: number;
  maxIdleSeconds: number;
  /** Derived from reportedAt: false once the host stops reporting. */
  online: boolean;
  /** Online, not draining, has capacity, and advertised somewhere to dial. */
  dispatchable: boolean;
  live: AdminFleetCapacity | null;
  liveError: string | null;
  liveErrorCode: AdminFleetLiveErrorCode | null;
  /** From a live `GET /v1/stats`. Null without a live read. */
  health?: AdminHostHealth | null;
  conditions?: AdminHostCondition[] | null;
  boxes?: AdminHostBoxCounts | null;
}

/**
 * A host's health, from fleetd's `GET /v1/stats` (`health`).
 *
 * The same numbers the YAS control plane raises its host alerts from. Null on a
 * host we could not reach, and on a fleetd older than the field.
 */
export interface AdminHostHealth {
  /** The fleet store's free space, unrounded. */
  diskFreeBytes: number;
  /** `ok`, `low` or `critical`. Null from a host that predates it. */
  diskPressure: 'ok' | 'low' | 'critical' | null;
  /** Growth that admitted boxes have not written yet. */
  diskCommittedMib: number | null;
  diskReserveMib: number | null;
  diskHardFloorMib: number | null;
  /** The boxes that write most. Set only under disk pressure. */
  diskTopWriters: Array<{ id: string; writtenMib: number; rateMibPerMin: number }>;
  /** Local suspensions whose last hibernation upload failed. */
  hibernateUploadFailing: number;
  bakeFailingRepos: number;
  bakeMaxConsecutiveFailures: number;
}

/**
 * One thing on a host that a person should look at. The kinds are the fleet's
 * stable strings (yas `internal/fleet/hosthealth.go`).
 */
export type AdminHostConditionKind = 'disk_low' | 'hibernate_upload_failing' | 'bake_failing' | (string & {});

export interface AdminHostCondition {
  kind: AdminHostConditionKind;
  severity: 'warning' | 'critical';
  detail: string;
}

/** A host's sandboxes by state, from `runsByStatus` on `GET /v1/stats`. */
export interface AdminHostBoxCounts {
  /** starting, idle and busy. */
  running: number;
  /** suspended. */
  asleep: number;
  queued: number;
}

/** A host alert as the console banner shows it. */
export interface AdminHostAlert {
  host: string;
  kind: AdminHostConditionKind | 'host_offline';
  severity: 'warning' | 'critical';
  detail: string;
}

export interface AdminFleetAlerts {
  alerts: AdminHostAlert[];
  /** When the backend last read the hosts. The answer is cached for a short time. */
  checkedAt: string;
}

export interface AdminFleetHostDetail extends AdminFleetHost {
  /** The registry's last stored snapshot — present even when the host is down. */
  metrics: AdminFleetMetrics | null;
  /** Fresh from the host when reachable; null otherwise. */
  liveMetrics: AdminFleetMetrics | null;
  runsByStatus: Record<string, number> | null;
}

export type AdminRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * What a fleet sandbox is for, read from its id.
 *
 * `talyn-<task>` is a task run, `talyn-wb-<workbench>` is a session or a
 * thread (the Talyn row says which), `talyn-rev-<unit>` is one code-review
 * unit. `unknown` is an id Talyn does not make (a deploy self-test, a box made
 * by hand).
 */
export type AdminRunKind = 'task' | 'session' | 'thread' | 'review' | 'unknown';
export const ADMIN_RUN_KINDS: readonly AdminRunKind[] = ['task', 'session', 'thread', 'review', 'unknown'];

/**
 * Whether a Talyn row claims the sandbox.
 *
 *  - `active`: a row claims it as its current sandbox.
 *  - `superseded`: a row names it, but the row is archived or has moved to a
 *    newer sandbox. A cleanup candidate, not a leak.
 *  - `orphan`: no Talyn row of any status names it.
 */
export type AdminRunClaim = 'active' | 'superseded' | 'orphan';

/**
 * Where a suspended sandbox sleeps. `local`: its images are on the host's
 * disk. `storage`: a complete copy is in object storage (hibernated).
 */
export type AdminRunSleepKind = 'local' | 'storage';

export interface AdminRunSleep {
  kind: AdminRunSleepKind;
  /** When the box went to sleep. Null when the host did not say. */
  since: string | null;
  /** `memory` keeps running processes. `rootfs` keeps only the disk. */
  suspendKind: 'memory' | 'rootfs' | null;
  /** Why the last hibernation upload failed. The box is still asleep locally. */
  uploadError: string | null;
}

/**
 * A run, joined from two sources that each know something the other doesn't.
 *
 * The fleet's own run store is IN-MEMORY (plus a per-run JSON ledger for crash
 * adoption), so run history dies with the process. The durable record is the
 * `tasks` row. Neither alone answers "what is happening on the fleet":
 *
 *   - `orphan: true` — live on a host with no task behind it. A microVM burning
 *     memory for nobody, and the single most valuable thing this page surfaces.
 *   - `live: null` on a non-terminal task — the task believes it is running and
 *     the host has never heard of it. Usually a fleetd restart.
 */
export interface AdminRunRow {
  runId: string;
  host: string | null;
  taskId: string | null;
  workspaceId: string | null;
  ownerEmail: string | null;
  repo: string | null;
  /** Absent on an older backend: read absent as `task` when `taskId` is set. */
  kind?: AdminRunKind;
  /** Absent on an older backend: read it from `orphan`. */
  claim?: AdminRunClaim;
  /** Why a `superseded` sandbox is a cleanup candidate, in words. */
  supersededReason?: string | null;
  /** The session's or task's title. */
  title?: string | null;
  /** The session or thread that claims the sandbox. */
  workbenchId?: string | null;
  workspaceName?: string | null;
  /** The fleet's own state word (`busy`, `idle`, `suspended`, ...). Null without a live read. */
  sandboxStatus?: string | null;
  /** Set while the sandbox is suspended. */
  sleep?: AdminRunSleep | null;
  vcpuCount?: number | null;
  diskMib?: number | null;
  /** The size the session chose (`standard`, `large`, ...). Null for a task, or a session on the default. */
  sandboxSize?: string | null;
  status: AdminRunStatus | null;
  phase: string | null;
  adopted: boolean;
  slot: number | null;
  goldenLayer: string | null;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  deadline: string | null;
  lastHeartbeat: string | null;
  lastActivity: string | null;
  costUsd: number | null;
  /**
   * Memory the run is spending right now, in MiB, and the size it was booted
   * at.
   *
   * Two numbers because one is not enough under the fleet's elastic admission:
   * `memMib` is a CEILING the guest is held well below by its balloon, so on
   * its own it says nothing about cost — fifteen runs on a 4096 ceiling read as
   * 60 GiB while actually using 23.
   *
   * `memUsedMib` is null on a terminal run (its VMM is gone) and on any host
   * running a fleetd older than the field. Null means unknown, never zero.
   */
  memUsedMib: number | null;
  memMib: number | null;
  prUrl: string | null;
  error: string | null;
  orphan: boolean;
  /**
   * A guest self-test rather than an agent loop.
   *
   * `deploy.sh` fires one of these after every fleet deploy to prove the API
   * contract still holds, so they land on the host with no Talyn task behind
   * them and are orphans by the strict definition — but they are exactly what
   * is supposed to happen, and four of them tinted red after four merges made
   * the orphan warning mean nothing. Kept as a separate field rather than
   * clearing `orphan`, because "no task behind it" is still true and the run
   * detail page should be able to say so.
   */
  selfTest: boolean;
}

/**
 * The runs page: durable rows, plus which hosts we could not reach.
 *
 * `degraded` is not decoration. Without it a fan-out that lost a host
 * under-reports silently, and an operator reads a short list as "the fleet is
 * idle" rather than "we could not ask one of the boxes".
 */
export interface AdminRunIndex {
  items: AdminRunRow[];
  nextCursor: string | null;
  degraded: Array<{ host: string; error: string }>;
}

/** One run, as the host currently sees it. */
export interface AdminRunDetail {
  run: AdminRunRow;
  terminal: boolean;
}

/** One transcript entry. `seq` is assigned host-side, not by the guest. */
export interface AdminRunEvent {
  seq: number;
  at: string;
  event: Record<string, unknown>;
}

export interface AdminRunEventPage {
  events: AdminRunEvent[];
  cursor: number;
  terminal: boolean;
}

/** A baked image. `diskBytes` is reflink-aware and is the one that bills. */
export interface AdminGolden {
  key: string;
  path: string;
  layer: 'base' | 'repo';
  contentSha: string | null;
  repoSlug: string | null;
  baseBranch: string | null;
  repoCommit: string | null;
  packageManager: string | null;
  builtAt: string | null;
  apparentBytes: number;
  diskBytes: number;
  inUse: boolean;
  operatorPinned: boolean;
  selectable: boolean;
}

export interface AdminGoldensView {
  goldens: AdminGolden[];
  baseGolden: string | null;
  baseOsSha: string | null;
  freePct: number | null;
}

/**
 * What a golden GC actually did.
 *
 * `triggered` is the field that matters. The fleet's GC is DISK-PRESSURE
 * driven: below `force` it only evicts when free space is under the low-water
 * mark (15%), so on a healthy disk it correctly removes nothing. Reporting
 * "GC complete" for that — which the console did at first — reads as "your
 * images are gone" when they are all still there.
 */
export interface AdminGcResult {
  freePctBefore: number;
  freePctAfter: number;
  /** False when the disk was above the threshold, so nothing was considered. */
  triggered: boolean;
  removed: string[];
  /**
   * Blocks the evicted images actually occupied, not their apparent size. A
   * golden sharing all its extents with another reclaims nothing, and
   * reporting its apparent size would make a GC that achieved nothing look
   * like it had worked.
   */
  freedBytes: number;
  protected: number;
  candidates: number;
}

export interface AdminRebakeStatus {
  slug: string | null;
  baseBranch: string | null;
  actor: string | null;
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/**
 * A derived operator signal. NOT a stored table.
 *
 * Every one of these is already a counter in the fleet's metrics snapshot;
 * materialising them would mean a second source of truth that can disagree with
 * the host it describes. The console computes them per request instead.
 */
export type AdminIncidentKind =
  | 'admission_rejection'
  | 'run_failure'
  | 'reaper_orphan'
  | 'wedged_run'
  | 'egress_denied'
  | 'golden_stale'
  | 'rebake_failure'
  | 'host_offline'
  | 'host_draining';

export type AdminIncidentSeverity = 'info' | 'warn' | 'critical';

export interface AdminIncident {
  kind: AdminIncidentKind;
  severity: AdminIncidentSeverity;
  host: string | null;
  /** e.g. the admission reason (`mem`, `max_runs`) or the failure reason. */
  detail: string | null;
  count: number;
  observedAt: string;
}

// ============================================================================
// Fleet mutation bodies
// ============================================================================
//
// `actor` is absent from every one of these ON PURPOSE. fleetd requires it, but
// the backend fills it from req.user — a client-supplied actor on an audit log
// is a field an attacker gets to write.

export interface AdminDrainRequest extends AdminMutationRequest {
  draining: boolean;
}

export interface AdminGoldenGcRequest extends AdminMutationRequest {
  force?: boolean;
  dryRun?: boolean;
  minAge?: string;
}

export interface AdminGoldenPinRequest extends AdminMutationRequest {
  path: string;
  pinned: boolean;
}

export interface AdminGoldenDeleteRequest extends AdminMutationRequest {
  path: string;
}

/**
 * What deleting one golden actually reclaimed.
 *
 * `freedBytes` is blocks the filesystem gave back, not the image's apparent
 * size — a golden sharing all its extents with a live run's overlay frees
 * nothing until that overlay goes, and reporting its apparent 2.5 GiB would
 * make a no-op look like a win.
 */
export interface AdminGoldenDeleteResult {
  path: string;
  key: string;
  freedBytes: number;
}

export interface AdminGoldenRebakeRequest extends AdminMutationRequest {
  repo: string;
  baseBranch: string;
}

// ============================================================================
// Product
// ============================================================================

/**
 * A plan value the console reads or writes. Matches `PLAN_OVERRIDE_VALUES` in
 * pricing.ts: the usage tiers plus `unlimited`, the old comp value (which
 * grants Pro). `effectivePlan` is always a tier, never `unlimited`.
 */
export type AdminPlan = 'free' | 'unlimited' | 'pro' | 'max' | 'legacy_pro';

export interface AdminUserSummary {
  id: string;
  email: string;
  githubUsername: string | null;
  isAdmin: boolean;
  /** Written exclusively by Polar webhooks. */
  plan: AdminPlan;
  /** The manual comp flag. Wins over `plan` when set. */
  planOverride: AdminPlan | null;
  /** The usage tier the gates enforce, from the override, the subscription and its product. */
  effectivePlan: AdminPlan;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  workspaceCount: number;
}

export interface AdminUserDetail extends AdminUserSummary {
  updatedAt: string;
  /** Only on the detail read — a Polar id in a list view is a liability with
   *  no read use, and it is exactly what a support escalation needs here. */
  polarCustomerId: string | null;
  polarSubscriptionId: string | null;
  subscriptionEventAt: string | null;
  activeTaskCount: number;
  workspaces: AdminWorkspaceSummary[];
}

export interface AdminWorkspaceSummary {
  id: string;
  ownerId: string;
  ownerEmail: string | null;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminWorkspaceDetail extends AdminWorkspaceSummary {
  repositoryCount: number;
  taskCount: number;
  activeTaskCount: number;
  /** Provider types with credentials configured. Never the credentials. */
  providers: string[];
  /** What the workspace uses beyond tasks. Absent on an older backend. */
  features?: AdminWorkspaceFeatures;
}

/** Counts only. The rules, prompts and secrets behind them stay on the backend. */
export interface AdminWorkspaceFeatures {
  /** Sessions and threads that are not archived. */
  sessions: number;
  threads: number;
  loops: { enabled: number; total: number };
  workflows: { enabled: number; total: number };
  mcpServers: number;
  /** Webhook endpoints that send to this workspace's events, enabled. */
  webhookEndpoints: number;
  /** The owner's API tokens that are not revoked and can reach this workspace. */
  apiTokens: number;
}

export interface AdminTaskSummary {
  id: string;
  workspaceId: string;
  workspaceName: string | null;
  ownerEmail: string | null;
  type: string;
  status: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Derived in SQL from metadata.cloudTask so the jsonb never ships. */
  provider: string | null;
  remoteRunId: string | null;
  cloudStatus: string | null;
  fleetHost: string | null;
  phase: string | null;
  costUsd: number | null;
}

export interface AdminTaskDetail extends AdminTaskSummary {
  prompt: string | null;
  repositoryId: string | null;
  branch: string | null;
  error: string | null;
  /**
   * Why the run handed back to a person, when it ended `needs_human`. Kept
   * separate from `error` so the console can say "needs a human" rather than
   * rendering a correct refusal in the red failure banner.
   */
  needsHumanReason: string | null;
  prUrl: string | null;
  /** Present only with ?transcript=1, and that read is audited. */
  transcript: unknown[] | null;
}

export interface AdminPlanOverrideRequest extends AdminConfirmRequest {
  planOverride: AdminPlan | null;
}

export interface AdminGrantRequest extends AdminConfirmRequest {
  isAdmin: boolean;
}

// ============================================================================
// Sessions (workbenches on fleet sandboxes)
// ============================================================================

export type AdminSessionKind = 'session' | 'thread';

/**
 * Provisioning longer than this is stuck. A box boots, clones and runs setup in
 * a few minutes; a cold repository with no golden can take ten. Twenty is past
 * every healthy start the fleet has recorded.
 */
export const ADMIN_SESSION_STUCK_PROVISIONING_MS = 20 * 60_000;

export interface AdminSessionSummary {
  id: string;
  kind: AdminSessionKind;
  workspaceId: string;
  workspaceName: string | null;
  ownerEmail: string | null;
  /** `owner/name`. '' for a thread. */
  repoFullName: string;
  /** The title a person sees: the session title, or its name when it has none. */
  title: string;
  name: string;
  branch: string;
  runtime: string;
  agent: string;
  model: string | null;
  /** `WorkbenchStatus`. */
  status: string;
  statusMessage: string | null;
  /** `WorkbenchSandboxState`. */
  sandboxState: string;
  sandboxId: string | null;
  fleetHost: string | null;
  /** The size the session chose. Null: the repository's size. */
  sandboxSize: string | null;
  /** `slack` when Slack started the session. Null: the app. */
  source: string | null;
  pullRequestId: string | null;
  chatCount: number;
  runningChats: number;
  /** The newest chat update, or the session's own update when it has no chats. */
  lastActivityAt: string;
  /** Provisioning for longer than ADMIN_SESSION_STUCK_PROVISIONING_MS. */
  stuckProvisioning: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSessionChat {
  id: string;
  title: string;
  agent: string;
  model: string | null;
  /** `WorkbenchChatStatus`. */
  status: string;
  statusMessage: string | null;
  turnCount: number;
  queuedCount: number;
  turnStartedAt: string | null;
  turnHeartbeatAt: string | null;
  closedAt: string | null;
  updatedAt: string;
}

export interface AdminSessionTurn {
  chatId: string;
  turn: number;
  wallMs: number;
  toolMs: number;
  modelMs: number;
  calls: number;
  at: string;
}

/**
 * One transcript event, WITHOUT its content: the type words only. The content is
 * another tenant's conversation, and this page does not need it to say what
 * the agent was doing.
 */
export interface AdminSessionEventMeta {
  chatId: string;
  seq: number;
  turn: number;
  type: string | null;
  subtype: string | null;
  at: string;
}

export interface AdminSessionSetupStep {
  id: string;
  kind: string;
  phase: string;
  /** The first 200 characters of the command. */
  command: string;
  sessionCount: number;
  live: boolean;
  disabled: boolean;
  boxFailureCount: number;
  boxDisabled: boolean;
  boxLastFailure: string | null;
  typicalDurationMs: number | null;
}

export interface AdminSessionSetup {
  /** The repository's newest box setup that ran learned steps. */
  timing: {
    totalMs: number;
    repositoryMs: number | null;
    learnedMs: number;
    measuredAt: string;
    /** True when the timing is from this session's box. */
    thisSession: boolean;
  } | null;
  steps: AdminSessionSetupStep[];
}

export interface AdminSessionDetail extends AdminSessionSummary {
  baseBranch: string;
  threadId: string | null;
  sandboxGeneration: string | null;
  /** The fleet sandbox the session's next turn tries first, when it is not `sandboxId`. */
  fleetSandboxId: string | null;
  /** The sandbox a move is creating, while the session moves. */
  moveSandboxId: string | null;
  /** Old sandboxes kept because their hibernated copy could not be restored. */
  keptSandboxIds: string[];
  internetAccess: boolean;
  archivePendingAt: string | null;
  archiveFailures: number;
  restoreRequestedAt: string | null;
  memoryRestorePending: string | null;
  workCheckpoint: { sha: string; at: string | null; bytes: number | null } | null;
  pullRequest: { number: number; owner: string; repo: string; state: string; url: string } | null;
  slackPermalink: string | null;
  chats: AdminSessionChat[];
  turns: AdminSessionTurn[];
  events: AdminSessionEventMeta[];
  setup: AdminSessionSetup | null;
  /** The live sandbox, when the fleet answered. */
  sandbox: AdminRunRow | null;
  /** Why the live read failed. Null when it worked or was not tried. */
  sandboxError: string | null;
}
