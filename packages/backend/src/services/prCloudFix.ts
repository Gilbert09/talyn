// Shared helpers for the two background services that fire a cloud
// "take this PR to a clean, mergeable state" run: the auto-keep-mergeable
// watcher (prAutoMergeWatcher) and the merge queue (mergeQueueProcessor).
//
// Both need the same two lookups — which cloud env to dispatch to, and whether
// the PR's linked task is still working — so they live here to avoid drift.

import { and, eq } from 'drizzle-orm';
import {
  buildMergeablePrompt,
  type CloudProviderType,
  type PRMergeableSummary,
} from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import {
  tasks as tasksTable,
  workspaces as workspacesTable,
  environments as environmentsTable,
} from '../db/schema.js';
import { getCloudProvider } from './cloudProviders/registry.js';
import { createCloudTask } from './taskCreate.js';

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

/** A resolved cloud target: which env marker to dispatch to, and the provider
 *  type behind it (so the caller can build a provider-appropriate prompt). */
export interface ResolvedCloudEnv {
  envId: string;
  provider: CloudProviderType;
}

/**
 * The cloud env a backend-initiated fix task (auto-keep-mergeable watcher,
 * merge-queue auto-fix) should dispatch to, plus the provider behind it. Honours
 * the workspace's `defaultCloudProvider` setting — a specific provider wins when
 * it's connected, otherwise (or for `'ask'`/unset) we fall back through {@link
 * CLOUD_PROVIDER_ORDER} since background tasks can't prompt. A provider counts as
 * usable only when it has stored credentials AND an env marker. Null when none
 * qualify.
 */
export async function resolveCloudEnv(workspaceId: string): Promise<ResolvedCloudEnv | null> {
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
    if (envId) return { envId, provider: type };
  }
  return null;
}

/** Env-id-only convenience over {@link resolveCloudEnv}. */
export async function resolveCloudEnvId(workspaceId: string): Promise<string | null> {
  return (await resolveCloudEnv(workspaceId))?.envId ?? null;
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

/** Minimal PR shape needed to fire a "get mergeable" run. */
export interface PrFixRow {
  id: string;
  workspaceId: string;
  repositoryId: string;
  owner: string;
  repo: string;
  number: number;
  lastSummary: unknown;
}

export type PrFixResult =
  | { ok: true; task: Awaited<ReturnType<typeof createCloudTask>> }
  | { ok: false; reason: 'no_cloud_provider' };

/**
 * The canonical "fix this PR" action — the one the desktop fix button, the
 * merge-queue, and the auto-keep-mergeable watcher all express: resolve the
 * workspace's cloud provider, build FastOwl's STANDARD `buildMergeablePrompt`,
 * and queue a `pr_response` task linked to the PR. Callers pass only the PR
 * row; everything (provider, env, prompt) is derived. Returns `no_cloud_provider`
 * when the workspace has no connected provider to dispatch to.
 */
export async function startPrMergeableRun(
  row: PrFixRow,
  opts: { title?: string; description?: string; model?: string } = {}
): Promise<PrFixResult> {
  const resolved = await resolveCloudEnv(row.workspaceId);
  if (!resolved) return { ok: false, reason: 'no_cloud_provider' };
  const { envId, provider } = resolved;

  const summary = (row.lastSummary ?? {}) as PRMergeableSummary;
  const ref = `${row.owner}/${row.repo}#${row.number}`;
  const prTitle = (summary as { title?: string }).title ?? '';

  const task = await createCloudTask({
    workspaceId: row.workspaceId,
    type: 'pr_response',
    title: opts.title ?? `Get ${ref} mergeable`,
    description:
      opts.description ?? `Take ${ref} ("${prTitle}") to a clean, mergeable state.`,
    prompt: buildMergeablePrompt({
      owner: row.owner,
      repo: row.repo,
      number: row.number,
      summary,
      provider,
    }),
    repositoryId: row.repositoryId,
    assignedEnvironmentId: envId,
    pullRequestId: row.id,
    model: opts.model,
  });
  return { ok: true, task };
}
