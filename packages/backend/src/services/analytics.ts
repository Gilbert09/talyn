import { eq } from 'drizzle-orm';
import {
  isTaskSource,
  type AnyCloudProviderType,
  type TaskResult,
  type TaskStatus,
} from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import { workspaces as workspacesTable } from '../db/schema.js';
import { debugBus } from './debugBus.js';

/**
 * Server-side product analytics (PostHog capture API).
 *
 * The renderer only sees what happens while the window is open — a cloud
 * task that finishes overnight is invisible to it. The backend owns the
 * authoritative task transitions (dispatch, terminal states, PR linking),
 * so lifecycle outcomes are captured here and attributed to the workspace
 * owner (the same Supabase user id the renderer identifies with, so both
 * sides land on one person profile).
 *
 * Deliberately NOT posthog-node: a single `fetch` per event keeps the
 * call inside our outbound-HTTP funnel (debugBus) per the debug-tooling
 * rules, and we need none of the SDK's flag/batching machinery at this
 * volume (a few events per task).
 *
 * Disabled unless TALYN_POSTHOG_KEY is set (same project key the
 * desktop build bakes in). Failures are swallowed — analytics must never
 * break task processing.
 */

function config(): { key: string; host: string } | null {
  const key = process.env.TALYN_POSTHOG_KEY || '';
  if (!key) return null;
  const host = (process.env.TALYN_POSTHOG_HOST || 'https://us.i.posthog.com').replace(
    /\/+$/,
    '',
  );
  return { key, host };
}

export function isServerAnalyticsConfigured(): boolean {
  return config() !== null;
}

/** workspaceId → ownerId. Ownership never changes, so cache forever. */
const ownerCache = new Map<string, string>();

async function getWorkspaceOwnerId(workspaceId: string): Promise<string | null> {
  const cached = ownerCache.get(workspaceId);
  if (cached) return cached;
  try {
    const rows = await getDbClient()
      .select({ ownerId: workspacesTable.ownerId })
      .from(workspacesTable)
      .where(eq(workspacesTable.id, workspaceId))
      .limit(1);
    const ownerId = rows[0]?.ownerId ?? null;
    if (ownerId) ownerCache.set(workspaceId, ownerId);
    return ownerId;
  } catch {
    return null;
  }
}

/** Tests: drop the workspace→owner cache between cases. */
export function resetAnalyticsCacheForTests(): void {
  ownerCache.clear();
}

/**
 * Capture one event against an explicit distinct id. Fire-and-forget:
 * resolves once the POST settles, never throws.
 */
export async function captureServerEvent(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const cfg = config();
  if (!cfg) return;
  const url = `${cfg.host}/i/v0/e/`;
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: cfg.key,
        event,
        distinct_id: distinctId,
        timestamp: new Date().toISOString(),
        properties: {
          $lib: 'fastowl-backend',
          environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
          ...properties,
        },
      }),
    });
    debugBus.recordHttp({
      service: 'posthog_analytics',
      method: 'POST',
      url,
      status: res.status,
      durationMs: Date.now() - startedAt,
      ok: res.ok,
      ...(res.ok ? {} : { error: `capture failed (${res.status})` }),
    });
  } catch (err) {
    debugBus.recordHttp({
      service: 'posthog_analytics',
      method: 'POST',
      url,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Capture one event attributed to a workspace's owner. The common entry
 * point for task-lifecycle events (call sites know the workspace, not the
 * user). `workspace_id` is stamped on automatically. Fire-and-forget.
 */
export function captureWorkspaceEvent(
  workspaceId: string,
  event: string,
  properties: Record<string, unknown> = {},
): void {
  if (!isServerAnalyticsConfigured()) return;
  void getWorkspaceOwnerId(workspaceId)
    .then((ownerId) => {
      if (!ownerId) return;
      return captureServerEvent(ownerId, event, {
        workspace_id: workspaceId,
        ...properties,
      });
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.warn(`[analytics] capture "${event}" failed:`, msg);
    });
}

/**
 * Capture the one-and-only-once `signup` for a brand-new account.
 *
 * The clients fire `logged_in` on every sign-in, which cannot answer "how
 * many people started using Talyn this week" — a returning user and a new
 * one look identical. Before this, the only source of that number was
 * `SELECT count(*) FROM users WHERE created_at > …`, which no funnel,
 * cohort or acquisition breakdown can read.
 *
 * Fired from the ONE place a `users` row is created (the JWT-verifying
 * middleware's upsert). There is no separate sign-up endpoint to hook: the
 * account comes into existence on the first authenticated request after a
 * Supabase OAuth round-trip, so "first insert wins" is the only honest
 * definition of the moment.
 *
 * `$set` populates the person profile so a PostHog release condition can
 * target the same email the feature-flag register already keys on.
 */
export function captureSignup(user: {
  id: string;
  email: string;
  githubUsername?: string | null;
}): void {
  if (!isServerAnalyticsConfigured()) return;
  void captureServerEvent(user.id, 'signup', {
    $set: {
      email: user.email,
      github_username: user.githubUsername ?? null,
    },
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn('[analytics] capture "signup" failed:', msg);
  });
}

/**
 * The terminal task event's name. Three-way, not two: folding a refusal into
 * `task_failed` is what made that class of stop invisible in the funnels.
 *
 * Shared by both pollers so the split cannot drift between providers — the
 * ternary used to be written out twice, identically, with the reasoning
 * duplicated in both comments.
 */
export function taskOutcomeEventName(
  status: TaskStatus
): 'task_completed' | 'task_needs_human' | 'task_failed' {
  if (status === 'completed') return 'task_completed';
  if (status === 'needs_human') return 'task_needs_human';
  return 'task_failed';
}

/**
 * The property bag every terminal task event carries, whichever provider ran it.
 *
 * Pure on purpose. Each poller has already read the task row for its own
 * reasons (the fleet's clears a stale quota hold off it), so a helper that did
 * its own read would cost a second round trip per settled task to learn what
 * the caller is holding.
 *
 * `source` and `duration_run_ms` are the two that make this answer questions.
 * Without `source`, `task_type` is all there is, and `pr_response` covers the
 * auto-keep watcher, the merge queue, the Fix button and a workflow action
 * alike — so "how long do the CI-fix runs take" could only be asked of the
 * task TITLE in SQL. Without `duration_run_ms` the fleet's runs could not be
 * compared with PostHog Code's at all: `duration_total_ms` includes the queue
 * wait, and only one provider was sending the run figure.
 */
export function taskOutcomeProperties(input: {
  taskId: string;
  taskType: string;
  provider: AnyCloudProviderType;
  status: TaskStatus;
  result: TaskResult;
  createdAt: Date;
  finishedAt: Date;
  metadata: Record<string, unknown>;
  /** `repositories.name` ("PostHog/posthog"), when the row named one. */
  repository?: string | null;
  /** The model that actually ran, when the provider records one. */
  model?: string | null;
  /** True when the run linked a pull request. */
  openedPr: boolean;
  /** Provider-specific extras — the fleet's `cost_usd`, and nothing else today. */
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  // Written at dispatch, so it is absent on a task that failed before one —
  // which is exactly when a run duration would be a lie rather than a gap.
  const dispatchedAtMs = Date.parse(String(input.metadata.dispatchedAt ?? ''));
  const source = input.metadata.source;
  return {
    task_id: input.taskId,
    task_type: input.taskType,
    provider: input.provider,
    // Absent rather than 'unknown' on a row written before sources existed:
    // a property that is missing can be excluded from a breakdown, whereas a
    // bucket named "unknown" silently mixes old rows in with genuinely
    // untagged ones.
    ...(isTaskSource(source) ? { source } : {}),
    ...(input.repository ? { repository: input.repository } : {}),
    ...(input.model ? { model: input.model } : {}),
    opened_pr: input.openedPr,
    duration_total_ms: input.finishedAt.getTime() - input.createdAt.getTime(),
    ...(Number.isNaN(dispatchedAtMs)
      ? {}
      : { duration_run_ms: input.finishedAt.getTime() - dispatchedAtMs }),
    ...(input.result.error ? { error_reason: input.result.error } : {}),
    ...(input.extra ?? {}),
  };
}
