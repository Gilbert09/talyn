import { eq } from 'drizzle-orm';
import {
  defaultFleetModelForAgent,
  type FleetAgent,
  type TaskResult,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable } from '../../db/schema.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus, emitTaskUpdate } from '../websocket.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { fleetAgentStatus } from '../selfHosted/credentials.js';
import {
  agentLabel,
  exhaustedDeadEndSummary,
  failoverSummary,
  heldBackAgents,
  noteExhaustedAgent,
} from '../selfHosted/exhaustedQuota.js';
import { resolveCloudEnvChain } from '../prCloudFix.js';
import { taskQueueService } from '../taskQueue.js';
import { getCloudProvider } from './registry.js';

/**
 * Moving a run whose vendor said the subscription is spent.
 *
 * The fleet's `finalize` calls this INSTEAD of settling the task as failed,
 * when (and only when) `exhaustedAgentFrom` recognised the vendor's own
 * "you are out" sentence. Everything else still fails the ordinary way.
 *
 * # The order, and why
 *
 * The other fleet agent first, then the rest of the provider chain. The fleet
 * runs on the workspace's OWN subscriptions; PostHog Code spends metered
 * credits. Spending a subscription that is already paid for before reaching
 * for one that bills per token is the whole reason the preference exists, and
 * it is why this cannot simply hand off to `resolveCloudEnvChain` — that
 * resolver thinks in PROVIDERS, and the fleet is one provider with two agents
 * behind it. Skipping straight to the next provider would step over a
 * perfectly good Codex subscription on the way to a bill.
 *
 * Tom's call (2026-09-20): the chain runs all the way to PostHog Code, for
 * unattended work too. This narrows — deliberately — the rule that a pinned
 * provider is never failed over. That rule was written about access being
 * REVOKED, where quietly moving to metered credits hides a thing the user
 * needs to fix. An exhausted quota is a different fact: the setup is correct,
 * the month simply ran out, and the work is still wanted.
 *
 * # Never a loop
 *
 * Each hop is recorded on the task, and a hop already recorded is never tried
 * again for this run. So the worst case is one wasted sandbox boot per
 * connected agent, which is what an exhaustion costs anyway — the run dies on
 * its first API call, before it does any work.
 */

/** A hop already attempted on THIS run. Agents are `fleet:<agent>`. */
type Hop = string;

interface FailoverState {
  /** Hops tried and exhausted, oldest first. Never re-tried. */
  tried?: Hop[];
  /** The agent that ran out, for the summary on the final dead end. */
  exhausted?: FleetAgent;
  /** Where the work went, in the words the user sees. */
  movedTo?: string;
  /** The note the task shows. Lives HERE rather than in `tasks.result`,
   *  because the detail panel paints any `result.success === false` as a red
   *  "Task failed" banner whatever the status says — and this task did not
   *  fail, it moved. Same mistake the needs_human banner exists to avoid. */
  note?: string;
  /** ISO instant of the move. */
  at?: string;
}

const FLEET_HOP = (agent: FleetAgent): Hop => `fleet:${agent}`;

function readState(metadata: unknown): FailoverState {
  const raw = (metadata as Record<string, unknown> | null)?.quotaFailover;
  return raw && typeof raw === 'object' ? (raw as FailoverState) : {};
}

/**
 * Re-dispatch `taskId` somewhere its subscription is not spent, or settle it
 * failed when there is nowhere left.
 *
 * Returns true when the task was moved (the caller must NOT also settle it),
 * false when it was settled here as a dead end. Either way the task is left in
 * a coherent terminal-or-queued state — the caller's `finalize` is done with
 * it once this returns.
 */
export async function failoverExhaustedRun(opts: {
  taskId: string;
  workspaceId: string;
  /** The agent whose quota the vendor just refused. */
  exhausted: FleetAgent;
  /** The vendor's own words. Recorded as the task's `error` on a dead end,
   *  and logged on a move — a move leaves `result` null on purpose. */
  detail: string | null;
}): Promise<boolean> {
  const { taskId, workspaceId, exhausted, detail } = opts;
  const db = getDbClient();

  const rows = await db
    .select({
      metadata: tasksTable.metadata,
      assignedEnvironmentId: tasksTable.assignedEnvironmentId,
    })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) return false;

  // Remember it BEFORE choosing where to go. This is what stops the next task
  // paying the same discovery cost — dispatch reads the hold and skips the
  // spent agent without booting a microVM to be refused again.
  await noteExhaustedAgent(workspaceId, exhausted, detail);

  const state = readState(row.metadata);
  const tried = new Set<Hop>(state.tried ?? []);
  // The agent that just died counts as tried even on the first hop — the run
  // that failed IS the attempt.
  tried.add(FLEET_HOP(exhausted));

  const next = await nextHop(workspaceId, tried);
  if (!next) {
    await settleDeadEnd(taskId, workspaceId, exhausted, detail, [...tried]);
    return false;
  }

  const movedTo =
    next.kind === 'fleet'
      ? `${agentLabel(next.agent)} on Talyn Fleet`
      : (getCloudProvider(next.providerType)?.displayName ?? next.providerType);

  await patchTaskMetadata(taskId, (existing: Record<string, unknown>) => {
    const meta = { ...existing };
    // Clear the finished run's handles so dispatch starts a fresh one instead
    // of short-circuiting on an id it already knows. Same set the /retry route
    // clears, for the same reason.
    delete meta.posthogTaskId;
    delete meta.posthogRunId;
    delete meta.posthogStatus;
    delete meta.cloudTask;
    // The fleet derives its run id from (task id, attempt) and its create is
    // idempotent on it, so WITHOUT this bump the next dispatch is handed back
    // the sandbox that just died and settles instantly.
    const attempt = typeof meta.runAttempt === 'number' ? meta.runAttempt : 0;
    meta.runAttempt = (Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0) + 1;
    // A fleet hop is a MODEL change, because the model is what carries the
    // vendor — `fleetProviderForModel` reads it and the host builds the
    // microVM's egress table from it. The agent's shipped default rather than
    // a like-for-like tier: there is no honest mapping from a Claude tier to
    // an OpenAI one, and the default is the id we have grounds to trust.
    if (next.kind === 'fleet') meta.model = defaultFleetModelForAgent(next.agent);
    meta.quotaFailover = {
      tried: [...tried, next.kind === 'fleet' ? FLEET_HOP(next.agent) : next.providerType],
      exhausted,
      movedTo,
      note: failoverSummary(exhausted, movedTo),
      at: new Date().toISOString(),
    } satisfies FailoverState;
    return meta;
  });

  await db
    .update(tasksTable)
    .set({
      status: 'queued',
      // CLEARED, not set to the failover note. The task detail paints any
      // `result.success === false` as a red "Task failed" banner regardless of
      // status, so leaving a failure-shaped result on a task that is merely
      // re-queued would announce a failure that did not happen. The note lives
      // on `metadata.quotaFailover` and the panel renders it in its own right.
      result: null,
      // The dead run's log, dropped for the same reason `redispatchCloudTask`
      // drops it: what is about to be in progress is a DIFFERENT run, and a
      // transcript ending in the refusal that caused the move reads as the new
      // run's own output.
      transcript: null,
      completedAt: null,
      // A provider hop moves the env marker; a fleet hop stays on the fleet's.
      ...(next.kind === 'provider' ? { assignedEnvironmentId: next.envId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tasksTable.id, taskId));

  // `queued`, not a terminal status — the run is not over, it is starting
  // again somewhere else. Emitted so an open task view stops showing the
  // failed run rather than waiting for the next poll to contradict it.
  emitTaskStatus(workspaceId, taskId, 'queued', null);
  emitTaskUpdate(workspaceId, taskId, { transcript: [] });

  captureWorkspaceEvent(workspaceId, 'task_quota_failed_over', {
    task_id: taskId,
    exhausted_agent: exhausted,
    to: next.kind === 'fleet' ? `fleet:${next.agent}` : next.providerType,
  });
  console.warn(
    `[quotaFailover] task ${taskId.slice(0, 8)}: ${agentLabel(exhausted)} usage exhausted — ` +
      `moving to ${movedTo}`,
  );

  void taskQueueService.processQueue();
  return true;
}

type NextHop =
  | { kind: 'fleet'; agent: FleetAgent }
  | { kind: 'provider'; providerType: string; envId: string };

/**
 * Where the work goes next, or null when nothing is left.
 *
 * The fleet's OTHER connected agent first — same hardware, same custody, a
 * subscription the workspace has already paid for. An agent needing reauth is
 * skipped: its credential exists but the vendor will not renew it, so moving
 * an exhausted run onto it trades one dead end for another.
 */
async function nextHop(workspaceId: string, tried: Set<Hop>): Promise<NextHop | null> {
  const { connectedAgents, reauthAgents } = await fleetAgentStatus(workspaceId).catch(() => ({
    connectedAgents: [] as FleetAgent[],
    reauthAgents: [] as FleetAgent[],
  }));
  // Held back for the WORKSPACE, not just tried on this run: another task may
  // have discovered this agent was spent minutes ago, and moving onto it now
  // would buy one more refusal.
  const held = await heldBackAgents(workspaceId).catch(() => ({}) as Record<string, unknown>);
  for (const agent of connectedAgents) {
    if (tried.has(FLEET_HOP(agent))) continue;
    if (reauthAgents.includes(agent)) continue;
    if (held[agent]) continue;
    return { kind: 'fleet', agent };
  }

  // Then the rest of the chain, fleet excluded — every fleet agent worth
  // trying has been by now, and re-entering the fleet here would dispatch at
  // whichever model the ladder picks, including the one that just ran out.
  const chain = await resolveCloudEnvChain(workspaceId);
  for (const link of chain) {
    if (link.provider === 'selfhosted') continue;
    if (tried.has(link.provider)) continue;
    return { kind: 'provider', providerType: link.provider, envId: link.envId };
  }
  return null;
}

/**
 * Nowhere left to go: settle failed, saying so in terms that name the fix.
 *
 * Deliberately `failed` and not `needs_human`. `needs_human` means the AGENT
 * stopped and handed back a judgement call; this run never started, and
 * reading it as a refusal would put a question in front of the user that no
 * answer of theirs resolves.
 */
async function settleDeadEnd(
  taskId: string,
  workspaceId: string,
  exhausted: FleetAgent,
  detail: string | null,
  tried: Hop[],
): Promise<void> {
  const result: TaskResult = {
    success: false,
    summary: exhaustedDeadEndSummary(exhausted),
    error: detail || `${agentLabel(exhausted)} usage exhausted; no provider left to move to`,
  };
  const now = new Date();
  await getDbClient()
    .update(tasksTable)
    .set({ status: 'failed', result, completedAt: null, updatedAt: now })
    .where(eq(tasksTable.id, taskId));
  emitTaskStatus(workspaceId, taskId, 'failed', result);
  captureWorkspaceEvent(workspaceId, 'task_quota_dead_end', {
    task_id: taskId,
    exhausted_agent: exhausted,
    tried_count: tried.length,
  });
  console.warn(
    `[quotaFailover] task ${taskId.slice(0, 8)}: ${agentLabel(exhausted)} usage exhausted and ` +
      `nowhere to move it (tried ${tried.join(', ')})`,
  );
}
