import { and, isNull, lt } from 'drizzle-orm';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { inboundDeliveries } from '../../db/schema.js';
import { guardCrossReplica } from '../advisoryLock.js';
import { debugBus } from '../debugBus.js';
import { TickGuard } from '../tickGuard.js';
import { processInboundDelivery } from './process.js';

/**
 * Retries inbound deliveries a crash or a deploy left unprocessed, and deletes
 * deliveries 7 days after they arrived. The same shape as the Slack event
 * sweep.
 */

const SWEEP_INTERVAL_MS = 60_000;
/** Older than this and still unprocessed means the inline path did not finish. */
const PENDING_GRACE_MS = 60_000;
/**
 * Deliveries one tick retries. A bound on the tick, not on the work: the next
 * tick takes what is left. Each retry can start a session, so a backlog after
 * an outage drains over minutes instead of in one burst.
 */
const SWEEP_BATCH = 50;
/**
 * Deliveries are kept this long, processed or not, so a person can read and
 * replay last week's requests. A run's retries end within half an hour, so
 * nothing still needs a row this old.
 */
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
const CLEANUP_EVERY_MS = 60 * 60_000;

class InboundDeliverySweep {
  private timer: NodeJS.Timeout | null = null;
  private guard = new TickGuard('inbound_delivery_sweep', 5 * 60_000);
  private lastCleanupAt = 0;

  init(): void {
    if (this.timer) return;
    debugBus.registerPoller(
      'inbound_delivery_sweep',
      SWEEP_INTERVAL_MS,
      'Inbound webhooks: retries any delivery that was stored but not processed (a crash or deploy part way), and hourly deletes deliveries older than 7 days.'
    );
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests. */
  async tick(now: Date = new Date()): Promise<{ retried: number; deleted: number }> {
    if (!this.guard.tryBegin()) return { retried: 0, deleted: 0 };
    const startedAt = Date.now();
    try {
      const outcome = await guardCrossReplica('inbound_delivery_sweep:tick', () => this.run(now), {
        maxHoldMs: this.guard.maxMs,
      });
      debugBus.pollerTick('inbound_delivery_sweep', { durationMs: Date.now() - startedAt, ok: true });
      return outcome.result ?? { retried: 0, deleted: 0 };
    } catch (err) {
      debugBus.pollerTick('inbound_delivery_sweep', { durationMs: Date.now() - startedAt, ok: false, error: err });
      return { retried: 0, deleted: 0 };
    } finally {
      this.guard.end();
    }
  }

  private async run(now: Date): Promise<{ retried: number; deleted: number }> {
    const db = getPoolDbClient();
    const due = await db
      .select({ id: inboundDeliveries.id })
      .from(inboundDeliveries)
      .where(
        and(
          isNull(inboundDeliveries.processedAt),
          lt(inboundDeliveries.receivedAt, new Date(now.getTime() - PENDING_GRACE_MS))
        )
      )
      .orderBy(inboundDeliveries.receivedAt)
      .limit(SWEEP_BATCH);
    let retried = 0;
    for (const { id } of due) {
      if ((await processInboundDelivery(id)) !== 'skipped') retried += 1;
    }

    let deleted = 0;
    if (now.getTime() - this.lastCleanupAt >= CLEANUP_EVERY_MS) {
      this.lastCleanupAt = now.getTime();
      const gone = await db
        .delete(inboundDeliveries)
        .where(lt(inboundDeliveries.receivedAt, new Date(now.getTime() - DELIVERY_RETENTION_MS)))
        .returning({ id: inboundDeliveries.id });
      deleted = gone.length;
    }
    return { retried, deleted };
  }

  /** Tests: run the hourly cleanup on the next tick. */
  resetForTests(): void {
    this.lastCleanupAt = 0;
  }
}

export const inboundDeliverySweep = new InboundDeliverySweep();

/** Wrapped so the timer's work never inherits a request's transaction handle. */
export function initInboundDeliverySweep(): void {
  runWithoutScope(() => inboundDeliverySweep.init());
}
