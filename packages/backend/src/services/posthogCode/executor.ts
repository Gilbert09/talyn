import { eq } from 'drizzle-orm';
import type { Environment, PostHogCodeRuntimeAdapter, Task } from '@fastowl/shared';
import { getDbClient } from '../../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../../db/schema.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus } from '../websocket.js';
import { getPostHogCodeClient, getPostHogCodeCredentials } from './credentials.js';
import { postHogCodeStreamer } from './streamer.js';
import { DEFAULT_POSTHOG_CODE_MODEL } from './client.js';

const DEFAULT_RUNTIME_ADAPTER: PostHogCodeRuntimeAdapter = 'claude';

export type DispatchResult = { ok: true } | { ok: false; error: string };

/**
 * Hand a task off to PostHog Code: create the remote task, start a
 * background run, and stash the remote ids on `task.metadata`. The
 * cloud owns the agent loop from here — the poller (poller.ts) drives
 * the FastOwl task through to `completed` / `failed`.
 *
 * Idempotent: if the task already carries a `posthogTaskId`, we assume a
 * prior dispatch succeeded and do nothing (the poller owns it).
 */
export async function dispatchTaskToPostHogCode(
  task: Task,
  env: Environment,
): Promise<DispatchResult> {
  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  const existingTaskId =
    typeof meta.posthogTaskId === 'string' && meta.posthogTaskId
      ? meta.posthogTaskId
      : undefined;
  const existingRunId =
    typeof meta.posthogRunId === 'string' && meta.posthogRunId
      ? meta.posthogRunId
      : undefined;
  // Only treat the dispatch as done once a run actually started. A task whose
  // remote task was created but whose `startRun` then failed (e.g. the model
  // validation error) has a `posthogTaskId` but no `posthogRunId` — re-running
  // below reuses that remote task and starts the run rather than wedging
  // forever on this guard.
  if (existingTaskId && existingRunId) {
    return { ok: true };
  }

  const creds = await getPostHogCodeCredentials(task.workspaceId);
  const client = await getPostHogCodeClient(task.workspaceId);
  if (!creds || !client) {
    return {
      ok: false,
      error:
        'PostHog Code is not configured for this workspace — add an API key and project id in workspace settings.',
    };
  }

  if (!task.repositoryId) {
    return { ok: false, error: 'PostHog Code tasks require a repository.' };
  }
  const repository = await resolveRepositorySlug(task.repositoryId);
  if (!repository) {
    return {
      ok: false,
      error: 'Could not resolve a GitHub owner/repo for this task’s repository.',
    };
  }

  const runtimeAdapter =
    (meta.runtimeAdapter as PostHogCodeRuntimeAdapter | undefined) ??
    runtimeAdapterFromEnv(env) ??
    DEFAULT_RUNTIME_ADAPTER;
  // The API requires a model on every cloud run, so resolve to a concrete one:
  // task-level (UI) → env default → the backend default.
  const model =
    (typeof meta.model === 'string' && meta.model) ||
    modelFromEnv(env) ||
    DEFAULT_POSTHOG_CODE_MODEL;

  const description = task.prompt?.trim() || task.description?.trim() || task.title;

  try {
    // Reuse a remote task from a prior attempt that failed before starting a
    // run (idempotent: avoids orphaning a fresh empty task each retry).
    let remoteTaskId = existingTaskId;
    if (!remoteTaskId) {
      const remoteTask = await client.createTask({
        title: task.title,
        description,
        repository,
      });
      remoteTaskId = remoteTask.id;

      // Record the remote task id before starting the run so a failure
      // mid-flight doesn't strand us into re-creating a duplicate task.
      await patchTaskMetadata(task.id, (existing) => ({
        ...existing,
        posthogTaskId: remoteTask.id,
        posthogProjectId: creds.projectId,
        posthogHost: creds.host,
        posthogStatus: 'not_started',
      }));
    }

    // `run/` returns the task; the new run is on `latest_run`. Its
    // `latest_run.id` (NOT the returned `id`, which is the task id) is the
    // run id the logs/stream endpoints are keyed on.
    const startedTask = await client.startRun(remoteTaskId, { runtimeAdapter, model });
    const startedRun = startedTask.latest_run ?? null;
    const runId = startedRun?.id;

    await patchTaskMetadata(task.id, (existing) => ({
      ...existing,
      posthogRunId: runId ?? existing.posthogRunId,
      posthogStatus: startedRun?.status ?? 'queued',
      posthogLogUrl: startedRun?.log_url ?? existing.posthogLogUrl,
    }));

    // Pin the env + flip to in_progress so the UI stops showing it as
    // queued. The poller takes it from here.
    await getDbClient()
      .update(tasksTable)
      .set({
        status: 'in_progress',
        assignedEnvironmentId: env.id,
        updatedAt: new Date(),
      })
      .where(eq(tasksTable.id, task.id));
    emitTaskStatus(task.workspaceId, task.id, 'in_progress');

    // Start streaming the run's logs into the transcript right away so
    // the task terminal shows progress without waiting for the poller's
    // first tick. If the run id isn't on the response yet, the poller
    // picks it up from `latest_run` on its next tick.
    if (runId) {
      postHogCodeStreamer.ensure({
        taskId: task.id,
        workspaceId: task.workspaceId,
        posthogTaskId: remoteTaskId,
        posthogRunId: runId,
      });
    }

    console.log(
      `[posthogCode] task ${task.id.slice(0, 8)} → remote task ${remoteTaskId} run ${runId ?? '(pending)'} (${repository})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function resolveRepositorySlug(repositoryId: string): Promise<string | null> {
  const rows = await getDbClient()
    .select({ url: repositoriesTable.url, name: repositoriesTable.name })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.id, repositoryId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return parseGitHubSlug(row.url) ?? sanitizeSlug(row.name);
}

function parseGitHubSlug(url: string): string | null {
  const match = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
}

function sanitizeSlug(name: string): string | null {
  // Repository.name is conventionally "owner/repo" already.
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : null;
}

function runtimeAdapterFromEnv(env: Environment): PostHogCodeRuntimeAdapter | undefined {
  const config = env.config as { runtimeAdapter?: PostHogCodeRuntimeAdapter };
  return config?.runtimeAdapter;
}

function modelFromEnv(env: Environment): string | undefined {
  const config = env.config as { model?: string };
  return config?.model;
}
