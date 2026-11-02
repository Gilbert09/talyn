import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { getPoolDbClient } from '../../db/client.js';
import { apiWebhookDeliveries as deliveriesTable, apiWebhookEndpoints as endpointsTable } from '../../db/schema.js';
import { afterCursor, cursorTimeColumn, type ListCursor } from '../public/cursor.js';
import { decryptString, encryptString } from '../tokenCrypto.js';
import type { WebhookEnvelope } from './events.js';
import { generateWebhookSecret } from './signing.js';

/**
 * Endpoint and delivery rows, and their public shapes. Like
 * `services/public/projections.ts`: an explicit column list (what is read) and
 * a mapper (what is sent). The secret columns are in no public column list,
 * so no mapper can send one; the plaintext secret leaves only in the create
 * and rotate answers.
 */

const db = () => getPoolDbClient();

/**
 * Endpoints per owner. Each endpoint gets its own copy of every event it
 * matches and its own outbound requests, so the cap bounds the fan-out of one
 * account. 20 is the same order as the 20 open streams a token may hold, the
 * other per-account fan-out in this API; a receiver can fan out further itself.
 */
export const MAX_WEBHOOK_ENDPOINTS_PER_OWNER = 20;

/** How long the previous secret still signs after a rotation, unless the caller says otherwise. */
export const DEFAULT_PREVIOUS_SECRET_TTL_SECONDS = 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const PUBLIC_WEBHOOK_ENDPOINT_COLUMNS = {
  id: endpointsTable.id,
  ownerId: endpointsTable.ownerId,
  workspaceId: endpointsTable.workspaceId,
  url: endpointsTable.url,
  description: endpointsTable.description,
  eventTypes: endpointsTable.eventTypes,
  enabled: endpointsTable.enabled,
  disabledReason: endpointsTable.disabledReason,
  disabledAt: endpointsTable.disabledAt,
  consecutiveFailures: endpointsTable.consecutiveFailures,
  failingSince: endpointsTable.failingSince,
  createdAt: endpointsTable.createdAt,
  updatedAt: endpointsTable.updatedAt,
  cursorTime: cursorTimeColumn(endpointsTable.createdAt),
} as const;

export type WebhookEndpointRow = Pick<
  typeof endpointsTable.$inferSelect,
  Exclude<keyof typeof PUBLIC_WEBHOOK_ENDPOINT_COLUMNS, 'cursorTime'>
>;

export function toPublicWebhookEndpoint(row: WebhookEndpointRow, secret?: string) {
  return {
    object: 'webhook_endpoint' as const,
    id: row.id,
    workspace_id: row.workspaceId ?? null,
    url: row.url,
    description: row.description ?? null,
    event_types: row.eventTypes ?? [],
    enabled: row.enabled,
    disabled_reason: row.disabledReason ?? null,
    disabled_at: row.disabledAt ? row.disabledAt.toISOString() : null,
    consecutive_failures: row.consecutiveFailures,
    failing_since: row.failingSince ? row.failingSince.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    ...(secret !== undefined ? { secret } : {}),
  };
}

export function getEndpointQuery(id: string) {
  return db().select(PUBLIC_WEBHOOK_ENDPOINT_COLUMNS).from(endpointsTable).where(eq(endpointsTable.id, id)).limit(1);
}

export function listEndpointsQuery(ownerId: string, workspaceIds: string[] | null, cursor: ListCursor | null, limit: number) {
  return db()
    .select(PUBLIC_WEBHOOK_ENDPOINT_COLUMNS)
    .from(endpointsTable)
    .where(
      and(
        eq(endpointsTable.ownerId, ownerId),
        // A workspace-bound token sees only endpoints bound to its workspaces.
        workspaceIds ? inArray(endpointsTable.workspaceId, workspaceIds) : undefined,
        afterCursor(endpointsTable.createdAt, endpointsTable.id, cursor),
      ),
    )
    .orderBy(desc(endpointsTable.createdAt), desc(endpointsTable.id))
    .limit(limit + 1);
}

export async function countOwnerEndpoints(ownerId: string): Promise<number> {
  const [row] = await db().select({ n: count() }).from(endpointsTable).where(eq(endpointsTable.ownerId, ownerId));
  return Number(row?.n ?? 0);
}

export async function insertEndpoint(input: {
  ownerId: string;
  workspaceId: string | null;
  url: string;
  description: string | null;
  eventTypes: string[];
  enabled: boolean;
}): Promise<{ row: WebhookEndpointRow; secret: string }> {
  const secret = generateWebhookSecret();
  const [row] = await db()
    .insert(endpointsTable)
    .values({
      id: uuid(),
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      url: input.url,
      description: input.description,
      eventTypes: input.eventTypes,
      enabled: input.enabled,
      disabledAt: input.enabled ? null : new Date(),
      secretEnc: encryptString(secret),
    })
    .returning(PUBLIC_WEBHOOK_ENDPOINT_COLUMNS);
  return { row, secret };
}

export async function updateEndpoint(
  id: string,
  patch: { url?: string; description?: string | null; eventTypes?: string[]; enabled?: boolean },
): Promise<WebhookEndpointRow | null> {
  const set: Partial<typeof endpointsTable.$inferInsert> = { updatedAt: new Date() };
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.eventTypes !== undefined) set.eventTypes = patch.eventTypes;
  if (patch.enabled === true) {
    // Switching it on again is a fresh start: the reason and the streak go.
    Object.assign(set, { enabled: true, disabledReason: null, disabledAt: null, consecutiveFailures: 0, failingSince: null });
  } else if (patch.enabled === false) {
    Object.assign(set, { enabled: false, disabledReason: 'Disabled through the API.', disabledAt: new Date() });
  }
  const [row] = await db().update(endpointsTable).set(set).where(eq(endpointsTable.id, id)).returning(PUBLIC_WEBHOOK_ENDPOINT_COLUMNS);
  if (row && patch.enabled === false) await abandonPendingDeliveries(id);
  return row ?? null;
}

export async function deleteEndpoint(id: string): Promise<boolean> {
  const rows = await db().delete(endpointsTable).where(eq(endpointsTable.id, id)).returning({ id: endpointsTable.id });
  return rows.length > 0;
}

/** A new secret; the old one keeps signing for `previousTtlSeconds` (0: stops now). */
export async function rotateEndpointSecret(
  id: string,
  previousTtlSeconds: number,
  now: Date = new Date(),
): Promise<{ row: WebhookEndpointRow; secret: string } | null> {
  const secret = generateWebhookSecret();
  const [row] = await db()
    .update(endpointsTable)
    .set({
      previousSecretEnc: previousTtlSeconds > 0 ? sql`${endpointsTable.secretEnc}` : null,
      previousSecretExpiresAt: previousTtlSeconds > 0 ? new Date(now.getTime() + previousTtlSeconds * 1000) : null,
      secretEnc: encryptString(secret),
      updatedAt: now,
    })
    .where(eq(endpointsTable.id, id))
    .returning(PUBLIC_WEBHOOK_ENDPOINT_COLUMNS);
  return row ? { row, secret } : null;
}

/** The current secret in plaintext, for an idempotent replay of create or rotate. Null when the endpoint is gone. */
export async function currentEndpointSecret(id: string): Promise<string | null> {
  const [row] = await db().select({ secretEnc: endpointsTable.secretEnc }).from(endpointsTable).where(eq(endpointsTable.id, id)).limit(1);
  return row ? decryptString(row.secretEnc) : null;
}

/** What the worker needs to send: the URL and every secret that signs now. */
export async function endpointsForDelivery(ids: string[], now: Date = new Date()) {
  if (ids.length === 0) return new Map<string, { url: string; secrets: string[]; workspaceId: string | null; enabled: boolean }>();
  const rows = await db()
    .select({
      id: endpointsTable.id,
      url: endpointsTable.url,
      workspaceId: endpointsTable.workspaceId,
      enabled: endpointsTable.enabled,
      secretEnc: endpointsTable.secretEnc,
      previousSecretEnc: endpointsTable.previousSecretEnc,
      previousSecretExpiresAt: endpointsTable.previousSecretExpiresAt,
    })
    .from(endpointsTable)
    .where(inArray(endpointsTable.id, ids));
  const out = new Map<string, { url: string; secrets: string[]; workspaceId: string | null; enabled: boolean }>();
  for (const r of rows) {
    const secrets = [decryptString(r.secretEnc)];
    if (r.previousSecretEnc && r.previousSecretExpiresAt && r.previousSecretExpiresAt > now) {
      secrets.push(decryptString(r.previousSecretEnc));
    }
    out.set(r.id, { url: r.url, secrets, workspaceId: r.workspaceId, enabled: r.enabled });
  }
  return out;
}

/** Stop what an endpoint still owed. Its history stays. */
export async function abandonPendingDeliveries(endpointId: string, reason = 'The endpoint was disabled.'): Promise<number> {
  const rows = await db()
    .update(deliveriesTable)
    .set({ status: 'abandoned', lastError: reason, claimToken: null })
    .where(and(eq(deliveriesTable.endpointId, endpointId), eq(deliveriesTable.status, 'pending')))
    .returning({ id: deliveriesTable.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export const DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'abandoned'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** List items carry no payload: it is the one big column, and a list is opened to skim. */
export const PUBLIC_WEBHOOK_DELIVERY_COLUMNS = {
  id: deliveriesTable.id,
  endpointId: deliveriesTable.endpointId,
  eventId: deliveriesTable.eventId,
  eventType: deliveriesTable.eventType,
  status: deliveriesTable.status,
  attemptCount: deliveriesTable.attemptCount,
  nextAttemptAt: deliveriesTable.nextAttemptAt,
  lastResponseStatus: deliveriesTable.lastResponseStatus,
  lastError: deliveriesTable.lastError,
  lastResponseMs: deliveriesTable.lastResponseMs,
  createdAt: deliveriesTable.createdAt,
  deliveredAt: deliveriesTable.deliveredAt,
  cursorTime: cursorTimeColumn(deliveriesTable.createdAt),
} as const;

export const PUBLIC_WEBHOOK_DELIVERY_DETAIL_COLUMNS = {
  ...PUBLIC_WEBHOOK_DELIVERY_COLUMNS,
  payload: deliveriesTable.payload,
} as const;

export type WebhookDeliveryRow = Pick<
  typeof deliveriesTable.$inferSelect,
  Exclude<keyof typeof PUBLIC_WEBHOOK_DELIVERY_COLUMNS, 'cursorTime'>
> & { payload?: Record<string, unknown> };

export function toPublicWebhookDelivery(row: WebhookDeliveryRow) {
  const status = (DELIVERY_STATUSES as readonly string[]).includes(row.status) ? (row.status as DeliveryStatus) : 'failed';
  return {
    object: 'webhook_delivery' as const,
    id: row.id,
    endpoint_id: row.endpointId,
    event_id: row.eventId,
    event_type: row.eventType,
    status,
    attempt_count: row.attemptCount,
    next_attempt_at: status === 'pending' ? row.nextAttemptAt.toISOString() : null,
    last_response_status: row.lastResponseStatus ?? null,
    last_error: row.lastError ?? null,
    last_response_ms: row.lastResponseMs ?? null,
    created_at: row.createdAt.toISOString(),
    delivered_at: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    ...(row.payload !== undefined ? { payload: row.payload } : {}),
  };
}

export function listDeliveriesQuery(endpointId: string, statuses: DeliveryStatus[] | undefined, cursor: ListCursor | null, limit: number) {
  return db()
    .select(PUBLIC_WEBHOOK_DELIVERY_COLUMNS)
    .from(deliveriesTable)
    .where(
      and(
        eq(deliveriesTable.endpointId, endpointId),
        statuses && statuses.length > 0 ? inArray(deliveriesTable.status, statuses) : undefined,
        afterCursor(deliveriesTable.createdAt, deliveriesTable.id, cursor),
      ),
    )
    .orderBy(desc(deliveriesTable.createdAt), desc(deliveriesTable.id))
    .limit(limit + 1);
}

export function getDeliveryQuery(id: string) {
  return db().select(PUBLIC_WEBHOOK_DELIVERY_DETAIL_COLUMNS).from(deliveriesTable).where(eq(deliveriesTable.id, id)).limit(1);
}

/** Enqueue one event for these endpoints. The unique key makes a repeat a no-op. Returns the rows inserted. */
export async function enqueueDeliveries(endpointIds: string[], envelope: WebhookEnvelope): Promise<number> {
  if (endpointIds.length === 0) return 0;
  const rows = await db()
    .insert(deliveriesTable)
    .values(
      endpointIds.map((endpointId) => ({
        id: uuid(),
        endpointId,
        eventId: envelope.id,
        eventType: envelope.type,
        payload: envelope as unknown as Record<string, unknown>,
      })),
    )
    .onConflictDoNothing({ target: [deliveriesTable.endpointId, deliveriesTable.eventId] })
    .returning({ id: deliveriesTable.id });
  return rows.length;
}

/** Enqueue one event for one endpoint and return the delivery row (a test ping). */
export async function enqueueSingleDelivery(endpointId: string, envelope: WebhookEnvelope): Promise<WebhookDeliveryRow> {
  const [row] = await db()
    .insert(deliveriesTable)
    .values({
      id: uuid(),
      endpointId,
      eventId: envelope.id,
      eventType: envelope.type,
      payload: envelope as unknown as Record<string, unknown>,
    })
    .returning(PUBLIC_WEBHOOK_DELIVERY_COLUMNS);
  return row;
}

/**
 * Send a delivery again from the first attempt. Refused (null) while it is
 * still pending: a claimed row is in flight, and the worker owns it.
 */
export async function resetDeliveryForRedelivery(id: string): Promise<WebhookDeliveryRow | null> {
  const [row] = await db()
    .update(deliveriesTable)
    .set({
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: new Date(),
      claimToken: null,
      lastError: null,
      deliveredAt: null,
    })
    .where(and(eq(deliveriesTable.id, id), sql`${deliveriesTable.status} <> 'pending'`))
    .returning(PUBLIC_WEBHOOK_DELIVERY_COLUMNS);
  return row ?? null;
}
