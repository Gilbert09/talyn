import {
  POSTHOG_INBOX_DESTINATION_NAME,
  POSTHOG_INBOX_READY_EVENT,
  posthogDestinationUrl,
  type PostHogInboxDestinationOutcome,
} from '@talyn/shared';
import { PostHogCodeApiError } from '../posthogCode/client.js';
import { PostHogReauthRequiredError } from '../posthogOAuth/core.js';
import type { PostHogHogFunctionWrite } from './api.js';
import type { PostHogInboxConnection } from './connection.js';

/**
 * The PostHog webhook destination that tells Talyn when an Inbox report is
 * ready, created and kept in step by Talyn through PostHog's hog functions API.
 *
 * Confirmed against PostHog's source (PostHog/posthog, 2026-11-16):
 * - The "HTTP Webhook when an Inbox report is ready" sub-template is an
 *   `internal_destination` from `template-webhook`, with filters
 *   `{source: 'internal-events', events: [{id: '$signals_report_ready', type: 'events'}]}`
 *   (`frontend/src/scenes/hog-functions/sub-templates/sub-templates.ts`).
 * - On a create, PostHog copies the code and `inputs_schema` from the
 *   template, but not the input values, so Talyn sends every input it uses
 *   (`products/cdp/backend/api/hog_function.py`, `to_internal_value`).
 * - `secret_headers` is the template's encrypted dictionary input
 *   (`secret: true`, `templating: false`). PostHog stores it encrypted and
 *   answers `{"secret": true}` for it. An explicit value replaces it.
 * - PostHog refuses a destination on `$signals_report_ready` with a truthy
 *   `debug` input, so Talyn sends `debug: false`.
 * - Writing one needs `hog_function:write`, `inbox:read` and Inbox viewer access.
 * - `DELETE` answers 405. The delete is `PATCH {deleted: true}`, after which
 *   the function answers 404.
 * - Only agent edits of a `destination` go to a draft. An
 *   `internal_destination` edit is live at once.
 */

/** PostHog's webhook template. */
export const WEBHOOK_TEMPLATE_ID = 'template-webhook';

/** The header PostHog sends the secret in, as a person reads it in PostHog. */
export const DESTINATION_SECRET_HEADER = 'X-Talyn-Secret';

const DESCRIPTION =
  'Tells Talyn when an Inbox report is ready. Talyn created this destination and keeps its URL and secret up to date. Rotate or remove it in Talyn.';

/** The trigger: PostHog's internal "Inbox report ready" event. */
export const DESTINATION_FILTERS = {
  source: 'internal-events',
  events: [{ id: POSTHOG_INBOX_READY_EVENT, type: 'events' }],
} as const;

/**
 * PURE: the hog function fields for Talyn's destination. The same body serves
 * a create and an update, so an update also puts back a trigger, body or
 * debug setting that somebody changed in PostHog. `type` and `template_id`
 * are only sent on a create: PostHog refuses a type change.
 *
 * `secret` is null for a URL without a secret. The secret headers are then
 * sent empty, which clears an old secret in PostHog.
 */
export function destinationPayload(input: { url: string; secret: string | null }, mode: 'create' | 'update'): PostHogHogFunctionWrite {
  return {
    ...(mode === 'create' ? { type: 'internal_destination' as const, template_id: WEBHOOK_TEMPLATE_ID } : {}),
    name: POSTHOG_INBOX_DESTINATION_NAME,
    description: DESCRIPTION,
    enabled: true,
    filters: { ...DESTINATION_FILTERS, events: DESTINATION_FILTERS.events.map((e) => ({ ...e })) },
    inputs: {
      url: { value: input.url },
      method: { value: 'POST' },
      // The sub-template's default body: PostHog fills `{event}` and `{person}`.
      body: { value: { event: '{event}', person: '{person}' }, templating: 'hog' },
      headers: { value: { 'Content-Type': 'application/json' }, templating: 'hog' },
      // Not templated (the template sets `templating: false`), so the secret is sent as typed.
      secret_headers: { value: input.secret ? { [DESTINATION_SECRET_HEADER]: input.secret } : {} },
      debug: { value: false },
    },
  };
}

/** Why a PostHog destination call failed, for the person and the route's answer. */
export type DestinationFailureKind = 'forbidden' | 'unauthorized' | 'invalid' | 'unavailable';

export interface DestinationFailure {
  kind: DestinationFailureKind;
  status: number | null;
  message: string;
}

/**
 * PURE: what a failed hog function call means. Never reads the error's
 * message for anything a person sees beyond the status: the message is
 * Talyn's own, and PostHog's body is not in it.
 */
export function classifyDestinationError(err: unknown): DestinationFailure {
  // The OAuth refresh after a 401 found the grant revoked.
  if (err instanceof PostHogReauthRequiredError) {
    return { kind: 'unauthorized', status: 401, message: 'PostHog ended the connection. Reconnect PostHog.' };
  }
  const status = err instanceof PostHogCodeApiError ? err.status : null;
  if (status === 403) {
    return {
      kind: 'forbidden',
      status,
      message:
        'PostHog refused to save the destination (403). The connection needs the hog_function:write and inbox:read permissions, and your PostHog user needs access to the Inbox. Reconnect PostHog, or ask a PostHog admin for Inbox access.',
    };
  }
  if (status === 401) {
    return { kind: 'unauthorized', status, message: 'PostHog did not accept the connection (401). Reconnect PostHog.' };
  }
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { kind: 'invalid', status, message: `PostHog did not accept the destination (${status}).` };
  }
  return {
    kind: 'unavailable',
    status,
    message: status ? `PostHog did not answer as expected (${status}). Try again later.` : 'Talyn could not reach PostHog. Try again later.',
  };
}

export class DestinationSyncError extends Error {
  constructor(readonly failure: DestinationFailure) {
    super(failure.message);
    this.name = 'DestinationSyncError';
  }
}

/**
 * Create Talyn's destination, or update the one Talyn made before. When
 * PostHog no longer has `existingId` (404: deleted in PostHog, or never in
 * this project), it creates a new one. Throws {@link DestinationSyncError}.
 */
export async function upsertDestination(
  connection: Pick<PostHogInboxConnection, 'client'>,
  existingId: string | null,
  input: { url: string; secret: string | null }
): Promise<{ id: string; created: boolean }> {
  try {
    if (existingId) {
      try {
        const updated = await connection.client.updateHogFunction(existingId, destinationPayload(input, 'update'));
        return { id: updated?.id || existingId, created: false };
      } catch (err) {
        if (!(err instanceof PostHogCodeApiError && err.status === 404)) throw err;
      }
    }
    const created = await connection.client.createHogFunction(destinationPayload(input, 'create'));
    if (!created?.id) throw new Error('PostHog answered without a destination id.');
    return { id: created.id, created: true };
  } catch (err) {
    throw new DestinationSyncError(classifyDestinationError(err));
  }
}

/** Delete Talyn's destination in PostHog. Never throws. */
export async function deleteDestination(
  connection: Pick<PostHogInboxConnection, 'client'>,
  id: string
): Promise<{ state: 'deleted' | 'not_found' | 'failed'; error: string | null }> {
  try {
    await connection.client.deleteHogFunction(id);
    return { state: 'deleted', error: null };
  } catch (err) {
    if (err instanceof PostHogCodeApiError && err.status === 404) return { state: 'not_found', error: null };
    return { state: 'failed', error: classifyDestinationError(err).message };
  }
}

/** The outcome as the routes answer it, with the destination's PostHog page. */
export function destinationOutcome(
  state: PostHogInboxDestinationOutcome['state'],
  error: string | null,
  where: { host: string | null; projectId: string | null; id: string | null }
): PostHogInboxDestinationOutcome {
  return { state, error, url: posthogDestinationUrl(where.host, where.projectId, where.id) };
}

/** The error stored on the URL row when a rotate could not update the destination. */
export function outOfDateError(reason: string): string {
  return `Talyn changed the webhook URL, but PostHog did not take the change. The destination still sends to the old URL, so pushes fail until you use Set up push in PostHog again. ${reason}`;
}
