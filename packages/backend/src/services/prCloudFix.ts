// Shared helpers for the two background services that fire a cloud
// "take this PR to a clean, mergeable state" run: the auto-keep-mergeable
// watcher (prAutoMergeWatcher) and the merge queue (mergeQueueProcessor).
//
// Both need the same two lookups — which cloud env to dispatch to, and whether
// the PR's linked task is still working — so they live here to avoid drift.

import { and, eq } from 'drizzle-orm';
import type { CloudProviderType } from '@fastowl/shared';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  workspaces as workspacesTable,
  environments as environmentsTable,
} from '../db/schema.js';
import { getCloudProvider } from './cloudProviders/registry.js';

/** Task statuses that mean a run is still working the PR. */
export const ACTIVE_STATUSES = new Set(['pending', 'queued', 'in_progress']);

/** The workspace owner's PostHog Code env marker, or null if none. */
export async function resolvePostHogEnvId(workspaceId: string): Promise<string | null> {
  return envIdForType(workspaceId, 'posthog_code');
}

/** The auto-provisioned env marker of a given provider type for a workspace
 *  (env markers are per-owner; credentials are per-workspace). */
async function envIdForType(
  workspaceId: string,
  type: CloudProviderType
): Promise<string | null> {
  const rows = await getDbClient()
    .select({ envId: environmentsTable.id })
    .from(workspacesTable)
    .innerJoin(
      environmentsTable,
      and(
        eq(environmentsTable.ownerId, workspacesTable.ownerId),
        eq(environmentsTable.type, type)
      )
    )
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return rows[0]?.envId ?? null;
}

/** Deterministic fallback order when no specific default is pinned (or it isn't
 *  connected): PostHog Code first for back-compat, then Claude Code. */
const CLOUD_PROVIDER_ORDER: CloudProviderType[] = ['posthog_code', 'claude_code'];

async function defaultCloudProvider(
  workspaceId: string
): Promise<CloudProviderType | 'ask' | null> {
  const rows = await getDbClient()
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const settings = (rows[0]?.settings as { defaultCloudProvider?: CloudProviderType | 'ask' } | null) ?? {};
  return settings.defaultCloudProvider ?? null;
}

/**
 * The cloud env a backend-initiated fix task (auto-keep-mergeable watcher,
 * merge-queue auto-fix) should dispatch to. Honours the workspace's
 * `defaultCloudProvider` setting — a specific provider wins when it's connected,
 * otherwise (or for `'ask'`/unset) we fall back through {@link
 * CLOUD_PROVIDER_ORDER} since background tasks can't prompt. A provider counts
 * as usable only when it has stored credentials AND an env marker. Null when
 * none qualify.
 */
export async function resolveCloudEnvId(workspaceId: string): Promise<string | null> {
  const pinned = await defaultCloudProvider(workspaceId);
  const order: CloudProviderType[] =
    pinned && pinned !== 'ask'
      ? [pinned, ...CLOUD_PROVIDER_ORDER.filter((t) => t !== pinned)]
      : CLOUD_PROVIDER_ORDER;

  for (const type of order) {
    const provider = getCloudProvider(type);
    if (!provider) continue;
    if (!(await provider.hasCredentials(workspaceId))) continue;
    const envId = await envIdForType(workspaceId, type);
    if (envId) return envId;
  }
  return null;
}

/** Current status of the PR's most-recently-linked task, or null. */
export async function linkedTaskStatus(taskId: string | null): Promise<string | null> {
  if (!taskId) return null;
  const db = getDbClient();
  const rows = await db
    .select({ status: tasksTable.status })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return rows[0]?.status ?? null;
}
