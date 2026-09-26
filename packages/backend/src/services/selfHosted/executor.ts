import { eq } from 'drizzle-orm';
import {
  readCloudTaskMeta,
  type CloudTaskMetadata,
  type Environment,
  type Task,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable } from '../../db/schema.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus, emitTaskUpdate } from '../websocket.js';
import { mcpServerIdsFromMetadata } from '../mcpServers/dispatch.js';
import { cloudStatusForSandbox } from './poller.js';
import { agentLabel, failoverSummary } from './exhaustedQuota.js';
import { dispatchSandboxRun, type SandboxRunHandle } from './sandboxRun.js';
import { TASK_SYSTEM_PROMPT } from './systemPrompts.js';

// Re-exported, not redeclared. A second definition of this contract is how the
// two drift: the shared one grew a `capacity` discriminator and this copy
// silently did not, so the value the fail-back routes on could not be set.
import type { DispatchResult } from '../cloudProviders/types.js';

export type { DispatchResult };

/**
 * Derive the fleet sandbox id from the task id and which RUN of it this is.
 *
 * Deterministic on purpose: the fleet is idempotent on the caller-chosen id
 * (fleet spec §11.5), so a redelivered webhook that re-dispatches the same
 * task cannot spawn a second microVM. A random id here would silently
 * double-spend. The name keeps "run": this is still the runId of the
 * credential-pull wire, and the id contract must not move with the merge.
 *
 * `attempt` is what keeps that guarantee true now a task row can be REUSED for
 * a later run at the same PR (see taskCreate's reuse path). Keyed on the task
 * id alone, a reused task asked the fleet for the id its PREVIOUS run already
 * holds — and because the create is idempotent on that id, it got that run
 * back rather than a new sandbox: an already-finished one, which the poller
 * immediately settled, so the "new" run ended the moment it started. Attempt 0
 * keeps the original format so nothing in flight moves.
 */
export function fleetRunIdForTask(taskId: string, attempt = 0): string {
  return attempt > 0 ? `talyn-${taskId}-r${attempt}` : `talyn-${taskId}`;
}

/** Which run of this task row we are dispatching — 0 for its first. */
export function fleetRunAttempt(task: { metadata?: Record<string, unknown> | null }): number {
  const raw = (task.metadata ?? {}).runAttempt;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * Hand a task to the self-hosted fleet: POST an ephemeral sandbox whose
 * initial task is the prompt, and let the fleet own the agent loop. The
 * poller drives the local task to completed / failed.
 *
 * Idempotent: a task already carrying a `cloudTask.remoteTaskId` is a no-op.
 *
 * Everything vendor-shaped — credentials, the model ladder, withdrawn models,
 * held-back subscriptions, the credential suppression policy, the uncertain-
 * dispatch retry — lives in `dispatchSandboxRun`, which the code-review
 * pipeline shares. What is left here is the part that is genuinely about a task
 * ROW: its idempotence marker, its run id, its metadata, its status and the
 * websocket traffic that follows.
 */
export async function dispatchTaskToFleet(task: Task, env: Environment): Promise<DispatchResult> {
  if (readCloudTaskMeta(task)?.remoteTaskId) return { ok: true };

  if (!task.repositoryId) {
    return { ok: false, error: 'Talyn Fleet tasks require a repository.' };
  }

  const dispatched = await dispatchSandboxRun({
    runId: fleetRunIdForTask(task.id, fleetRunAttempt(task)),
    workspaceId: task.workspaceId,
    repositoryId: task.repositoryId,
    taskType: task.type === 'pr_response' ? 'pr_response' : 'code_writing',
    prompt: task.prompt?.trim() || task.description?.trim() || task.title,
    systemPrompt: TASK_SYSTEM_PROMPT,
    // The task's own pin wins; the environment's is the rung below the
    // workspace's setting. Kept as two separate fields rather than collapsed
    // into one, because collapsing them would let an environment's model
    // outrank the workspace's choice.
    ...(modelFromTask(task) ? { model: modelFromTask(task) } : {}),
    ...(modelFromEnv(env) ? { modelFallback: modelFromEnv(env) } : {}),
    // Rides on the task rather than being read from whatever created it,
    // because a revived run must get the POSTURE IT HAD: reading the loop
    // instead would give a re-dispatch whatever the loop says today, which is a
    // different box from the one being replaced.
    internetAccess: internetAccessFromTask(task),
    mcpServerIds: mcpServerIdsFromMetadata(task.metadata),
    // No budget. Talyn has never sent the fleet a turn, spend or time cap on a
    // task run, and adding one here would be a tightening nobody asked for —
    // the caps belong to callers that can justify a number.
  });

  if (!dispatched.ok) {
    return dispatched.capacity
      ? { ok: false, error: dispatched.error, capacity: true }
      : { ok: false, error: dispatched.error };
  }

  const { sandbox, provider, model, endpoint, host, repoSlug, quotaSwap } = dispatched.handle;

  // The bookkeeping is inside a boundary of its own, and it matters that it is.
  // The sandbox is already booted by this point, so a failure here is not a
  // failure to dispatch — but `dispatch` is a provider-contract function whose
  // caller (`taskQueue.dispatchTask`) expects a `DispatchResult` and not a
  // throw. Letting one escape would take down the queue tick for every other
  // task in it. Reporting it as a plain failure is what the whole function used
  // to do when it was one big try block, and the retry is safe: the fleet create
  // is idempotent on the run id, so the next attempt re-attaches to this same
  // sandbox rather than booting a second one.
  try {
    await recordDispatch(task, env, {
      sandbox,
      provider,
      model,
      endpoint,
      host,
      repoSlug,
      quotaSwap,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  console.log(`[selfhosted] task ${task.id.slice(0, 8)} → sandbox ${sandbox.id} (${repoSlug})`);
  return { ok: true };
}

/**
 * Write what the dispatch decided onto the task row, and tell the clients.
 *
 * Separated from the dispatch itself so the failure boundary around it is
 * visible: everything here is a database write or a broadcast, and none of it
 * can un-boot the microVM that already exists.
 */
async function recordDispatch(
  task: Task,
  env: Environment,
  handle: Pick<
    SandboxRunHandle,
    'sandbox' | 'provider' | 'model' | 'endpoint' | 'host' | 'repoSlug' | 'quotaSwap'
  >,
): Promise<void> {
  const { sandbox, provider, model, endpoint, host, repoSlug, quotaSwap } = handle;

  const cloudTask: CloudTaskMetadata = {
    provider: 'selfhosted',
    remoteTaskId: sandbox.id,
    remoteRunId: sandbox.id,
    status: cloudStatusForSandbox(sandbox),
    extra: {
      repo: repoSlug,
      endpoint,
      // WHICH VENDOR THIS RUN IS SPENDING. Recorded because two other paths
      // have to agree with the choice made at dispatch: the poller re-supplies
      // an adopted sandbox's credentials, and `resolveRunCredentials` answers a
      // host that asks for them back after a restart. Both used to send the
      // Claude key unconditionally, which is a run that authenticates against
      // the wrong vendor for the rest of its deadline.
      llm: provider,
      model,
      // An authorization input, not a label: a row with no host refuses every
      // credential pull, and the run goes on failing every LLM call for the
      // rest of its deadline. It is also what the operator console's host
      // column and host filter read.
      ...(host ? { host } : {}),
    },
  };

  await patchTaskMetadata(task.id, (existing) => ({
    ...existing,
    cloudTask,
    // The task carries its own explanation when a held-back quota moved it
    // onto the other agent — the same note the run-time failover writes, so
    // one place in the UI covers both routes to a swapped vendor.
    ...(quotaSwap
      ? {
          quotaFailover: {
            ...((existing.quotaFailover as Record<string, unknown> | undefined) ?? {}),
            exhausted: quotaSwap.from,
            movedTo: `${agentLabel(quotaSwap.to)} on Talyn Fleet`,
            note: failoverSummary(quotaSwap.from, `${agentLabel(quotaSwap.to)} on Talyn Fleet`),
            at: new Date().toISOString(),
          },
        }
      : {}),
  }));
  emitTaskUpdate(task.workspaceId, task.id, {
    metadata: { cloudTask: { provider: cloudTask.provider, extra: { model } } },
  });

  await getDbClient()
    .update(tasksTable)
    .set({ status: 'in_progress', assignedEnvironmentId: env.id, updatedAt: new Date() })
    .where(eq(tasksTable.id, task.id));
  emitTaskStatus(task.workspaceId, task.id, 'in_progress');

}

function modelFromTask(task: Task): string | undefined {
  const m = (task.metadata as Record<string, unknown> | null)?.model;
  return typeof m === 'string' && m ? m : undefined;
}

/**
 * Whether this task asked for a sandbox that can reach the internet.
 *
 * Strictly `true`, never truthiness: the value arrives from a jsonb column, and
 * a string left there by an older shape must not read as a yes on the one
 * switch that opens a network.
 */
function internetAccessFromTask(task: Task): boolean {
  return (task.metadata as Record<string, unknown> | null)?.internetAccess === true;
}

function modelFromEnv(env: Environment): string | undefined {
  return (env.config as { model?: string } | null)?.model;
}
