import { createHmac, randomBytes, randomUUID } from 'node:crypto';

/**
 * Standard Webhooks signing (https://www.standardwebhooks.com). A receiver can
 * verify with any Standard Webhooks library.
 *
 * Implemented here and not with the `standardwebhooks` package: that package
 * is only a dependency of the Polar SDK, and the scheme is one HMAC. The tests
 * check this code against the spec's vector and against that package's verify.
 *
 *   signed content = `${webhook-id}.${webhook-timestamp}.${body}`
 *   signature      = base64(HMAC-SHA256(base64decode(secret without "whsec_"), signed content))
 *   header         = "v1,<signature>", space-separated when more than one secret signs
 */

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** 32 random bytes. The spec asks for 24 to 64. */
const SECRET_BYTES = 32;

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64')}`;
}

function secretKey(secret: string): Buffer {
  const raw = secret.startsWith(WEBHOOK_SECRET_PREFIX) ? secret.slice(WEBHOOK_SECRET_PREFIX.length) : secret;
  return Buffer.from(raw, 'base64');
}

/** One `v1,<base64>` signature. */
export function signWebhook(secret: string, messageId: string, timestampSeconds: number, body: string): string {
  const mac = createHmac('sha256', secretKey(secret)).update(`${messageId}.${timestampSeconds}.${body}`).digest('base64');
  return `v1,${mac}`;
}

/** The three headers of one attempt. Every secret in `secrets` signs; the receiver accepts any match. */
export function webhookHeaders(
  secrets: readonly string[],
  messageId: string,
  body: string,
  now: Date = new Date(),
): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    'webhook-id': messageId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': secrets.map((s) => signWebhook(s, messageId, timestamp, body)).join(' '),
  };
}

/** A fresh event id: `evt_` and 32 hex characters. */
export function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, '')}`;
}
