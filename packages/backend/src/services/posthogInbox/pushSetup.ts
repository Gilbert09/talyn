import { v4 as uuid } from 'uuid';
import {
  POSTHOG_INBOX_PUSH_RECONNECT_MESSAGE,
  posthogDestinationUrl,
  type PostHogInboxDestinationOutcome,
  type PostHogInboxDestinationSummary,
} from '@talyn/shared';
import { mintWebhookSecrets } from '../inbound/adapters/webhook.js';
import {
  deletePostHogInboxPushConnections,
  posthogInboxDestinations,
  posthogInboxPushConnection,
  rotatePostHogInboxPushConnection,
  setPostHogInboxDestination,
  type PostHogInboxDestinationState,
  type PostHogInboxPushConnectionRow,
} from '../inbound/store.js';
import { getPostHogInboxConnection, type PostHogInboxConnection } from './connection.js';
import { PostHogCodeApiError } from '../posthogCode/client.js';
import {
  classifyDestinationError,
  deleteDestination,
  destinationOutcome,
  destinationPayload,
  DestinationSyncError,
  outOfDateError,
  upsertDestination,
  type DestinationFailure,
} from './destination.js';

/**
 * "Set up push in PostHog", and the PostHog side of rotate, remove and
 * disconnect. The routes call these; they hold no Express types, so the URL
 * comes in as a function.
 *
 * The secret never leaves this module except to PostHog: it is not logged,
 * not returned and not stored outside its encrypted column.
 */

export type WebhookUrlFor = (connectionId: string, token: string) => string;

/** A PostHog call that changes the destination runs one at a time per workspace, on this replica. */
const inFlight = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const before = inFlight.get(workspaceId) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  inFlight.set(workspaceId, tail);
  try {
    return await run;
  } finally {
    if (inFlight.get(workspaceId) === tail) inFlight.delete(workspaceId);
  }
}

function logFailure(op: string, workspaceId: string, failure: DestinationFailure): void {
  // Ids and the status only. Never the URL (it holds the token) or the secret.
  console.warn(`[posthog-inbox] destination ${op} failed for workspace ${workspaceId}: ${failure.kind} (${failure.status ?? 'no status'})`);
}

/** The destination summary for the Connection tab, or null when Talyn did not create one. */
export function destinationSummary(
  row: Pick<PostHogInboxPushConnectionRow, 'projectId' | 'destinationId' | 'destinationSyncedAt' | 'destinationError'>,
  host: string | null
): PostHogInboxDestinationSummary | null {
  if (!row.destinationId) return null;
  return {
    id: row.destinationId,
    url: posthogDestinationUrl(host, row.projectId, row.destinationId),
    syncedAt: row.destinationSyncedAt ? row.destinationSyncedAt.toISOString() : null,
    error: row.destinationError,
  };
}

export type SetupResult =
  | { ok: true; connectionId: string; created: boolean; destination: PostHogInboxDestinationSummary }
  | { ok: false; reason: 'scopes_missing'; missingScopes: string[]; message: string }
  | { ok: false; reason: 'posthog'; failure: DestinationFailure; message: string }
  | { ok: false; reason: 'store'; message: string };

/**
 * Make or rotate the URL and create or update Talyn's PostHog destination.
 *
 * PostHog goes first: Talyn mints the new token and secret, saves them in
 * the destination, and only then stores them. So a refusal (missing scopes,
 * 403, 5xx) leaves the old URL working and the destination as it was. If
 * the store then fails, PostHog has a URL Talyn does not know; the answer
 * and the row say the destination is out of date.
 *
 * Idempotent: a stored destination id that PostHog still has is updated, so a
 * second run never makes a second destination. One PostHog no longer has is
 * replaced by a new one.
 */
export async function setUpPostHogInboxPush(input: {
  workspaceId: string;
  connection: PostHogInboxConnection;
  createdBy: string;
  urlFor: WebhookUrlFor;
}): Promise<SetupResult> {
  const { workspaceId, connection } = input;
  const missingScopes = connection.pushSetupMissingScopes ?? [];
  if (missingScopes.length > 0) {
    return {
      ok: false,
      reason: 'scopes_missing',
      missingScopes,
      message: `${POSTHOG_INBOX_PUSH_RECONNECT_MESSAGE} The connection lacks ${missingScopes.join(' and ')}. Talyn did not change the webhook URL.`,
    };
  }
  return oneAtATime(workspaceId, async () => {
    const row = await posthogInboxPushConnection(workspaceId, connection.projectId);
    const connectionId = row?.id ?? uuid();
    const minted = mintWebhookSecrets();
    let saved: { id: string; created: boolean };
    try {
      saved = await upsertDestination(connection, row?.destinationId ?? null, {
        url: input.urlFor(connectionId, minted.token),
        secret: minted.signingSecret,
      });
    } catch (err) {
      if (!(err instanceof DestinationSyncError)) throw err;
      logFailure('setup', workspaceId, err.failure);
      return {
        ok: false,
        reason: 'posthog',
        failure: err.failure,
        message: `${err.failure.message} Talyn did not change the webhook URL.`,
      };
    }

    const syncedAt = new Date();
    let stored: { connectionId: string };
    try {
      stored = await rotatePostHogInboxPushConnection(workspaceId, connection.projectId, {
        requireSecret: true,
        createdBy: input.createdBy,
        minted,
        connectionId,
        destination: { id: saved.id, syncedAt, error: null },
      });
    } catch (err) {
      // The name only: a database error can quote the row it failed to write.
      console.error(
        `[posthog-inbox] stored no new URL after PostHog saved destination ${saved.id} for workspace ${workspaceId}:`,
        errorName(err)
      );
      const message =
        'PostHog saved the destination, but Talyn could not save the new webhook URL. The destination is out of date. Use Set up push in PostHog again.';
      if (row) {
        await setPostHogInboxDestination(row.id, {
          id: saved.id,
          syncedAt: row.destinationSyncedAt,
          error: message,
        }).catch(() => undefined);
      }
      return { ok: false, reason: 'store', message };
    }

    // Another request made the row between the read and the write: PostHog has a URL with the wrong row id.
    if (stored.connectionId !== connectionId) {
      const message = outOfDateError('Another change to the webhook URL ran at the same time.');
      await setPostHogInboxDestination(stored.connectionId, { id: saved.id, syncedAt: null, error: message });
      return { ok: false, reason: 'store', message };
    }

    return {
      ok: true,
      connectionId,
      created: saved.created,
      destination: {
        id: saved.id,
        url: posthogDestinationUrl(connection.host, connection.projectId, saved.id),
        syncedAt: syncedAt.toISOString(),
        error: null,
      },
    };
  });
}

/**
 * Rotate the URL and, when Talyn set up its PostHog destination, give it the
 * new URL and secret. The rotate always happens (it may answer a leak). Only
 * then does Talyn update the destination, so a PostHog failure leaves the row
 * saying the destination is out of date, and the answer says so too.
 *
 * Runs under the workspace's lock, so a setup at the same time cannot leave
 * PostHog and Talyn holding different secrets.
 */
export async function rotatePostHogInboxPush(input: {
  workspaceId: string;
  connection: PostHogInboxConnection;
  requireSecret: boolean;
  createdBy: string;
  urlFor: WebhookUrlFor;
}): Promise<{
  connectionId: string;
  url: string;
  secret: string | null;
  created: boolean;
  managed: boolean;
  destination: PostHogInboxDestinationOutcome | null;
}> {
  const { workspaceId, connection } = input;
  return oneAtATime(workspaceId, async () => {
    const before = await posthogInboxPushConnection(workspaceId, connection.projectId);
    const rotated = await rotatePostHogInboxPushConnection(workspaceId, connection.projectId, {
      requireSecret: input.requireSecret,
      createdBy: input.createdBy,
    });
    const url = input.urlFor(rotated.connectionId, rotated.token);
    const destination = before?.destinationId
      ? await syncDestinationAfterRotate({
          workspaceId,
          connection,
          before: { destinationId: before.destinationId, destinationSyncedAt: before.destinationSyncedAt },
          connectionId: rotated.connectionId,
          url,
          secret: rotated.secret,
        })
      : null;
    return {
      connectionId: rotated.connectionId,
      url,
      secret: rotated.secret,
      created: rotated.created,
      managed: Boolean(before?.destinationId),
      destination,
    };
  });
}

/**
 * Give Talyn's destination the new URL and secret. Only updates: a
 * destination somebody deleted in PostHog is not made again (its id is
 * dropped). Never throws: the rotate already happened, and its one-time
 * reveal must reach the person.
 */
async function syncDestinationAfterRotate(input: {
  workspaceId: string;
  connection: PostHogInboxConnection;
  before: { destinationId: string; destinationSyncedAt: Date | null };
  connectionId: string;
  url: string;
  secret: string | null;
}): Promise<PostHogInboxDestinationOutcome> {
  const { workspaceId, connection, before } = input;
  const where = { host: connection.host, projectId: connection.projectId, id: before.destinationId };
  const record = async (state: PostHogInboxDestinationState): Promise<void> => {
    await setPostHogInboxDestination(input.connectionId, state).catch((err: unknown) => {
      console.warn(`[posthog-inbox] could not record the destination state for workspace ${workspaceId}:`, errorName(err));
    });
  };
  const fail = async (reason: string): Promise<PostHogInboxDestinationOutcome> => {
    const error = outOfDateError(reason);
    await record({ id: before.destinationId, syncedAt: before.destinationSyncedAt, error });
    return destinationOutcome('failed', error, where);
  };

  if ((connection.pushSetupMissingScopes ?? []).length > 0) return fail(POSTHOG_INBOX_PUSH_RECONNECT_MESSAGE);
  try {
    await connection.client.updateHogFunction(
      before.destinationId,
      destinationPayload({ url: input.url, secret: input.secret }, 'update')
    );
  } catch (err) {
    if (err instanceof PostHogCodeApiError && err.status === 404) {
      await record({ id: null, syncedAt: null, error: null });
      return destinationOutcome('not_found', null, { ...where, id: null });
    }
    const failure = classifyDestinationError(err);
    logFailure('rotate', workspaceId, failure);
    return fail(failure.message);
  }
  await record({ id: before.destinationId, syncedAt: new Date(), error: null });
  return destinationOutcome('updated', null, where);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}

/**
 * Remove the workspace's URLs, after deleting Talyn's destinations in
 * PostHog while the connection can still reach them. The PostHog part is best
 * effort and never stops the removal. A destination in a project the
 * connection no longer reads is reported as failed, with its PostHog link.
 *
 * The outcome is the one for the connection's current project, else the first one.
 */
export async function removePostHogInboxPush(
  workspaceId: string,
  connection: PostHogInboxConnection | null
): Promise<{ removed: number; destination: PostHogInboxDestinationOutcome | null }> {
  return oneAtATime(workspaceId, async () => {
    const destination = await deleteAllDestinations(workspaceId, connection).catch((err: unknown) => {
      console.warn(`[posthog-inbox] destination cleanup failed for workspace ${workspaceId}:`, errorName(err));
      return null;
    });
    const removed = await deletePostHogInboxPushConnections(workspaceId);
    return { removed, destination };
  });
}

async function deleteAllDestinations(
  workspaceId: string,
  connection: PostHogInboxConnection | null
): Promise<PostHogInboxDestinationOutcome | null> {
  const destinations = await posthogInboxDestinations(workspaceId);
  if (destinations.length === 0) return null;
  const outcomes: Array<{ projectId: string | null; outcome: PostHogInboxDestinationOutcome }> = [];
  for (const d of destinations) {
    const where = { host: connection?.host ?? null, projectId: d.projectId, id: d.destinationId };
    if (!connection || connection.projectId !== d.projectId) {
      outcomes.push({
        projectId: d.projectId,
        outcome: destinationOutcome(
          'failed',
          'Talyn can no longer reach the PostHog project of this destination. Delete it in PostHog.',
          where
        ),
      });
      continue;
    }
    const result = await deleteDestination(connection, d.destinationId);
    if (result.state === 'failed') console.warn(`[posthog-inbox] destination delete failed for workspace ${workspaceId}`);
    outcomes.push({
      projectId: d.projectId,
      outcome: destinationOutcome(result.state, result.error ? `${result.error} Delete the destination in PostHog.` : null, where),
    });
  }
  return (outcomes.find((o) => o.projectId === connection?.projectId) ?? outcomes[0])!.outcome;
}

const DISCONNECT_BUDGET_MS = 10_000;

/**
 * When the Inbox's own connection is removed: delete Talyn's destination
 * with that connection, while it still works. Best effort and bounded in
 * time: it never throws and never holds up the disconnect for long. A
 * deleted (or already gone) destination's id is cleared from the URL row; one
 * PostHog did not delete keeps its id and an error, so a later setup updates
 * it rather than making a second one.
 */
export async function deleteDestinationsOnDisconnect(workspaceId: string): Promise<void> {
  const work = oneAtATime(workspaceId, async () => {
    const connection = await getPostHogInboxConnection(workspaceId, 'read');
    if (!connection || connection.source !== 'posthog_inbox') return;
    const destinations = (await posthogInboxDestinations(workspaceId)).filter((d) => d.projectId === connection.projectId);
    for (const d of destinations) {
      const result = await deleteDestination(connection, d.destinationId);
      if (result.state === 'failed') {
        console.warn(`[posthog-inbox] destination delete on disconnect failed for workspace ${workspaceId}`);
        await setPostHogInboxDestination(d.connectionId, {
          id: d.destinationId,
          syncedAt: null,
          error: `Talyn could not delete the PostHog destination when PostHog was disconnected. ${result.error ?? ''} Delete it in PostHog.`
            .replace(/\s+/g, ' ')
            .trim(),
        });
      } else {
        await setPostHogInboxDestination(d.connectionId, { id: null, syncedAt: null, error: null });
      }
    }
  }).catch((err: unknown) => {
    console.warn(`[posthog-inbox] destination cleanup on disconnect failed for workspace ${workspaceId}:`, errorName(err));
  });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DISCONNECT_BUDGET_MS);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}
