// Drizzle schema for FastOwl's Postgres database.
//
// This is the source of truth for the schema — hand-rolled SQLite migrations
// (001-007) are being retired in favor of drizzle-kit's generated migrations.
// When adding a column, add it here, then `npm run db:generate` to produce
// the next SQL migration.
//
// Type choices:
//   - text for IDs: we generate UUIDs via `uuid()` in code and keep them as
//     strings so the same id flows through websocket messages etc.
//   - jsonb for structured payloads (settings, config, metadata, result,
//     actions). Query-able + indexable when we need it.
//   - timestamp with time zone for all dates. Postgres default.
//   - boolean for flags. No more 0/1 int masquerading as boolean.

import {
  pgTable,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ---------- Users ----------
//
// Mirror of Supabase's `auth.users`, keyed by the same UUID. We never write
// to `auth.users` directly — Supabase owns it — but we store our own row
// per authenticated user so we can FK ownership columns against it and hang
// app-specific fields (github_username, preferences) off it later.
//
// Rows are upserted by the JWT-verifying middleware on the first request
// after sign-in.

export const users = pgTable('users', {
  id: text('id').primaryKey(), // == auth.users.id (uuid)
  email: text('email').notNull(),
  githubUsername: text('github_username'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- Workspaces ----------

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    logo: jsonb('logo'),
    settings: jsonb('settings').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index('idx_workspaces_owner').on(t.ownerId),
  })
);

// ---------- Repositories ----------

export const repositories = pgTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceIdx: index('idx_repositories_workspace').on(t.workspaceId),
  })
);

// ---------- Integrations ----------

export const integrations = pgTable(
  'integrations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    workspaceTypeUq: uniqueIndex('uq_integrations_workspace_type').on(t.workspaceId, t.type),
  })
);

// ---------- Environments ----------

// A cloud-only environment is a secret-free marker, one per connected
// cloud provider (auto-provisioned on integration connect). It carries no
// daemon state — the `type` (a CloudProviderType) is all a task needs to
// resolve its provider; per-workspace credentials live on `integrations`.
export const environments = pgTable(
  'environments',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // CloudProviderType: 'posthog_code' (today), 'codex_cloud',
    // 'claude_routine' (planned). See docs/CLOUD_PROVIDERS.md.
    type: text('type').notNull(),
    status: text('status').notNull().default('connected'),
    config: jsonb('config').notNull(),
    lastConnected: timestamp('last_connected', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index('idx_environments_owner').on(t.ownerId),
  })
);

// ---------- Tasks ----------

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // 'code_writing' | 'pr_response' | 'pr_review'
    status: text('status').notNull().default('pending'),
    priority: text('priority').notNull().default('medium'),
    title: text('title').notNull(),
    description: text('description').notNull(),
    prompt: text('prompt'),
    // The cloud-marker env this task is delegated to (resolves its
    // provider). `set null` if the marker is removed.
    assignedEnvironmentId: text('assigned_environment_id').references(
      () => environments.id,
      { onDelete: 'set null' }
    ),
    repositoryId: text('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    branch: text('branch'),
    /**
     * JSONL event log of `AgentEvent` objects (from @fastowl/shared) —
     * the cloud run's transcript, ingested by the provider's streamer.
     */
    transcript: jsonb('transcript'),
    result: jsonb('result'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    workspaceIdx: index('idx_tasks_workspace').on(t.workspaceId),
    statusIdx: index('idx_tasks_status').on(t.status),
    repositoryIdx: index('idx_tasks_repository').on(t.repositoryId),
  })
);

// ---------- Inbox items ----------

export const inboxItems = pgTable(
  'inbox_items',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    status: text('status').notNull().default('unread'),
    priority: text('priority').notNull().default('medium'),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    source: jsonb('source').notNull(),
    actions: jsonb('actions').notNull().default([]),
    data: jsonb('data'),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
    actionedAt: timestamp('actioned_at', { withTimezone: true }),
  },
  (t) => ({
    workspaceIdx: index('idx_inbox_workspace').on(t.workspaceId),
    statusIdx: index('idx_inbox_status').on(t.status),
  })
);

// ---------- Global settings (key/value) ----------

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- Pull requests (DB-as-cache) ----------

/**
 * One row per user-authored open PR in a watched repo, plus any PR ever
 * opened by a task (kept after merge/close for filtering).
 *
 * This is a CACHE, not a source of truth — `last_polled_at` drives a
 * TTL the prCache layer enforces. Fresh row → return it; stale → fetch
 * from GitHub via the batched GraphQL helper, upsert, return.
 *
 * Only minimal fields are persisted. Per-check rows, file lists, and
 * raw GraphQL payloads are NOT stored — the detail-view tabs always
 * fetch fresh on open. Keeps row size bounded (~2 KB) and avoids an
 * "out of date forever" failure mode if the polling loop ever stalls.
 *
 * Event-cursor columns (`last_review_id`, etc.) survive backend restart
 * so review/comment/CI deltas don't false-fire after every deploy —
 * the in-memory state map the old prMonitor used baseline-reset on
 * boot, which is how a restart could lose unread events.
 */
export const pullRequests = pgTable(
  'pull_requests',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /**
     * Set when this PR was opened by a FastOwl task. Lets the task
     * screen pill render off this row, and lets the user filter
     * "merged PRs from my old tasks" on the GitHub page.
     */
    taskId: text('task_id').references(() => tasks.id, {
      onDelete: 'set null',
    }),
    owner: text('owner').notNull(),
    repo: text('repo').notNull(),
    number: integer('number').notNull(),
    state: text('state').notNull(), // 'open' | 'closed' | 'merged'
    /**
     * True when this PR is awaiting the connected user's review: they're a
     * requested reviewer (directly or via a team) AND haven't reviewed it
     * yet. The monitor reconciles this every poll, so it clears once the
     * user submits a review — which is what keeps an approved PR off the
     * GitHub page's "Review" list even when GitHub leaves a team review
     * request standing.
     */
    reviewRequested: boolean('review_requested').notNull().default(false),
    /**
     * True when the PR was opened by the connected user. Drives the "Mine"
     * tab independently of {@link reviewRequested} (a PR can be neither —
     * e.g. one the user already reviewed — and then belongs to neither tab).
     */
    authored: boolean('authored').notNull().default(false),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    /**
     * Drives the TTL: prCache returns this row if `last_polled_at` is
     * within the focused (30s) or unfocused (60s) window. Bumped on
     * every successful poll, regardless of whether anything changed.
     */
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Lightweight summary for instant rendering on the GitHub page +
     * task pill. Shape:
     *   {
     *     title, author, draft,
     *     headBranch, baseBranch, headSha, updatedAt,
     *     mergeable, mergeStateStatus, reviewDecision,
     *     blockingReason: 'mergeable' | 'merge_conflicts'
     *                   | 'changes_requested' | 'checks_failed'
     *                   | 'checks_failed_optional' | 'blocked' | 'unknown',
     *     checksTotal, checksPassed, checksFailed,
     *     checksInProgress, checksSkipped
     *   }
     */
    lastSummary: jsonb('last_summary').notNull().default({}),
    /**
     * When true, a background watcher keeps this PR mergeable: it repeatedly
     * fires a cloud "fix every blocker" run whenever the PR has a blocker and
     * no run is in flight, indefinitely — including conflicts that surface days
     * later. Survives backend restarts (the watch can span days).
     */
    autoKeepMergeable: boolean('auto_keep_mergeable').notNull().default(false),
    /**
     * Watcher bookkeeping for the runaway guard. Shape:
     *   {
     *     attempts: number,        // consecutive auto-runs that left it un-mergeable
     *     lastAutoTaskId?: string, // the run the watcher most recently launched
     *     accounted?: boolean,     // whether lastAutoTaskId's result was folded in
     *     pausedAt?: string        // ISO time we paused after 3 failed attempts
     *   }
     * `attempts` resets to 0 once the PR is observed mergeable, so a problem
     * that appears after a clean state gets a fresh batch of attempts.
     */
    autoMergeState: jsonb('auto_merge_state'),
    // Event cursors — NULL until the first poll has populated them.
    lastReviewId: text('last_review_id'),
    lastReviewCommentId: text('last_review_comment_id'),
    lastCommentId: text('last_comment_id'),
    /**
     * Hash of `head_sha + sorted check states` — bumps whenever a
     * push lands or any check transitions. Cheaper than diffing the
     * whole rollup payload.
     */
    lastCheckDigest: text('last_check_digest'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One row per (workspace, repo, number). Upsert key for the
    // poller — same PR seen twice in one tick must not double-insert.
    workspaceRepoNumberUq: uniqueIndex('uq_pull_requests_workspace_repo_number').on(
      t.workspaceId,
      t.repositoryId,
      t.number
    ),
    workspaceIdx: index('idx_pull_requests_workspace').on(t.workspaceId),
    repositoryIdx: index('idx_pull_requests_repository').on(t.repositoryId),
    taskIdx: index('idx_pull_requests_task').on(t.taskId),
    // Drives the scheduler's "fetch the stalest PR first" policy.
    stateLastPolledIdx: index('idx_pull_requests_state_last_polled').on(
      t.state,
      t.lastPolledAt
    ),
  })
);
