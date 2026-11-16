import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { POSTHOG_INBOX_READY_EVENT, POSTHOG_INBOX_SECRET_HEADER } from '@talyn/shared';
import { debugBus } from '../../debugBus.js';
import { PostHogCodeApiError } from '../../posthogCode/client.js';
import { getPostHogInboxConnection } from '../../posthogInbox/connection.js';
import { ingestPostHogReport } from '../../posthogInbox/ingest.js';
import { recordPostHogInboxPush } from '../../posthogInbox/poller.js';
import { workspaceMayUsePostHogInboxRules, workspaceMayUseWorkflows } from '../../workflowsAccess.js';
import {
  headerValue,
  type InboundConnectionRef,
  type InboundNudgeAdapter,
  type InboundNudgeResult,
  type InboundVerifyInput,
  type InboundVerifyResult,
  type StoredInboundDelivery,
} from '../adapter.js';
import { BODY_DEDUPE_WINDOW_MS, webhookTokenMatches } from './webhook.js';

/**
 * The PostHog Inbox push: PostHog's webhook destination on the internal event
 * `$signals_report_ready` (PostHog/posthog#135880), one URL per workspace and
 * PostHog project.
 *
 * PostHog's webhook template sends `POST` with `Content-Type: application/json`
 * and, by default, the body `{"event": {...}, "person": null}`. `event` is
 * the invocation's event: `uuid` (one per emitted event; PostHog's retries
 * repeat it), `event`, a random `distinct_id`, and `properties` with
 * `report_id`, `report_url`, `priority`, `actionability`, `source_products`,
 * `source_products_text` and `updated_at`. A user can edit the body, so a flat
 * body with `report_id` at the top works too.
 *
 * The push is ONLY a nudge. Talyn reads `report_id` (and `updated_at` and the
 * event `uuid`, for the delivery id) and then reads the report from PostHog
 * with the connection's own credentials (`ingestPostHogReport`). Nothing else
 * in the body decides anything, and a report id the connection's project does
 * not have is dropped. So a forged push can at most make Talyn read a report
 * it would have read on its next poll.
 *
 * The URL token is the credential, as for the generic webhook. A URL made with
 * a secret also needs `X-Talyn-Secret`, which the user adds in PostHog as a
 * secret header (PostHog stores it encrypted and never shows it again).
 */

/** Report ids and event uuids are uuids. Anything outside this is not used. */
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
/** PostHog's `updated_at` is an ISO time with microseconds and an offset. */
const MAX_UPDATED_AT_CHARS = 64;

export interface PostHogInboxPush {
  reportId: string;
  /** PostHog's `updated_at` text, or null when the body has none. Used only in the delivery id. */
  updatedAt: string | null;
  /** The event uuid, or null when the body has none. */
  eventUuid: string | null;
}

export type PostHogInboxPushParse = { ok: true; push: PostHogInboxPush } | { ok: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function idOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return ID_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * PURE: the report a push names. Reads only the event name (to refuse other
 * events), `report_id`, `updated_at` and the event `uuid`.
 */
export function parsePostHogInboxPush(payload: unknown): PostHogInboxPushParse {
  const body = asRecord(payload);
  if (!body) return { ok: false, reason: 'The body is not a JSON object.' };

  const nested = asRecord(body.event);
  // The default body nests the event; an edited body can be flat.
  const event = nested ?? body;
  const properties = nested ? asRecord(nested.properties) : body;
  const eventName = typeof event.event === 'string' ? event.event : null;
  if (eventName !== null && eventName !== POSTHOG_INBOX_READY_EVENT) {
    return { ok: false, reason: `The event is ${eventName.slice(0, 80)}, not ${POSTHOG_INBOX_READY_EVENT}.` };
  }
  if (!properties) return { ok: false, reason: 'The event has no properties.' };

  const rawReportId = properties.report_id;
  if (rawReportId === undefined || rawReportId === null || rawReportId === '') {
    return { ok: false, reason: 'The body has no report_id.' };
  }
  const reportId = idOrNull(rawReportId);
  if (!reportId) return { ok: false, reason: 'The report_id is not a PostHog report id.' };

  const rawUpdatedAt = properties.updated_at;
  const updatedAt =
    typeof rawUpdatedAt === 'string' && rawUpdatedAt.trim() && rawUpdatedAt.length <= MAX_UPDATED_AT_CHARS
      ? rawUpdatedAt.trim()
      : null;
  return { ok: true, push: { reportId, updatedAt, eventUuid: idOrNull(event.uuid) } };
}

/** Compare a presented secret with the stored one, in constant time (hashes have equal lengths). */
export function posthogInboxSecretMatches(presented: string, stored: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(stored, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function verifyPostHogInboxPush(input: InboundVerifyInput): InboundVerifyResult {
  if (!input.urlToken) return 'missing';
  if (!input.connection.tokenHash) return 'invalid';
  if (!webhookTokenMatches(input.urlToken, input.connection.tokenHash)) return 'invalid';
  if (!input.connection.hasSecret) return 'valid';
  const given = headerValue(input.headers, POSTHOG_INBOX_SECRET_HEADER);
  if (!given) return 'missing';
  // A stored secret that did not decrypt (a rotated key) refuses every request.
  if (!input.connection.signingSecret) return 'invalid';
  return posthogInboxSecretMatches(given, input.connection.signingSecret) ? 'valid' : 'invalid';
}

/**
 * The id a resend repeats: the event uuid, else the report version, else the
 * body in a time window (as the generic webhook does).
 */
export function posthogInboxPushDeliveryId(rawBody: Buffer, now: number = Date.now()): string {
  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    payload = null;
  }
  const parsed = parsePostHogInboxPush(payload);
  if (parsed.ok && parsed.push.eventUuid) return parsed.push.eventUuid;
  if (parsed.ok && parsed.push.updatedAt) return `posthog_inbox:${parsed.push.reportId}:${parsed.push.updatedAt}`;
  const window = Math.floor(now / BODY_DEDUPE_WINDOW_MS);
  return `body:${createHash('sha256').update(rawBody).digest('hex')}:${window}`;
}

function eventType(payload: unknown): string {
  const body = asRecord(payload);
  const nested = asRecord(body?.event);
  const name = nested?.event ?? body?.event;
  return typeof name === 'string' && name ? name.slice(0, 200) : 'posthog_inbox';
}

async function workspaceAllowed(workspaceId: string): Promise<boolean> {
  return (await workspaceMayUseWorkflows(workspaceId)) && (await workspaceMayUsePostHogInboxRules(workspaceId));
}

const result = (outcome: InboundNudgeResult['outcome'], note: string | null, ran = 0): InboundNudgeResult => ({
  outcome,
  ran,
  note,
});

/**
 * Read the pushed report from PostHog and run the rules on it. A replay
 * (`<id>:replay:<n>`) reads the report again but does not count as a push
 * from PostHog, so it never slows the poller.
 */
export async function nudgePostHogInbox(
  delivery: StoredInboundDelivery,
  connection: InboundConnectionRef
): Promise<InboundNudgeResult> {
  const parsed = parsePostHogInboxPush(delivery.payload);
  if (!parsed.ok) return result('ignored', parsed.reason);
  const { reportId } = parsed.push;

  if (!(await workspaceAllowed(connection.workspaceId))) {
    return result('ignored', 'PostHog Inbox automations are off for this workspace.');
  }
  const inbox = await getPostHogInboxConnection(connection.workspaceId);
  if (!inbox) {
    return result('failed', "Talyn cannot read this workspace's PostHog Inbox. Connect PostHog again with the Inbox permission.");
  }
  if (connection.externalAccountId && inbox.projectId !== connection.externalAccountId) {
    return result(
      'ignored',
      `This URL is for PostHog project ${connection.externalAccountId}, but the PostHog connection now reads project ${inbox.projectId}. Make a new URL.`
    );
  }

  let ingested: Awaited<ReturnType<typeof ingestPostHogReport>>;
  try {
    ingested = await ingestPostHogReport(inbox, reportId);
  } catch (err) {
    const status = err instanceof PostHogCodeApiError ? err.status : null;
    if (status === 404 || status === 400) {
      // A forged or misdirected push: the project has no such report.
      debugBus.recordEvent({
        service: 'inbound',
        action: 'posthog_inbox_unknown_report',
        summary: `connection ${connection.id}: project ${inbox.projectId} has no report ${reportId}`,
        ok: false,
        workspaceId: connection.workspaceId,
      });
      return result('ignored', `PostHog project ${inbox.projectId} has no report ${reportId}. Talyn dropped the request.`);
    }
    if (status === 401 || status === 403) {
      return result('failed', 'PostHog refused to show the report. Connect PostHog again with the Inbox permission.');
    }
    // PostHog is down or rate limited: the delivery is retried, and the poller reconciles.
    throw err;
  }
  if (ingested.kind === 'unreadable') return result('ignored', 'PostHog answered with something that is not a report.');

  if (!delivery.deliveryId.includes(':replay:')) {
    await recordPostHogInboxPush(inbox.id, connection.workspaceId, delivery.receivedAt);
  }
  return ingested.ran > 0 ? result('handled', null, ingested.ran) : result('ignored', null);
}

export const posthogInboxAdapter: InboundNudgeAdapter = {
  kind: 'posthog_inbox',
  verify: verifyPostHogInboxPush,
  deliveryId: (rawBody: Buffer, _headers: IncomingHttpHeaders) => posthogInboxPushDeliveryId(rawBody),
  eventType: (payload: unknown) => eventType(payload),
  nudge: nudgePostHogInbox,
  workspaceAllowed,
};
