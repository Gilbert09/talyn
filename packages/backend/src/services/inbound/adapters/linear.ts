import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { IssueEventFacts } from '@talyn/shared';
import { debugBus } from '../../debugBus.js';
import { linearWebhookSecret } from '../../linear/config.js';
import { connectionsForOrganization, markLinearReauthRequired } from '../../linear/store.js';
import { workspaceMayUseIssueRules } from '../../workflowsAccess.js';
import { linearToFacts, linearWorkflowSource, type LinearWorkflowTarget } from '../../workflows/sources/linear.js';
import {
  headerValue,
  type InboundAdapter,
  type InboundConnectionRef,
  type InboundVendorRoute,
  type InboundVerifyResult,
} from '../adapter.js';

/**
 * Linear: one app-level webhook for every organization that connected
 * Talyn's OAuth app, signed with the app's one secret
 * (`LINEAR_WEBHOOK_SECRET`).
 *
 * - `Linear-Signature` is the hex HMAC-SHA256 of the raw body.
 * - `webhookTimestamp` (ms, in the body) must be within a minute, as Linear
 *   recommends, so a captured request cannot be replayed later.
 * - `Linear-Delivery` is a UUID per payload; a retry repeats it.
 * - `organizationId` names the organization. An organization nobody here
 *   connected is answered 200 and dropped: Linear disables a webhook whose
 *   deliveries keep failing, and that would cut off every other organization.
 */

/** Linear's recommended window for `webhookTimestamp`. */
export const LINEAR_TIMESTAMP_TOLERANCE_MS = 60_000;

export function linearSignature(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyLinearRequest(
  rawBody: Buffer,
  headers: IncomingHttpHeaders,
  payload: unknown,
  secret: string | null,
  now: number
): InboundVerifyResult {
  const given = headerValue(headers, 'linear-signature');
  if (!given) return 'missing';
  if (!secret) return 'invalid';
  const a = Buffer.from(given.toLowerCase());
  const b = Buffer.from(linearSignature(rawBody, secret));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'invalid';
  const stamp = (payload as { webhookTimestamp?: unknown } | null)?.webhookTimestamp;
  if (typeof stamp !== 'number' || !Number.isFinite(stamp)) return 'stale';
  if (Math.abs(now - stamp) > LINEAR_TIMESTAMP_TOLERANCE_MS) return 'stale';
  return 'valid';
}

function organizationOf(payload: unknown): string | null {
  const id = (payload as { organizationId?: unknown } | null)?.organizationId;
  return typeof id === 'string' && id ? id : null;
}

export const linearVendorRoute: InboundVendorRoute = {
  path: 'linear',
  kind: 'linear',

  configured: () => linearWebhookSecret() !== null,

  verify: (rawBody, headers, payload, now) => verifyLinearRequest(rawBody, headers, payload, linearWebhookSecret(), now),

  async handleControl(payload) {
    const p = payload as { type?: unknown; action?: unknown } | null;
    if (p?.type !== 'OAuthApp') return false;
    if (p.action === 'revoked') {
      const org = organizationOf(payload);
      for (const connection of org ? await connectionsForOrganization(org) : []) {
        await markLinearReauthRequired(connection.id, 'Talyn was removed from this Linear workspace. Connect Linear again.');
        debugBus.recordEvent({
          service: 'inbound',
          action: 'linear_revoked',
          summary: `Linear organization ${org} revoked Talyn`,
          workspaceId: connection.workspaceId,
        });
      }
    }
    return true;
  },

  async connectionsFor(payload): Promise<InboundConnectionRef[]> {
    const org = organizationOf(payload);
    if (!org) return [];
    return (await connectionsForOrganization(org)).map((c) => ({
      id: c.id,
      workspaceId: c.workspaceId,
      kind: 'linear',
      ruleId: null,
    }));
  },

  deliveryId: (rawBody, headers) =>
    headerValue(headers, 'linear-delivery') ?? `body:${createHash('sha256').update(rawBody).digest('hex')}`,

  eventType: (payload, headers) => {
    const p = payload as { type?: unknown; action?: unknown } | null;
    const type = typeof p?.type === 'string' ? p.type : (headerValue(headers, 'linear-event') ?? 'linear');
    const action = typeof p?.action === 'string' ? p.action : '';
    return `${type}${action ? `.${action}` : ''}`.slice(0, 200);
  },
};

export const linearAdapter: InboundAdapter<IssueEventFacts, LinearWorkflowTarget> = {
  kind: 'linear',
  // A Linear connection has no URL of its own: every request comes through
  // the app-level route. The per-connection route refuses it.
  verify: () => 'invalid',
  deliveryId: linearVendorRoute.deliveryId,
  eventType: linearVendorRoute.eventType,
  toFacts: linearToFacts,
  workflowSource: linearWorkflowSource,
  workspaceAllowed: workspaceMayUseIssueRules,
};
