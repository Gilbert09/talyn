import type { ApiTokenPrincipal } from '../../services/apiTokens.js';
import { invalidateWebhookTargets } from '../../services/apiWebhooks/dispatch.js';
import { buildEnvelope, WEBHOOK_EVENT_DESCRIPTIONS, WEBHOOK_EVENT_TYPES } from '../../services/apiWebhooks/events.js';
import {
  countOwnerEndpoints,
  currentEndpointSecret,
  DEFAULT_PREVIOUS_SECRET_TTL_SECONDS,
  deleteEndpoint,
  enqueueSingleDelivery,
  getDeliveryQuery,
  getEndpointQuery,
  insertEndpoint,
  listDeliveriesQuery,
  listEndpointsQuery,
  MAX_WEBHOOK_ENDPOINTS_PER_OWNER,
  resetDeliveryForRedelivery,
  rotateEndpointSecret,
  toPublicWebhookDelivery,
  toPublicWebhookEndpoint,
  updateEndpoint,
  type WebhookEndpointRow,
} from '../../services/apiWebhooks/store.js';
import { assertWebhookUrlAllowed, WebhookUrlError } from '../../services/apiWebhooks/urlPolicy.js';
import { webhookDeliveryWorker } from '../../services/apiWebhooks/worker.js';
import { authorizeWorkspace, resolveWorkspaceId } from '../../services/public/authorize.js';
import { decodeCursor, pageOf } from '../../services/public/cursor.js';
import { invalid, notFound, PublicApiError } from '../../services/public/errors.js';
import { IdParams } from '../../schemas/public/resources.js';
import {
  CreateWebhookEndpointBody,
  ListWebhookDeliveriesQuery,
  ListWebhookEndpointsQuery,
  RotateWebhookSecretBody,
  UpdateWebhookEndpointBody,
  WebhookDelivery,
  WebhookDeliveryList,
  WebhookDeliveryWithPayload,
  WebhookEndpoint,
  WebhookEndpointList,
  WebhookEndpointWithSecret,
  WebhookEventTypeList,
} from '../../schemas/public/webhooks.js';
import { definePublicRoute, type PublicRoute } from './define.js';

/**
 * Webhook endpoints and their deliveries. An endpoint belongs to the token's
 * owner. A token bound to workspaces reaches only the endpoints bound to one
 * of them; anything else is 404, like every other `/v1` resource.
 */

function endpointVisible(token: ApiTokenPrincipal, row: Pick<WebhookEndpointRow, 'ownerId' | 'workspaceId'>): boolean {
  if (row.ownerId !== token.ownerId) return false;
  if (token.workspaceIds) return row.workspaceId !== null && token.workspaceIds.includes(row.workspaceId);
  return true;
}

async function authorizedEndpoint(token: ApiTokenPrincipal, id: string): Promise<WebhookEndpointRow> {
  const [row] = await getEndpointQuery(id);
  if (!row || !endpointVisible(token, row)) throw notFound('webhook_endpoint');
  return row;
}

async function authorizedDelivery(token: ApiTokenPrincipal, id: string) {
  const [delivery] = await getDeliveryQuery(id);
  if (!delivery) throw notFound('webhook_delivery');
  const [endpoint] = await getEndpointQuery(delivery.endpointId);
  if (!endpoint || !endpointVisible(token, endpoint)) throw notFound('webhook_delivery');
  return { delivery, endpoint };
}

async function checkUrl(url: string): Promise<string> {
  try {
    return (await assertWebhookUrlAllowed(url)).toString();
  } catch (err) {
    if (err instanceof WebhookUrlError) throw invalid(err.message, 'url', 'invalid_webhook_url');
    throw err;
  }
}

function refuseDisabled(row: WebhookEndpointRow): void {
  if (!row.enabled) {
    throw new PublicApiError(409, 'webhook_endpoint_disabled', 'This endpoint is disabled. Enable it first with PATCH.');
  }
}

/** The idempotency record keeps the answer without its secret... */
function withoutSecret(body: unknown): unknown {
  const { secret: _secret, ...rest } = body as Record<string, unknown>;
  return rest;
}

/** ...and a replay reads the endpoint's current secret again. */
async function withCurrentSecret(stored: unknown): Promise<unknown> {
  const body = stored as Record<string, unknown>;
  const secret = typeof body.id === 'string' ? await currentEndpointSecret(body.id) : null;
  return secret ? { ...body, secret } : body;
}

export const webhookRoutes: PublicRoute[] = [
  definePublicRoute({
    method: 'get',
    path: '/webhooks',
    operationId: 'listWebhookEndpoints',
    summary: 'List webhook endpoints',
    description: 'Your webhook endpoints, newest first.',
    tag: 'Webhooks',
    scope: 'webhooks:read',
    query: ListWebhookEndpointsQuery,
    responses: { 200: { description: 'A page of endpoints. Secrets are never listed.', schema: WebhookEndpointList } },
    async handler({ query, token }) {
      const rows = await listEndpointsQuery(token.ownerId, token.workspaceIds, decodeCursor(query.cursor), query.limit);
      const page = pageOf(rows, query.limit);
      return {
        status: 200,
        body: {
          object: 'list',
          data: page.rows.map((r) => toPublicWebhookEndpoint(r)),
          has_more: page.hasMore,
          next_cursor: page.nextCursor,
        },
      };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/webhooks',
    operationId: 'createWebhookEndpoint',
    summary: 'Create a webhook endpoint',
    description:
      `Talyn signs each delivery with the secret in the answer (Standard Webhooks). The secret is shown only here and after a rotation. ` +
      `An account can have ${MAX_WEBHOOK_ENDPOINTS_PER_OWNER} endpoints.`,
    tag: 'Webhooks',
    scope: 'webhooks:write',
    creates: true,
    body: CreateWebhookEndpointBody,
    idempotentBody: withoutSecret,
    replayBody: withCurrentSecret,
    responses: { 201: { description: 'The new endpoint, with its secret.', schema: WebhookEndpointWithSecret } },
    async handler({ body, token }) {
      let workspaceId: string | null = null;
      if (body.workspace_id !== undefined) {
        await authorizeWorkspace(token, body.workspace_id);
        workspaceId = body.workspace_id;
      } else if (token.workspaceIds) {
        // A bound token cannot make an endpoint for workspaces it cannot reach.
        workspaceId = await resolveWorkspaceId(token, undefined);
      }
      const url = await checkUrl(body.url);
      if ((await countOwnerEndpoints(token.ownerId)) >= MAX_WEBHOOK_ENDPOINTS_PER_OWNER) {
        throw new PublicApiError(
          409,
          'webhook_endpoint_limit_reached',
          `An account can have ${MAX_WEBHOOK_ENDPOINTS_PER_OWNER} webhook endpoints. Delete one first.`,
          { details: { limit: MAX_WEBHOOK_ENDPOINTS_PER_OWNER } },
        );
      }
      const { row, secret } = await insertEndpoint({
        ownerId: token.ownerId,
        workspaceId,
        url,
        description: body.description?.trim() || null,
        eventTypes: body.event_types ?? [],
        enabled: body.enabled ?? true,
      });
      invalidateWebhookTargets();
      return { status: 201, body: toPublicWebhookEndpoint(row, secret) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/webhooks/{id}',
    operationId: 'getWebhookEndpoint',
    summary: 'Get a webhook endpoint',
    tag: 'Webhooks',
    scope: 'webhooks:read',
    params: IdParams,
    responses: { 200: { description: 'The endpoint, without its secret.', schema: WebhookEndpoint } },
    async handler({ params, token }) {
      return { status: 200, body: toPublicWebhookEndpoint(await authorizedEndpoint(token, params.id)) };
    },
  }),

  definePublicRoute({
    method: 'patch',
    path: '/webhooks/{id}',
    operationId: 'updateWebhookEndpoint',
    summary: 'Change a webhook endpoint',
    description: 'Change the URL, the description or the event types, or switch the endpoint off and on.',
    tag: 'Webhooks',
    scope: 'webhooks:write',
    params: IdParams,
    body: UpdateWebhookEndpointBody,
    responses: { 200: { description: 'The endpoint.', schema: WebhookEndpoint } },
    async handler({ params, body, token }) {
      const row = await authorizedEndpoint(token, params.id);
      const url = body.url !== undefined ? await checkUrl(body.url) : undefined;
      const updated = await updateEndpoint(row.id, {
        ...(url !== undefined ? { url } : {}),
        ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}),
        ...(body.event_types !== undefined ? { eventTypes: body.event_types } : {}),
        ...(body.enabled !== undefined && body.enabled !== row.enabled ? { enabled: body.enabled } : {}),
      });
      if (!updated) throw notFound('webhook_endpoint');
      invalidateWebhookTargets();
      return { status: 200, body: toPublicWebhookEndpoint(updated) };
    },
  }),

  definePublicRoute({
    method: 'delete',
    path: '/webhooks/{id}',
    operationId: 'deleteWebhookEndpoint',
    summary: 'Delete a webhook endpoint',
    description: 'Deletes the endpoint and its delivery history. Pending deliveries are not sent.',
    tag: 'Webhooks',
    scope: 'webhooks:write',
    params: IdParams,
    responses: { 204: { description: 'Deleted.' } },
    async handler({ params, token }) {
      const row = await authorizedEndpoint(token, params.id);
      await deleteEndpoint(row.id);
      invalidateWebhookTargets();
      return { status: 204 };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/webhooks/{id}/rotate-secret',
    operationId: 'rotateWebhookSecret',
    summary: "Rotate an endpoint's signing secret",
    description:
      'Makes a new secret and returns it once. The old secret also signs each delivery for `expire_previous_in_seconds` ' +
      '(default 24 hours), so the receiver can accept either while you deploy the new one.',
    tag: 'Webhooks',
    scope: 'webhooks:write',
    creates: true,
    params: IdParams,
    body: RotateWebhookSecretBody,
    idempotentBody: withoutSecret,
    replayBody: withCurrentSecret,
    responses: { 200: { description: 'The endpoint, with its new secret.', schema: WebhookEndpointWithSecret } },
    async handler({ params, body, token }) {
      const row = await authorizedEndpoint(token, params.id);
      const rotated = await rotateEndpointSecret(row.id, body.expire_previous_in_seconds ?? DEFAULT_PREVIOUS_SECRET_TTL_SECONDS);
      if (!rotated) throw notFound('webhook_endpoint');
      return { status: 200, body: toPublicWebhookEndpoint(rotated.row, rotated.secret) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/webhooks/{id}/test',
    operationId: 'testWebhookEndpoint',
    summary: 'Send a test event',
    description:
      'Queues a `ping` event to the endpoint. It is signed and retried like any other event. Read the delivery to see the answer.',
    tag: 'Webhooks',
    scope: 'webhooks:write',
    creates: true,
    params: IdParams,
    responses: { 202: { description: 'The queued delivery.', schema: WebhookDelivery } },
    async handler({ params, token }) {
      const row = await authorizedEndpoint(token, params.id);
      refuseDisabled(row);
      const envelope = buildEnvelope('ping', row.workspaceId, { object: toPublicWebhookEndpoint(row) });
      const delivery = await enqueueSingleDelivery(row.id, envelope);
      webhookDeliveryWorker.nudge();
      return { status: 202, body: toPublicWebhookDelivery(delivery) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/webhooks/{id}/deliveries',
    operationId: 'listWebhookDeliveries',
    summary: "List an endpoint's deliveries",
    description: 'Deliveries to one endpoint, newest first, without their payloads. Kept for 30 days.',
    tag: 'Webhooks',
    scope: 'webhooks:read',
    params: IdParams,
    query: ListWebhookDeliveriesQuery,
    responses: { 200: { description: 'A page of deliveries.', schema: WebhookDeliveryList } },
    async handler({ params, query, token }) {
      const row = await authorizedEndpoint(token, params.id);
      const rows = await listDeliveriesQuery(row.id, query.status ? [query.status] : undefined, decodeCursor(query.cursor), query.limit);
      const page = pageOf(rows, query.limit);
      return {
        status: 200,
        body: { object: 'list', data: page.rows.map(toPublicWebhookDelivery), has_more: page.hasMore, next_cursor: page.nextCursor },
      };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/webhook-deliveries/{id}',
    operationId: 'getWebhookDelivery',
    summary: 'Get a webhook delivery',
    tag: 'Webhooks',
    scope: 'webhooks:read',
    params: IdParams,
    responses: { 200: { description: 'The delivery, with the payload it sends.', schema: WebhookDeliveryWithPayload } },
    async handler({ params, token }) {
      const { delivery } = await authorizedDelivery(token, params.id);
      return { status: 200, body: toPublicWebhookDelivery(delivery) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/webhook-deliveries/{id}/redeliver',
    operationId: 'redeliverWebhookDelivery',
    summary: 'Send a delivery again',
    description:
      'Sends the same event again, from the first attempt, with the same `webhook-id`. Refused while the delivery is still pending.',
    tag: 'Webhooks',
    scope: 'webhooks:write',
    creates: true,
    params: IdParams,
    responses: { 202: { description: 'The delivery, pending again.', schema: WebhookDelivery } },
    async handler({ params, token }) {
      const { delivery, endpoint } = await authorizedDelivery(token, params.id);
      refuseDisabled(endpoint);
      const reset = await resetDeliveryForRedelivery(delivery.id);
      if (!reset) {
        throw new PublicApiError(409, 'delivery_pending', 'This delivery is still pending. Wait for it to finish.');
      }
      webhookDeliveryWorker.nudge();
      return { status: 202, body: toPublicWebhookDelivery(reset) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/webhook-event-types',
    operationId: 'listWebhookEventTypes',
    summary: 'List the webhook event types',
    tag: 'Webhooks',
    scope: 'webhooks:read',
    responses: { 200: { description: 'Every event type an endpoint can receive.', schema: WebhookEventTypeList } },
    async handler() {
      return {
        status: 200,
        body: {
          object: 'list',
          data: WEBHOOK_EVENT_TYPES.map((type) => ({ object: 'webhook_event_type', type, description: WEBHOOK_EVENT_DESCRIPTIONS[type] })),
          has_more: false,
          next_cursor: null,
        },
      };
    },
  }),
];
