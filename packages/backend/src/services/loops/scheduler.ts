import { eq } from 'drizzle-orm';
import { getDbClient, runWithoutScope } from '../../db/client.js';
import { loopRuns as runsTable } from '../../db/schema.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { domainEvents, type DomainTaskStatusEvent } from '../events.js';
import { TickGuard } from '../tickGuard.js';
import { emitLoopRun } from '../websocket.js';
import { loopsKillSwitchPulled } from '../loopsAccess.js';
import { dispatchRun } from './dispatch.js';
import {
  activeRunsWithTaskStatus,
  advanceSchedule,
  claimFiring,
  clearFailures,
  concurrencyOf,
  disableLoop,
  dueLoops,
  dueWaitingSlots,
  hasActiveRun,
  isSuperseded,
  orphanedClaims,
  recordFailure,
  runByClaim,
  settleRun,
  type DueLoop,
} from './runs.js';
import { getLoop, getLoopRun } from './store.js';

/**
 * The Loops scheduler.
 *
 * # The schedule is a column, not a timer
 *
 * `loops.next_run_at` holds the next occurrence, and this sweep reads the rows
 * whose occurrence has arrived. Nothing is held in memory between ticks, so a
 * Railway deploy — which happens on every push to main, and briefly runs the
 * old and new instances together — loses nothing. A `setTimeout` per loop would
 * lose every pending firing on each release and double-fire during the overlap.
 *
 * # claim → dispatch → advance, and the order is load-bearing
 *
 * Advancing the schedule before dispatching looks tidier and is wrong. If the
 * process dies in between, `next_run_at` is already in the future, so nothing
 * ever selects that loop again: the claimed run sits `queued` forever and the
 * firing is silently lost — recoverable only by a special orphan hunt.
 *
 * Dispatching first means every crash leaves `next_run_at` in the PAST, so the
 * ordinary due-scan re-enters on the next tick and the conflict path finishes
 * the job. The unique `(loop_id, scheduled_for)` index makes that re-entry
 * idempotent.
 *
 * The window that remains is the few milliseconds between `createCloudTask`
 * returning and `task_id` landing on the run row. A crash exactly there costs
 * one duplicate task — a redundant agent run, not a lost firing and not a
 * corrupt row. That is the right side of the trade to be on.
 *
 * # Catch-up fires once
 *
 * A deploy, an outage, or a loop re-enabled after a week all leave
 * `next_run_at` in the past, possibly by hours. The firing happens ONCE, for
 * the occurrence that was stored, and the schedule then advances from `now`.
 *
 * Replaying every missed occurrence would turn a six-hour outage into six
 * near-identical cloud tasks — and, on a free plan, one run and five immediate
 * task-limit refusals. Skipping entirely would let a thirty-second deploy at
 * 08:59:50 eat the 09:00 daily run. Firing once makes short gaps invisible and
 * long gaps degrade honestly: the history shows "scheduled 09:00, ran 15:04".
 */

/**
 * How often to look for due loops.
 *
 * Cron's own grain is one minute, so a 30-second sweep is half a grain of
 * worst-case lateness — and a tighter interval would buy nothing but ticks. It
 * matches the workflow retry sweep, whose query has the same shape: a
 * partial-index lookup that returns nothing almost every time.
 */
const INTERVAL_MS = 30_000;

/**
 * How many firings one tick will start.
 *
 * A bound on the TICK, not on the work — a backlog drains over several ticks.
 * It exists so that a backend coming up after an outage, with two hundred loops
 * all overdue, cannot create two hundred cloud tasks in one breath.
 */
const BATCH = 10;

/** How many active runs one tick will re-check against their task. */
const SETTLE_BATCH = 50;

/**
 * How long a claimed-but-undispatched run may sit before it is called lost.
 *
 * It has to be longer than a dispatch can legitimately take (a `createCloudTask`
 * behind the billing gate's advisory lock, plus the fleet-agent lookups), and
 * short enough that a genuinely orphaned claim does not block an overlap-skip
 * loop forever. Five minutes is the same figure `TickGuard` uses for a wedged
 * tick, for the same reason: past it, the thing is not slow, it is gone.
 */
const ORPHAN_GRACE_MS = 5 * 60_000;

class LoopScheduler {
  private timer: NodeJS.Timeout | null = null;
  private guard = new TickGuard('loop_scheduler', 5 * 60_000);
  private listener: ((evt: DomainTaskStatusEvent) => void) | null = null;

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'loop_scheduler',
      INTERVAL_MS,
      'Fires loops whose cron occurrence has arrived, and settles the runs already in flight. The schedule lives in loops.next_run_at, so a deploy loses nothing.'
    );
    // The fast half of settlement. Per-replica, so it is an optimisation rather
    // than the mechanism — `settleBacklog` is what makes it correct.
    this.listener = (evt) => {
      void this.settleFromTaskStatus(evt).catch((err) => {
        console.error('[loops] settle from task:status failed:', err);
      });
    };
    domainEvents.on('task:status', this.listener);
    this.timer = setInterval(() => {
      void this.tick();
    }, INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.listener) domainEvents.off('task:status', this.listener);
    this.listener = null;
  }

  /** Exposed for tests, which drive a tick directly rather than on a timer. */
  async tick(): Promise<number> {
    // The deployment-wide break glass only. The per-workspace flag is checked
    // per firing in `dispatch.ts`, where a refusal can be recorded against the
    // run it refuses.
    if (loopsKillSwitchPulled()) return 0;
    if (!this.guard.tryBegin()) return 0;
    const startedAt = Date.now();
    let fired = 0;
    try {
      // One replica at a time. Two sweeps reading the same due loop would each
      // try to claim it — the unique index would stop the second from creating
      // a task, but the lock keeps the wasted work off the database too.
      // `acquired: false` means another replica is sweeping; not an error, and
      // not worth retrying here.
      const outcome = await guardCrossReplica('loop_scheduler:tick', async () => {
        const count = await this.fireDue();
        await this.settleBacklog();
        await this.retryWaitingSlots();
        await this.reapOrphans();
        return count;
      });
      fired = outcome.acquired ? (outcome.result ?? 0) : 0;
      debugBus.pollerTick('loop_scheduler', { durationMs: Date.now() - startedAt, ok: true });
    } catch (err) {
      debugBus.pollerTick('loop_scheduler', {
        durationMs: Date.now() - startedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.guard.end();
    }
    return fired;
  }

  private async fireDue(): Promise<number> {
    const due = await dueLoops(BATCH);
    let fired = 0;
    for (const loop of due) {
      try {
        if (await this.fireOne(loop)) fired += 1;
      } catch (err) {
        // One broken loop must not stop the others in this tick. Leaving
        // next_run_at where it is means the due-scan re-enters next tick, and
        // the claim it already holds makes that safe.
        console.error(`[loops] firing ${loop.id.slice(0, 8)} failed:`, err);
      }
    }
    return fired;
  }

  /** claim → dispatch → advance. See the header for why that order. */
  private async fireOne(loop: DueLoop): Promise<boolean> {
    const scheduledFor = loop.nextRunAt as Date;
    const claim = await claimFiring(loop, scheduledFor);

    if (!claim.fresh) {
      // Somebody already owns this occurrence. Either another replica took it
      // while we were reading, or we died mid-fire last tick and next_run_at is
      // still in the past. Finish whatever is unfinished, then advance — this
      // is the recovery path the dispatch-before-advance order creates.
      const existing = await runByClaim(loop.id, scheduledFor);
      if (existing && existing.status === 'queued' && !existing.taskId) {
        await this.dispatchAndSettle(loop, existing.id, scheduledFor);
      }
      await advanceSchedule(loop, new Date());
      return false;
    }

    if (concurrencyOf(loop) === 'skip' && (await hasActiveRun(loop.id, claim.id))) {
      // Recorded, not silent. Nineteen "skipped — the previous run was still
      // going" rows say exactly what a minute-by-minute loop with a
      // twenty-minute task is doing; a schedule that appears to have stopped
      // does not.
      await settleRun(claim.id, {
        status: 'skipped',
        failureCode: 'overlap',
        error: 'The previous run had not finished.',
      });
      await this.broadcast(loop.workspaceId, claim.id);
      await advanceSchedule(loop, new Date());
      return false;
    }

    await this.dispatchAndSettle(loop, claim.id, scheduledFor);

    // Advance LAST, and from `now` rather than from the stored occurrence when
    // that is stale — this is the catch-up rule: one firing for the miss, then
    // straight to the next future occurrence.
    const from = new Date(Math.max(scheduledFor.getTime(), Date.now()));
    await advanceSchedule(loop, from);
    return true;
  }

  private async dispatchAndSettle(
    loop: DueLoop,
    runId: string,
    scheduledFor: Date
  ): Promise<void> {
    const outcome = await dispatchRun(loop, runId, scheduledFor);
    if (!outcome.ok) {
      if (outcome.status === 'failed') await recordFailure(loop.id);
      // A configuration that has GONE is not a failure to count — it will not
      // fix itself, so counting to five would just mean five noisy runs before
      // the inevitable. Switch the loop off now, with the reason on the row.
      if (outcome.code === 'repo_missing') await disableLoop(loop.id, 'repo_missing');
      if (outcome.code === 'environment_missing' || outcome.code === 'agent_not_connected') {
        await disableLoop(loop.id, 'environment_missing');
      }
    }
    await this.broadcast(loop.workspaceId, runId);
  }

  /**
   * The durable half of settlement: re-read the task behind every active run.
   *
   * The `task:status` listener is faster, but it only fires on the replica that
   * finalised the task and it is lost entirely across a deploy. Without this, a
   * run whose task completed during a release stays `running` forever — and for
   * an overlap-skip loop, that is a schedule that never fires again.
   */
  private async settleBacklog(): Promise<void> {
    const rows = await activeRunsWithTaskStatus(SETTLE_BATCH);
    for (const row of rows) {
      if (!row.taskId) {
        // No task, but this run HAD one — `dispatched_at` is the memory the FK
        // erases. The task row was deleted while the run was in flight, which
        // is deliberate user action, so it settles failed WITHOUT counting
        // toward the failure limit that would switch the loop off.
        //
        // A run with no `dispatched_at` is a different animal: a claim that
        // never got a task at all. That is `reapOrphans`'s, after a grace
        // period, because it might simply be mid-dispatch right now.
        if (row.dispatchedAt) {
          await settleRun(row.runId, {
            status: 'failed',
            failureCode: 'task_deleted',
            error: 'The task this run started was deleted before it finished.',
          });
          await this.broadcast(row.workspaceId, row.runId);
        }
        continue;
      }
      if (row.taskStatus === null) continue;
      await this.applyTaskStatus(row.runId, row.loopId, row.workspaceId, row.taskStatus);
    }
  }

  /** Map a task's status onto its run. Idempotent — both settle paths call it. */
  private async applyTaskStatus(
    runId: string,
    loopId: string,
    workspaceId: string,
    taskStatus: string
  ): Promise<void> {
    if (taskStatus === 'in_progress') {
      const moved = await settleRun(runId, { status: 'running' });
      if (moved) await this.broadcast(workspaceId, runId);
      return;
    }
    if (taskStatus === 'completed') {
      const moved = await settleRun(runId, { status: 'succeeded' });
      if (moved) {
        await clearFailures(loopId);
        await this.broadcast(workspaceId, runId);
      }
      return;
    }
    if (taskStatus === 'failed' || taskStatus === 'cancelled') {
      const moved = await settleRun(runId, {
        status: 'failed',
        failureCode: 'dispatch_failed',
        error: `The task ${taskStatus === 'cancelled' ? 'was cancelled' : 'failed'}.`,
      });
      if (moved) {
        await recordFailure(loopId);
        await this.broadcast(workspaceId, runId);
      }
    }
  }

  private async settleFromTaskStatus(evt: DomainTaskStatusEvent): Promise<void> {
    const rows = await getDbClient()
      .select({
        runId: runsTable.id,
        loopId: runsTable.loopId,
        workspaceId: runsTable.workspaceId,
      })
      .from(runsTable)
      .where(eq(runsTable.taskId, evt.taskId))
      .limit(1);
    const row = rows[0];
    if (!row) return;
    await this.applyTaskStatus(row.runId, row.loopId, row.workspaceId, evt.status);
  }

  /**
   * Re-attempt the runs parked on the plan's task limit.
   *
   * The give-up condition is SUPERSESSION, not an attempt cap: a cron payload
   * is "it is time", which does not go stale until the next occurrence arrives.
   * So a daily loop waits most of a day for a slot and an every-five-minutes
   * loop gives up in five — both correct, and no fixed number would be.
   */
  private async retryWaitingSlots(): Promise<void> {
    const due = await dueWaitingSlots(BATCH);
    for (const parked of due) {
      const loop = await getLoop(parked.loopId);
      if (!loop || !loop.repositoryId) {
        await settleRun(parked.runId, {
          status: 'skipped',
          failureCode: 'repo_missing',
          error: 'The loop was removed or lost its repository while this run waited.',
        });
        continue;
      }
      if (await isSuperseded(parked.loopId, parked.scheduledFor)) {
        await settleRun(parked.runId, {
          status: 'skipped',
          failureCode: 'task_limit_reached',
          error: 'No task slot freed before the next run was due.',
        });
        await this.broadcast(loop.workspaceId, parked.runId);
        continue;
      }
      // Put it back in flight so `dispatchRun` can settle it either way. Without
      // this the run is still `waiting_slot` and a second refusal would be a
      // no-op update against a status the settle guard does not accept.
      const outcome = await dispatchRun(
        {
          id: loop.id,
          workspaceId: loop.workspaceId,
          name: loop.name,
          prompt: loop.prompt,
          cron: loop.cron,
          timezone: loop.timezone,
          provider: loop.provider,
          model: loop.model,
          concurrency: loop.concurrency,
          repositoryId: loop.repositoryId,
          repoFullName: loop.repoFullName,
          nextRunAt: loop.nextRunAt ? new Date(loop.nextRunAt) : null,
          consecutiveFailures: 0,
        },
        parked.runId,
        parked.scheduledFor
      );
      if (!outcome.ok && outcome.status === 'waiting_slot') {
        // Still full. `dispatchRun` has already re-parked it with a fresh
        // retry_after, so there is nothing else owed here.
        continue;
      }
      await this.broadcast(loop.workspaceId, parked.runId);
    }
  }

  /**
   * Settle claims that were never dispatched.
   *
   * The residual of the crash window in `fireOne`. Normally the due-scan
   * recovers these, because `next_run_at` is still in the past — but a loop
   * disabled or deleted in between never comes back through that path, and an
   * overlap-skip loop would treat the stuck row as "still running" forever.
   */
  private async reapOrphans(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS);
    const rows = await orphanedClaims(cutoff, BATCH);
    for (const row of rows) {
      await settleRun(row.runId, {
        status: 'failed',
        failureCode: 'dispatch_lost',
        error: 'This run was claimed but never started — the backend restarted mid-dispatch.',
      });
      await this.broadcast(row.workspaceId, row.runId);
    }
  }

  private async broadcast(workspaceId: string, runId: string): Promise<void> {
    const run = await getLoopRun(runId);
    if (run) emitLoopRun(workspaceId, run);
  }
}

export const loopScheduler = new LoopScheduler();

/**
 * Arm the scheduler.
 *
 * Wrapped in `runWithoutScope` so the interval never inherits a request's
 * owner-scoped transaction — the sweep acts for every workspace, and a timer
 * that started life inside one user's RLS scope would see only that user's
 * loops.
 */
export function initLoopScheduler(): void {
  runWithoutScope(() => loopScheduler.init());
}
