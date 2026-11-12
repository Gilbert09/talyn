import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEventFacts,
} from '@talyn/shared';
import { workspaceMayUseWebhookRules } from '../../workflowsAccess.js';
import { webhookWorkflowSource, type WebhookWorkflowTarget } from '../../workflows/sources/webhook.js';
import { headerValue, type InboundAdapter, type InboundVerifyInput, type InboundVerifyResult } from '../adapter.js';

/**
 * The generic webhook: one URL per rule, for senders that cannot sign
 * (Zapier, n8n, a cron job).
 *
 * The URL token is the credential. Talyn stores only its sha256, so a leaked
 * table row cannot be turned back into a working URL. A sender that can sign
 * adds `X-Talyn-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body with
 * the rule's signing secret. When the header is present it must be valid.
 */

/**
 * The longest sender id or event name stored as given. Both are keys in a
 * btree index or labels in a list, and Postgres refuses a btree entry over
 * about 2.7 KB. A longer delivery id is stored as its sha256, which keeps it
 * unique. A longer event name is cut, because it is only a label.
 */
export const MAX_IDENTIFIER_CHARS = 200;

/**
 * How long the same body, sent without a delivery id, counts as one request.
 * Sender retries come within seconds to a few minutes (Zapier and n8n back off
 * for less than 10 minutes in total). A repeat job runs at most this often.
 */
export const BODY_DEDUPE_WINDOW_MS = 10 * 60_000;

/** 32 random bytes: the same strength as the signing secret. */
const TOKEN_BYTES = 32;

export interface WebhookSecrets {
  token: string;
  tokenHash: string;
  signingSecret: string;
}

export function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A new URL token and signing secret. Shown once, then only the hash is kept. */
export function mintWebhookSecrets(): WebhookSecrets {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return {
    token,
    tokenHash: hashWebhookToken(token),
    signingSecret: `whsec_${randomBytes(TOKEN_BYTES).toString('base64url')}`,
  };
}

/** Compare a presented token with a stored hash, in constant time. */
export function webhookTokenMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hashWebhookToken(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/** The `X-Talyn-Signature` value a sender computes for a body. */
export function webhookSignature(rawBody: Buffer | string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Check `X-Talyn-Signature`. `missing` when the header is absent. */
export function verifyWebhookSignature(
  rawBody: Buffer,
  header: string | null,
  secret: string | null
): 'valid' | 'invalid' | 'missing' {
  if (!header) return 'missing';
  if (!secret) return 'invalid';
  const a = Buffer.from(header.trim().toLowerCase());
  const b = Buffer.from(webhookSignature(rawBody, secret));
  if (a.length !== b.length) return 'invalid';
  return timingSafeEqual(a, b) ? 'valid' : 'invalid';
}

function verify(input: InboundVerifyInput): InboundVerifyResult {
  if (!input.urlToken) return 'missing';
  if (!input.connection.tokenHash) return 'invalid';
  if (!webhookTokenMatches(input.urlToken, input.connection.tokenHash)) return 'invalid';
  const signature = verifyWebhookSignature(
    input.rawBody,
    headerValue(input.headers, WEBHOOK_SIGNATURE_HEADER),
    input.connection.signingSecret
  );
  // The signature is optional. A header that is present and wrong is refused:
  // the sender meant to sign, so a mismatch is tampering or a wrong secret.
  return signature === 'invalid' ? 'invalid' : 'valid';
}

export const webhookAdapter: InboundAdapter<WebhookEventFacts, WebhookWorkflowTarget> = {
  kind: 'webhook',

  verify,

  deliveryId: (rawBody, headers) => {
    const given = headerValue(headers, WEBHOOK_DELIVERY_HEADER);
    if (given) {
      return given.length > MAX_IDENTIFIER_CHARS
        ? `sha256:${createHash('sha256').update(given, 'utf8').digest('hex')}`
        : given;
    }
    // No id from the sender: the same body in the same window is a resend.
    // The window stops a scheduled job that posts one body every day from
    // being dropped after its first run.
    const window = Math.floor(Date.now() / BODY_DEDUPE_WINDOW_MS);
    return `body:${createHash('sha256').update(rawBody).digest('hex')}:${window}`;
  },

  eventType: (_payload, headers) =>
    (headerValue(headers, WEBHOOK_EVENT_HEADER) ?? 'webhook').slice(0, MAX_IDENTIFIER_CHARS),

  toFacts: (delivery, connection) => {
    if (connection.kind !== 'webhook' || !connection.ruleId) return [];
    return [
      {
        integration: 'webhook',
        event: 'webhook_received',
        ruleId: connection.ruleId,
        connectionId: connection.id,
        deliveryRowId: delivery.id,
        deliveryId: delivery.deliveryId,
        receivedAt: delivery.receivedAt.toISOString(),
        payload: delivery.payload,
        headers: delivery.headers,
      },
    ];
  },

  workflowSource: webhookWorkflowSource,

  workspaceAllowed: workspaceMayUseWebhookRules,
};
