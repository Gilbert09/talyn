import { eq } from 'drizzle-orm';
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
