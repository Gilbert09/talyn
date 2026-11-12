import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { getPoolDbClient, runWithoutScope } from '../../db/client.js';
import { inboundDeliveries } from '../../db/schema.js';
import { debugBus } from '../debugBus.js';
import { evaluateWorkflows } from '../workflows/engine.js';
import { inboundAdapterFor } from './adapters/index.js';
import { connectionRef } from './store.js';

/**
 * Process one stored inbound delivery: claim it, turn it into facts with the
 * connection's adapter, and run the rules engine. The same shape as
 * `processSlackEvent`.
 *
 * The conditional UPDATE is the claim, so two replicas (or the inline path and
 * the sweep) cannot both run the rules. The engine's own claim on
 * `UNIQUE (workflow_id, delivery_id)` is the second guard: a delivery that is
 * processed twice still runs each rule once.
 */

/**
 * A claim older than this is presumed dead (a crash part way), and another
 * replica may take the delivery. Longer than one delivery takes: the rules
 * engine runs each matched rule's actions, and a session create waits up to
 * 45 s on the fleet.
 */
const CLAIM_TIMEOUT_MS = 2 * 60_000;

/** After this many failed tries a delivery is settled `failed` and stops retrying. */
export const MAX_DELIVERY_ATTEMPTS = 5;

export type InboundProcessResult = 'handled' | 'ignored' | 'failed' | 'skipped';

export async function processInboundDelivery(id: string): Promise<InboundProcessResult> {
  return runWithoutScope(() => processUnscoped(id));
}

async function processUnscoped(id: string): Promise<InboundProcessResult> {
  const db = getPoolDbClient();
  const now = new Date();
  const claimed = await db
    .update(inboundDeliveries)
    .set({ claimedAt: now, attempts: sql`${inboundDeliveries.attempts} + 1` })
    .where(
      and(
        eq(inboundDeliveries.id, id),
        isNull(inboundDeliveries.processedAt),
        or(
          isNull(inboundDeliveries.claimedAt),
          lt(inboundDeliveries.claimedAt, new Date(now.getTime() - CLAIM_TIMEOUT_MS))
        )
      )
    )
    .returning({
      connectionId: inboundDeliveries.connectionId,
      deliveryId: inboundDeliveries.deliveryId,
      eventType: inboundDeliveries.eventType,
      payload: inboundDeliveries.payload,
      headers: inboundDeliveries.headers,
      receivedAt: inboundDeliveries.receivedAt,
      attempts: inboundDeliveries.attempts,
    });
  const row = claimed[0];
  if (!row) return 'skipped';

  const settle = async (outcome: 'handled' | 'ignored' | 'failed', error: string | null = null) => {
    await db
      .update(inboundDeliveries)
      .set({ processedAt: new Date(), outcome, error })
      .where(eq(inboundDeliveries.id, id));
  };

  try {
    const connection = await connectionRef(row.connectionId);
    const adapter = connection ? inboundAdapterFor(connection.kind) : null;
    if (!connection || !adapter) {
      await settle('ignored');
      return 'ignored';
    }
    const delivery = {
      id,
      connectionId: row.connectionId,
      deliveryId: row.deliveryId,
      eventType: row.eventType,
      payload: row.payload,
      headers: row.headers ?? {},
      receivedAt: row.receivedAt,
    };
    const facts = adapter.toFacts(delivery, connection);
    const ran = facts.length > 0 ? await evaluateWorkflows(adapter.workflowSource, { connection, delivery, facts }) : 0;
    const outcome = ran > 0 ? 'handled' : 'ignored';
    await settle(outcome);
    debugBus.recordEvent({
      service: 'inbound',
      action: 'processed',
      summary: `${connection.kind} ${row.deliveryId}: ${outcome} (${ran} rule run${ran === 1 ? '' : 's'})`,
      ok: true,
      workspaceId: connection.workspaceId,
    });
    return outcome;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const giveUp = row.attempts >= MAX_DELIVERY_ATTEMPTS;
    if (giveUp) {
      await settle('failed', message);
    } else {
      await db
        .update(inboundDeliveries)
        .set({ claimedAt: null, error: message })
        .where(eq(inboundDeliveries.id, id));
    }
    debugBus.recordEvent({
      service: 'inbound',
      action: 'failed',
      ok: false,
      summary: `${row.deliveryId} attempt ${row.attempts}${giveUp ? ' (gave up)' : ''}`,
      error: err,
    });
    return 'failed';
  }
}
