import type { AgentEvent } from '@talyn/shared';
import { debugBus } from '../debugBus.js';
import { TickGuard } from '../tickGuard.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { runWithoutScope } from '../../db/client.js';
import { getSelfHostedClient } from '../selfHosted/credentials.js';
import { FleetRunNotFoundError } from '../selfHosted/client.js';
import { isFleetSandboxTerminal } from '../selfHosted/poller.js';
import { finalTextFromEvents, toAgentEvent } from '../selfHosted/eventCursor.js';
import { getPostHogCodeClient } from '../posthogCode/credentials.js';
import {
  finalAgentMessageText,
  lastFlowEventIsTurnComplete,
} from '../posthogCode/poller.js';
import type { PostHogCodeClient } from '../posthogCode/client.js';
import { ingestUnitOutput } from './executor.js';
import {
  getReview,
  loadDispatchedRuns,
  patchRun,
  settleRun,
  type RunRow,
} from './store.js';
import { scheduleReviewEvaluation } from './evaluator.js';

/**
 * Watching review units, and ingesting what they produced.
 *
 * Separate from the task poller because review units are not tasks: there is no
 * `tasks` row, no transcript column, and nothing for the desktop's task feed to
 * subscribe to. What it shares is the event reader — `eventCursor.ts` — so "what
 * did the agent last say" has one definition.
 *
 * **Review units persist no transcript**, deliberately. The transcript blob is the
 * dominant consumer of the database's IO budget on an active run, and a Deep
 * review is six sandboxes on one pull request. The substitute is the audit log
 * plus the findings themselves; the cost is that a review's reasoning is not
 * replayable afterwards, which is a trade worth making at six units a pull
 * request.
 */

const POLL_INTERVAL_MS = 10_000;
const BATCH = 25;

/**
 * How long past its own deadline a unit may run before we stop believing in it.
 *
 * The fleet enforces `timeoutSec` host-side, so this only catches a unit whose
 * host stopped answering — the grace is for the gap between the host giving up and
 * us noticing.
 */
const DEADLINE_GRACE_MS = 5 * 60_000;
const MAX_UNIT_LIFETIME_MS = 25 * 60_000;

/**
 * How often to read a PostHog Code unit's session log while its run still says
 * `in_progress`, and how far back from the run's last activity to read.
 *
 * PostHog leaves a background run `in_progress` after the agent has finished
 * its turn — it idles, waiting for a follow-up that a review never sends. So
 * the run's status alone never says "done", and until this existed every
 * PostHog Code review unit sat there until the 30-minute reaper failed it
 * (12 of 12, all sakce's, 2026-09-28/29), while the sessions stayed open on
 * PostHog's side. The log ending on `turn_complete` is the real signal.
 */
const POSTHOG_LOG_CHECK_MS = 45_000;
const POSTHOG_LOG_TAIL_MS = 5 * 60_000;

class CodeReviewPoller {
  private timer: NodeJS.Timeout | null = null;
  /** Per-run throttle for the PostHog Code session-log read (run id → ms). */
  private readonly lastLogCheck = new Map<string, number>();
  private readonly guard = new TickGuard('code_review_poller', 5 * 60_000);

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'code_review_poller',
      POLL_INTERVAL_MS,
      'Watches in-flight code-review units, ingests their findings, and reaps the ones whose runner went quiet.'
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (!this.guard.tryBegin()) return;
    const started = Date.now();
    let ok = true;
    let error: unknown;
    try {
      await guardCrossReplica(
        'codeReview:poll',
        async () => {
          const runs = await loadDispatchedRuns(BATCH);
          for (const run of runs) {
            try {
              await this.reconcileRun(run);
            } catch (err) {
              // One bad unit must not take the tick down for the others.
              console.warn(`[code-review] polling ${run.id} failed:`, err);
            }
          }
        },
        { maxHoldMs: this.guard.maxMs }
      );
    } catch (err) {
      ok = false;
      error = err;
    } finally {
      this.guard.end();
      debugBus.pollerTick('code_review_poller', {
        durationMs: Date.now() - started,
        ok,
        error,
      });
    }
  }

  private async reconcileRun(run: RunRow): Promise<void> {
    if (await this.reapIfOverdue(run)) return;
    if (run.provider === 'selfhosted') return this.reconcileFleetRun(run);
    if (run.provider === 'posthog_code') return this.reconcilePostHogRun(run);
  }

  /**
   * A unit whose runner has gone quiet past every deadline it had.
   *
   * Settled as a timeout rather than left in flight, because an in-flight unit
   * holds a slot in the workspace's ceiling and blocks the rest of the review
   * behind a sandbox nobody is watching.
   */
  private async reapIfOverdue(run: RunRow): Promise<boolean> {
    const age = Date.now() - (run.dispatchedAt?.getTime() ?? Date.now());
    if (age < MAX_UNIT_LIFETIME_MS + DEADLINE_GRACE_MS) return false;
    await settleRun(run.id, { status: 'failed', failureCode: 'timeout' });
    // The fleet stops its own sandbox at `timeoutSec`; PostHog Code has no such
    // budget, so a unit we gave up on keeps its session open until told.
    await this.releasePostHogRun(run);
    void scheduleReviewEvaluation(run.reviewId, 'poller:timeout');
    return true;
  }

  private async reconcileFleetRun(run: RunRow): Promise<void> {
    if (!run.sandboxId) return;
    const client = await getSelfHostedClient(run.workspaceId);
    if (!client) return;

    let sandbox;
    try {
      ({ sandbox } = await client.getSandbox(run.sandboxId));
    } catch (err) {
      if (err instanceof FleetRunNotFoundError) {
        // A healthy host is authoritative about what it is running, so a run it
        // has never heard of is gone rather than pending. Terminal.
        await settleRun(run.id, { status: 'failed', failureCode: 'run_vanished' });
        void scheduleReviewEvaluation(run.reviewId, 'poller:vanished');
        return;
      }
      throw err;
    }

    // Read the log forward from where we left off. The cursor is a COLUMN rather
    // than a memory map, so a deploy mid-cycle resumes rather than re-reading or
    // losing the unit's output entirely.
    const events: AgentEvent[] = [];
    let cursor = run.eventCursor;
    try {
      const page = await client.getEvents(run.sandboxId, cursor, 500);
      for (const ev of page.events) {
        events.push(toAgentEvent(ev));
        cursor = Math.max(cursor, ev.seq);
      }
    } catch (err) {
      console.warn(`[code-review] reading events for ${run.id} failed:`, err);
    }
    if (cursor !== run.eventCursor) await patchRun(run.id, { eventCursor: cursor });
    if (sandbox.costUsd !== undefined) {
      // Recorded rather than capped: this is the number that will justify a spend
      // limit later, and guessing one now would truncate good reviews.
      await patchRun(run.id, { costUsd: String(sandbox.costUsd) });
    }

    if (!isFleetSandboxTerminal(sandbox.status)) return;

    // Terminal. Re-read the tail from the durable log rather than trusting a
    // transcript we never kept, then ingest.
    const tail = await this.fleetTail(run, cursor);
    await this.settleWithOutput(run, finalTextFromEvents(tail.length ? tail : events));
  }

  /** The whole log, for the one moment we need the agent's last word. */
  private async fleetTail(run: RunRow, cursor: number): Promise<AgentEvent[]> {
    if (!run.sandboxId) return [];
    const client = await getSelfHostedClient(run.workspaceId);
    if (!client) return [];
    try {
      // From zero, because the last assistant message may predate this tick's
      // cursor — a unit that finished between two polls has all its output behind
      // us.
      const page = await client.getEvents(run.sandboxId, 0, 2000);
      void cursor;
      return page.events.map(toAgentEvent);
    } catch {
      return [];
    }
  }

  private async reconcilePostHogRun(run: RunRow): Promise<void> {
    if (!run.remoteTaskId) return;
    const client = await getPostHogCodeClient(run.workspaceId);
    if (!client) return;

    const task = await client.getTask(run.remoteTaskId);
    const latest = task.latest_run;
    if (!latest) return;
    if (latest.status !== 'completed' && latest.status !== 'failed' && latest.status !== 'cancelled') {
      await this.settleIfTurnEnded(run, client, latest);
      return;
    }
    this.lastLogCheck.delete(run.id);
    if (latest.status !== 'completed') {
      await settleRun(run.id, { status: 'failed', failureCode: 'dispatch_failed' });
      void scheduleReviewEvaluation(run.reviewId, 'poller:unit_settled');
      return;
    }
    // `output.final_message` is server-side and durable here, which is why this
    // provider needs no cursor bookkeeping at all — a restart re-reads it.
    const output = (latest.output ?? {}) as { final_message?: unknown };
    const finalMessage =
      typeof output.final_message === 'string' ? output.final_message : null;
    await this.settleWithOutput(run, finalMessage);
  }

  /**
   * Settle a unit whose run is still `in_progress` but whose agent has ended
   * its turn — see {@link POSTHOG_LOG_CHECK_MS}. A review unit is ONE turn: the
   * agent reads the diff, writes its findings, and stops. Then release the run,
   * so the session does not stay open on PostHog's side.
   */
  private async settleIfTurnEnded(
    run: RunRow,
    client: PostHogCodeClient,
    latest: { updated_at?: string | null; output?: unknown }
  ): Promise<void> {
    if (!run.remoteTaskId || !run.remoteRunId) return;
    const last = this.lastLogCheck.get(run.id) ?? 0;
    if (Date.now() - last < POSTHOG_LOG_CHECK_MS) return;
    this.lastLogCheck.set(run.id, Date.now());

    const updatedAtMs = latest.updated_at ? Date.parse(latest.updated_at) : NaN;
    const from = Number.isNaN(updatedAtMs)
      ? run.dispatchedAt ?? new Date(Date.now() - MAX_UNIT_LIFETIME_MS)
      : new Date(updatedAtMs - POSTHOG_LOG_TAIL_MS);
    let entries;
    try {
      ({ entries } = await client.getSessionLogs(run.remoteTaskId, run.remoteRunId, {
        after: from.toISOString(),
        limit: 5000,
      }));
    } catch (err) {
      console.warn(`[code-review] reading the session log for ${run.id} failed:`, err);
      return;
    }
    if (!lastFlowEventIsTurnComplete(entries)) return;

    // The structured field when PostHog wrote it, else the message rebuilt from
    // the log — streamed as chunks, so the findings block spans several entries.
    const output = (latest.output ?? {}) as { final_message?: unknown };
    const finalMessage =
      typeof output.final_message === 'string' && output.final_message.trim()
        ? output.final_message
        : finalAgentMessageText(entries);
    this.lastLogCheck.delete(run.id);
    await this.settleWithOutput(run, finalMessage);
    await this.releasePostHogRun(run);
  }

  /** Best-effort cancel of a PostHog Code run we no longer need. */
  private async releasePostHogRun(run: RunRow): Promise<void> {
    this.lastLogCheck.delete(run.id);
    if (run.provider !== 'posthog_code' || !run.remoteTaskId || !run.remoteRunId) return;
    try {
      const client = await getPostHogCodeClient(run.workspaceId);
      await client?.cancelRun(run.remoteTaskId, run.remoteRunId);
    } catch (err) {
      console.warn(`[code-review] releasing PostHog Code run for ${run.id} failed:`, err);
    }
  }

  private async settleWithOutput(run: RunRow, finalText: string | null): Promise<void> {
    const review = await getReview(run.reviewId);
    if (!review) return;
    await patchRun(run.id, { status: 'parsing' });
    await ingestUnitOutput(review, run, finalText);
    // Whatever the outcome, the review has moved: a unit settling is the event
    // that lets the next one fire or the phase advance.
    void scheduleReviewEvaluation(run.reviewId, 'poller:unit_settled');
  }
}

export const codeReviewPoller = new CodeReviewPoller();

export function initCodeReviewPoller(): void {
  // Wrapped so the interval never inherits a request's RLS scope — a detached
  // handler holding a committed transaction is the 25P02 cascade.
  runWithoutScope(() => codeReviewPoller.init());
}
