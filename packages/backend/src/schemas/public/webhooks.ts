import { WEBHOOK_EVENT_TYPES } from '../../services/apiWebhooks/events.js';
import { DELIVERY_STATUSES } from '../../services/apiWebhooks/store.js';
import { MAX_WEBHOOK_URL_LENGTH } from '../../services/apiWebhooks/urlPolicy.js';
import { Id, listOf, PageQuery, Timestamp } from './common.js';
import { z } from './zod.js';

/** Request and response schemas of `/v1/webhooks` and `/v1/webhook-deliveries`. */

const EventTypeEnum = z.enum(WEBHOOK_EVENT_TYPES);

export const WebhookEndpoint = z
  .object({
    object: z.literal('webhook_endpoint'),
    id: Id,
    workspace_id: Id.nullable().openapi({ description: 'The workspace whose events it receives. Null: every workspace of the owner.' }),
    url: z.string().openapi({ example: 'https://example.com/talyn/webhooks' }),
    description: z.string().nullable(),
    event_types: z.array(EventTypeEnum).openapi({ description: 'The events it receives. Empty: every event.' }),
    enabled: z.boolean(),
    disabled_reason: z.string().nullable().openapi({ description: 'Why Talyn or a caller disabled it.' }),
    disabled_at: Timestamp.nullable(),
    consecutive_failures: z.number().int().openapi({ description: 'Failed attempts since the last success.' }),
    failing_since: Timestamp.nullable().openapi({ description: 'The first failed attempt of the current streak.' }),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .openapi('WebhookEndpoint');

export const WebhookEndpointWithSecret = WebhookEndpoint.extend({
  secret: z.string().openapi({
    description: 'The signing secret (`whsec_...`). Shown only in this answer. Store it now.',
    example: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  }),
}).openapi('WebhookEndpointWithSecret');

export const WebhookEndpointList = listOf(WebhookEndpoint, 'WebhookEndpointList');

export const ListWebhookEndpointsQuery = z.object(PageQuery).strict();

const WebhookUrl = z.string().min(1).max(MAX_WEBHOOK_URL_LENGTH).openapi({
  description: 'An https URL on the public internet. Private, loopback and link-local addresses are refused.',
});
const Description = z.string().max(500);
const EventTypes = z
  .array(EventTypeEnum)
  .max(WEBHOOK_EVENT_TYPES.length)
  .transform((types) => [...new Set(types)])
  .openapi({ description: 'The events to receive. Empty or absent: every event, including events added later.' });

export const CreateWebhookEndpointBody = z
  .object({
    url: WebhookUrl,
    description: Description.optional(),
    workspace_id: Id.optional().openapi({
      description:
        'Receive the events of this workspace only. Absent: every workspace of the owner. A token bound to workspaces must name one of them, unless it is bound to exactly one.',
    }),
    event_types: EventTypes.optional(),
    enabled: z.boolean().optional().openapi({ description: 'Default true.' }),
  })
  .strict()
  .openapi('CreateWebhookEndpointRequest');

export const UpdateWebhookEndpointBody = z
  .object({
    url: WebhookUrl.optional(),
    description: Description.nullable().optional(),
    event_types: EventTypes.optional(),
    enabled: z.boolean().optional().openapi({
      description: 'False stops deliveries and abandons the pending ones. True clears `disabled_reason` and the failure streak.',
    }),
  })
  .strict()
  .openapi('UpdateWebhookEndpointRequest');

/** The longest the previous secret can keep signing after a rotation: 3 days. */
const MAX_PREVIOUS_SECRET_SECONDS = 3 * 24 * 60 * 60;

export const RotateWebhookSecretBody = z
  .object({
    expire_previous_in_seconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_PREVIOUS_SECRET_SECONDS)
      .optional()
      .openapi({
        description:
          'How long the old secret also signs, so you can deploy the new one first. Default 86400 (24 hours). 0 stops it now.',
      }),
  })
  .strict()
  .openapi('RotateWebhookSecretRequest');

export const WebhookDelivery = z
  .object({
    object: z.literal('webhook_delivery'),
    id: Id,
    endpoint_id: Id,
    event_id: z.string().openapi({ description: 'The `webhook-id` header. The same for every attempt and every redelivery.' }),
    event_type: z.string().openapi({ example: 'session.updated' }),
    status: z.enum(DELIVERY_STATUSES).openapi({
      description:
        '`pending`: waiting for an attempt. `succeeded`: a 2xx answer. `failed`: every attempt failed, or the endpoint answered 410. `abandoned`: the endpoint was disabled first.',
    }),
    attempt_count: z.number().int(),
    next_attempt_at: Timestamp.nullable().openapi({ description: 'When the next attempt is due. Null unless `pending`.' }),
    last_response_status: z.number().int().nullable(),
    last_error: z.string().nullable(),
    last_response_ms: z.number().int().nullable(),
    created_at: Timestamp,
    delivered_at: Timestamp.nullable(),
  })
  .openapi('WebhookDelivery');

export const WebhookDeliveryWithPayload = WebhookDelivery.extend({
  payload: z.record(z.unknown()).openapi({ description: 'The event body, as sent.' }),
}).openapi('WebhookDeliveryWithPayload');

export const WebhookDeliveryList = listOf(WebhookDelivery, 'WebhookDeliveryList');

export const ListWebhookDeliveriesQuery = z
  .object({
    status: z.enum(DELIVERY_STATUSES).optional(),
    ...PageQuery,
  })
  .strict();

export const WebhookEventType = z
  .object({
    object: z.literal('webhook_event_type'),
    type: EventTypeEnum,
    description: z.string(),
  })
  .openapi('WebhookEventType');

export const WebhookEventTypeList = z
  .object({
    object: z.literal('list'),
    data: z.array(WebhookEventType),
    has_more: z.literal(false),
    next_cursor: z.null(),
  })
  .openapi('WebhookEventTypeList');
