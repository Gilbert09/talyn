import type { WorkflowAction, WorkflowActionOutcome } from '@talyn/shared';
import { guardCrossReplica } from '../advisoryLock.js';
import { runWithoutScope } from '../../db/client.js';
import { debugBus } from '../debugBus.js';
import { githubRateGate } from '../githubRateGate.js';
import { githubService } from '../github.js';
import { TickGuard } from '../tickGuard.js';
import { workflowsEnabled } from '../workflowsAccess.js';
import { runWorkflowActions } from './actions.js';
import { workflowFactsFromRun } from './facts.js';
import { dueRetries, isRetryable, MAX_RETRY_ATTEMPTS, settlementFor, settleRun } from './runs.js';
import { getWorkflow } from './store.js';
import { emitWorkflowRun } from '../websocket.js';
import { ownerOfWorkspace } from './owner.js';

/**
 * Re-runs workflow actions that GitHub rate-limited.
 *
 * # Why this exists
 *
 * A workflow action that hit a long rate-limit gate used to settle `failed` and
 * stop there. The delivery was consumed, and the unique
 * `(workflow_id, delivery_id)` index made a redelivery a no-op — so alone among
 * this codebase's subsystems, nothing ever tried again. Four PRs on
 * PostHog/posthog lost their labels in one burst to gates of 128–163s, which is
 * two minutes of patience away from working.
 *
 * # Why it is a sweep and not a wait
 *
 * The obvious fix is to sleep until the gate clears. It is the wrong one: these
 * run in the webhook worker's six-wide slow lane, and the gate is per ACCOUNT —
 * so a burst of four PRs from one org would block four of the six slots on the
 * same wait, with PR refreshes queued behind them. Parking the run costs a row
 * update and frees the worker immediately.
 *
 * It also survives what a wait cannot: a deploy, a crash, a replica moving. The
 * schedule is a column, not a timer.
 *
 * # What it re-runs
 *
 * Only the actions that have not already succeeded. A run whose comment posted
 * and whose label was gated must not post the comment twice — which is the same
 * reason the run row is a claim rather than a log.
 */

/**
 * How often to look for due retries.
 *
 * Short, because the thing being waited on is short: GitHub's gates here run
 * 60–300s, and a sweep interval much longer than that would add more delay than
 * the rate limit did. The query it runs is a partial-index lookup that returns
 * nothing almost every time.
 */
const INTERVAL_MS = 30_000;

/**
 * How many parked runs one tick will re-run.
 *
 * A bound on the TICK, not on the work: whatever is left is picked up by the
 * next one. It exists so that draining a backlog cannot itself become a burst of
 * GitHub calls against an account that has just come out of a rate limit — which
 * is how the outage would restart itself.
 */
const BATCH = 10;

class WorkflowRetrySweep {
  private timer: NodeJS.Timeout | null = null;
  private guard = new TickGuard('workflow_retry_sweep', 5 * 60_000);

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'workflow_retry_sweep',
      INTERVAL_MS,
      'Re-runs workflow actions GitHub rate-limited. A parked run holds the instant its gate clears; this picks it up once it has.'
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests, which drive a tick directly rather than on a timer. */
  async tick(): Promise<number> {
    if (!workflowsEnabled()) return 0;
    if (!this.guard.tryBegin()) return 0;
    const startedAt = Date.now();
    let retried = 0;
    try {
      // One replica at a time. Two sweeps re-running the same parked run would
      // each see it as owed and act twice — and "twice" for a comment action is
      // a comment the user did not ask for.
      // `acquired: false` means another replica is already draining — not an
      // error, and not something to retry here: the next tick will find whatever
      // is left.
      const outcome = await guardCrossReplica('workflow_retry_sweep:tick', async () =>
        this.drain()
      );
      retried = outcome.acquired ? (outcome.result ?? 0) : 0;
      debugBus.pollerTick('workflow_retry_sweep', {
        durationMs: Date.now() - startedAt,
        ok: true,
      });
    } catch (err) {
      debugBus.pollerTick('workflow_retry_sweep', {
        durationMs: Date.now() - startedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.guard.end();
    }
    return retried;
  }

  private async drain(): Promise<number> {
    const due = await dueRetries(BATCH);
    let retried = 0;
    for (const run of due) {
      try {
        if (await this.retryOne(run)) retried += 1;
      } catch (err) {
        console.warn(
          `[workflows] retry failed for run ${run.id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
    return retried;
  }

  private async retryOne(run: Awaited<ReturnType<typeof dueRetries>>[number]): Promise<boolean> {
    // Still gated: re-park rather than spend an attempt on a call that cannot
    // succeed. The gate may have been extended since this run was scheduled.
    const accountKey = githubService.accountKeyFor(run.workspaceId);
    const blockedUntilMs = githubRateGate.blockedUntil(accountKey, 'rest');
    if (blockedUntilMs > Date.now()) {
      await settleRun(run.id, {
        status: 'pending_retry',
        actions: run.actions,
        retryAfter: new Date(blockedUntilMs + 5_000),
        attempts: run.attempts,
      });
      return false;
    }

    const workflow = await getWorkflow(run.workflowId);
    const ownerId = await ownerOfWorkspace(run.workspaceId);
    if (!workflow || !ownerId) {
      // Defensive rather than reachable: `workflow_runs.workflow_id` is ON DELETE
      // cascade, so a deleted workflow takes its parked runs with it. Kept
      // because the alternative to a cheap guard here is a run owed forever if
      // that ever stops being true.
      await this.giveUp(run, 'the workflow no longer exists');
      return false;
    }

    // Re-run ONLY what has not already succeeded. A run whose comment posted and
    // whose label was gated must not post the comment twice.
    const pending: Array<{ index: number; action: WorkflowAction }> = [];
    run.actions.forEach((outcome, index) => {
      if (!isRetryable(outcome)) return;
      const action = workflow.actions[index];
      // The workflow may have been edited while the run was parked. An action
      // that has changed shape is not the one that was owed, so it is dropped
      // rather than guessed at.
      if (action && action.type === outcome.type) pending.push({ index, action });
    });
    if (pending.length === 0) {
      await this.giveUp(run, 'the workflow was edited while this was waiting');
      return false;
    }

    const facts = workflowFactsFromRun(run);
    const attempts = run.attempts + 1;
    const results = await runWorkflowActions(
      pending.map((p) => p.action),
      {
        workspaceId: run.workspaceId,
        ownerId,
        repositoryId: run.repositoryId ?? '',
        owner: facts.repoFullName.split('/')[0] ?? '',
        repo: facts.repoFullName.split('/')[1] ?? '',
        facts,
        workflowId: run.workflowId,
        runId: run.id,
      }
    );

    // Merge back in place: the outcomes array is positional and the history
    // renders it against the workflow's action list, so a retried action has to
    // land in its own slot rather than being appended.
    const merged = [...run.actions];
    pending.forEach((p, i) => {
      const outcome = results.outcomes[i];
      if (outcome) merged[p.index] = outcome;
    });

    const { status, retryAfter } = settlementFor(merged, {
      blockedUntilMs: githubRateGate.blockedUntil(accountKey, 'rest'),
      attempts,
    });
    const settled = await settleRun(run.id, {
      status,
      actions: merged,
      attempts,
      retryAfter,
      ...(results.taskId ? { taskId: results.taskId } : {}),
      ...(results.pullRequestId ? { pullRequestId: results.pullRequestId } : {}),
    });
    if (settled) emitWorkflowRun(run.workspaceId, settled);

    debugBus.recordEvent({
      service: 'workflows',
      action: 'workflow:retry',
      summary:
        `retried ${pending.length} action(s) on ${facts.repoFullName}#${facts.number} ` +
        `(attempt ${attempts}/${MAX_RETRY_ATTEMPTS}) → ${status}`,
      ok: status === 'succeeded',
      workspaceId: run.workspaceId,
      meta: { workflowId: run.workflowId, runId: run.id, attempts },
    });
    return true;
  }

  /** Stop owing the work, and say in the history why. */
  private async giveUp(
    run: Awaited<ReturnType<typeof dueRetries>>[number],
    reason: string
  ): Promise<void> {
    const actions: WorkflowActionOutcome[] = run.actions.map((o) =>
      isRetryable(o) ? { ...o, error: `${o.error ?? 'Could not run'} — gave up: ${reason}` } : o
    );
    const settled = await settleRun(run.id, {
      status: actions.every((o) => o.ok) ? 'succeeded' : 'failed',
      actions,
      attempts: run.attempts,
      retryAfter: null,
    });
    if (settled) emitWorkflowRun(run.workspaceId, settled);
  }
}

export const workflowRetrySweep = new WorkflowRetrySweep();

/** Wrapped so the timer's work never inherits a request's transaction handle. */
export function initWorkflowRetrySweep(): void {
  runWithoutScope(() => workflowRetrySweep.init());
}
