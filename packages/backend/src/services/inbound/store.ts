import { v4 as uuid } from 'uuid';
import { and, count, desc, eq, isNotNull, lt, max, ne, sql } from 'drizzle-orm';
import type {
  InboundDelivery,
  InboundDeliveryOutcome,
  InboundDeliverySummary,
  InboundKind,
  NormalizedWorkflow,
  WorkflowWithStats,
} from '@talyn/shared';
import { getPoolDbClient, runInScopedDb, type Database } from '../../db/client.js';
import { inboundConnections, inboundDeliveries } from '../../db/schema.js';
import { decryptString, encryptString } from '../tokenCrypto.js';
import { createWorkflow, invalidateWorkflowCache } from '../workflows/store.js';
import type { InboundConnectionRef, InboundConnectionSecrets } from './adapter.js';
import { mintWebhookSecrets, type WebhookSecrets } from './adapters/webhook.js';

/**
 * Reads and writes for `inbound_connections` and `inbound_deliveries`.
 *
 * Both tables are backend-pool only (no RLS policy, no grant), so every query
 * here uses the pool. The owner routes check workspace access before they
 * call in. Every read names its columns: a list never selects `payload` or
 * `headers`, and nothing outside the receiver selects `token_hash` or
 * `secret_enc`.
 */

const db = (): Database => getPoolDbClient();

// ---- Connections -------------------------------------------------------------

/** A webhook rule's connection, without its secrets. */
export interface WebhookConnectionRow {
  id: string;
  workspaceId: string;
  ruleId: string;
  createdAt: Date;
  rotatedAt: Date | null;
  lastDeliveryAt: Date | null;
}

/**
 * Create a webhook rule and its connection in one transaction, on the pool.
 *
 * One transaction because the connection points at the rule (`rule_id`), and
 * the pool because the connection table has no grant for the request's scoped
 * role. The rule row is written by the same `createWorkflow` every rule uses.
 */
export async function createWebhookRule(
  workspaceId: string,
  input: NormalizedWorkflow,
  createdBy: string
): Promise<{ workflow: WorkflowWithStats; connectionId: string; secrets: WebhookSecrets }> {
  const secrets = mintWebhookSecrets();
  const connectionId = uuid();
  const workflow = await db().transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const created = await runInScopedDb(txDb, () => createWorkflow(workspaceId, input));
    await txDb.insert(inboundConnections).values({
      id: connectionId,
      workspaceId,
      kind: 'webhook',
      tokenHash: secrets.tokenHash,
      secretEnc: encryptString(secrets.signingSecret),
      ruleId: created.id,
      createdBy,
    });
    return created;
  });
  // Again after the commit: a read between the first invalidation and the
  // commit could have cached the list without this rule.
  invalidateWorkflowCache(workspaceId);
  return { workflow, connectionId, secrets };
}

/**
 * Replace a rule's URL token and signing secret. The old URL stops working
 * at once. A rule that lost its connection (a failed delete half-way) gets a
 * new one, so rotating is also the repair.
 */
export async function rotateWebhookConnection(
  workspaceId: string,
  ruleId: string,
  createdBy: string
): Promise<{ connectionId: string; secrets: WebhookSecrets }> {
  const secrets = mintWebhookSecrets();
  const now = new Date();
  const updated = await db()
    .update(inboundConnections)
    .set({
      tokenHash: secrets.tokenHash,
      secretEnc: encryptString(secrets.signingSecret),
      rotatedAt: now,
      updatedAt: now,
    })
    .where(and(eq(inboundConnections.ruleId, ruleId), eq(inboundConnections.workspaceId, workspaceId)))
    .returning({ id: inboundConnections.id });
  if (updated[0]) return { connectionId: updated[0].id, secrets };

  const connectionId = uuid();
  await db().insert(inboundConnections).values({
    id: connectionId,
    workspaceId,
    kind: 'webhook',
    tokenHash: secrets.tokenHash,
    secretEnc: encryptString(secrets.signingSecret),
    ruleId,
    createdBy,
    rotatedAt: now,
  });
  return { connectionId, secrets };
}

/** Delete a rule's connections and, by cascade, their deliveries. */
export async function deleteConnectionsForRule(ruleId: string): Promise<void> {
  await db().delete(inboundConnections).where(eq(inboundConnections.ruleId, ruleId));
}

/** The query behind {@link webhookConnectionForRule}. Exported for the egress test. */
export function webhookConnectionQuery(ruleId: string) {
  return db()
    .select({
      id: inboundConnections.id,
      workspaceId: inboundConnections.workspaceId,
      ruleId: inboundConnections.ruleId,
      createdAt: inboundConnections.createdAt,
      rotatedAt: inboundConnections.rotatedAt,
    })
    .from(inboundConnections)
    .where(and(eq(inboundConnections.ruleId, ruleId), eq(inboundConnections.kind, 'webhook')))
    .limit(1);
}

export async function webhookConnectionForRule(ruleId: string): Promise<WebhookConnectionRow | null> {
  const rows = await webhookConnectionQuery(ruleId);
  const row = rows[0];
  if (!row?.ruleId) return null;
  const last = await db()
    .select({ at: max(inboundDeliveries.receivedAt) })
    .from(inboundDeliveries)
    .where(eq(inboundDeliveries.connectionId, row.id));
  const at = last[0]?.at;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ruleId: row.ruleId,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    lastDeliveryAt: at ? new Date(at) : null,
  };
}

/**
 * The secrets the receiver checks a request against. The signing secret is
 * decrypted here; an envelope that will not decrypt (a rotated key) reads as
 * no secret, so a signed request is refused rather than passed.
 */
export async function connectionSecrets(connectionId: string): Promise<InboundConnectionSecrets | null> {
  const rows = await db()
    .select({
      id: inboundConnections.id,
      workspaceId: inboundConnections.workspaceId,
      kind: inboundConnections.kind,
      ruleId: inboundConnections.ruleId,
      tokenHash: inboundConnections.tokenHash,
      secretEnc: inboundConnections.secretEnc,
    })
    .from(inboundConnections)
    .where(eq(inboundConnections.id, connectionId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  let signingSecret: string | null = null;
  if (row.secretEnc) {
    try {
      signingSecret = decryptString(row.secretEnc);
    } catch {
      signingSecret = null;
    }
  }
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as InboundKind,
    ruleId: row.ruleId,
    tokenHash: row.tokenHash,
    signingSecret,
    hasSecret: row.secretEnc !== null && row.secretEnc !== undefined,
  };
}

/** A connection as processing reads it. No secrets. */
export async function connectionRef(connectionId: string): Promise<InboundConnectionRef | null> {
  const rows = await db()
    .select({
      id: inboundConnections.id,
      workspaceId: inboundConnections.workspaceId,
      kind: inboundConnections.kind,
      ruleId: inboundConnections.ruleId,
      externalAccountId: inboundConnections.externalAccountId,
    })
    .from(inboundConnections)
    .where(eq(inboundConnections.id, connectionId))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, kind: row.kind as InboundKind } : null;
}

// ---- PostHog Inbox push ------------------------------------------------------

/** The workspace's PostHog Inbox webhook URL for one PostHog project, without its secrets. */
export interface PostHogInboxPushConnectionRow {
  id: string;
  workspaceId: string;
  projectId: string;
  secretRequired: boolean;
  createdAt: Date;
  rotatedAt: Date | null;
  lastDeliveryAt: Date | null;
  /** The PostHog destination Talyn created for this URL, or null. */
  destinationId: string | null;
  destinationSyncedAt: Date | null;
  /** Set when the destination is out of date (a rotate PostHog did not take). */
  destinationError: string | null;
}

/** The query behind {@link posthogInboxPushConnection}. Exported for the egress test. */
export function posthogInboxPushConnectionQuery(workspaceId: string, projectId: string) {
  return db()
    .select({
      id: inboundConnections.id,
      workspaceId: inboundConnections.workspaceId,
      projectId: inboundConnections.externalAccountId,
      // Only whether a secret exists: the encrypted envelope never leaves the database here.
      secretRequired: sql<boolean>`${inboundConnections.secretEnc} IS NOT NULL`,
      createdAt: inboundConnections.createdAt,
      rotatedAt: inboundConnections.rotatedAt,
      destinationId: inboundConnections.posthogDestinationId,
      destinationSyncedAt: inboundConnections.posthogDestinationSyncedAt,
      destinationError: inboundConnections.posthogDestinationError,
    })
    .from(inboundConnections)
    .where(
      and(
        eq(inboundConnections.workspaceId, workspaceId),
        eq(inboundConnections.kind, 'posthog_inbox'),
        eq(inboundConnections.externalAccountId, projectId)
      )
    )
    .limit(1);
}

export async function posthogInboxPushConnection(
  workspaceId: string,
  projectId: string
): Promise<PostHogInboxPushConnectionRow | null> {
  const rows = await posthogInboxPushConnectionQuery(workspaceId, projectId);
  const row = rows[0];
  if (!row?.projectId) return null;
  const last = await db()
    .select({ at: max(inboundDeliveries.receivedAt) })
    .from(inboundDeliveries)
    .where(eq(inboundDeliveries.connectionId, row.id));
  const at = last[0]?.at;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    secretRequired: Boolean(row.secretRequired),
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    lastDeliveryAt: at ? new Date(at) : null,
    destinationId: row.destinationId ?? null,
    destinationSyncedAt: row.destinationSyncedAt ?? null,
    destinationError: row.destinationError ?? null,
  };
}

/**
 * Make or replace the workspace's PostHog Inbox webhook URL for one PostHog
 * project. The old URL stops working at once. With `requireSecret`, every
 * request must carry the new secret in `X-Talyn-Secret`; without it, the URL
 * token alone is the credential.
 *
 * A workspace reads one PostHog project at a time, so a URL for any other
 * project is deleted: its pushes could only name reports the connection
 * cannot read.
 *
 * The PostHog destination fields stay as they are unless `destination` sets
 * them. "Set up push in PostHog" mints the secrets first (`minted`, with the
 * row id it will use as `connectionId`), saves the destination in PostHog,
 * and only then calls this, so a PostHog failure changes nothing here.
 */
export async function rotatePostHogInboxPushConnection(
  workspaceId: string,
  projectId: string,
  opts: {
    requireSecret: boolean;
    createdBy: string;
    minted?: WebhookSecrets;
    /** The id for a new row. Ignored when the row exists. */
    connectionId?: string;
    destination?: PostHogInboxDestinationState;
  }
): Promise<{ connectionId: string; token: string; secret: string | null; created: boolean }> {
  const minted = opts.minted ?? mintWebhookSecrets();
  const secret = opts.requireSecret ? minted.signingSecret : null;
  const now = new Date();
  const destination = opts.destination ? destinationColumns(opts.destination) : {};
  return db().transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await txDb
      .delete(inboundConnections)
      .where(
        and(
          eq(inboundConnections.workspaceId, workspaceId),
          eq(inboundConnections.kind, 'posthog_inbox'),
          ne(inboundConnections.externalAccountId, projectId)
        )
      );
    const updated = await txDb
      .update(inboundConnections)
      .set({
        tokenHash: minted.tokenHash,
        secretEnc: secret ? encryptString(secret) : null,
        rotatedAt: now,
        updatedAt: now,
        ...destination,
      })
      .where(
        and(
          eq(inboundConnections.workspaceId, workspaceId),
          eq(inboundConnections.kind, 'posthog_inbox'),
          eq(inboundConnections.externalAccountId, projectId)
        )
      )
      .returning({ id: inboundConnections.id });
    if (updated[0]) return { connectionId: updated[0].id, token: minted.token, secret, created: false };
    const connectionId = opts.connectionId ?? uuid();
    await txDb.insert(inboundConnections).values({
      id: connectionId,
      workspaceId,
      kind: 'posthog_inbox',
      externalAccountId: projectId,
      tokenHash: minted.tokenHash,
      secretEnc: secret ? encryptString(secret) : null,
      createdBy: opts.createdBy,
      ...destination,
    });
    return { connectionId, token: minted.token, secret, created: true };
  });
}

/** What Talyn knows about its PostHog destination for one URL. */
export interface PostHogInboxDestinationState {
  id: string | null;
  syncedAt: Date | null;
  error: string | null;
}

function destinationColumns(state: PostHogInboxDestinationState) {
  return {
    posthogDestinationId: state.id,
    posthogDestinationSyncedAt: state.syncedAt,
    posthogDestinationError: state.error,
  };
}

/** Record what happened to the PostHog destination of one URL row. */
export async function setPostHogInboxDestination(connectionId: string, state: PostHogInboxDestinationState): Promise<void> {
  await db()
    .update(inboundConnections)
    .set({ ...destinationColumns(state), updatedAt: new Date() })
    .where(and(eq(inboundConnections.id, connectionId), eq(inboundConnections.kind, 'posthog_inbox')));
}

/** The workspace's PostHog Inbox URL rows that have a Talyn destination. */
export async function posthogInboxDestinations(
  workspaceId: string
): Promise<Array<{ connectionId: string; projectId: string | null; destinationId: string }>> {
  const rows = await db()
    .select({
      connectionId: inboundConnections.id,
      projectId: inboundConnections.externalAccountId,
      destinationId: inboundConnections.posthogDestinationId,
    })
    .from(inboundConnections)
    .where(
      and(
        eq(inboundConnections.workspaceId, workspaceId),
        eq(inboundConnections.kind, 'posthog_inbox'),
        isNotNull(inboundConnections.posthogDestinationId)
      )
    );
  return rows.flatMap((r) =>
    r.destinationId ? [{ connectionId: r.connectionId, projectId: r.projectId, destinationId: r.destinationId }] : []
  );
}

/** Delete the workspace's PostHog Inbox webhook URLs and, by cascade, their deliveries. */
export async function deletePostHogInboxPushConnections(workspaceId: string): Promise<number> {
  const rows = await db()
    .delete(inboundConnections)
    .where(and(eq(inboundConnections.workspaceId, workspaceId), eq(inboundConnections.kind, 'posthog_inbox')))
    .returning({ id: inboundConnections.id });
  return rows.length;
}

// ---- Deliveries --------------------------------------------------------------

export interface NewDelivery {
  connectionId: string;
  deliveryId: string;
  eventType: string;
  payload: unknown;
  headers: Record<string, string>;
  payloadBytes: number;
  replayOf?: string | null;
}

/**
 * Store one request. `inserted` is true only for the call whose insert won:
 * a resend and the other replica get false, and the id of the row that is
 * already there.
 */
export async function insertDelivery(input: NewDelivery): Promise<{ id: string; inserted: boolean }> {
  const id = uuid();
  const rows = await db()
    .insert(inboundDeliveries)
    .values({
      id,
      connectionId: input.connectionId,
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      payload: input.payload ?? null,
      headers: input.headers,
      payloadBytes: input.payloadBytes,
      replayOf: input.replayOf ?? null,
    })
    .onConflictDoNothing({ target: [inboundDeliveries.connectionId, inboundDeliveries.deliveryId] })
    .returning({ id: inboundDeliveries.id });
  if (rows[0]) return { id: rows[0].id, inserted: true };
  const existing = await db()
    .select({ id: inboundDeliveries.id })
    .from(inboundDeliveries)
    .where(
      and(eq(inboundDeliveries.connectionId, input.connectionId), eq(inboundDeliveries.deliveryId, input.deliveryId))
    )
    .limit(1);
  return { id: existing[0]?.id ?? id, inserted: false };
}

/** The list projection: never the body, never the headers. */
const SUMMARY_COLUMNS = {
  id: inboundDeliveries.id,
  connectionId: inboundDeliveries.connectionId,
  deliveryId: inboundDeliveries.deliveryId,
  eventType: inboundDeliveries.eventType,
  receivedAt: inboundDeliveries.receivedAt,
  processedAt: inboundDeliveries.processedAt,
  attempts: inboundDeliveries.attempts,
  outcome: inboundDeliveries.outcome,
  error: inboundDeliveries.error,
  replayOf: inboundDeliveries.replayOf,
  payloadBytes: inboundDeliveries.payloadBytes,
} as const;

type SummaryRow = Pick<typeof inboundDeliveries.$inferSelect, keyof typeof SUMMARY_COLUMNS>;

function toSummary(row: SummaryRow): InboundDeliverySummary {
  return {
    id: row.id,
    connectionId: row.connectionId,
    deliveryId: row.deliveryId,
    eventType: row.eventType,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt ? row.processedAt.toISOString() : null,
    attempts: row.attempts,
    outcome: (row.outcome as InboundDeliveryOutcome | null) ?? null,
    error: row.error,
    replayOf: row.replayOf,
    payloadBytes: row.payloadBytes,
  };
}

/**
 * A page of one connection's deliveries, newest first. Keyset on
 * `received_at`: `cursor` is the `receivedAt` of the last row the caller has.
 * Exported so the egress test can read its SQL.
 */
export function listDeliveriesQuery(connectionId: string, opts: { limit: number; cursor?: string | null }) {
  const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
  const valid = cursorDate && !Number.isNaN(cursorDate.getTime()) ? cursorDate : null;
  return db()
    .select(SUMMARY_COLUMNS)
    .from(inboundDeliveries)
    .where(
      valid
        ? and(eq(inboundDeliveries.connectionId, connectionId), lt(inboundDeliveries.receivedAt, valid))
        : eq(inboundDeliveries.connectionId, connectionId)
    )
    .orderBy(desc(inboundDeliveries.receivedAt))
    .limit(opts.limit);
}

export async function listDeliveries(
  connectionId: string,
  opts: { limit: number; cursor?: string | null }
): Promise<InboundDeliverySummary[]> {
  return (await listDeliveriesQuery(connectionId, opts)).map(toSummary);
}

export async function deliverySummary(connectionId: string, id: string): Promise<InboundDeliverySummary | null> {
  const rows = await db()
    .select(SUMMARY_COLUMNS)
    .from(inboundDeliveries)
    .where(and(eq(inboundDeliveries.connectionId, connectionId), eq(inboundDeliveries.id, id)))
    .limit(1);
  return rows[0] ? toSummary(rows[0]) : null;
}

/** One delivery with its body and kept headers. */
export async function getDelivery(connectionId: string, id: string): Promise<InboundDelivery | null> {
  const rows = await db()
    .select({ ...SUMMARY_COLUMNS, payload: inboundDeliveries.payload, headers: inboundDeliveries.headers })
    .from(inboundDeliveries)
    .where(and(eq(inboundDeliveries.connectionId, connectionId), eq(inboundDeliveries.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...toSummary(row), payload: row.payload ?? null, headers: row.headers ?? {} };
}

/**
 * Copy a delivery as a new one, `delivery_id = <orig>:replay:<n>`, so the
 * rule's run claim (`workflow_id`, delivery id) is fresh and the rule runs
 * again. A replay of a replay counts from the first request.
 *
 * `n` is one more than the replays already stored. Two replays at the same
 * moment can pick the same `n`; the loser takes the next one.
 */
export async function replayDelivery(connectionId: string, id: string): Promise<{ id: string } | null> {
  const original = await db()
    .select({
      id: inboundDeliveries.id,
      deliveryId: inboundDeliveries.deliveryId,
      eventType: inboundDeliveries.eventType,
      payload: inboundDeliveries.payload,
      headers: inboundDeliveries.headers,
      payloadBytes: inboundDeliveries.payloadBytes,
      replayOf: inboundDeliveries.replayOf,
    })
    .from(inboundDeliveries)
    .where(and(eq(inboundDeliveries.connectionId, connectionId), eq(inboundDeliveries.id, id)))
    .limit(1);
  const row = original[0];
  if (!row) return null;

  let rootId = row.id;
  let rootDeliveryId = row.deliveryId;
  if (row.replayOf) {
    const root = await db()
      .select({ id: inboundDeliveries.id, deliveryId: inboundDeliveries.deliveryId })
      .from(inboundDeliveries)
      .where(eq(inboundDeliveries.id, row.replayOf))
      .limit(1);
    if (root[0]) {
      rootId = root[0].id;
      rootDeliveryId = root[0].deliveryId;
    }
  }

  const existing = await db()
    .select({ n: count() })
    .from(inboundDeliveries)
    .where(eq(inboundDeliveries.replayOf, rootId));
  let n = Number(existing[0]?.n ?? 0) + 1;
  // Each lost race moves on by one. Concurrent presses are a person
  // clicking, so a handful of tries covers them.
  for (let tries = 0; tries < 5; tries++, n++) {
    const stored = await insertDelivery({
      connectionId,
      deliveryId: `${rootDeliveryId}:replay:${n}`,
      eventType: row.eventType,
      payload: row.payload,
      headers: row.headers ?? {},
      payloadBytes: row.payloadBytes,
      replayOf: rootId,
    });
    if (stored.inserted) return { id: stored.id };
  }
  throw new Error('Could not store the replay. Try again.');
}

/**
 * A delivery's body and kept headers, by row id, for a parked run's retry:
 * the run row does not store the body. Null when the row is gone (7 days).
 */
export async function deliveryBody(
  id: string
): Promise<{ payload: unknown; headers: Record<string, string> } | null> {
  const rows = await db()
    .select({ payload: inboundDeliveries.payload, headers: inboundDeliveries.headers })
    .from(inboundDeliveries)
    .where(eq(inboundDeliveries.id, id))
    .limit(1);
  const row = rows[0];
  return row ? { payload: row.payload ?? null, headers: row.headers ?? {} } : null;
}
