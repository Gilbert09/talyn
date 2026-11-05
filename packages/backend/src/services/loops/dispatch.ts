import {
  boxRefusalReason,
  fleetAgentForModel,
  resolveFleetModel,
  type LoopRunFailureCode,
} from '@talyn/shared';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { users as usersTable, workspaces as workspacesTable } from '../../db/schema.js';
import { isBoxGateError } from '../billing/entitlements.js';
import { deferralRetryAt } from '../billing/boxDeferral.js';
import { getCloudProvider } from '../cloudProviders/registry.js';
import { fleetRefusalReason, workspaceMayUseFleet } from '../cloudProviders/fleetAccess.js';
import { fleetAgentStatus } from '../selfHosted/credentials.js';
import { envIdForType } from '../prCloudFix.js';
import { createCloudTask } from '../taskCreate.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { workspaceMayUseLoops } from '../loopsAccess.js';
import { createWorkbench } from '../workbenches/create.js';
import { WorkbenchError } from '../workbenches/errors.js';
import {
  markDispatched,
  markSessionDispatched,
  providerOf,
  settleRun,
  targetOf,
  type DueLoop,
} from './runs.js';

/**
 * One claimed firing → one cloud task or sandbox session.
 *
 * Shared by the scheduler and the "Run now" route, so a manual run and a
 * scheduled one are the same code path: a manual run that behaved differently
 * would be a test of something the schedule never does.
 *
 * # Nothing here throws
 *
 * Every refusal settles the run with a machine-readable `failureCode` and
 * returns. A loop that cannot run must say so in its history — the history is
 * the only place a person will ever look, and a schedule that silently stops is
 * indistinguishable from one that was never set up.
 *
 * # A pinned provider is never failed over
 *
 * `resolveCloudEnvChain` walks providers in preference order, and that is right
 * for "fix this PR somehow" — a fleet at capacity should degrade to PostHog
 * Code rather than fail the user's work. It is wrong here. A loop names its
 * provider, and somebody who chose Talyn Fleet chose it because it runs on
 * their own subscription with their own credential custody. Quietly moving that
 * work onto metered PostHog credits at 3am is a bill they did not agree to.
 */

export type DispatchOutcome =
  | { ok: true; taskId?: string; sessionId?: string }
  | { ok: false; status: 'failed' | 'waiting_slot' | 'skipped'; code: LoopRunFailureCode };

/** A refusal that settles the run and hands the caller the shape back. */
async function refuse(
  runId: string,
  status: 'failed' | 'waiting_slot' | 'skipped',
  code: LoopRunFailureCode,
  error: string,
  retryAfter?: Date
): Promise<DispatchOutcome> {
  await settleRun(runId, { status, failureCode: code, error, retryAfter: retryAfter ?? null });
  return { ok: false, status, code };
}

/**
 * Check the things that can change AFTER a loop is saved.
 *
 * All three were verified when the loop was written, and all three can be taken
 * away without anything touching the row: a flag audience changes, a
 * subscription is revoked, a repository is disconnected. Re-checking at fire
 * time is what turns "the loop mysteriously stopped" into a run that says why.
 */
async function resolveTarget(
  loop: DueLoop,
  runId: string
): Promise<{ envId?: string; model: string } | DispatchOutcome> {
  if (!(await workspaceMayUseLoops(loop.workspaceId))) {
    return refuse(
      runId,
      'failed',
      'loops_not_allowed',
      'This workspace is no longer in the audience for Loops.'
    );
  }

  if (!loop.repositoryId) {
    return refuse(
      runId,
      'skipped',
      'repo_missing',
      `${loop.repoFullName} is no longer connected to this workspace.`
    );
  }

  const provider = providerOf(loop);
  if (!getCloudProvider(provider)) {
    return refuse(
      runId,
      'failed',
      'environment_missing',
      `${provider} is not available on this deployment.`
    );
  }

  if (provider === 'selfhosted') {
    if (!(await workspaceMayUseFleet(loop.workspaceId))) {
      return refuse(runId, 'failed', 'fleet_not_allowed', `Talyn Fleet is unavailable: ${fleetRefusalReason()}.`);
    }
    // The model carries the vendor, so the agent to check is the one the model
    // implies. Offering a run on a subscription the workspace has disconnected
    // would fail at the gateway with a much less legible error.
    const agent = fleetAgentForModel(loop.model);
    const { connectedAgents } = await fleetAgentStatus(loop.workspaceId);
    if (!connectedAgents.includes(agent)) {
      return refuse(
        runId,
        'failed',
        'agent_not_connected',
        `Talyn Fleet has no ${agent === 'codex' ? 'Codex' : 'Claude'} subscription connected.`
      );
    }
  }

  // A stored fleet id can be retired out from under a loop (OpenAI withdraws
  // models from the ChatGPT sign-in path on its own schedule), and dispatching
  // at a dead id is a 400 every firing until somebody edits the loop.
  const model = provider === 'selfhosted' ? resolveFleetModel(loop.model) : loop.model;
  if (targetOf(loop) === 'session') return { model };

  const envId = await envIdForType(loop.workspaceId, provider);
  if (!envId) {
    return refuse(
      runId,
      'failed',
      'environment_missing',
      `No ${provider} credentials are connected to this workspace.`
    );
  }
  return { envId, model };
}

/** The title a loop's task carries — the loop's name, plus which firing it is. */
function titleFor(loop: DueLoop, scheduledFor: Date): string {
  const when = scheduledFor.toISOString().slice(0, 16).replace('T', ' ');
  return `${loop.name} — ${when}`;
}

async function workspaceOwner(workspaceId: string): Promise<{ id: string; email: string } | null> {
  const rows = await getDbClient()
    .select({ id: usersTable.id, email: usersTable.email })
    .from(workspacesTable)
    .innerJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

function failureForSessionError(err: WorkbenchError): LoopRunFailureCode {
  if (err.code === 'flag_off') return 'sessions_not_allowed';
  if (err.code === 'fleet_not_allowed' || err.code === 'fleet_disabled' || err.code === 'fleet_not_deployed') {
    return 'fleet_not_allowed';
  }
  if (err.code === 'agent_not_connected' || err.code === 'agent_reauth_required') {
    return 'agent_not_connected';
  }
  return 'dispatch_failed';
}

/**
 * Create the task or session for a claimed run.
 *
 * The run stays `queued` on success: the task row is inserted as `queued` too,
 * and `task:status` is what moves the run to `running`. Writing `running` here
 * would claim the agent had started before the dispatcher had even seen it.
 */
export async function dispatchRun(
  loop: DueLoop,
  runId: string,
  scheduledFor: Date
): Promise<DispatchOutcome> {
  const target = await resolveTarget(loop, runId);
  if ('ok' in target) return target;

  try {
    if (targetOf(loop) === 'session') {
      const owner = await workspaceOwner(loop.workspaceId);
      if (!owner) return refuse(runId, 'failed', 'dispatch_failed', 'The workspace owner no longer exists.');
      const session = await createWorkbench(
        {
          workspaceId: loop.workspaceId,
          repositoryId: loop.repositoryId as string,
          runtime: 'sandbox',
          agent: fleetAgentForModel(target.model),
          model: target.model,
          prompt: loop.prompt,
          namingText: loop.name,
          internetAccess: loop.internetAccess,
          autoCreatePr: true,
          source: { kind: 'loop', loopId: loop.id, runId },
        },
        owner
      );
      const chatId = session.chats?.[0]?.id;
      if (!chatId) throw new Error('The session was created without a chat.');
      await markSessionDispatched(runId, session.id, chatId);
      return { ok: true, sessionId: session.id };
    }

    const task = await createCloudTask({
      workspaceId: loop.workspaceId,
      type: 'code_writing',
      source: 'loop',
      title: titleFor(loop, scheduledFor),
      description: `Loop: ${loop.name}`,
      prompt: loop.prompt,
      repositoryId: loop.repositoryId as string,
      assignedEnvironmentId: target.envId as string,
      model: target.model,
      // The loop's own switch. The fleet turns it into an egress policy; every
      // other provider ignores it, which is why the editor only offers it on a
      // fleet loop.
      internetAccess: loop.internetAccess,
      mcpServerIds: loop.mcpServerIds,
      loop: { loopId: loop.id, runId, scheduledFor: scheduledFor.toISOString() },
    });
    await markDispatched(runId, task.id);
    return { ok: true, taskId: task.id };
  } catch (err) {
    if (isBoxGateError(err)) {
      // No request to answer with a 402 and no modal to open: this is the
      // server-side deferral the merge queue and the auto-keep watcher take
      // too. A loop's deferral is VISIBLE: the run row parks as
      // `waiting_slot` with the gate's own sentence and the reason, and the
      // scheduler's retry sweep looks again at `retry_after`. That is a few
      // seconds for a full box cap, and the period reset (or a quarter hour,
      // or the moment credits arrive) for used-up hours, so an exhausted
      // owner's loop does not ask on every tick. A newer firing supersedes it.
      const code = boxRefusalReason(err.code);
      captureWorkspaceEvent(loop.workspaceId, 'paywall_deferred', {
        source: 'loops',
        gate: code,
        ...(err.notice.limit !== undefined ? { limit: err.notice.limit, active: err.notice.active } : {}),
      });
      const retryAt = deferralRetryAt(err);
      // A size the plan cannot start does not clear by waiting. Unattended
      // runs are downsized before this can happen, so it is not expected.
      if (!retryAt) return refuse(runId, 'failed', code, err.message);
      return refuse(runId, 'waiting_slot', code, err.message, retryAt);
    }
    if (err instanceof WorkbenchError) {
      return refuse(runId, 'failed', failureForSessionError(err), err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    return refuse(runId, 'failed', 'dispatch_failed', message);
  }
}
